import { existsSync, watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  RelayFileClient,
  RelayFileSync,
  RelayfileSetup,
  type ChangeEvent,
  type FilesystemEvent,
  type Subscription
} from '@relayfile/sdk'
import type { ConnectedIntegration } from './integrations'

const INTEGRATION_EVENT_AGENT_NAME = 'pear-integration-events'
const INTEGRATION_EVENT_SCOPES = ['relayfile:fs:read:/**']
const PROJECT_INTEGRATIONS_LINK_NAME = '.integrations'
const RECENT_INJECTION_TTL_MS = 10_000
const INTEGRATION_EVENT_LOG_PATH = join(homedir(), '.agentworkforce', 'pear', 'integration-events.log')

type WatchRegistration = {
  glob: string
  coalesceMs: number
}

type DeliveryTargets = {
  agents: string[]
  channels: string[]
}

type SubscriptionSpec = {
  integrationId: string
  provider: string
  mountPaths: string[]
  watches: WatchRegistration[]
  targets: DeliveryTargets
}

type ProjectSubscription = {
  subscriptions: Subscription[]
  signature: string
}

type LocalMountSubscription = Subscription & {
  localRoots: string[]
}

type BrokerEventBridge = {
  listAgents: (projectId?: string) => Promise<Array<{ name: string; projectId?: string }>>
  sendMessage: (
    projectId: string,
    input: {
      to: string
      text: string
      from?: string
      data?: Record<string, unknown>
      priority?: number
      mode?: 'wait' | 'steer'
    }
  ) => Promise<void> | void
  sendMessageAndWaitForDelivery?: (
    projectId: string,
    input: {
      to: string
      text: string
      from?: string
      data?: Record<string, unknown>
      priority?: number
      mode?: 'wait' | 'steer'
    },
    options?: { timeoutMs?: number }
  ) => Promise<unknown>
}

type RelayfileEventClient = {
  subscribe(
    globs: string[],
    onChange: (event: ChangeEvent) => void,
    options?: { coalesce?: 'none' | 'fire-once'; coalesceMs?: number }
  ): Subscription
}

type RelayfileWorkspaceHandle = {
  workspaceId: string
  localMountWorkspaceId: string
  client(): RelayfileEventClient
}

type TokenProvider = () => Promise<string | undefined>

type IntegrationEventBridgeDeps = {
  broker?: BrokerEventBridge
  getWorkspaceHandle?: () => Promise<RelayfileWorkspaceHandle>
}

type EventWorkspaceHandleCache = {
  apiUrl: string
  accountKey: string
  accountWorkspaceId: string
  handle: RelayfileWorkspaceHandle
}

export type IntegrationSubscriptionSummary = {
  provider: string
  watches: string[]
  targets: string[]
}

let accountIntegrationEventHandle: EventWorkspaceHandleCache | null = null
let localEventSequence = 0

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { httpStatus?: unknown; status?: unknown }).httpStatus ??
    (error as { httpStatus?: unknown; status?: unknown }).status
  if (status === 401 || status === 403) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /\b(401|403|unauthor|forbidden)\b/i.test(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort()
}

function toRelayfileProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  return normalized === 'gmail' ? 'google-mail' : normalized
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/u).filter(Boolean)
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function workspaceIdFromJwt(token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  const claims = decodeBase64UrlJson(parts[1])
  return typeof claims?.workspace_id === 'string' && claims.workspace_id ? claims.workspace_id : null
}

// Provider adapters materialize data at the workspace root (`/github/...`,
// `/linear/...`), so watch globs must target the root-level provider layout.
// Tolerates the legacy `/integrations/<provider>/...` catalog form.
function canonicalMountPaths(integration: ConnectedIntegration): string[] {
  const provider = toRelayfileProvider(integration.provider)
  const mountPaths = integration.mountPaths.map((path) => {
    const discovery = path.match(/^\/discovery(?:\/.*)?$/)
    if (discovery) return path
    const prefixed = path.match(/^\/integrations\/[^/]+(\/.*)?$/)
    if (prefixed) return `/${provider}${prefixed[1] ?? ''}`
    const rootLevel = path.match(/^\/[^/]+(\/.*)?$/)
    if (rootLevel) return `/${provider}${rootLevel[1] ?? ''}`
    return path
  })
  return dedupeStrings([
    ...mountPaths,
    ...mountPaths.map((path) => slackChannelIdFallbackMountPath(provider, path)).filter((path): path is string => path !== null)
  ])
}

function slackChannelIdFallbackMountPath(provider: string, path: string): string | null {
  if (provider !== 'slack') return null
  const match = path.match(/^\/slack\/channels\/([^/_][^/]*)__[^/]+$/u)
  return match?.[1] ? `/slack/channels/${match[1]}` : null
}

function watchGlobForPath(path: string): string {
  const root = path.trim().replace(/\/+$/u, '')
  return root.endsWith('/**') ? root : `${root || '/'}/**`
}

function watchRegistrationsFor(integrations: ConnectedIntegration[]): WatchRegistration[] {
  return dedupeStrings(integrations.flatMap((integration) => canonicalMountPaths(integration).map(watchGlobForPath)))
    .map((glob) => ({
      glob,
      coalesceMs: 750
    }))
}

function normalizeAgentTarget(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() || null : trimmed
}

function normalizeChannelTarget(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

function deliveryTargetsFor(integrations: ConnectedIntegration[]): DeliveryTargets {
  const agents: string[] = []
  const channels: string[] = []
  for (const integration of integrations) {
    const scope = integration.scope
    agents.push(
      ...[
        ...stringList(scope.notifyAgents),
        ...stringList(scope.notificationAgents),
        ...stringList(scope.listenerAgents),
        ...stringList(scope.agentListeners)
      ].map(normalizeAgentTarget).filter((entry): entry is string => entry !== null)
    )
    channels.push(
      ...[
        ...stringList(scope.notifyChannels),
        ...stringList(scope.notificationChannels),
        ...stringList(scope.listenerChannels),
        ...stringList(scope.channelListeners),
        ...stringList(scope.relayChannels)
      ].map(normalizeChannelTarget).filter((entry): entry is string => entry !== null)
    )
  }
  return {
    agents: dedupeStrings(agents),
    channels: dedupeStrings(channels)
  }
}

function targetLabels(targets: DeliveryTargets): string[] {
  return [...targets.agents.map((agent) => `@${agent}`), ...targets.channels]
}

function subscriptionSpecsFor(integrations: ConnectedIntegration[]): SubscriptionSpec[] {
  return integrations.map((integration) => {
    const mountPaths = canonicalMountPaths(integration)
    return {
      integrationId: integration.integrationId,
      provider: integration.provider,
      mountPaths,
      watches: mountPaths.map(watchGlobForPath).map((glob) => ({
        glob,
        coalesceMs: 750
      })),
      targets: deliveryTargetsFor([integration])
    }
  }).filter((spec) => spec.watches.length > 0)
}

function pathIsInsideMount(path: string, mountPath: string): boolean {
  const normalizedPath = path.trim().replace(/\/+$/u, '') || '/'
  const normalizedMountPath = mountPath.trim().replace(/\/+$/u, '') || '/'
  return normalizedPath === normalizedMountPath || normalizedPath.startsWith(`${normalizedMountPath}/`)
}

function projectIntegrationPathForRelayfilePath(path: string): string {
  const normalized = path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`
  return `${PROJECT_INTEGRATIONS_LINK_NAME}${normalized}`
}

function normalizeChangePath(path: string): string[] {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const trimmed = normalized.replace(/\/+$/u, '')
  return trimmed === '' ? [] : trimmed.split('/').filter(Boolean)
}

function globMatchesPath(glob: string, path: string): boolean {
  const pattern = normalizeChangePath(glob)
  const target = normalizeChangePath(path)
  if (pattern.at(-1) === '**') {
    const prefix = pattern.slice(0, -1)
    return target.length >= prefix.length &&
      prefix.every((segment, index) => segment === '*' || segment === target[index])
  }
  return pattern.length === target.length &&
    pattern.every((segment, index) => segment === '*' || segment === target[index])
}

function shouldPublishFilesystemEvent(event: FilesystemEvent): boolean {
  return event.type === 'file.created' || event.type === 'file.updated' || event.type === 'file.deleted'
}

function filesystemEventToChangeEvent(
  client: RelayFileClient | null,
  workspaceId: string,
  event: FilesystemEvent
): ChangeEvent {
  const path = event.path.startsWith('/') ? event.path : `/${event.path}`
  const provider = event.provider || path.split('/').filter(Boolean)[0] || 'relayfile'
  const resourceId = path.split('/').filter(Boolean).at(-1) || path
  const summary = {
    title: path
  }

  return {
    id: event.eventId || `${workspaceId}:${path}:${event.revision}`,
    workspace: workspaceId,
    type: 'relayfile.changed',
    occurredAt: event.timestamp || new Date().toISOString(),
    resource: {
      path,
      provider,
      kind: 'record',
      id: resourceId
    },
    summary,
    digest: event.revision ? `revision:${event.revision}` : undefined,
    expand: async (level = 'summary') => {
      if (level === 'summary') {
        return {
          level,
          path,
          summary
        }
      }
      if (level === 'full') {
        if (client) {
          try {
            const resource = await client.getResourceAtEvent(event.eventId, { workspaceId })
            return {
              level,
              path: resource.path,
              data: resource.data
            }
          } catch {
            // Fall through to the local fallback below.
          }
        }
        return {
          level,
          path,
          data: { path, deleted: event.type === 'file.deleted' }
        }
      }
      throw new Error(`ChangeEvent.expand(${JSON.stringify(level)}) is not implemented for integration events`)
    }
  } as ChangeEvent
}

function createWorkspaceScopedEventClient(
  client: RelayFileClient,
  workspaceId: string,
  tokenProvider: TokenProvider
): RelayfileEventClient {
  return {
    subscribe(globs, onChange, options) {
      let active = true
      let sync: RelayFileSync | null = null
      const pendingByPath = new Map<string, ReturnType<typeof setTimeout>>()
      const coalesceMs = Math.max(0, Math.floor(options?.coalesceMs ?? 750))
      const shouldCoalesce = (options?.coalesce ?? 'fire-once') !== 'none'

      const dispatch = (event: FilesystemEvent): void => {
        if (!active) return
        const changeEvent = filesystemEventToChangeEvent(client, workspaceId, event)
        Promise.resolve(onChange(changeEvent)).catch((error) => {
          logIntegrationEvent('change handler failed', {
            workspaceId,
            eventId: event.eventId,
            path: event.path,
            error: toErrorMessage(error)
          })
        })
      }

      const handleEvent = (event: FilesystemEvent): void => {
        if (!active || !shouldPublishFilesystemEvent(event)) return
        const path = event.path.startsWith('/') ? event.path : `/${event.path}`
        if (!globs.some((glob) => globMatchesPath(glob, path))) return

        if (!shouldCoalesce) {
          dispatch({ ...event, path })
          return
        }

        const existing = pendingByPath.get(path)
        if (existing) clearTimeout(existing)
        pendingByPath.set(path, setTimeout(() => {
          pendingByPath.delete(path)
          dispatch({ ...event, path })
        }, coalesceMs))
      }

      void tokenProvider()
        .then((token) => {
          if (!active) return
          const tokenWorkspaceId = workspaceIdFromJwt(token)
          if (tokenWorkspaceId && tokenWorkspaceId !== workspaceId) {
            logIntegrationEvent('skipping remote stream with mismatched workspace JWT', {
              workspaceId,
              tokenWorkspaceId
            })
            return
          }
          logIntegrationEvent('remote stream starting', {
            workspaceId,
            globs
          })
          sync = new RelayFileSync({
            client,
            workspaceId,
            token,
            onPollingFallback: (info) => {
              logIntegrationEvent('remote stream polling fallback', {
                workspaceId,
                reason: info.reason
              })
            }
          })
          sync.on('event', handleEvent)
          sync.on('error', (error) => {
            logIntegrationEvent('remote stream error', {
              workspaceId,
              error: toErrorMessage(error)
            })
          })
          sync.start()
        })
        .catch((error) => {
          logIntegrationEvent('remote stream token check failed', {
            workspaceId,
            error: toErrorMessage(error)
          })
        })

      return {
        async unsubscribe() {
          active = false
          for (const timer of pendingByPath.values()) clearTimeout(timer)
          pendingByPath.clear()
          await sync?.stop()
        }
      }
    }
  }
}

function remoteRootForLocalMountPath(workspaceId: string, localPath: string): string | null {
  const segments = pathSegments(localPath)
  const workspaceIndex = segments.findIndex((segment) => segment === workspaceId)
  if (workspaceIndex < 0) return null
  const remoteSegments = segments.slice(workspaceIndex + 1)
  return remoteSegments.length > 0 ? `/${remoteSegments.join('/')}` : null
}

function localRootsForIntegration(
  workspaceId: string,
  integration: ConnectedIntegration
): Array<{ localRoot: string; remoteRoot: string }> {
  if (!allowsLocalMountWatching(integration)) return []

  return (integration.localMountPaths || [])
    .map((localRoot) => {
      const remoteRoot = remoteRootForLocalMountPath(workspaceId, localRoot)
      return remoteRoot ? { localRoot, remoteRoot } : null
    })
    .filter((entry): entry is { localRoot: string; remoteRoot: string } =>
      entry !== null && isBoundedLocalCommandRoot(entry.remoteRoot)
    )
}

function allowsLocalMountWatching(integration: ConnectedIntegration): boolean {
  // Local filesystem fallback must never recursively watch provider history roots.
  return integration.downloadHistoricalData === true &&
    integration.mountPaths.some((mountPath) => isBoundedLocalCommandRoot(mountPath))
}

function isBoundedLocalCommandRoot(remoteRoot: string): boolean {
  const segments = pathSegments(remoteRoot)
  if (segments.length === 0) return false
  return segments.some((segment) => segment === '.outbox' || segment === 'outbox')
}

function watchableLocalIntegrations(integrations: ConnectedIntegration[]): ConnectedIntegration[] {
  return integrations.filter(allowsLocalMountWatching)
}

function hasWatchableLocalIntegrationFor(
  integrations: ConnectedIntegration[],
  remoteRoot: string
): boolean {
  return integrations.some((integration) =>
    canonicalMountPaths(integration).some((mountPath) => pathIsInsideMount(remoteRoot, mountPath))
  )
}

function remoteRootForWatchGlob(glob: string): string | null {
  const trimmed = glob.trim()
  if (!trimmed.startsWith('/')) return null
  const withoutWildcard = trimmed.replace(/\/\*\*$/u, '').replace(/\/+$/u, '')
  return withoutWildcard || '/'
}

function parentRemoteRootForDynamicChildren(remoteRoot: string): string | null {
  const segments = pathSegments(remoteRoot)
  if (segments.length < 3) return null
  return `/${segments.slice(0, -1).join('/')}`
}

function localPathForRemoteRoot(workspaceId: string, remoteRoot: string): string {
  return join(homedir(), '.agentworkforce', 'pear', 'relayfile', 'workspaces', workspaceId, ...pathSegments(remoteRoot))
}

export function localWatchRootsFor(
  workspaceId: string,
  integrations: ConnectedIntegration[],
  globs: string[]
): Array<{ localRoot: string; remoteRoot: string }> {
  const watchableIntegrations = watchableLocalIntegrations(integrations)
  if (watchableIntegrations.length === 0) return []

  const roots = new Map<string, { localRoot: string; remoteRoot: string }>()
  for (const integration of watchableIntegrations) {
    for (const root of localRootsForIntegration(workspaceId, integration)) {
      roots.set(resolve(root.localRoot), { localRoot: resolve(root.localRoot), remoteRoot: root.remoteRoot })
    }
  }

  for (const glob of globs) {
    const remoteRoot = remoteRootForWatchGlob(glob)
    if (!remoteRoot) continue
    for (const candidate of dedupeStrings([
      remoteRoot,
      parentRemoteRootForDynamicChildren(remoteRoot)
    ].filter((entry): entry is string => entry !== null))) {
      if (!isBoundedLocalCommandRoot(candidate)) continue
      if (!hasWatchableLocalIntegrationFor(watchableIntegrations, candidate)) continue
      const localRoot = resolve(localPathForRemoteRoot(workspaceId, candidate))
      if (!roots.has(localRoot)) roots.set(localRoot, { localRoot, remoteRoot: candidate })
    }
  }

  return Array.from(roots.values())
}

function remotePathForLocalPath(localRoot: string, remoteRoot: string, localPath: string): string | null {
  const relativePath = relative(localRoot, localPath)
  if (!relativePath || relativePath.startsWith('..') || relativePath === '..') return null
  const normalizedRelative = relativePath.split(sep).join('/')
  return `${remoteRoot.replace(/\/+$/u, '')}/${normalizedRelative}`
}

async function fileEventForLocalPath(
  workspaceId: string,
  localPath: string,
  remotePath: string,
  eventType: string
): Promise<FilesystemEvent | null> {
  const stats = await stat(localPath).catch(() => null)
  if (stats?.isDirectory()) return null
  localEventSequence += 1
  return {
    eventId: `local:${workspaceId}:${remotePath}:${Date.now()}:${localEventSequence}`,
    type: stats ? (eventType === 'rename' ? 'file.created' : 'file.updated') : 'file.deleted',
    path: remotePath,
    revision: stats ? `${Math.round(stats.mtimeMs)}:${stats.size}` : '',
    timestamp: new Date().toISOString()
  }
}

function watchLocalMounts(
  workspaceId: string,
  integrations: ConnectedIntegration[],
  globs: string[],
  onChange: (event: ChangeEvent) => void,
  coalesceMs: number
): LocalMountSubscription | null {
  const roots = new Map<string, { localRoot: string; remoteRoot: string }>()
  for (const root of localWatchRootsFor(workspaceId, integrations, globs)) {
    roots.set(resolve(root.localRoot), { localRoot: resolve(root.localRoot), remoteRoot: root.remoteRoot })
  }
  if (roots.size === 0) return null

  let active = true
  const watchers: FSWatcher[] = []
  const pendingByPath = new Map<string, ReturnType<typeof setTimeout>>()

  const schedule = (localRoot: string, remoteRoot: string, localPath: string, eventType: string): void => {
    const remotePath = remotePathForLocalPath(localRoot, remoteRoot, localPath)
    if (!remotePath || !shouldNotifyRelayfilePath(remotePath)) return
    if (!globs.some((glob) => globMatchesPath(glob, remotePath))) return

    const existing = pendingByPath.get(remotePath)
    if (existing) clearTimeout(existing)
    pendingByPath.set(remotePath, setTimeout(() => {
      pendingByPath.delete(remotePath)
      if (!active) return
      void fileEventForLocalPath(workspaceId, localPath, remotePath, eventType)
        .then((event) => {
          if (!event || !active) return
          logIntegrationEvent('local mount event', {
            workspaceId,
            path: event.path,
            type: event.type,
            localPath
          })
          onChange(filesystemEventToChangeEvent(null, workspaceId, event))
        })
        .catch((error) => {
          console.warn('[integration-events] Local mount event failed:', toErrorMessage(error))
        })
    }, coalesceMs))
  }

  for (const { localRoot, remoteRoot } of roots.values()) {
    if (!existsSync(localRoot)) continue
    try {
      const watcher = watch(localRoot, { recursive: true }, (eventType, filename) => {
        if (!active || !filename) return
        schedule(localRoot, remoteRoot, join(localRoot, String(filename)), eventType)
      })
      watcher.on('error', (error) => {
        console.warn('[integration-events] Local mount watcher error:', toErrorMessage(error))
      })
      watchers.push(watcher)
    } catch (error) {
      console.warn('[integration-events] Failed to watch local integration mount:', {
        localRoot,
        error: toErrorMessage(error)
      })
    }
  }

  if (watchers.length === 0) return null
  return {
    localRoots: Array.from(roots.keys()),
    async unsubscribe() {
      active = false
      for (const timer of pendingByPath.values()) clearTimeout(timer)
      pendingByPath.clear()
      await Promise.all(watchers.map((watcher) => new Promise<void>((resolveClose) => {
        watcher.once('close', resolveClose)
        watcher.close()
      })))
    }
  }
}

function specsForEvent(event: ChangeEvent, specs: SubscriptionSpec[]): SubscriptionSpec[] {
  const path = event.resource.path
  return specs.filter((spec) => spec.mountPaths.some((mountPath) => pathIsInsideMount(path, mountPath)))
}

function longestMatchingMountPath(path: string, spec: SubscriptionSpec): string | null {
  return spec.mountPaths
    .filter((mountPath) => pathIsInsideMount(path, mountPath))
    .sort((a, b) => b.length - a.length)[0] || null
}

function pathTailAfterMount(path: string, mountPath: string): string {
  const normalizedPath = path.trim().replace(/\/+$/u, '') || '/'
  const normalizedMountPath = mountPath.trim().replace(/\/+$/u, '') || '/'
  if (normalizedPath === normalizedMountPath) return '/'
  return normalizedPath.slice(normalizedMountPath.length) || '/'
}

function injectionDeduplicationKey(projectId: string, event: ChangeEvent, matchedSpecs: SubscriptionSpec[]): string {
  const path = event.resource.path.startsWith('/') ? event.resource.path : `/${event.resource.path}`
  const scopedKeys = matchedSpecs
    .map((spec) => {
      const mountPath = longestMatchingMountPath(path, spec)
      return mountPath
        ? `${spec.integrationId}:${spec.provider}:${pathTailAfterMount(path, mountPath)}`
        : null
    })
    .filter((entry): entry is string => entry !== null)
  if (scopedKeys.length > 0) return `${projectId}:${event.type}:${dedupeStrings(scopedKeys).join('|')}`
  return `${projectId}:${event.type}:${path}`
}

function logIntegrationEvent(message: string, metadata: Record<string, unknown>): void {
  console.info(`[integration-events] ${message}`, metadata)
  if (isTestProcess()) return
  void appendIntegrationEventLog(message, metadata)
}

function isTestProcess(): boolean {
  return process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    process.argv.some((arg) => arg === '--test' || arg.includes('/vitest/'))
}

async function appendIntegrationEventLog(message: string, metadata: Record<string, unknown>): Promise<void> {
  const entry = {
    timestamp: new Date().toISOString(),
    message,
    metadata
  }
  try {
    await mkdir(dirname(INTEGRATION_EVENT_LOG_PATH), { recursive: true })
    await appendFile(INTEGRATION_EVENT_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Diagnostics must never affect event delivery.
  }
}

export function integrationSubscriptionSummaries(
  integrations: ConnectedIntegration[]
): IntegrationSubscriptionSummary[] {
  return integrations
    .filter((integration) => integration.subscribeAgent === true)
    .map((integration) => {
      const targets = deliveryTargetsFor([integration])
      return {
        provider: integration.provider,
        watches: watchRegistrationsFor([integration])
          .map((watch) => watch.glob)
          .map(projectIntegrationPathForRelayfilePath),
        targets: targetLabels(targets)
      }
    })
    .filter((summary) => summary.watches.length > 0)
}

function eventSummaryValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value) && value.length > 0) return value.map((entry) => String(entry)).join(', ')
  return undefined
}

function shouldNotifyRelayfilePath(pathValue: string): boolean {
  const path = pathValue.trim()
  if (!path || !path.startsWith('/')) return false

  const leaf = path.split('/').pop() || ''
  if (
    leaf === 'LAYOUT.md' ||
    leaf === '_index.json' ||
    leaf === '.schema.json' ||
    leaf === '.create.example.json' ||
    path === '/discovery' ||
    path.startsWith('/discovery/') ||
    path.includes('/discovery/') ||
    path.includes('/.relay/') ||
    path.includes('/.relayfile-') ||
    path.endsWith('/.schema.json') ||
    path.endsWith('/.create.example.json')
  ) {
    return false
  }

  // Local writeback drafts are commands from an agent, not provider-originated
  // updates. Notifying agents about their own draft files creates loops.
  if (/\/(?:draft[@-][^/]*|create)\.json$/u.test(path)) return false

  return true
}

function shouldNotifyRelayfileChange(event: ChangeEvent): boolean {
  return shouldNotifyRelayfilePath(event.resource.path)
}

function formatIntegrationEventMessage(event: ChangeEvent): string {
  const summary = isRecord(event.summary) ? event.summary : {}
  const resource = isRecord(event.resource) ? event.resource : {}
  const provider = eventSummaryValue(resource.provider) || 'integration'
  const relayfilePath = eventSummaryValue(resource.path)
  const projectPath = relayfilePath ? projectIntegrationPathForRelayfilePath(relayfilePath) : undefined
  const resourceKind = eventSummaryValue(resource.kind)
  const resourceId = eventSummaryValue(resource.id)
  const title = eventSummaryValue(summary.title)
  const status = eventSummaryValue(summary.status)
  const actor = isRecord(summary.actor)
    ? eventSummaryValue(summary.actor.displayName) || eventSummaryValue(summary.actor.id)
    : undefined
  const fieldsChanged = eventSummaryValue(summary.fieldsChanged)
  const labels = eventSummaryValue(summary.labels) || eventSummaryValue(summary.tags)

  const lines = [
    '<integration-event>',
    `Provider: ${provider}`,
    `Type: ${event.type}`,
    `Occurred at: ${event.occurredAt}`,
    `Event id: ${event.id}`
  ]

  if (projectPath) lines.push(`Path: ${projectPath}`)
  if (relayfilePath) lines.push(`Relayfile path: ${relayfilePath}`)
  if (resourceKind) lines.push(`Resource kind: ${resourceKind}`)
  if (resourceId) lines.push(`Resource id: ${resourceId}`)
  if (title) lines.push(`Title: ${title}`)
  if (status) lines.push(`Status: ${status}`)
  if (actor) lines.push(`Actor: ${actor}`)
  if (fieldsChanged) lines.push(`Fields changed: ${fieldsChanged}`)
  if (labels) lines.push(`Labels: ${labels}`)

  lines.push(
    'Handle this like an incoming user-relevant integration update. The Relayfile path above identifies the changed record; use the matching .integrations path for extra context only when historical download is enabled. Use the existing writeback or messaging path when a response is needed.',
    '</integration-event>'
  )
  return lines.join('\n')
}

export class IntegrationEventBridge {
  private subscriptions = new Map<string, ProjectSubscription>()
  private recentInjections = new Map<string, number>()
  private readonly deps: IntegrationEventBridgeDeps

  constructor(deps: IntegrationEventBridgeDeps = {}) {
    this.deps = deps
  }

  async reconcile(projectId: string, integrations: ConnectedIntegration[]): Promise<void> {
    const subscribed = integrations.filter((integration) => integration.subscribeAgent === true)
    if (subscribed.length === 0) {
      await this.close(projectId)
      return
    }

    const specs = subscriptionSpecsFor(subscribed)
    const watches = dedupeStrings(specs.flatMap((spec) => spec.watches.map((watch) => watch.glob))).map((glob) => ({
      glob,
      coalesceMs: 750
    }))
    if (watches.length === 0) {
      await this.close(projectId)
      return
    }

    const handle = await this.getWorkspaceHandle()
    const signature = JSON.stringify({
      workspaceId: handle.workspaceId,
      localMountWorkspaceId: handle.localMountWorkspaceId,
      watches,
      specs: specs.map((spec) => ({
        integrationId: spec.integrationId,
        provider: spec.provider,
        mountPaths: spec.mountPaths,
        targets: spec.targets
      }))
    })
    if (this.subscriptions.get(projectId)?.signature === signature) return

    await this.close(projectId)
    const subscriptions: Subscription[] = []
    try {
      logIntegrationEvent('subscribing', {
        projectId,
        workspaceId: handle.workspaceId,
        localMountWorkspaceId: handle.localMountWorkspaceId,
        globs: watches.map((watch) => watch.glob),
        specs: specs.map((spec) => ({
          integrationId: spec.integrationId,
          provider: spec.provider,
          mountPaths: spec.mountPaths,
          targets: targetLabels(spec.targets)
        }))
      })
      subscriptions.push(
        handle.client().subscribe(
          watches.map((watch) => watch.glob),
          (event) => {
            logIntegrationEvent('received', {
              projectId,
              eventId: event.id,
              type: event.type,
              path: event.resource.path
            })
            void this.injectEvent(projectId, event, specs).catch((error) => {
              logIntegrationEvent('event delivery failed', {
                projectId,
                eventId: event.id,
                error: toErrorMessage(error)
              })
            })
          },
          {
            coalesce: 'fire-once',
            coalesceMs: Math.max(...watches.map((watch) => watch.coalesceMs), 750)
          }
        )
      )
      const localSubscription = watchLocalMounts(
        handle.localMountWorkspaceId,
        subscribed,
        watches.map((watch) => watch.glob),
        (event) => {
          logIntegrationEvent('received', {
            projectId,
            eventId: event.id,
            type: event.type,
            path: event.resource.path,
            source: 'local-mount'
          })
          void this.injectEvent(projectId, event, specs).catch((error) => {
            logIntegrationEvent('local event delivery failed', {
              projectId,
              eventId: event.id,
              error: toErrorMessage(error)
            })
          })
        },
        Math.max(...watches.map((watch) => watch.coalesceMs), 750)
      )
      if (localSubscription) {
        logIntegrationEvent('watching local mounts', {
          projectId,
          workspaceId: handle.workspaceId,
          localMountWorkspaceId: handle.localMountWorkspaceId,
          localRoots: localSubscription.localRoots
        })
        subscriptions.push(localSubscription)
      }
      this.subscriptions.set(projectId, { subscriptions, signature })
    } catch (error) {
      await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe().catch(() => undefined)))
      throw error
    }
  }

  async close(projectId: string): Promise<void> {
    const subscription = this.subscriptions.get(projectId)
    this.subscriptions.delete(projectId)
    if (!subscription) return
    await Promise.all(subscription.subscriptions.map((entry) => entry.unsubscribe().catch(() => undefined)))
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.subscriptions.keys()).map((projectId) => this.close(projectId)))
  }

  private async injectEvent(projectId: string, event: ChangeEvent, specs: SubscriptionSpec[]): Promise<void> {
    if (!shouldNotifyRelayfileChange(event)) {
      logIntegrationEvent('skipped filtered path', {
        projectId,
        eventId: event.id,
        path: event.resource.path
      })
      return
    }

    const matchedSpecs = specsForEvent(event, specs)
    if (matchedSpecs.length === 0) {
      logIntegrationEvent('skipped unmatched path', {
        projectId,
        eventId: event.id,
        path: event.resource.path,
        mountPaths: specs.flatMap((spec) => spec.mountPaths)
      })
      return
    }

    const duplicateKey = injectionDeduplicationKey(projectId, event, matchedSpecs)
    if (this.wasRecentlyInjected(duplicateKey)) {
      logIntegrationEvent('skipped duplicate path', {
        projectId,
        eventId: event.id,
        path: event.resource.path,
        duplicateKey
      })
      return
    }

    const bridge = await this.bridge()
    let allProjectAgents: string[] | null = null
    const recipients: string[] = []
    const listProjectAgents = async (): Promise<string[]> => {
      allProjectAgents ??= (await bridge.listAgents(projectId))
        .filter((agent) => agent.projectId === undefined || agent.projectId === projectId)
        .map((agent) => agent.name)
      return allProjectAgents
    }

    for (const spec of matchedSpecs) {
      const projectAgents = spec.targets.agents.length > 0
        ? await listProjectAgents()
        : null
      const onlineExplicitAgents = projectAgents
        ? spec.targets.agents.filter((agent) => projectAgents.includes(agent))
        : []
      const explicitTargets = dedupeStrings([...onlineExplicitAgents, ...spec.targets.channels])
      if (explicitTargets.length === 0) {
        recipients.push(...await listProjectAgents())
      } else {
        recipients.push(...explicitTargets)
      }
    }

    const uniqueRecipients = dedupeStrings(recipients)
    logIntegrationEvent('injecting', {
      projectId,
      eventId: event.id,
      path: event.resource.path,
      recipients: uniqueRecipients
    })
    await Promise.all(
      uniqueRecipients.map((recipient) => {
        const input = {
          to: recipient,
          from: 'integration',
          text: formatIntegrationEventMessage(event),
          priority: 0,
          mode: 'steer',
          data: {
            kind: 'integration-event',
            system: true,
            eventId: event.id,
            eventType: event.type,
            occurredAt: event.occurredAt,
            resource: isRecord(event.resource) ? { ...event.resource } : undefined,
            path: event.resource.path
          }
        } as const
        return bridge.sendMessageAndWaitForDelivery
          ? bridge.sendMessageAndWaitForDelivery(projectId, input)
          : bridge.sendMessage(projectId, input)
      })
    )
  }

  private wasRecentlyInjected(key: string): boolean {
    const now = Date.now()
    for (const [entryKey, expiresAt] of this.recentInjections.entries()) {
      if (expiresAt <= now) this.recentInjections.delete(entryKey)
    }
    if (this.recentInjections.has(key)) return true
    this.recentInjections.set(key, now + RECENT_INJECTION_TTL_MS)
    return false
  }

  private async getWorkspaceHandle(): Promise<RelayfileWorkspaceHandle> {
    if (this.deps.getWorkspaceHandle) return this.deps.getWorkspaceHandle()
    const { accountWorkspaceReadyRetryOptions, getAccountWorkspaceId, refreshCloudAuth, resolveCloudAuth } = await import('./auth.ts')
    let auth = await resolveCloudAuth()
    if (!auth) {
      accountIntegrationEventHandle = null
      throw new Error('cloud-auth-required')
    }

    const accountWorkspaceId = await getAccountWorkspaceId(accountWorkspaceReadyRetryOptions())
    if (
      accountIntegrationEventHandle &&
      accountIntegrationEventHandle.apiUrl === auth.apiUrl &&
      accountIntegrationEventHandle.accountKey === auth.accountKey &&
      accountIntegrationEventHandle.accountWorkspaceId === accountWorkspaceId
    ) {
      return accountIntegrationEventHandle.handle
    }

    const joinWorkspace = async () => {
      const tokenProvider = async (): Promise<string | undefined> => {
        const fresh = await resolveCloudAuth()
        return fresh?.accessToken ?? auth?.accessToken
      }
      const setup = new RelayfileSetup({
        cloudApiUrl: auth.apiUrl,
        accessToken: tokenProvider
      })
      return setup.joinWorkspace(accountWorkspaceId, {
        agentName: INTEGRATION_EVENT_AGENT_NAME,
        scopes: INTEGRATION_EVENT_SCOPES
      })
    }

    let joined: Awaited<ReturnType<typeof joinWorkspace>>
    try {
      joined = await joinWorkspace()
    } catch (error) {
      if (!isUnauthorizedError(error)) throw error
      const refreshed = await refreshCloudAuth()
      if (!refreshed) throw error
      auth = refreshed
      joined = await joinWorkspace()
    }
    const relayWorkspaceId = joined.workspaceId
    const workspaceTokenProvider = async (): Promise<string> => {
      await joined.refreshToken()
      return joined.getToken()
    }
    const client = new RelayFileClient({
      baseUrl: joined.info.relayfileUrl,
      token: workspaceTokenProvider
    })
    const handle: RelayfileWorkspaceHandle = {
      workspaceId: relayWorkspaceId,
      localMountWorkspaceId: accountWorkspaceId,
      client: () => createWorkspaceScopedEventClient(client, relayWorkspaceId, workspaceTokenProvider)
    }
    accountIntegrationEventHandle = {
      apiUrl: auth.apiUrl,
      accountKey: auth.accountKey,
      accountWorkspaceId,
      handle
    }
    return handle
  }

  private async bridge(): Promise<BrokerEventBridge> {
    if (this.deps.broker) return this.deps.broker
    const { brokerManager } = await import('./broker')
    return brokerManager as unknown as BrokerEventBridge
  }
}

export const integrationEventBridge = new IntegrationEventBridge()
