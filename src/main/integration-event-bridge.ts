import { createHash } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  RelayFileClient,
  RelayFileSync,
  RelayfileSetup,
  type ChangeEvent,
  type FileReadResponse,
  type FilesystemEvent,
  type RelayFileSyncOptions,
  type Subscription
} from '@relayfile/sdk'
import type { ConnectedIntegration } from './integrations'
// @ts-expect-error Node's strip-types test runner requires the explicit .ts extension.
import { isSlackWritebackCommandRoot, slackWritebackCommandMountPathFor } from './slack-writeback-command-roots.ts'
import type {
  IntegrationEventTelemetryCounters,
  IntegrationEventTelemetrySnapshot
} from '../shared/types/ipc'

const INTEGRATION_EVENT_AGENT_NAME = 'pear-integration-events'
const INTEGRATION_EVENT_SCOPES = ['relayfile:fs:read:/**']
const PROJECT_INTEGRATIONS_LINK_NAME = '.integrations'
const RECENT_INJECTION_TTL_MS = 10_000
const RECENT_LOGICAL_CHANGE_TTL_MS = 10 * 60_000
const SLACK_SELF_ECHO_WRITEBACK_TTL_MS = 15 * 60_000
// Bounded persistent window for Slack record identities: must outlast the
// upstream queue's retry storm (max 5 retries of a batch that can stall for
// ~13 minutes each) so time-separated replays of one logical message are
// still suppressed. Slack dedupe is content-aware when preview data is
// available, so an edit to the same Slack message can still inject.
const SLACK_RECORD_REPLAY_TTL_MS = 60 * 60_000
const REPLAY_SKEW_TOLERANCE_MS = 15 * 60_000
const REMOTE_SUBSCRIPTION_FROM: 'legacy' = 'legacy'
const INTEGRATION_EVENT_LOG_PATH = join(homedir(), '.agentworkforce', 'pear', 'integration-events.log')
const AGGREGATED_WARNING_REPEAT_EVERY = 25
const MAX_AGGREGATED_WARNING_KEYS = 256
const SLACK_LIVE_EVENT_WINDOW_MS = 30 * 60 * 1_000
// DM event watch globs. Canonical 1:1 DM surface is the user-recipient model
// `/slack/users/<U>/messages` (where the adapter materializes message.im once
// D→U mapping lands). `/slack/channels/D*` is retained only as a diagnostic
// alias for raw Slack IM conversation ids the adapter still materializes
// channel-style today. `/slack/dms/*` was vestigial residue — no adapter
// resource or record ever materialized there — so it is intentionally dropped;
// it must not imply mounted/readable DM content.
const SLACK_DM_EVENT_GLOBS = [
  '/slack/channels/D*/**',
  '/slack/users/*/messages/**'
]
const MAX_EVENT_CONTEXT_PREVIEW_BYTES = 32 * 1024
const EVENT_CONTEXT_READ_RETRY_DELAYS_MS = [150, 350, 750]
const MAX_DISPATCH_QUEUE_EVENTS = 50
const MAX_DISPATCH_SUMMARY_GROUPS = 10
const MAX_DISPATCHED_EVENTS_PER_SECOND = 25
const PROJECT_AGENT_RECIPIENT_CACHE_TTL_MS = 2_000
const MAX_BROKER_SENDS_PER_SECOND = 25
const DEFAULT_DELIVERY_INJECTED_CONFIRMATION_TIMEOUT_MS = 5_000
const REMOTE_STREAM_ERROR_POLLING_FALLBACK_THRESHOLD = 5
const REMOTE_STREAM_POLL_INTERVAL_MS = 5_000

type IntegrationEventCounterName =
  | 'eventsReceived'
  | 'eventsInjected'
  | 'eventsCoalesced'
  | 'eventsDropped'
  | 'eventsSelfEchoSuppressed'
  | 'brokerSends'
  | 'brokerSendsDeferred'
type IntegrationEventGaugeName = 'queueDepth' | 'mountCount' | 'brokerSendQueueDepth'

type WatchRegistration = {
  glob: string
  coalesceMs: number
}

type DeliveryTargets = {
  agents: string[]
  channels: string[]
}

type LinearScopePredicates = {
  teams: string[]
  projects: string[]
  labels: string[]
  assignees: string[]
}

type SubscriptionSpec = {
  integrationId: string
  provider: string
  mountPaths: string[]
  localMountRoots: LocalMountRoot[]
  eventPathGlobs: string[]
  watches: WatchRegistration[]
  targets: DeliveryTargets
  allowHistoricalReplay: boolean
  linearPredicates?: LinearScopePredicates
}

type LocalMountRoot = {
  localRoot: string
  remoteRoot: string
}

type ProjectSubscription = {
  subscriptions: Subscription[]
  signature: string
}

type EventContextPreview = {
  path: string
  kind: 'text' | 'binary' | 'too-large'
  content: string
  size: number
  contentType?: string
}

type EventContextPreviewMetadata = Omit<EventContextPreview, 'content'>

type SlackLogicalInjectionState = {
  expiresAt: number
  committedBlind: boolean
  committedContentHashes: Set<string>
  provisionalBlind: boolean
  provisionalContentHashes: Set<string>
}

type RecentInjectionState = {
  expiresAt: number
  provisional: boolean
}

type DeliveryDedupeClaim = {
  key: string
  isSlackLogicalKey: boolean
  ttlMs: number
  contentHash?: string
}

type DeliveryDedupeClaimOutcome = 'committed' | 'released'

type InFlightDedupeClaim = {
  promise: Promise<DeliveryDedupeClaimOutcome>
  settle: (outcome: DeliveryDedupeClaimOutcome) => void
}

type DispatchItem = {
  event: ChangeEvent
  specs: SubscriptionSpec[]
}

type DispatchSummary = {
  count: number
  provider: string
  groupPath: string
  label: string
  specs: SubscriptionSpec[]
  latestEvent: ChangeEvent
}

type BrokerMessageInput = Parameters<BrokerEventBridge['sendMessage']>[1]

type ProjectAgentRecipientCacheEntry = {
  agents: string[]
  expiresAt: number
  pending?: Promise<string[]>
}

type CachedSpecTargets = {
  agents: string[]
  channels: string[]
}

type NotificationTargetCacheEntry = {
  specs: CachedSpecTargets[]
  needsProjectAgents: boolean
}

type LocalMountSubscription = Subscription & {
  localRoots: string[]
}

type SlackOutboundWritebackCommand = {
  localPath: string
  remotePath: string
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
  sendMessageAndWaitForInjected?: (
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
  ) => Promise<{ eventId: string; targets: string[] }>
}

type RelayfileEventClient = {
  subscribe(
    globs: string[],
    onChange: (event: ChangeEvent) => void,
    options?: {
      coalesce?: 'none' | 'fire-once'
      coalesceMs?: number
      pathScope?: string[]
      from?: 'now' | 'legacy'
      onCoalesced?: () => void
      onQueueDepth?: (depth: number) => void
    }
  ): Subscription
  readFile?(workspaceId: string, path: string): Promise<FileReadResponse>
}

type RelayfileWorkspaceHandle = {
  workspaceId: string
  localMountWorkspaceId: string
  client(): RelayfileEventClient
}

type TokenProvider = () => Promise<string | undefined>
type RelayFileSyncFactory = (options: RelayFileSyncOptions) => RelayFileSync

type IntegrationRelayFileSyncOptionsInput = Omit<RelayFileSyncOptions, 'token'> & {
  tokenProvider: TokenProvider
}

type IntegrationEventBridgeDeps = {
  broker?: BrokerEventBridge
  getWorkspaceHandle?: () => Promise<RelayfileWorkspaceHandle>
}

type EventDeliverySource = 'remote' | 'local-mount'

type EventInjectionOptions = {
  source: EventDeliverySource
  subscriptionStartedAtMs: number
  localMountWorkspaceId: string
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
const integrationEventTelemetry = new Map<string, IntegrationEventTelemetryCounters>()
const aggregatedWarnings = new Map<string, { count: number; lastLoggedCount: number }>()

function emptyIntegrationEventCounters(): IntegrationEventTelemetryCounters {
  return {
    eventsReceived: 0,
    eventsInjected: 0,
    eventsCoalesced: 0,
    eventsDropped: 0,
    eventsSelfEchoSuppressed: 0,
    brokerSends: 0,
    brokerSendsDeferred: 0,
    queueDepth: 0,
    mountCount: 0,
    brokerSendQueueDepth: 0
  }
}

function countersForProject(projectId: string): IntegrationEventTelemetryCounters {
  let counters = integrationEventTelemetry.get(projectId)
  if (!counters) {
    counters = emptyIntegrationEventCounters()
    integrationEventTelemetry.set(projectId, counters)
  }
  return counters
}

function incrementIntegrationEventCounter(projectId: string, counter: IntegrationEventCounterName, amount = 1): void {
  countersForProject(projectId)[counter] += amount
}

function setIntegrationEventGauge(projectId: string, gauge: IntegrationEventGaugeName, value: number): void {
  countersForProject(projectId)[gauge] = Math.max(0, Math.floor(value))
}

export function getIntegrationEventTelemetrySnapshot(): IntegrationEventTelemetrySnapshot {
  const totals = emptyIntegrationEventCounters()
  const projects: Record<string, IntegrationEventTelemetryCounters> = {}
  for (const [projectId, counters] of Array.from(integrationEventTelemetry.entries())) {
    const copy = { ...counters }
    projects[projectId] = copy
    for (const counter of Object.keys(totals) as Array<keyof IntegrationEventTelemetryCounters>) {
      totals[counter] += copy[counter]
    }
  }
  return { totals, projects }
}

export function resetIntegrationEventTelemetryForTests(): void {
  integrationEventTelemetry.clear()
  aggregatedWarnings.clear()
}

export function integrationRelayFileSyncOptions(
  input: IntegrationRelayFileSyncOptionsInput
): RelayFileSyncOptions {
  const { tokenProvider, ...options } = input
  return {
    ...options,
    token: tokenProvider
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    return message || error.name || error.constructor.name || 'Error'
  }
  if (typeof error === 'string') {
    const message = error.trim()
    return message || 'empty string error'
  }
  if (isRecord(error)) {
    const record = error as Record<string, unknown>
    const message = record.message
    if (typeof message === 'string' && message.trim()) return message.trim()
    const reason = record.reason
    if (typeof reason === 'string' && reason.trim()) return reason.trim()
    const parts = [
      typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null,
      typeof record.type === 'string' && record.type.trim() ? `type=${record.type.trim()}` : null,
      typeof record.code === 'string' && record.code.trim() ? `code=${record.code.trim()}` : typeof record.code === 'number' ? `code=${record.code}` : null,
      typeof record.status === 'string' && record.status.trim() ? `status=${record.status.trim()}` : typeof record.status === 'number' ? `status=${record.status}` : null,
      typeof record.statusCode === 'string' && record.statusCode.trim() ? `statusCode=${record.statusCode.trim()}` : typeof record.statusCode === 'number' ? `statusCode=${record.statusCode}` : null,
      typeof record.httpStatus === 'string' && record.httpStatus.trim() ? `httpStatus=${record.httpStatus.trim()}` : typeof record.httpStatus === 'number' ? `httpStatus=${record.httpStatus}` : null
    ].filter((entry): entry is string => entry !== null)
    if (parts.length > 0) return parts.join(' ')
    const constructorName = record.constructor?.name
    if (constructorName && constructorName !== 'Object') return constructorName

    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch {
      // Fall through to String(error).
    }
  }
  const text = String(error).trim()
  return text && text !== '[object Object]' ? text : 'unknown error'
}

function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { httpStatus?: unknown; status?: unknown }).httpStatus ??
    (error as { httpStatus?: unknown; status?: unknown }).status
  if (status === 401 || status === 403) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /\b(401|403|unauthor|forbidden)\b/i.test(message)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deliveryInjectedConfirmationTimeoutMs(): number {
  const value = Number.parseInt(process.env.PEAR_INTEGRATION_EVENT_INJECTED_CONFIRMATION_TIMEOUT_MS || '', 10)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DELIVERY_INJECTED_CONFIRMATION_TIMEOUT_MS
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function scopeStringList(scope: Record<string, unknown>, key: string): string[] {
  return stringList(scope[key])
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort()
}

function dedupeStringsInOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    deduped.push(trimmed)
  }
  return deduped
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function toRelayfileProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  return normalized === 'gmail' ? 'google-mail' : normalized
}

function isSlackProvider(provider: string): boolean {
  const normalized = toRelayfileProvider(provider)
  return normalized === 'slack' || normalized.startsWith('slack-')
}

function isLinearProvider(provider: string): boolean {
  const normalized = toRelayfileProvider(provider)
  return normalized === 'linear' || normalized.startsWith('linear-')
}

function linearScopePredicates(scope: Record<string, unknown>): LinearScopePredicates {
  return {
    teams: scopeStringList(scope, 'teams'),
    projects: scopeStringList(scope, 'projects'),
    labels: scopeStringList(scope, 'labels'),
    assignees: scopeStringList(scope, 'assignees')
  }
}

function hasLinearPredicates(predicates: LinearScopePredicates): boolean {
  return predicates.teams.length > 0 ||
    predicates.projects.length > 0 ||
    predicates.labels.length > 0 ||
    predicates.assignees.length > 0
}

function scopeBooleanDefault(scope: Record<string, unknown>, keys: string[], defaultValue: boolean): boolean {
  for (const key of keys) {
    const value = scope[key]
    if (typeof value === 'boolean') return value
  }
  return defaultValue
}

export function slackListenDms(integration: ConnectedIntegration): boolean {
  if (!isSlackProvider(integration.provider)) return false
  return scopeBooleanDefault(integration.scope, ['listenDms', 'listenDirectMessages', 'directMessages'], false)
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
  const mountPaths = integration.mountPaths.flatMap((path) => {
    const discovery = path.match(/^\/discovery(?:\/.*)?$/)
    if (discovery) return [path]
    const prefixed = path.match(/^\/integrations\/[^/]+(\/.*)?$/)
    if (prefixed) {
      const normalized = `/${provider}${prefixed[1] ?? ''}`
      return [normalized, ...slackCanonicalChannelAliases(provider, normalized)]
    }
    const rootLevel = path.match(/^\/[^/]+(\/.*)?$/)
    if (rootLevel) {
      const normalized = `/${provider}${rootLevel[1] ?? ''}`
      return [normalized, ...slackCanonicalChannelAliases(provider, normalized)]
    }
    return [path, ...slackCanonicalChannelAliases(provider, path)]
  })
  return dedupeStrings(mountPaths)
}

function slackCanonicalChannelAliases(provider: string, path: string): string[] {
  if (!isSlackProvider(provider)) return []
  const match = path.match(/^\/slack\/channels\/([^/]+)__(?:[^/]+)(\/.*)?$/u)
  const channelId = match?.[1]?.trim()
  if (!channelId) return []
  return [`/slack/channels/${channelId}${match?.[2] ?? ''}`]
}

function watchGlobForPath(path: string): string {
  const root = path.trim().replace(/\/+$/u, '')
  return root.endsWith('/**') ? root : `${root || '/'}/**`
}

export function eventPathGlobsForIntegration(integration: ConnectedIntegration): string[] {
  return dedupeStrings([
    ...canonicalMountPaths(integration).map(watchGlobForPath),
    ...(slackListenDms(integration) ? SLACK_DM_EVENT_GLOBS : [])
  ])
}

function watchRegistrationsFor(integrations: ConnectedIntegration[]): WatchRegistration[] {
  return dedupeStrings(integrations.flatMap(eventPathGlobsForIntegration))
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

export function subscriptionSpecsFor(
  integrations: ConnectedIntegration[],
  localMountWorkspaceId?: string
): SubscriptionSpec[] {
  return integrations.map((integration) => {
    const mountPaths = canonicalMountPaths(integration)
    const eventPathGlobs = eventPathGlobsForIntegration(integration)
    return {
      integrationId: integration.integrationId,
      provider: integration.provider,
      mountPaths,
      localMountRoots: localMountWorkspaceId
        ? concreteLocalMountRootsForIntegration(localMountWorkspaceId, integration, mountPaths)
        : [],
      eventPathGlobs,
      watches: eventPathGlobs.map((glob) => ({
        glob,
        coalesceMs: 750
      })),
      targets: deliveryTargetsFor([integration]),
      allowHistoricalReplay: integration.downloadHistoricalData === true,
      ...(isLinearProvider(integration.provider) && hasLinearPredicates(linearScopePredicates(integration.scope))
        ? { linearPredicates: linearScopePredicates(integration.scope) }
        : {})
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

function globSegmentMatches(pattern: string, segment: string | undefined): boolean {
  if (segment === undefined) return false
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === segment
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`, 'u').test(segment)
}

function globMatchesPath(glob: string, path: string): boolean {
  const pattern = normalizeChangePath(glob)
  const target = normalizeChangePath(path)
  if (pattern.at(-1) === '**') {
    const prefix = pattern.slice(0, -1)
    return target.length >= prefix.length &&
      prefix.every((segment, index) => globSegmentMatches(segment, target[index]))
  }
  return pattern.length === target.length &&
    pattern.every((segment, index) => globSegmentMatches(segment, target[index]))
}

export function relayfileSdkPathFiltersFor(globs: string[]): string[] {
  return dedupeStrings(globs.map((glob) => {
    const segments = normalizeChangePath(glob)
    if (segments.length === 0) return '/'
    const sdkSegments = segments.map((segment, index) => {
      if (segment === '*') return segment
      if (segment === '**') return index === segments.length - 1 ? segment : '*'
      return segment.includes('*') ? '*' : segment
    })
    return `/${sdkSegments.join('/')}`
  }))
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
      id: resourceId,
      origin: event.origin,
      revision: event.revision
    },
    summary,
    digest: event.revision ? `revision:${event.revision}` : undefined,
    origin: event.origin,
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

export function createWorkspaceScopedEventClient(
  client: RelayFileClient,
  workspaceId: string,
  tokenProvider: TokenProvider,
  baseUrl?: string,
  syncFactory: RelayFileSyncFactory = (options) => new RelayFileSync(options)
): RelayfileEventClient {
  return {
    subscribe(globs, onChange, options) {
      let active = true
      let sync: RelayFileSync | null = null
      let polling = false
      let pollingTimer: ReturnType<typeof setTimeout> | null = null
      let pollingInFlight = false
      let consecutiveStreamErrors = 0
      let lastEventCursor: string | undefined
      const polledEventIds = new Set<string>()
      const pendingByPath = new Map<string, ReturnType<typeof setTimeout>>()
      const coalesceMs = Math.max(0, Math.floor(options?.coalesceMs ?? 750))
      const shouldCoalesce = (options?.coalesce ?? 'fire-once') !== 'none'
      const pathScope = options?.pathScope?.length && !sameStringList(options.pathScope, globs)
        ? options.pathScope
        : null
      const relayfilePathFilters = relayfileSdkPathFiltersFor(
        options?.pathScope?.length ? options.pathScope : globs
      )

      const dispatch = (event: FilesystemEvent): void => {
        if (!active) return
        const changeEvent = filesystemEventToChangeEvent(client, workspaceId, event)
        Promise.resolve(onChange(changeEvent)).catch((error) => {
          const errorMessage = toErrorMessage(error)
          warnIntegrationEventAggregated(
            `change handler failed:${workspaceId}`,
            'change handler failed',
            {
              workspaceId,
              eventId: event.eventId,
              path: event.path,
              error: errorMessage
            }
          )
        })
      }

      const handleEvent = (event: FilesystemEvent): void => {
        if (!active || !shouldPublishFilesystemEvent(event)) return
        consecutiveStreamErrors = 0
        if (event.eventId) {
          lastEventCursor = event.eventId
          polledEventIds.add(event.eventId)
        }
        const path = event.path.startsWith('/') ? event.path : `/${event.path}`
        if (!globs.some((glob) => globMatchesPath(glob, path))) return
        if (pathScope && !pathScope.some((glob) => globMatchesPath(glob, path))) return

        if (!shouldCoalesce) {
          dispatch({ ...event, path })
          return
        }

        const existing = pendingByPath.get(path)
        if (existing) {
          clearTimeout(existing)
          options?.onCoalesced?.()
        }
        pendingByPath.set(path, setTimeout(() => {
          pendingByPath.delete(path)
          options?.onQueueDepth?.(pendingByPath.size)
          dispatch({ ...event, path })
        }, coalesceMs))
        options?.onQueueDepth?.(pendingByPath.size)
      }

      const pollOnce = async (): Promise<void> => {
        if (!active || pollingInFlight) return
        pollingInFlight = true
        try {
          let cursor = lastEventCursor
          for (;;) {
            const response = await client.getEvents(workspaceId, {
              cursor,
              limit: 1000
            })
            const events = response.events ?? []
            for (const event of events) {
              if (event.eventId && polledEventIds.has(event.eventId)) {
                lastEventCursor = event.eventId
                continue
              }
              handleEvent(event)
            }
            const nextCursor = response.nextCursor || null
            if (events.length > 0) {
              lastEventCursor = events[events.length - 1]?.eventId ?? lastEventCursor
            }
            if (nextCursor) lastEventCursor = nextCursor
            if (!nextCursor || nextCursor === cursor) break
            cursor = nextCursor
          }
          consecutiveStreamErrors = 0
        } catch (error) {
          const errorMessage = toErrorMessage(error)
          warnIntegrationEventAggregated(
            `remote stream polling error:${workspaceId}`,
            'remote stream polling error',
            {
              workspaceId,
              error: errorMessage
            }
          )
        } finally {
          pollingInFlight = false
        }
      }

      const schedulePolling = (delayMs = REMOTE_STREAM_POLL_INTERVAL_MS): void => {
        if (!active || !polling || pollingTimer) return
        pollingTimer = setTimeout(() => {
          pollingTimer = null
          void pollOnce().finally(() => schedulePolling())
        }, delayMs)
      }

      const startPollingFallback = (reason: string): void => {
        if (!active || polling) return
        polling = true
        warnIntegrationEventAggregated(
          `remote stream forced polling fallback:${workspaceId}`,
          'remote stream forced polling fallback',
          {
            workspaceId,
            reason,
            cursor: lastEventCursor
          }
        )
        void sync?.stop().catch(() => undefined)
        sync = null
        void pollOnce().finally(() => schedulePolling())
      }

      void tokenProvider()
        .then((token) => {
          if (!active) return
          const tokenWorkspaceId = workspaceIdFromJwt(token)
          if (tokenWorkspaceId && tokenWorkspaceId !== workspaceId) {
            warnIntegrationEventAggregated(
              `skipping remote stream with mismatched workspace JWT:${workspaceId}`,
              'skipping remote stream with mismatched workspace JWT',
              {
                workspaceId,
                tokenWorkspaceId
              }
            )
            return
          }
          logIntegrationEvent('remote stream starting', {
            workspaceId,
            globs,
            pathScope: options?.pathScope,
            relayfilePathFilters,
            from: options?.from ?? 'now',
            transport: baseUrl ? 'websocket' : 'polling'
          })
          sync = syncFactory(integrationRelayFileSyncOptions({
            client,
            workspaceId,
            baseUrl,
            tokenProvider,
            from: options?.from ?? 'now',
            paths: relayfilePathFilters,
            onPollingFallback: (info) => {
              warnIntegrationEventAggregated(
                `remote stream polling fallback:${workspaceId}`,
                'remote stream polling fallback',
                {
                  workspaceId,
                  reason: info.reason
                }
              )
            }
          }))
          sync.on('event', handleEvent)
          sync.on('state', (state) => {
            if (state === 'open') consecutiveStreamErrors = 0
            logIntegrationEvent('remote stream state', {
              workspaceId,
              state
            })
          })
          sync.on('error', (error) => {
            consecutiveStreamErrors += 1
            const errorMessage = toErrorMessage(error)
            warnIntegrationEventAggregated(
              `remote stream error:${workspaceId}`,
              'remote stream error',
              {
                workspaceId,
                error: errorMessage
              }
            )
            if (consecutiveStreamErrors >= REMOTE_STREAM_ERROR_POLLING_FALLBACK_THRESHOLD) {
              startPollingFallback('repeated-stream-errors')
            }
          })
          sync.start()
        })
        .catch((error) => {
          const errorMessage = toErrorMessage(error)
          warnIntegrationEventAggregated(
            `remote stream token check failed:${workspaceId}`,
            'remote stream token check failed',
            {
              workspaceId,
              error: errorMessage
            }
          )
        })

      return {
        async unsubscribe() {
          active = false
          if (pollingTimer) clearTimeout(pollingTimer)
          pollingTimer = null
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
    canonicalMountPaths(integration).some((mountPath) => isBoundedLocalCommandRoot(mountPath))
}

function isBoundedLocalCommandRoot(remoteRoot: string): boolean {
  return isSlackWritebackCommandRoot(remoteRoot)
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

function concreteLocalMountRootsForIntegration(
  workspaceId: string,
  integration: ConnectedIntegration,
  mountPaths: string[]
): LocalMountRoot[] {
  const roots = new Map<string, LocalMountRoot>()
  const addRoot = (localRoot: string, remoteRoot: string): void => {
    if (remoteRoot.includes('*')) return
    if (!mountPaths.some((mountPath) =>
      pathIsInsideMount(remoteRoot, mountPath) || pathIsInsideMount(mountPath, remoteRoot)
    )) {
      return
    }
    const normalizedLocalRoot = resolve(localRoot)
    roots.set(`${remoteRoot}:${normalizedLocalRoot}`, {
      localRoot: normalizedLocalRoot,
      remoteRoot
    })
  }

  for (const localRoot of integration.localMountPaths || []) {
    const remoteRoot = remoteRootForLocalMountPath(workspaceId, localRoot)
    if (remoteRoot) addRoot(localRoot, remoteRoot)
  }

  return Array.from(roots.values())
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

function staticRemoteRootBeforeWildcard(remoteRoot: string): string | null {
  const segments = pathSegments(remoteRoot)
  const wildcardIndex = segments.findIndex((segment) => segment.includes('*'))
  if (wildcardIndex <= 0) return null
  return `/${segments.slice(0, wildcardIndex).join('/')}`
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
    const candidates = [
      ...(remoteRoot.includes('*') ? [] : [remoteRoot]),
      parentRemoteRootForDynamicChildren(remoteRoot),
      staticRemoteRootBeforeWildcard(remoteRoot)
    ].filter((entry): entry is string => entry !== null && !entry.includes('*'))
    for (const candidate of dedupeStrings(candidates)) {
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

function normalizeRelayfilePath(path: string): string {
  const segments = pathSegments(path)
  return segments.length > 0 ? `/${segments.join('/')}` : '/'
}

function localPathForRemotePathInsideRoot(localRoot: string, remoteRoot: string, remotePath: string): string {
  const tail = pathTailAfterMount(remotePath, remoteRoot)
  return tail === '/' ? resolve(localRoot) : join(resolve(localRoot), ...pathSegments(tail))
}

function localPathIsInsideRoot(localRoot: string, localPath: string): boolean {
  const relativePath = relative(resolve(localRoot), resolve(localPath))
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export function localWatchEventPathsForFilename(
  localRoot: string,
  remoteRoot: string,
  filename: string
): { localPath: string; remotePath: string } | null {
  const trimmed = filename.trim()
  if (!trimmed) return null

  const asRemotePath = normalizeRelayfilePath(trimmed)
  if (pathIsInsideMount(asRemotePath, remoteRoot)) {
    return {
      localPath: localPathForRemotePathInsideRoot(localRoot, remoteRoot, asRemotePath),
      remotePath: asRemotePath
    }
  }

  const localPath = isAbsolute(trimmed) ? resolve(trimmed) : join(localRoot, trimmed)
  const remotePath = remotePathForLocalPath(localRoot, remoteRoot, localPath)
  return remotePath ? { localPath, remotePath } : null
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
    origin: 'system',
    revision: stats ? `${Math.round(stats.mtimeMs)}:${stats.size}` : '',
    timestamp: new Date().toISOString()
  }
}

function watchLocalMounts(
  workspaceId: string,
  integrations: ConnectedIntegration[],
  globs: string[],
  onChange: (event: ChangeEvent) => void,
  coalesceMs: number,
  telemetry?: {
    onCoalesced?: () => void
    onQueueDepth?: (depth: number) => void
  }
): LocalMountSubscription | null {
  const roots = new Map<string, { localRoot: string; remoteRoot: string }>()
  for (const root of localWatchRootsFor(workspaceId, integrations, globs)) {
    roots.set(resolve(root.localRoot), { localRoot: resolve(root.localRoot), remoteRoot: root.remoteRoot })
  }
  if (roots.size === 0) return null

  let active = true
  const watchers: FSWatcher[] = []
  const pendingByPath = new Map<string, ReturnType<typeof setTimeout>>()

  const schedule = (localRoot: string, remoteRoot: string, filename: string, eventType: string): void => {
    const eventPaths = localWatchEventPathsForFilename(localRoot, remoteRoot, filename)
    if (!eventPaths || !shouldNotifyRelayfilePath(eventPaths.remotePath)) return
    const { localPath, remotePath } = eventPaths
    if (!globs.some((glob) => globMatchesPath(glob, remotePath))) return

    const existing = pendingByPath.get(remotePath)
    if (existing) {
      clearTimeout(existing)
      telemetry?.onCoalesced?.()
    }
    pendingByPath.set(remotePath, setTimeout(() => {
      pendingByPath.delete(remotePath)
      telemetry?.onQueueDepth?.(pendingByPath.size)
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
          const errorMessage = toErrorMessage(error)
          warnIntegrationEventAggregated(
            `local mount event failed:${workspaceId}`,
            'local mount event failed',
            {
              workspaceId,
              remotePath,
              error: errorMessage
            }
          )
        })
    }, coalesceMs))
    telemetry?.onQueueDepth?.(pendingByPath.size)
  }

  for (const { localRoot, remoteRoot } of roots.values()) {
    if (!existsSync(localRoot)) continue
    try {
      const watcher = watch(localRoot, { recursive: true }, (eventType, filename) => {
        if (!active || !filename) return
        schedule(localRoot, remoteRoot, String(filename), eventType)
      })
      watcher.on('error', (error) => {
        const errorMessage = toErrorMessage(error)
        warnIntegrationEventAggregated(
          `local mount watcher error:${workspaceId}`,
          'local mount watcher error',
          {
            workspaceId,
            localRoot,
            error: errorMessage
          }
        )
      })
      watchers.push(watcher)
    } catch (error) {
      const errorMessage = toErrorMessage(error)
      warnIntegrationEventAggregated(
        `failed to watch local integration mount:${workspaceId}`,
        'failed to watch local integration mount',
        {
          workspaceId,
          localRoot,
          error: errorMessage
        }
      )
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

function slackWritebackCaptureRootsFor(
  workspaceId: string,
  integrations: ConnectedIntegration[]
): Array<{ localRoot: string; remoteRoot: string }> {
  const roots = new Map<string, { localRoot: string; remoteRoot: string }>()
  for (const integration of integrations) {
    if (!isSlackProvider(integration.provider)) continue
    for (const mountPath of canonicalMountPaths(integration)) {
      const remoteRoot = slackWritebackCommandMountPathFor(integration.provider, mountPath)
      if (!remoteRoot || !isSlackWritebackCommandRoot(remoteRoot)) continue
      const localRoot = resolve(localPathForRemoteRoot(workspaceId, remoteRoot))
      roots.set(localRoot, { localRoot, remoteRoot })
    }
  }
  return Array.from(roots.values())
}

function watchSlackWritebackCommandRoots(
  workspaceId: string,
  integrations: ConnectedIntegration[],
  onSlackOutboundWriteback: (command: SlackOutboundWritebackCommand) => void
): LocalMountSubscription | null {
  const roots = new Map<string, { localRoot: string; remoteRoot: string }>()
  for (const root of slackWritebackCaptureRootsFor(workspaceId, integrations)) {
    roots.set(root.localRoot, root)
  }
  if (roots.size === 0) return null

  let active = true
  const watchers: FSWatcher[] = []

  const capture = (localRoot: string, remoteRoot: string, filename: string): void => {
    const eventPaths = localWatchEventPathsForFilename(localRoot, remoteRoot, filename)
    if (!eventPaths || !isSlackLocalWritebackCommandPath(eventPaths.remotePath)) return
    onSlackOutboundWriteback({
      localPath: eventPaths.localPath,
      remotePath: eventPaths.remotePath
    })
  }

  for (const { localRoot, remoteRoot } of roots.values()) {
    if (!existsSync(localRoot)) continue
    try {
      const watcher = watch(localRoot, { recursive: true }, (_eventType, filename) => {
        if (!active || !filename) return
        capture(localRoot, remoteRoot, String(filename))
      })
      watcher.on('error', (error) => {
        const errorMessage = toErrorMessage(error)
        warnIntegrationEventAggregated(
          `Slack writeback command watcher error:${workspaceId}`,
          'Slack writeback command watcher error',
          {
            workspaceId,
            localRoot,
            error: errorMessage
          }
        )
      })
      watchers.push(watcher)
    } catch (error) {
      const errorMessage = toErrorMessage(error)
      warnIntegrationEventAggregated(
        `failed to watch Slack writeback command root:${workspaceId}`,
        'failed to watch Slack writeback command root',
        {
          workspaceId,
          localRoot,
          error: errorMessage
        }
      )
    }
  }

  if (watchers.length === 0) return null
  return {
    localRoots: Array.from(roots.keys()),
    async unsubscribe() {
      active = false
      await Promise.all(watchers.map((watcher) => new Promise<void>((resolveClose) => {
        watcher.once('close', resolveClose)
        watcher.close()
      })))
    }
  }
}

function specsForEvent(event: ChangeEvent, specs: SubscriptionSpec[]): SubscriptionSpec[] {
  const path = event.resource.path
  return specs.filter((spec) =>
    spec.mountPaths.some((mountPath) => pathIsInsideMount(path, mountPath)) ||
    spec.eventPathGlobs.some((glob) => globMatchesPath(glob, path))
  )
}

function eventOccurredAtMs(event: ChangeEvent): number | null {
  const value = Date.parse(event.occurredAt)
  return Number.isFinite(value) ? value : null
}

function historicalRemoteReplayAllowedSpecs(
  event: ChangeEvent,
  matchedSpecs: SubscriptionSpec[],
  options: EventInjectionOptions
): SubscriptionSpec[] {
  if (options.source !== 'remote') return matchedSpecs
  const occurredAtMs = eventOccurredAtMs(event)
  if (occurredAtMs === null) return matchedSpecs
  if (occurredAtMs >= options.subscriptionStartedAtMs - REPLAY_SKEW_TOLERANCE_MS) return matchedSpecs
  return matchedSpecs.filter((spec) => spec.allowHistoricalReplay)
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
      if (mountPath) return `${spec.integrationId}:${spec.provider}:${pathTailAfterMount(path, mountPath)}`
      const eventGlob = spec.eventPathGlobs.find((glob) => globMatchesPath(glob, path))
      return eventGlob ? `${spec.integrationId}:${spec.provider}:${eventGlob}:${path}` : null
    })
    .filter((entry): entry is string => entry !== null)
  if (scopedKeys.length > 0) return `${projectId}:${event.type}:${dedupeStrings(scopedKeys).join('|')}`
  return `${projectId}:${event.type}:${path}`
}

function eventRecordValue(event: ChangeEvent, key: string): unknown {
  const resource = isRecord(event.resource) ? event.resource : {}
  const summary = isRecord(event.summary) ? event.summary : {}
  return (event as Record<string, unknown>)[key] ?? resource[key] ?? summary[key]
}

function eventOrigin(event: ChangeEvent): string | null {
  const origin = eventRecordValue(event, 'origin')
  return typeof origin === 'string' && origin.trim() ? origin.trim() : null
}

function eventChangeFingerprint(event: ChangeEvent): string | null {
  // Slack channel records reach us as raw-id and `<id>__<name>` slug copies,
  // and queue retries rewrite the same record with a fresh revision each time
  // (probe #1: evt_143356/143358/143393/143401 all carried distinct
  // revisions for one logical message). Logical path identity must therefore
  // take precedence over per-file revisions, which can never match across
  // copies or replays.
  const slackFingerprint = slackLogicalChangeFingerprint(event)
  if (slackFingerprint) return slackFingerprint
  const digest = eventRecordValue(event, 'digest')
  const revision = eventRecordValue(event, 'revision')
  const contentHash = eventRecordValue(event, 'contentHash')
  const fingerprint = [digest, revision, contentHash]
    .find((value) => typeof value === 'string' && value.trim().length > 0)
  return typeof fingerprint === 'string' ? fingerprint.trim() : null
}

function eventProvider(event: ChangeEvent): string {
  const provider = eventRecordValue(event, 'provider')
  if (typeof provider === 'string' && provider.trim()) return provider.trim().toLowerCase()
  return pathSegments(event.resource.path)[0]?.toLowerCase() || 'integration'
}

function slackChannelLabel(channelSegment: string): string {
  const [, label] = channelSegment.split(/__(.+)/u)
  return label ? `#${label}` : channelSegment
}

function canonicalSlackChannelSegment(channelSegment: string): string {
  return channelSegment.split('__', 1)[0] || channelSegment
}

function dispatchCoalescingKey(event: ChangeEvent): string {
  const provider = eventProvider(event)
  const segments = pathSegments(event.resource.path)
  if (provider === 'slack') {
    const channelIndex = segments.indexOf('channels')
    const messageIndex = segments.indexOf('messages')
    const threadIndex = segments.indexOf('threads')
    const replyIndex = segments.indexOf('replies')
    if (channelIndex >= 0 && segments[channelIndex + 1]) {
      const channel = canonicalSlackChannelSegment(segments[channelIndex + 1])
      if (messageIndex >= 0 && segments[messageIndex + 1]) {
        return `${provider}:channel:${channel}:message:${segments[messageIndex + 1]}`
      }
      if (threadIndex >= 0 && segments[threadIndex + 1]) {
        const thread = segments[threadIndex + 1]
        if (replyIndex >= 0 && segments[replyIndex + 1]) {
          return `${provider}:channel:${channel}:thread:${thread}:reply:${segments[replyIndex + 1]}`
        }
        return `${provider}:channel:${channel}:thread:${thread}`
      }
      return `${provider}:channel:${channel}:${segments.slice(channelIndex + 2).join('/')}`
    }
  }
  return `${provider}:${normalizeRelayfilePath(event.resource.path)}`
}

function slackLogicalChangeFingerprint(event: ChangeEvent): string | null {
  if (eventProvider(event) !== 'slack') return null
  const segments = pathSegments(event.resource.path)
  const channelIndex = segments.indexOf('channels')
  const dmIndex = segments.indexOf('dms')
  const userIndex = segments.indexOf('users')
  const messageIndex = segments.indexOf('messages')
  const threadIndex = segments.indexOf('threads')
  const replyIndex = segments.indexOf('replies')

  const scopeIndex = channelIndex >= 0 ? channelIndex : dmIndex >= 0 ? dmIndex : userIndex
  if (scopeIndex < 0 || !segments[scopeIndex + 1]) return null

  const scopeKind = segments[scopeIndex]
  const scopeValue = scopeKind === 'channels'
    ? canonicalSlackChannelSegment(segments[scopeIndex + 1])
    : segments[scopeIndex + 1]

  if (messageIndex >= 0 && segments[messageIndex + 1]) {
    const suffix = segments.slice(messageIndex + 2).join('/')
    return `slack:${scopeKind}:${scopeValue}:message:${segments[messageIndex + 1]}:${suffix}`
  }

  if (threadIndex >= 0 && segments[threadIndex + 1]) {
    const thread = segments[threadIndex + 1]
    if (replyIndex >= 0 && segments[replyIndex + 1]) {
      const suffix = segments.slice(replyIndex + 2).join('/')
      return `slack:${scopeKind}:${scopeValue}:thread:${thread}:reply:${segments[replyIndex + 1]}:${suffix}`
    }
    // The thread ROOT (no reply segment) is the same logical Slack message as
    // the channel's top-level `messages/<thread>/...` record (thread_ts ==
    // parent ts). A thread parent therefore materializes under BOTH trees;
    // collapse the root to the message identity so the dual materialization
    // dedupes to a single injection instead of one per tree.
    const suffix = segments.slice(threadIndex + 2).join('/')
    return `slack:${scopeKind}:${scopeValue}:message:${thread}:${suffix}`
  }

  return null
}

function stableContentFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function normalizedSlackOutboundText(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/gu, ' ')
  return normalized ? normalized : null
}

function slackOutboundTextHash(text: string | undefined): string | null {
  const normalized = normalizedSlackOutboundText(text)
  return normalized ? stableContentFingerprint(normalized) : null
}

function slackPathScopeKey(path: string): string | null {
  const segments = pathSegments(path)
  const channelIndex = segments.indexOf('channels')
  const dmIndex = segments.indexOf('dms')
  const userIndex = segments.indexOf('users')
  const scopeIndex = channelIndex >= 0 ? channelIndex : dmIndex >= 0 ? dmIndex : userIndex
  if (scopeIndex < 0 || !segments[scopeIndex + 1]) return null

  const scopeKind = segments[scopeIndex]
  const scopeValue = scopeKind === 'channels'
    ? canonicalSlackChannelSegment(segments[scopeIndex + 1])
    : segments[scopeIndex + 1]
  return `${scopeKind}:${scopeValue}`
}

function slackOutboundCorrelationKey(path: string, text: string | undefined): string | null {
  const scopeKey = slackPathScopeKey(path)
  const textHash = slackOutboundTextHash(text)
  return scopeKey && textHash ? `${scopeKey}:${textHash}` : null
}

function eventDedupeKeyWithFingerprint(
  duplicateKey: string,
  fingerprint: string | null
): { key: string; ttlMs: number } {
  if (!fingerprint) {
    return {
      key: duplicateKey,
      ttlMs: RECENT_INJECTION_TTL_MS
    }
  }

  if (fingerprint.startsWith('slack:')) {
    return {
      key: `${duplicateKey}:change:${fingerprint}`,
      ttlMs: SLACK_RECORD_REPLAY_TTL_MS
    }
  }

  return {
    key: `${duplicateKey}:change:${fingerprint}`,
    ttlMs: RECENT_LOGICAL_CHANGE_TTL_MS
  }
}

function dispatchSummaryForEvent(event: ChangeEvent, specs: SubscriptionSpec[]): DispatchSummary {
  const provider = eventProvider(event)
  const segments = pathSegments(event.resource.path)
  if (provider === 'slack') {
    const channelIndex = segments.indexOf('channels')
    if (channelIndex >= 0 && segments[channelIndex + 1]) {
      const channel = segments[channelIndex + 1]
      return {
        count: 1,
        provider,
        groupPath: `/${segments.slice(0, channelIndex + 2).join('/')}`,
        label: slackChannelLabel(channel),
        specs,
        latestEvent: event
      }
    }
  }

  const groupSegments = segments.length > 1 ? segments.slice(0, -1) : segments
  const groupPath = groupSegments.length > 0 ? `/${groupSegments.join('/')}` : normalizeRelayfilePath(event.resource.path)
  return {
    count: 1,
    provider,
    groupPath,
    label: groupPath,
    specs,
    latestEvent: event
  }
}

function dispatchSummaryKey(summary: DispatchSummary): string {
  return `${summary.provider}:${summary.groupPath}`
}

function notificationTargetCacheKey(matchedSpecs: SubscriptionSpec[]): string {
  return matchedSpecs.map((spec) => JSON.stringify({
    integrationId: spec.integrationId,
    provider: spec.provider,
    agents: spec.targets.agents,
    channels: spec.targets.channels
  })).join('|')
}

function compactedSummaryTitle(summary: DispatchSummary): string {
  const providerLabel = summary.provider.charAt(0).toUpperCase() + summary.provider.slice(1)
  if (summary.provider === 'slack') {
    return `${summary.count} Slack messages changed in ${summary.label}`
  }
  return `${summary.count} ${providerLabel} records changed under ${summary.label}`
}

function dispatchSummaryEvent(projectId: string, summary: DispatchSummary): ChangeEvent {
  const occurredAt = new Date().toISOString()
  const title = compactedSummaryTitle(summary)
  return {
    id: `summary:${projectId}:${summary.provider}:${summary.groupPath}:${Date.now()}`,
    workspace: summary.latestEvent.workspace,
    type: 'relayfile.changed.summary',
    occurredAt,
    resource: {
      path: summary.groupPath,
      provider: summary.provider,
      kind: 'summary',
      id: summary.groupPath
    },
    summary: {
      title,
      compactedIntegrationEvents: summary.count,
      latestEventId: summary.latestEvent.id,
      latestEventPath: summary.latestEvent.resource.path
    },
    digest: `summary:${summary.count}:${summary.latestEvent.id}`,
    expand: async () => ({
      level: 'summary',
      path: summary.groupPath,
      summary: {
        title
      }
    })
  } as ChangeEvent
}

function logIntegrationEvent(message: string, metadata: Record<string, unknown>): void {
  if (!isIntegrationEventDebugEnabled()) return
  console.debug(`[integration-events] ${message}`, metadata)
  if (isTestProcess()) return
  void appendIntegrationEventLog(message, metadata)
}

function warnIntegrationEventAggregated(key: string, message: string, metadata: Record<string, unknown>): void {
  if (!aggregatedWarnings.has(key) && aggregatedWarnings.size >= MAX_AGGREGATED_WARNING_KEYS) {
    const oldestKey = aggregatedWarnings.keys().next().value
    if (typeof oldestKey === 'string') aggregatedWarnings.delete(oldestKey)
  }
  const entry = aggregatedWarnings.get(key) || { count: 0, lastLoggedCount: 0 }
  entry.count += 1
  const shouldLog = entry.count === 1 || entry.count - entry.lastLoggedCount >= AGGREGATED_WARNING_REPEAT_EVERY
  if (shouldLog) {
    const suppressedSinceLastLog = Math.max(0, entry.count - entry.lastLoggedCount - 1)
    console.warn(`[integration-events] ${message}`, {
      ...metadata,
      occurrences: entry.count,
      suppressedSinceLastLog
    })
    entry.lastLoggedCount = entry.count
  }
  aggregatedWarnings.set(key, entry)
  logIntegrationEvent(message, {
    ...metadata,
    occurrences: entry.count
  })
}

function isIntegrationEventDebugEnabled(): boolean {
  return process.env.PEAR_INTEGRATION_EVENTS_DEBUG === '1' ||
    process.env.PEAR_INTEGRATION_EVENTS_DEBUG === 'true'
}

function isTestProcess(): boolean {
  return process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    // node:test children carry NODE_TEST_CONTEXT; `--test` itself is consumed
    // by the node CLI and never reaches argv/execArgv in the test process.
    process.env.NODE_TEST_CONTEXT !== undefined ||
    process.execArgv.includes('--test') ||
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

function integrationEventMetadata(event: ChangeEvent): Record<string, unknown> {
  const summary = isRecord(event.summary) ? event.summary : {}
  const resource = isRecord(event.resource) ? event.resource : {}
  const actor = isRecord(summary.actor)
    ? eventSummaryValue(summary.actor.displayName) || eventSummaryValue(summary.actor.id)
    : undefined
  return {
    provider: eventSummaryValue(resource.provider),
    resourcePath: eventSummaryValue(resource.path),
    resourceId: eventSummaryValue(resource.id),
    title: eventSummaryValue(summary.title),
    status: eventSummaryValue(summary.status),
    actor
  }
}

function eventContextPreviewFromFile(file: FileReadResponse): EventContextPreview {
  const rawContent = file.content || ''
  const buffer = file.encoding === 'base64'
    ? Buffer.from(rawContent, 'base64')
    : Buffer.from(rawContent, 'utf8')
  return eventContextPreviewFromBuffer(file.path, buffer, file.contentType)
}

function eventContextPreviewFromBuffer(path: string, buffer: Buffer, contentType?: string): EventContextPreview {
  const size = buffer.byteLength

  // The current Relayfile SDK readFile call returns the full file; this cap only
  // bounds what Pear injects into agent context after the targeted read.
  if (size > MAX_EVENT_CONTEXT_PREVIEW_BYTES) {
    return {
      path,
      kind: 'too-large',
      content: '',
      size,
      contentType
    }
  }

  if (buffer.includes(0)) {
    return {
      path,
      kind: 'binary',
      content: '',
      size,
      contentType
    }
  }

  return {
    path,
    kind: 'text',
    content: buffer.toString('utf8'),
    size,
    contentType
  }
}

function eventContextPreviewFromData(path: string, data: unknown): EventContextPreview | undefined {
  if (data === undefined || data === null) return undefined
  if (isSparseRelayfilePointerData(path, data)) return undefined
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return eventContextPreviewFromBuffer(path, Buffer.from(content, 'utf8'), 'application/json')
}

function parseJsonPreview(preview: EventContextPreview | undefined): Record<string, unknown> | null {
  if (!preview || preview.kind !== 'text') return null
  try {
    const parsed = JSON.parse(preview.content)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeLinearFilterValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).toLowerCase()
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.toLowerCase() : null
}

function addLinearFilterCandidate(candidates: Set<string>, value: unknown): void {
  const normalized = normalizeLinearFilterValue(value)
  if (normalized) candidates.add(normalized)
}

function addLinearRecordCandidates(candidates: Set<string>, value: unknown): void {
  addLinearFilterCandidate(candidates, value)
  if (!isRecord(value)) return
  for (const key of ['id', 'name', 'displayName', 'title', 'key', 'email', 'url', 'identifier']) {
    addLinearFilterCandidate(candidates, value[key])
  }
}

function linearRecordCandidates(record: Record<string, unknown>, key: keyof LinearScopePredicates): Set<string> {
  const candidates = new Set<string>()
  if (key === 'teams') {
    addLinearFilterCandidate(candidates, record.teamId)
    addLinearRecordCandidates(candidates, record.team)
    return candidates
  }
  if (key === 'projects') {
    addLinearFilterCandidate(candidates, record.projectId)
    addLinearRecordCandidates(candidates, record.project)
    return candidates
  }
  if (key === 'assignees') {
    addLinearFilterCandidate(candidates, record.assigneeId)
    addLinearRecordCandidates(candidates, record.assignee)
    return candidates
  }

  const labelIds = record.labelIds
  if (Array.isArray(labelIds)) {
    for (const label of labelIds) addLinearFilterCandidate(candidates, label)
  }
  const labels = record.labels
  if (Array.isArray(labels)) {
    for (const label of labels) addLinearRecordCandidates(candidates, label)
  }
  return candidates
}

function linearPredicateMatches(
  record: Record<string, unknown>,
  predicates: LinearScopePredicates,
  key: keyof LinearScopePredicates
): boolean {
  const selected = predicates[key]
    .map(normalizeLinearFilterValue)
    .filter((entry): entry is string => entry !== null)
  if (selected.length === 0) return true
  const candidates = linearRecordCandidates(record, key)
  return selected.some((value) => candidates.has(value))
}

function linearIssueMatchesPredicates(record: Record<string, unknown>, predicates: LinearScopePredicates): boolean {
  return linearPredicateMatches(record, predicates, 'teams') &&
    linearPredicateMatches(record, predicates, 'projects') &&
    linearPredicateMatches(record, predicates, 'labels') &&
    linearPredicateMatches(record, predicates, 'assignees')
}

function isLinearIssueEventPath(path: string): boolean {
  return /^\/linear\/issues\/[^/]+\.json$/u.test(path)
}

function isSparseRelayfilePointerData(path: string, data: unknown): boolean {
  if (!isRecord(data)) return false
  const keys = Object.keys(data).sort()
  if (keys.length === 1 && keys[0] === 'path') return data.path === path
  if (keys.length === 2 && keys[0] === 'deleted' && keys[1] === 'path') {
    return data.path === path && typeof data.deleted === 'boolean'
  }
  return false
}

function eventContextPreviewMetadata(preview: EventContextPreview): EventContextPreviewMetadata {
  return {
    path: preview.path,
    kind: preview.kind,
    size: preview.size,
    contentType: preview.contentType
  }
}

function previewRecord(preview: EventContextPreview | undefined): Record<string, unknown> | undefined {
  if (!preview || preview.kind !== 'text') return undefined
  try {
    const parsed = JSON.parse(preview.content)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function slackPreviewText(preview: EventContextPreview | undefined): string | undefined {
  if (!preview || preview.kind !== 'text') return undefined
  const record = previewRecord(preview)
  const payload = isRecord(record?.payload) ? record.payload : record
  const rawEvent = isRecord(payload?.raw_event) ? payload.raw_event : undefined
  return eventSummaryValue(payload?.text) || eventSummaryValue(rawEvent?.text) || preview.content
}

function slackPreviewAuthor(preview: EventContextPreview | undefined): string | undefined {
  const record = previewRecord(preview)
  const payload = isRecord(record?.payload) ? record.payload : record
  const rawEvent = isRecord(payload?.raw_event) ? payload.raw_event : undefined
  return eventSummaryValue(payload?.userName) ||
    eventSummaryValue(payload?.user_name) ||
    eventSummaryValue(payload?.user) ||
    eventSummaryValue(rawEvent?.user)
}

function slackPreviewAuthorUserId(preview: EventContextPreview | undefined): string | undefined {
  const record = previewRecord(preview)
  const payload = isRecord(record?.payload) ? record.payload : record
  const rawEvent = isRecord(payload?.raw_event) ? payload.raw_event : undefined
  return eventSummaryValue(payload?.user) ||
    eventSummaryValue(record?.user) ||
    eventSummaryValue(rawEvent?.user)
}

function slackPreviewAuthorIsBot(preview: EventContextPreview | undefined): boolean {
  const record = previewRecord(preview)
  const payload = isRecord(record?.payload) ? record.payload : record
  const rawEvent = isRecord(payload?.raw_event) ? payload.raw_event : undefined
  return payload?.user_is_bot === true ||
    record?.user_is_bot === true ||
    rawEvent?.user_is_bot === true
}

function shouldNotifyRelayfilePath(pathValue: string): boolean {
  const path = pathValue.trim()
  if (!path || !path.startsWith('/')) return false

  const leaf = path.split('/').pop() || ''
  if (
    leaf.startsWith('.') ||
    leaf.includes('.tmp-') ||
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
  if (isLikelyLocalWritebackCommandPath(path)) return false

  return true
}

function isLikelyLocalWritebackCommandPath(path: string): boolean {
  const segments = pathSegments(path)
  const leaf = segments.at(-1) || ''
  const parent = segments.at(-2)
  const stem = leaf.replace(/\.json$/u, '')
  const provider = segments[0]
  if (provider !== 'slack' && provider !== 'chat') return false
  if (!leaf.endsWith('.json') || leaf === 'meta.json') return false
  if (parent !== 'messages' && parent !== 'replies') return false
  return !/^\d+(?:[._-]\d+)*$/u.test(stem)
}

function isSlackLocalWritebackCommandPath(path: string): boolean {
  return pathSegments(path)[0] === 'slack' && isLikelyLocalWritebackCommandPath(path)
}

function slackOutboundWritebackTextFromBuffer(buffer: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(buffer.toString('utf8'))
    if (!isRecord(parsed)) return undefined
    return eventSummaryValue(parsed.text)
  } catch {
    return undefined
  }
}

function slackEventTimestampMs(path: string): number | null {
  const match = path.match(/\/(?:messages|replies)\/(\d{10})_(\d+)(?:\/|\.json$)/u)
  if (!match?.[1]) return null
  return Number(`${match[1]}.${match[2] || '0'}`) * 1000
}

function repeatedSlackRoot(path: string): boolean {
  const matches = path.match(/\/slack\/(?:channels|dms|users)\//gu)
  return (matches?.length || 0) > 1
}

function shouldNotifySlackMessageChange(event: ChangeEvent): boolean {
  const path = event.resource.path
  if (repeatedSlackRoot(path)) return false

  const occurredAtMs = Date.parse(event.occurredAt)
  const slackTsMs = slackEventTimestampMs(path)
  if (slackTsMs !== null && Number.isFinite(occurredAtMs)) {
    return Math.abs(occurredAtMs - slackTsMs) <= SLACK_LIVE_EVENT_WINDOW_MS
  }

  return true
}

function shouldNotifyRelayfileChange(event: ChangeEvent): boolean {
  if (eventOrigin(event) === 'agent_write') return false
  if (!shouldNotifyRelayfilePath(event.resource.path)) return false
  if (event.resource.provider === 'slack' && slackEventContextPath(event.resource.path)) {
    return shouldNotifySlackMessageChange(event)
  }
  return true
}

function slackEventContextPath(path: string): boolean {
  return /^\/slack\/(?:channels|dms|users)\/[^/]+\/(?:messages|threads)\/.+\.json$/u.test(path)
}

function slackContextReadCandidatePaths(path: string, specs: SubscriptionSpec[]): string[] {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (!slackEventContextPath(normalizedPath)) return [normalizedPath]

  const match = normalizedPath.match(/^\/slack\/channels\/([^/]+)(\/(?:messages|threads)\/.+\.json)$/u)
  if (!match?.[1] || !match[2]) return [normalizedPath]

  const currentChannel = match[1]
  const channelId = canonicalSlackChannelSegment(currentChannel)
  const tail = match[2]
  const candidates = [normalizedPath]

  for (const spec of specs) {
    for (const mountPath of spec.mountPaths) {
      const mountMatch = mountPath.match(/^\/slack\/channels\/([^/]+)(?:\/|$)/u)
      const mountedChannel = mountMatch?.[1]
      if (!mountedChannel || canonicalSlackChannelSegment(mountedChannel) !== channelId) {
        continue
      }
      candidates.push(`/slack/channels/${mountedChannel}${tail}`)
    }
  }

  return dedupeStringsInOrder(candidates)
}

function isSuffixedSlackChannelPath(path: string): boolean {
  return /^\/slack\/channels\/[^/]+__[^/]+\//u.test(path)
}

function resolvedSlackContextPath(path: string, specs: SubscriptionSpec[]): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (!slackEventContextPath(normalizedPath)) return normalizedPath
  const candidates = slackContextReadCandidatePaths(normalizedPath, specs)
  return candidates.find((candidate) =>
    isSuffixedSlackChannelPath(candidate) &&
    specs.some((spec) =>
      spec.mountPaths.some((mountPath) => pathIsInsideMount(candidate, mountPath))
    )
  ) || candidates[0] || normalizedPath
}

function contentTypeForLocalPath(localPath: string): string | undefined {
  if (/\.json$/u.test(localPath)) return 'application/json'
  if (/\.(?:txt|md|markdown)$/u.test(localPath)) return 'text/plain'
  return undefined
}

async function readLocalEventContextPreview(
  remotePath: string,
  specs: SubscriptionSpec[]
): Promise<EventContextPreview | undefined> {
  for (const spec of specs) {
    for (const root of spec.localMountRoots) {
      if (!pathIsInsideMount(remotePath, root.remoteRoot)) continue
      const localPath = localPathForRemotePathInsideRoot(root.localRoot, root.remoteRoot, remotePath)
      if (!localPathIsInsideRoot(root.localRoot, localPath)) continue
      const stats = await stat(localPath).catch(() => null)
      if (!stats || stats.isDirectory()) continue
      try {
        const buffer = await readFile(localPath)
        logIntegrationEvent('event context local fallback read', {
          integrationId: spec.integrationId,
          remotePath,
          localRoot: root.localRoot
        })
        return eventContextPreviewFromBuffer(remotePath, buffer, contentTypeForLocalPath(localPath))
      } catch {
        // Try the next matched concrete root/candidate. Missing or transient local
        // reads should not mask the remote expand fallback.
      }
    }
  }
  return undefined
}

async function cleanupConfirmedSlackWritebackDraft(
  projectId: string,
  event: ChangeEvent,
  specs: SubscriptionSpec[]
): Promise<void> {
  if (event.type !== 'writeback.succeeded') return
  const remotePath = eventSummaryValue(event.resource.path)
  if (!remotePath || !isLikelyLocalWritebackCommandPath(remotePath)) return

  for (const spec of specs) {
    if (spec.provider !== 'slack') continue
    for (const root of spec.localMountRoots) {
      if (!isSlackWritebackCommandRoot(root.remoteRoot)) continue
      if (!pathIsInsideMount(remotePath, root.remoteRoot)) continue
      const localPath = localPathForRemotePathInsideRoot(root.localRoot, root.remoteRoot, remotePath)
      if (!localPathIsInsideRoot(root.localRoot, localPath)) continue
      const stats = await stat(localPath).catch(() => null)
      if (!stats || stats.isDirectory()) continue
      await rm(localPath, { force: true })
      logIntegrationEvent('confirmed Slack writeback draft cleaned', {
        projectId,
        eventId: event.id,
        remotePath,
        localRoot: root.localRoot
      })
      return
    }
  }
}

function slackScopeLabel(path: string): string | undefined {
  const segments = pathSegments(path)
  const channelIndex = segments.indexOf('channels')
  if (channelIndex >= 0 && segments[channelIndex + 1]) {
    return slackChannelLabel(segments[channelIndex + 1])
  }
  const dmIndex = segments.indexOf('dms')
  if (dmIndex >= 0 && segments[dmIndex + 1]) return `DM ${segments[dmIndex + 1]}`
  const userIndex = segments.indexOf('users')
  if (userIndex >= 0 && segments[userIndex + 1]) return `User ${segments[userIndex + 1]}`
  return undefined
}

function formatSlackIntegrationEventMessage(
  event: ChangeEvent,
  contextPreview?: EventContextPreview,
  resolvedPath?: string
): string | null {
  const resource = isRecord(event.resource) ? event.resource : {}
  const provider = eventSummaryValue(resource.provider) || eventProvider(event)
  const relayfilePath = eventSummaryValue(resource.path)
  if (provider !== 'slack' || !relayfilePath || !slackEventContextPath(relayfilePath)) return null

  const contextPath = contextPreview?.path || resolvedPath || relayfilePath
  const projectPath = projectIntegrationPathForRelayfilePath(contextPath)
  const scopeLabel = slackScopeLabel(contextPath)
  const messageText = slackPreviewText(contextPreview)
  const author = slackPreviewAuthor(contextPreview)
  const lines = [
    '<integration-event>',
    'Slack message event'
  ]

  if (scopeLabel) lines.push(`Location: ${scopeLabel}`)
  if (author) lines.push(`Author: ${author}`)
  if (messageText) {
    lines.push('Message:', messageText)
  } else if (contextPreview?.kind === 'too-large') {
    lines.push(`Message: skipped; context preview is ${contextPreview.size} bytes.`)
  } else if (contextPreview?.kind === 'binary') {
    lines.push(`Message: skipped; context preview is binary (${contextPreview.size} bytes).`)
  } else {
    lines.push('Message: unavailable; targeted context read did not return content.')
  }
  lines.push(`Path: ${projectPath}`)
  lines.push('</integration-event>')
  return lines.join('\n')
}

function formatIntegrationEventMessage(
  event: ChangeEvent,
  contextPreview?: EventContextPreview,
  resolvedPath?: string
): string {
  const slackMessage = formatSlackIntegrationEventMessage(event, contextPreview, resolvedPath)
  if (slackMessage) return slackMessage

  const summary = isRecord(event.summary) ? event.summary : {}
  const resource = isRecord(event.resource) ? event.resource : {}
  const provider = eventSummaryValue(resource.provider) || 'integration'
  const relayfilePath = eventSummaryValue(resource.path)
  const displayPath = resolvedPath || relayfilePath
  const projectPath = displayPath ? projectIntegrationPathForRelayfilePath(displayPath) : undefined
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
  if (displayPath) {
    lines.push(`Targeted context path: ${displayPath}`)
  }
  if (contextPreview) {
    if (contextPreview.kind === 'text') {
      lines.push('Inline context preview:', contextPreview.content)
    } else if (contextPreview.kind === 'too-large') {
      lines.push(`Context preview skipped: ${contextPreview.size} bytes exceeds the injection preview cap.`)
    } else {
      lines.push(`Context preview skipped: binary content (${contextPreview.size} bytes).`)
    }
  }

  lines.push(
    'Handle this like an incoming user-relevant integration update. The inline context preview, Relayfile path, and structured event data identify the changed record. Use the matching .integrations path only when historical download is enabled. Use the existing writeback or messaging path when a response is needed.',
    '</integration-event>'
  )
  return lines.join('\n')
}

class ProjectEventDispatcher {
  private readonly queue: DispatchItem[] = []
  private readonly pendingByKey = new Map<string, DispatchItem>()
  private readonly summariesByKey = new Map<string, DispatchSummary>()
  private readonly projectId: string
  private readonly deliver: (event: ChangeEvent, specs: SubscriptionSpec[]) => Promise<void>
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private windowStartedAt = 0
  private dispatchedInWindow = 0
  private active = true

  constructor(
    projectId: string,
    deliver: (event: ChangeEvent, specs: SubscriptionSpec[]) => Promise<void>
  ) {
    this.projectId = projectId
    this.deliver = deliver
  }

  enqueue(event: ChangeEvent, specs: SubscriptionSpec[]): void {
    if (!this.active) return

    const key = dispatchCoalescingKey(event)
    const pending = this.pendingByKey.get(key)
    if (pending) {
      pending.event = event
      pending.specs = specs
      incrementIntegrationEventCounter(this.projectId, 'eventsCoalesced')
      this.scheduleDrain(0)
      return
    }

    if (this.queue.length >= MAX_DISPATCH_QUEUE_EVENTS) {
      this.compact(event, specs)
      this.updateDepthGauge()
      this.scheduleDrain(0)
      return
    }

    const item = { event, specs }
    this.queue.push(item)
    this.pendingByKey.set(key, item)
    this.updateDepthGauge()
    this.scheduleDrain(0)
  }

  dispose(): void {
    this.active = false
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = null
    this.queue.length = 0
    this.pendingByKey.clear()
    this.summariesByKey.clear()
    this.updateDepthGauge()
  }

  private compact(event: ChangeEvent, specs: SubscriptionSpec[]): void {
    const summary = dispatchSummaryForEvent(event, specs)
    const key = dispatchSummaryKey(summary)
    const existing = this.summariesByKey.get(key)
    if (existing) {
      existing.count += 1
      existing.specs = specs
      existing.latestEvent = event
      incrementIntegrationEventCounter(this.projectId, 'eventsCoalesced')
      return
    }

    if (this.summariesByKey.size >= MAX_DISPATCH_SUMMARY_GROUPS) {
      incrementIntegrationEventCounter(this.projectId, 'eventsDropped')
      logIntegrationEvent('dropped event because dispatcher summary budget is full', {
        projectId: this.projectId,
        eventId: event.id,
        path: event.resource.path,
        maxSummaryGroups: MAX_DISPATCH_SUMMARY_GROUPS
      })
      return
    }

    this.summariesByKey.set(key, summary)
    incrementIntegrationEventCounter(this.projectId, 'eventsCoalesced')
  }

  private scheduleDrain(delayMs: number): void {
    if (!this.active || this.drainTimer || this.draining) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      void this.drain()
    }, delayMs)
  }

  private async drain(): Promise<void> {
    if (!this.active || this.draining) return
    this.draining = true
    try {
      while (this.active && (this.queue.length > 0 || this.summariesByKey.size > 0)) {
        const waitMs = this.nextRateLimitDelayMs()
        if (waitMs > 0) {
          this.scheduleDrain(waitMs)
          return
        }

        const item = this.queue.shift()
        if (item) {
          this.pendingByKey.delete(dispatchCoalescingKey(item.event))
          this.updateDepthGauge()
          await this.deliverItem(item.event, item.specs)
          continue
        }

        const [key, summary] = this.summariesByKey.entries().next().value as [string, DispatchSummary]
        this.summariesByKey.delete(key)
        this.updateDepthGauge()
        await this.deliverItem(dispatchSummaryEvent(this.projectId, summary), summary.specs)
      }
    } finally {
      this.draining = false
      this.updateDepthGauge()
      if (this.active && (this.queue.length > 0 || this.summariesByKey.size > 0)) {
        this.scheduleDrain(this.nextRateLimitDelayMs())
      }
    }
  }

  private nextRateLimitDelayMs(): number {
    const now = Date.now()
    if (this.windowStartedAt === 0 || now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now
      this.dispatchedInWindow = 0
    }
    if (this.dispatchedInWindow < MAX_DISPATCHED_EVENTS_PER_SECOND) return 0
    return Math.max(1, 1_000 - (now - this.windowStartedAt))
  }

  private async deliverItem(event: ChangeEvent, specs: SubscriptionSpec[]): Promise<void> {
    this.dispatchedInWindow += 1
    try {
      await this.deliver(event, specs)
    } catch (error) {
      const errorMessage = toErrorMessage(error)
      warnIntegrationEventAggregated(
        `event delivery failed:${this.projectId}`,
        'event delivery failed',
        {
          projectId: this.projectId,
          eventId: event.id,
          error: errorMessage
        }
      )
    }
  }

  private updateDepthGauge(): void {
    setIntegrationEventGauge(this.projectId, 'queueDepth', this.queue.length + this.summariesByKey.size)
  }
}

class ProjectBrokerSendPacer {
  private readonly queue: Array<{
    input: BrokerMessageInput
    send?: (input: BrokerMessageInput) => Promise<void>
    resolve: () => void
    reject: (error: unknown) => void
  }> = []
  private readonly projectId: string
  private readonly send: (input: BrokerMessageInput) => Promise<void>
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private active = true
  private windowStartedAt = 0
  private sentInWindow = 0

  constructor(projectId: string, send: (input: BrokerMessageInput) => Promise<void>) {
    this.projectId = projectId
    this.send = send
  }

  enqueue(input: BrokerMessageInput, send?: (input: BrokerMessageInput) => Promise<void>): Promise<void> {
    if (!this.active) return Promise.resolve()
    const deferred = this.queue.length > 0 || this.nextRateLimitDelayMs() > 0 || this.draining
    if (deferred) incrementIntegrationEventCounter(this.projectId, 'brokerSendsDeferred')
    return new Promise((resolveSend, rejectSend) => {
      this.queue.push({ input, send, resolve: resolveSend, reject: rejectSend })
      this.updateDepthGauge()
      this.scheduleDrain(0)
    })
  }

  dispose(): void {
    this.active = false
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = null
    const error = new Error('integration event broker send pacer disposed')
    for (const item of this.queue.splice(0)) item.reject(error)
    this.updateDepthGauge()
  }

  private scheduleDrain(delayMs: number): void {
    if (!this.active || this.drainTimer || this.draining) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      void this.drain()
    }, delayMs)
  }

  private async drain(): Promise<void> {
    if (!this.active || this.draining) return
    this.draining = true
    try {
      while (this.active && this.queue.length > 0) {
        const waitMs = this.nextRateLimitDelayMs()
        if (waitMs > 0) {
          this.scheduleDrain(waitMs)
          return
        }

        const item = this.queue.shift()
        if (!item) continue
        this.updateDepthGauge()
        this.sentInWindow += 1
        try {
          await (item.send ?? this.send)(item.input)
          incrementIntegrationEventCounter(this.projectId, 'brokerSends')
          item.resolve()
        } catch (error) {
          item.reject(error)
        }
      }
    } finally {
      this.draining = false
      this.updateDepthGauge()
      if (this.active && this.queue.length > 0) {
        this.scheduleDrain(this.nextRateLimitDelayMs())
      }
    }
  }

  private nextRateLimitDelayMs(): number {
    const now = Date.now()
    if (this.windowStartedAt === 0 || now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now
      this.sentInWindow = 0
    }
    if (this.sentInWindow < MAX_BROKER_SENDS_PER_SECOND) return 0
    return Math.max(1, 1_000 - (now - this.windowStartedAt))
  }

  private updateDepthGauge(): void {
    setIntegrationEventGauge(this.projectId, 'brokerSendQueueDepth', this.queue.length)
  }
}

export class IntegrationEventBridge {
  private subscriptions = new Map<string, ProjectSubscription>()
  private dispatchers = new Map<string, ProjectEventDispatcher>()
  private recentInjections = new Map<string, RecentInjectionState>()
  private slackLogicalInjections = new Map<string, SlackLogicalInjectionState>()
  private inFlightDedupeClaims = new Map<string, Set<Promise<DeliveryDedupeClaimOutcome>>>()
  private selfBotUserIds = new Map<string, Map<string, number>>()
  private recentOutboundWritebacks = new Map<string, Map<string, number>>()
  private projectAgentRecipientCache = new Map<string, ProjectAgentRecipientCacheEntry>()
  private notificationTargetCache = new Map<string, NotificationTargetCacheEntry>()
  private brokerSendPacers = new Map<string, ProjectBrokerSendPacer>()
  private readonly deps: IntegrationEventBridgeDeps

  constructor(deps: IntegrationEventBridgeDeps = {}) {
    this.deps = deps
  }

  invalidateProjectAgentCache(projectId?: string): void {
    if (projectId) {
      this.projectAgentRecipientCache.delete(projectId)
      return
    }
    this.projectAgentRecipientCache.clear()
  }

  private invalidateNotificationTargetCache(projectId: string): void {
    const prefix = `${projectId}:`
    for (const key of Array.from(this.notificationTargetCache.keys())) {
      if (key.startsWith(prefix)) this.notificationTargetCache.delete(key)
    }
  }

  async reconcile(projectId: string, integrations: ConnectedIntegration[]): Promise<void> {
    const subscribed = integrations.filter((integration) => integration.subscribeAgent === true)
    if (subscribed.length === 0) {
      await this.close(projectId)
      return
    }

    const handle = await this.getWorkspaceHandle()
    const specs = subscriptionSpecsFor(subscribed, handle.localMountWorkspaceId)
    const watches = dedupeStrings(specs.flatMap((spec) => spec.watches.map((watch) => watch.glob))).map((glob) => ({
      glob,
      coalesceMs: 750
    }))
    if (watches.length === 0) {
      await this.close(projectId)
      return
    }

    const signature = JSON.stringify({
      workspaceId: handle.workspaceId,
      localMountWorkspaceId: handle.localMountWorkspaceId,
      watches,
      specs: specs.map((spec) => ({
        integrationId: spec.integrationId,
        provider: spec.provider,
        mountPaths: spec.mountPaths,
        localMountRoots: spec.localMountRoots,
        eventPathGlobs: spec.eventPathGlobs,
        linearPredicates: spec.linearPredicates,
        allowHistoricalReplay: spec.allowHistoricalReplay,
        targets: spec.targets
      }))
    })
    if (this.subscriptions.get(projectId)?.signature === signature) return

    this.invalidateNotificationTargetCache(projectId)
    await this.close(projectId)
    const subscriptions: Subscription[] = []
    try {
      const remoteSubscriptionStartedAtMs = Date.now()
      logIntegrationEvent('subscribing', {
        projectId,
        workspaceId: handle.workspaceId,
        localMountWorkspaceId: handle.localMountWorkspaceId,
        // Use the SDK catch-up stream and let Pear's replay filter below
        // decide what is live enough to inject. This avoids losing a Slack
        // webhook that lands while Pear is still attaching the stream.
        remoteSubscriptionStartedAt: new Date(remoteSubscriptionStartedAtMs).toISOString(),
        globs: watches.map((watch) => watch.glob),
        specs: specs.map((spec) => ({
          integrationId: spec.integrationId,
          provider: spec.provider,
          mountPaths: spec.mountPaths,
          localMountRoots: spec.localMountRoots,
          eventPathGlobs: spec.eventPathGlobs,
          linearPredicates: spec.linearPredicates,
          allowHistoricalReplay: spec.allowHistoricalReplay,
          targets: targetLabels(spec.targets)
        }))
      })
      subscriptions.push(
        handle.client().subscribe(
          watches.map((watch) => watch.glob),
          (event) => {
            incrementIntegrationEventCounter(projectId, 'eventsReceived')
            logIntegrationEvent('received', {
              projectId,
              eventId: event.id,
              type: event.type,
              path: event.resource.path
            })
            void cleanupConfirmedSlackWritebackDraft(projectId, event, specs).catch((error) => {
              warnIntegrationEventAggregated(
                `confirmed writeback cleanup failed:${projectId}`,
                'confirmed writeback cleanup failed',
                {
                  projectId,
                  eventId: event.id,
                  path: event.resource.path,
                  error: toErrorMessage(error)
                }
              )
            })
            void this.enqueueEvent(projectId, event, specs, {
              source: 'remote',
              subscriptionStartedAtMs: remoteSubscriptionStartedAtMs,
              localMountWorkspaceId: handle.localMountWorkspaceId
            }).catch((error) => {
              const errorMessage = toErrorMessage(error)
              warnIntegrationEventAggregated(
                `event enqueue failed:${projectId}`,
                'event enqueue failed',
                {
                  projectId,
                  eventId: event.id,
                  error: errorMessage
                }
              )
            })
          },
          {
            coalesce: 'fire-once',
            coalesceMs: Math.max(...watches.map((watch) => watch.coalesceMs), 750),
            pathScope: watches.map((watch) => watch.glob),
            from: REMOTE_SUBSCRIPTION_FROM,
            onCoalesced: () => incrementIntegrationEventCounter(projectId, 'eventsCoalesced'),
            onQueueDepth: (depth) => setIntegrationEventGauge(projectId, 'queueDepth', depth)
          }
        )
      )
      const localSubscription = watchLocalMounts(
        handle.localMountWorkspaceId,
        subscribed,
        watches.map((watch) => watch.glob),
        (event) => {
          incrementIntegrationEventCounter(projectId, 'eventsReceived')
          logIntegrationEvent('received', {
            projectId,
            eventId: event.id,
            type: event.type,
            path: event.resource.path,
            source: 'local-mount'
          })
          void this.enqueueEvent(projectId, event, specs, {
            source: 'local-mount',
            subscriptionStartedAtMs: remoteSubscriptionStartedAtMs,
            localMountWorkspaceId: handle.localMountWorkspaceId
          }).catch((error) => {
            const errorMessage = toErrorMessage(error)
            warnIntegrationEventAggregated(
              `local event enqueue failed:${projectId}`,
              'local event enqueue failed',
              {
                projectId,
                eventId: event.id,
                error: errorMessage
              }
            )
          })
        },
        Math.max(...watches.map((watch) => watch.coalesceMs), 750),
        {
          onCoalesced: () => incrementIntegrationEventCounter(projectId, 'eventsCoalesced'),
          onQueueDepth: (depth) => setIntegrationEventGauge(projectId, 'queueDepth', depth)
        }
      )
      setIntegrationEventGauge(projectId, 'mountCount', localSubscription?.localRoots.length ?? 0)
      if (localSubscription) {
        logIntegrationEvent('watching local mounts', {
          projectId,
          workspaceId: handle.workspaceId,
          localMountWorkspaceId: handle.localMountWorkspaceId,
          localRoots: localSubscription.localRoots
        })
        subscriptions.push(localSubscription)
      }
      const slackWritebackCaptureSubscription = watchSlackWritebackCommandRoots(
        handle.localMountWorkspaceId,
        subscribed,
        (command) => {
          void this.recordSlackOutboundWriteback(projectId, command).catch((error) => {
            warnIntegrationEventAggregated(
              `Slack outbound writeback capture failed:${projectId}`,
              'Slack outbound writeback capture failed',
              {
                projectId,
                remotePath: command.remotePath,
                error: toErrorMessage(error)
              }
            )
          })
        }
      )
      if (slackWritebackCaptureSubscription) {
        logIntegrationEvent('watching Slack writeback command roots', {
          projectId,
          workspaceId: handle.workspaceId,
          localMountWorkspaceId: handle.localMountWorkspaceId,
          localRoots: slackWritebackCaptureSubscription.localRoots
        })
        subscriptions.push(slackWritebackCaptureSubscription)
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
    this.dispatchers.get(projectId)?.dispose()
    this.dispatchers.delete(projectId)
    this.brokerSendPacers.get(projectId)?.dispose()
    this.brokerSendPacers.delete(projectId)
    this.selfBotUserIds.delete(projectId)
    this.recentOutboundWritebacks.delete(projectId)
    this.invalidateProjectAgentCache(projectId)
    this.invalidateNotificationTargetCache(projectId)
    setIntegrationEventGauge(projectId, 'queueDepth', 0)
    setIntegrationEventGauge(projectId, 'mountCount', 0)
    setIntegrationEventGauge(projectId, 'brokerSendQueueDepth', 0)
    if (!subscription) return
    await Promise.all(subscription.subscriptions.map((entry) => entry.unsubscribe().catch(() => undefined)))
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.subscriptions.keys()).map((projectId) => this.close(projectId)))
  }

  async closeAllExcept(projectIdToKeep: string): Promise<void> {
    await Promise.all(
      Array.from(this.subscriptions.keys())
        .filter((projectId) => projectId !== projectIdToKeep)
        .map((projectId) => this.close(projectId))
    )
  }

  private async readEventContextPreview(
    projectId: string,
    event: ChangeEvent,
    matchedSpecs: SubscriptionSpec[]
  ): Promise<EventContextPreview | undefined> {
    if (event.type === 'file.deleted' || event.type === 'relayfile.changed.summary') return undefined
    const path = eventSummaryValue(event.resource.path)
    if (!path) return undefined

    let readFileError: unknown
    try {
      const readDelays = slackEventContextPath(path) ? [0, ...EVENT_CONTEXT_READ_RETRY_DELAYS_MS] : [0]
      const handle = await this.getWorkspaceHandle()
      const client = handle.client()
      const candidatePaths = slackEventContextPath(path)
        ? slackContextReadCandidatePaths(path, matchedSpecs)
        : [path]
      if (typeof client.readFile === 'function') {
        for (const [index, delayMs] of readDelays.entries()) {
          if (delayMs > 0) await delay(delayMs)
          for (const candidatePath of candidatePaths) {
            try {
              return eventContextPreviewFromFile(await client.readFile(handle.workspaceId, candidatePath))
            } catch (error) {
              readFileError = error
              if (isUnauthorizedError(error)) throw error
            }
          }
        }
      }
      for (const candidatePath of candidatePaths) {
        const localPreview = await readLocalEventContextPreview(candidatePath, matchedSpecs)
        if (localPreview) return localPreview
      }
    } catch (error) {
      readFileError = error
    }

    try {
      const expanded = await event.expand('full')
      const expandedRecord = isRecord(expanded) ? expanded : {}
      return eventContextPreviewFromData(
        typeof expandedRecord.path === 'string' ? expandedRecord.path : path,
        expandedRecord.data
      )
    } catch (expandError) {
      warnIntegrationEventAggregated(
        `event context read failed:${projectId}`,
        'event context read failed',
        {
          projectId,
          eventId: event.id,
          path,
          error: readFileError ? toErrorMessage(readFileError) : toErrorMessage(expandError),
          expandError: readFileError ? toErrorMessage(expandError) : undefined
        }
      )
      return undefined
    }
  }

  private async filterLinearPredicateSpecs(
    projectId: string,
    event: ChangeEvent,
    matchedSpecs: SubscriptionSpec[]
  ): Promise<SubscriptionSpec[]> {
    const predicateSpecs = matchedSpecs.filter((spec) => spec.linearPredicates)
    if (predicateSpecs.length === 0) return matchedSpecs
    const path = eventSummaryValue(event.resource.path)
    if (!path || !isLinearIssueEventPath(path)) return matchedSpecs

    const unfilteredSpecs = matchedSpecs.filter((spec) => !spec.linearPredicates)
    const contextPreview = await this.readEventContextPreview(projectId, event, matchedSpecs)
    const record = parseJsonPreview(contextPreview)
    if (!record) {
      warnIntegrationEventAggregated(
        `Linear predicate issue read failed:${projectId}`,
        'Linear predicate issue read failed',
        {
          projectId,
          eventId: event.id,
          path
        }
      )
      return unfilteredSpecs
    }

    const filteredPredicateSpecs = predicateSpecs.filter((spec) =>
      spec.linearPredicates && linearIssueMatchesPredicates(record, spec.linearPredicates)
    )
    const droppedCount = predicateSpecs.length - filteredPredicateSpecs.length
    if (droppedCount > 0) {
      logIntegrationEvent('filtered Linear event by scope predicates', {
        projectId,
        eventId: event.id,
        path,
        droppedSpecs: droppedCount
      })
    }

    return [...unfilteredSpecs, ...filteredPredicateSpecs]
  }

  private pruneProjectTtlMap(entries: Map<string, number>, now = Date.now()): void {
    for (const [key, expiresAt] of entries.entries()) {
      if (expiresAt <= now) entries.delete(key)
    }
  }

  private projectTtlMap(store: Map<string, Map<string, number>>, projectId: string): Map<string, number> {
    let entries = store.get(projectId)
    if (!entries) {
      entries = new Map<string, number>()
      store.set(projectId, entries)
    }
    this.pruneProjectTtlMap(entries)
    return entries
  }

  private recentOutboundWritebackSeen(projectId: string, key: string): boolean {
    return this.projectTtlMap(this.recentOutboundWritebacks, projectId).has(key)
  }

  private activeSelfBotUserIds(projectId: string): Map<string, number> {
    return this.projectTtlMap(this.selfBotUserIds, projectId)
  }

  private learnSelfBotUserId(projectId: string, authorId: string): void {
    const selfBotUserIds = this.activeSelfBotUserIds(projectId)
    if (selfBotUserIds.has(authorId)) return
    selfBotUserIds.set(authorId, Date.now() + SLACK_RECORD_REPLAY_TTL_MS)
    logIntegrationEvent('learned Slack self bot user id', {
      projectId,
      authorId
    })
  }

  private async recordSlackOutboundWriteback(
    projectId: string,
    command: SlackOutboundWritebackCommand
  ): Promise<void> {
    const buffer = await readFile(command.localPath)
    const text = slackOutboundWritebackTextFromBuffer(buffer)
    const correlationKey = slackOutboundCorrelationKey(command.remotePath, text)
    if (!correlationKey) return

    const recentOutboundWritebacks = this.projectTtlMap(this.recentOutboundWritebacks, projectId)
    recentOutboundWritebacks.set(correlationKey, Date.now() + SLACK_SELF_ECHO_WRITEBACK_TTL_MS)
    logIntegrationEvent('recorded Slack outbound writeback', {
      projectId,
      remotePath: command.remotePath,
      correlationKey
    })
  }

  private shouldSuppressSlackSelfEcho(
    projectId: string,
    event: ChangeEvent,
    contextPreview: EventContextPreview | undefined,
    resolvedPath: string
  ): boolean {
    if (eventProvider(event) !== 'slack') return false

    const authorId = slackPreviewAuthorUserId(contextPreview)
    const isBot = slackPreviewAuthorIsBot(contextPreview)
    const selfBotUserIds = this.activeSelfBotUserIds(projectId)
    if (authorId && selfBotUserIds.has(authorId)) {
      incrementIntegrationEventCounter(projectId, 'eventsSelfEchoSuppressed')
      logIntegrationEvent('suppressed Slack self-echo', {
        projectId,
        eventId: event.id,
        path: resolvedPath,
        authorId,
        learnedFromWriteback: false
      })
      return true
    }

    if (isBot && !authorId) {
      warnIntegrationEventAggregated(
        `Slack bot event missing author id:${projectId}`,
        'Slack bot event missing author id',
        {
          projectId,
          eventId: event.id,
          path: resolvedPath
        }
      )
      return false
    }

    const correlationKey = slackOutboundCorrelationKey(resolvedPath, slackPreviewText(contextPreview))
    if (
      isBot &&
      authorId &&
      correlationKey &&
      // Learn once per project so a later text collision cannot keep re-learning
      // another bot id; the self-id TTL self-heals a bad first correlation.
      selfBotUserIds.size === 0 &&
      this.recentOutboundWritebackSeen(projectId, correlationKey)
    ) {
      this.learnSelfBotUserId(projectId, authorId)
      incrementIntegrationEventCounter(projectId, 'eventsSelfEchoSuppressed')
      logIntegrationEvent('suppressed Slack self-echo', {
        projectId,
        eventId: event.id,
        path: resolvedPath,
        authorId,
        correlationKey,
        learnedFromWriteback: true
      })
      return true
    }

    return false
  }

  private async enqueueEvent(
    projectId: string,
    event: ChangeEvent,
    specs: SubscriptionSpec[],
    options: EventInjectionOptions
  ): Promise<void> {
    if (!shouldNotifyRelayfileChange(event)) {
      logIntegrationEvent('skipped filtered path', {
        projectId,
        eventId: event.id,
        path: event.resource.path
      })
      return
    }

    const eventMatchedSpecs = specsForEvent(event, specs)
    const replayAllowedSpecs = historicalRemoteReplayAllowedSpecs(event, eventMatchedSpecs, options)
    const matchedSpecs = await this.filterLinearPredicateSpecs(projectId, event, replayAllowedSpecs)
    if (matchedSpecs.length === 0) {
      if (eventMatchedSpecs.length > 0) {
        incrementIntegrationEventCounter(projectId, 'eventsDropped')
        if (replayAllowedSpecs.length > 0) {
          logIntegrationEvent('skipped Linear event by scope predicates', {
            projectId,
            eventId: event.id,
            path: event.resource.path
          })
        } else {
          logIntegrationEvent('skipped historical remote replay', {
            projectId,
            eventId: event.id,
            path: event.resource.path,
            occurredAt: event.occurredAt,
            subscriptionStartedAt: new Date(options.subscriptionStartedAtMs).toISOString(),
            replaySkewToleranceMs: REPLAY_SKEW_TOLERANCE_MS,
            temporaryPendingSdkContract: true
          })
        }
      } else {
        logIntegrationEvent('skipped unmatched path', {
          projectId,
          eventId: event.id,
          path: event.resource.path,
          mountPaths: specs.flatMap((spec) => spec.mountPaths)
        })
      }
      return
    }

    let dispatcher = this.dispatchers.get(projectId)
    if (!dispatcher) {
      dispatcher = new ProjectEventDispatcher(projectId, (queuedEvent, queuedSpecs) =>
        this.injectEvent(projectId, queuedEvent, queuedSpecs)
      )
      this.dispatchers.set(projectId, dispatcher)
    }
    dispatcher.enqueue(event, matchedSpecs)
  }

  private async injectEvent(
    projectId: string,
    event: ChangeEvent,
    matchedSpecs: SubscriptionSpec[]
  ): Promise<void> {
    const duplicateKey = injectionDeduplicationKey(projectId, event, matchedSpecs)
    const fingerprint = eventChangeFingerprint(event)
    const needsSlackContentAwareDedupe = fingerprint?.startsWith('slack:') === true
    let dedupe = eventDedupeKeyWithFingerprint(duplicateKey, fingerprint)
    let dedupeClaimed = false

    const bridge = await this.bridge()
    const uniqueRecipients = await this.recipientsForMatchedSpecs(projectId, matchedSpecs, bridge)
    if (uniqueRecipients.length === 0) {
      // Release the dedupe key: a duplicate of this event (remote copy of a
      // local change, coalesced update) must be allowed to retry once a
      // recipient registers; otherwise the event is suppressed for the TTL.
      if (dedupeClaimed) this.releaseDedupeKey(dedupe.key, needsSlackContentAwareDedupe)
      incrementIntegrationEventCounter(projectId, 'eventsDropped')
      warnIntegrationEventAggregated(
        `skipped no recipients:${projectId}`,
        'skipped no recipients',
        {
          projectId,
          eventId: event.id,
          path: event.resource.path
        }
      )
      return
    }

    const eventMetadata = integrationEventMetadata(event)
    const contextPreview = await this.readEventContextPreview(projectId, event, matchedSpecs)
    const resolvedPath = contextPreview?.path || resolvedSlackContextPath(event.resource.path, matchedSpecs)
    if (this.shouldSuppressSlackSelfEcho(projectId, event, contextPreview, resolvedPath)) {
      return
    }
    const usesConcreteAgentTargets = uniqueRecipients.every((recipient) => !recipient.startsWith('#'))
    const canTrackInjectedDelivery = usesConcreteAgentTargets && typeof bridge.sendMessageAndWaitForInjected === 'function'
    const shouldTrackDedupe = canTrackInjectedDelivery
    if (!usesConcreteAgentTargets) {
      warnIntegrationEventAggregated(
        `delivery injected tracking skipped for channel targets:${projectId}`,
        'delivery injected tracking skipped for channel targets',
        {
          projectId,
          eventId: event.id,
          path: event.resource.path,
          recipients: uniqueRecipients
        }
      )
    } else if (!canTrackInjectedDelivery) {
      throw new Error('Broker delivery_injected confirmation is unavailable')
    }

    let deliveryClaim: DeliveryDedupeClaim | undefined
    if (needsSlackContentAwareDedupe && shouldTrackDedupe) {
      dedupe = eventDedupeKeyWithFingerprint(duplicateKey, fingerprint)
      const slackClaim = this.claimSlackLogicalInjection(dedupe.key, contextPreview, dedupe.ttlMs, shouldTrackDedupe)
      if (!slackClaim.claimed) {
        const inFlightOutcome = await this.waitForInFlightDedupeClaims(dedupe.key)
        if (inFlightOutcome === 'released') {
          logIntegrationEvent('retrying duplicate path after unconfirmed delivery', {
            projectId,
            eventId: event.id,
            path: event.resource.path,
            duplicateKey: dedupe.key
          })
          return this.injectEvent(projectId, event, matchedSpecs)
        }
        incrementIntegrationEventCounter(projectId, 'eventsDropped')
        this.reportSkippedDuplicatePath(projectId, event, dedupe.key)
        return
      }
      dedupeClaimed = shouldTrackDedupe
      if (shouldTrackDedupe) {
        deliveryClaim = {
          key: dedupe.key,
          isSlackLogicalKey: true,
          ttlMs: dedupe.ttlMs,
          contentHash: slackClaim.contentHash
        }
      }
    } else if (shouldTrackDedupe) {
      if (!this.claimRecentInjection(dedupe.key, dedupe.ttlMs, true)) {
        const inFlightOutcome = await this.waitForInFlightDedupeClaims(dedupe.key)
        if (inFlightOutcome === 'released') {
          logIntegrationEvent('retrying duplicate path after unconfirmed delivery', {
            projectId,
            eventId: event.id,
            path: event.resource.path,
            duplicateKey: dedupe.key
          })
          return this.injectEvent(projectId, event, matchedSpecs)
        }
        incrementIntegrationEventCounter(projectId, 'eventsDropped')
        this.reportSkippedDuplicatePath(projectId, event, dedupe.key)
        return
      }
      dedupeClaimed = true
      deliveryClaim = {
        key: dedupe.key,
        isSlackLogicalKey: false,
        ttlMs: dedupe.ttlMs
      }
    } else if (!needsSlackContentAwareDedupe) {
      // Channel/untracked targets must not be falsely committed based on an
      // unresolved target list. Keep delivery flowing and leave dedupe to
      // relay/replay identity rather than pinning a local claim.
      dedupeClaimed = false
    }
    const inFlightClaim = deliveryClaim ? this.trackInFlightDedupeClaim(deliveryClaim.key) : undefined
    const contextPreviewData = contextPreview ? eventContextPreviewMetadata(contextPreview) : undefined
    const resolvedResource = isRecord(event.resource)
      ? { ...event.resource, path: resolvedPath }
      : undefined
    logIntegrationEvent('injecting', {
      projectId,
      eventId: event.id,
      path: resolvedPath,
      recipients: uniqueRecipients
    })
    let deliveredCount = 0
    const sendErrors: Array<{ recipient: string; error: unknown }> = []
    const injectedConfirmations: Array<Promise<unknown>> = []
    for (const recipient of uniqueRecipients) {
      const input = {
        to: recipient,
        from: 'integration',
        text: formatIntegrationEventMessage(event, contextPreview, resolvedPath),
        priority: 0,
        mode: 'steer',
        data: {
          kind: 'integration-event',
          system: true,
          eventId: event.id,
          eventType: event.type,
          occurredAt: event.occurredAt,
          resource: resolvedResource,
          path: resolvedPath,
          contextPreview: contextPreviewData,
          ...eventMetadata
        }
      } as const
      try {
        const sendResult = await this.sendBrokerMessage(projectId, input, bridge, {
          waitForInjected: canTrackInjectedDelivery
        })
        if (sendResult.injectedConfirmation) injectedConfirmations.push(sendResult.injectedConfirmation)
        deliveredCount += 1
      } catch (error) {
        sendErrors.push({ recipient, error })
      }
    }
    if (deliveredCount === 0 && sendErrors.length > 0) {
      // No recipient got the event. Release the dedupe key so a duplicate of
      // this event (remote copy of a local change, coalesced update) retries
      // delivery instead of being dropped as a recent injection.
      if (dedupeClaimed) this.releaseDedupeKey(dedupe.key, needsSlackContentAwareDedupe)
      inFlightClaim?.settle('released')
      throw sendErrors[0].error
    }
    if (sendErrors.length > 0) {
      warnIntegrationEventAggregated(
        `event recipient send failed:${projectId}`,
        'event recipient send failed',
        {
          projectId,
          eventId: event.id,
          path: event.resource.path,
          recipients: sendErrors.map((entry) => entry.recipient),
          error: toErrorMessage(sendErrors[0].error)
        }
      )
    }
    if (deliveryClaim && injectedConfirmations.length > 0) {
      void Promise.all(injectedConfirmations)
        .then(() => {
          this.commitDedupeKey(deliveryClaim)
          incrementIntegrationEventCounter(projectId, 'eventsInjected')
          inFlightClaim?.settle('committed')
        })
        .catch((error) => {
          this.releaseDedupeKey(deliveryClaim.key, deliveryClaim.isSlackLogicalKey, deliveryClaim.contentHash)
          warnIntegrationEventAggregated(
            `delivery injected confirmation failed:${projectId}`,
            'delivery injected confirmation failed',
            {
              projectId,
              eventId: event.id,
              path: event.resource.path,
              duplicateKey: deliveryClaim.key,
              error: toErrorMessage(error)
            }
          )
          inFlightClaim?.settle('released')
        })
    } else if (deliveryClaim) {
      this.releaseDedupeKey(deliveryClaim.key, deliveryClaim.isSlackLogicalKey, deliveryClaim.contentHash)
      inFlightClaim?.settle('released')
    } else {
      incrementIntegrationEventCounter(projectId, 'eventsInjected')
    }
  }

  private reportSkippedDuplicatePath(projectId: string, event: ChangeEvent, duplicateKey: string): void {
    warnIntegrationEventAggregated(
      `skipped duplicate path:${projectId}`,
      'skipped duplicate path',
      {
        projectId,
        eventId: event.id,
        path: event.resource.path,
        duplicateKey
      }
    )
  }

  private async recipientsForMatchedSpecs(
    projectId: string,
    matchedSpecs: SubscriptionSpec[],
    bridge: BrokerEventBridge
  ): Promise<string[]> {
    const targetGroups = this.notificationTargetsFor(projectId, matchedSpecs)
    const projectAgents = targetGroups.needsProjectAgents
      ? await this.listProjectAgentsCached(projectId, bridge)
      : null
    const recipients: string[] = []

    for (const targets of targetGroups.specs) {
      const onlineExplicitAgents = projectAgents
        ? targets.agents.filter((agent) => projectAgents.includes(agent))
        : []
      const explicitAgents = projectAgents && projectAgents.length === 0 && targets.agents.length > 0
        ? targets.agents
        : onlineExplicitAgents
      const explicitTargets = dedupeStrings([...explicitAgents, ...targets.channels])
      if (explicitTargets.length === 0) {
        recipients.push(...(projectAgents ?? await this.listProjectAgentsCached(projectId, bridge)))
      } else {
        recipients.push(...explicitTargets)
      }
    }

    return dedupeStrings(recipients)
  }

  private notificationTargetsFor(projectId: string, matchedSpecs: SubscriptionSpec[]): NotificationTargetCacheEntry {
    const key = `${projectId}:${notificationTargetCacheKey(matchedSpecs)}`
    const cached = this.notificationTargetCache.get(key)
    if (cached) return cached

    const specs = matchedSpecs.map((spec) => ({
      agents: spec.targets.agents,
      channels: spec.targets.channels
    }))
    const needsProjectAgents = specs.some((targets) =>
      targets.agents.length > 0 || (targets.agents.length === 0 && targets.channels.length === 0)
    )
    const entry = { specs, needsProjectAgents }
    this.notificationTargetCache.set(key, entry)
    return entry
  }

  private async listProjectAgentsCached(projectId: string, bridge: BrokerEventBridge): Promise<string[]> {
    const now = Date.now()
    const cached = this.projectAgentRecipientCache.get(projectId)
    if (cached?.pending) return cached.pending
    if (cached && cached.expiresAt > now) return cached.agents

    const pending = bridge.listAgents(projectId)
      .then((agents) => dedupeStrings(
        agents
          .filter((agent) => agent.projectId === undefined || agent.projectId === projectId)
          .map((agent) => agent.name)
      ))
      .then((agents) => {
        // If an explicit invalidation races with this in-flight refresh, the
        // short TTL bounds how long the older roster can be reused.
        this.projectAgentRecipientCache.set(projectId, {
          agents,
          expiresAt: Date.now() + PROJECT_AGENT_RECIPIENT_CACHE_TTL_MS
        })
        return agents
      })
      .catch((error) => {
        this.projectAgentRecipientCache.delete(projectId)
        throw error
      })
    this.projectAgentRecipientCache.set(projectId, {
      agents: cached?.agents ?? [],
      expiresAt: 0,
      pending
    })
    return pending
  }

  private async sendBrokerMessage(
    projectId: string,
    input: BrokerMessageInput,
    bridge: BrokerEventBridge,
    options: { waitForInjected?: boolean } = {}
  ): Promise<{ injectedConfirmation?: Promise<unknown> }> {
    let pacer = this.brokerSendPacers.get(projectId)
    if (!pacer) {
      // Integration-event delivery is paced on broker send acceptance. Waiting
      // for delivery confirmation here can head-of-line block every later event
      // behind a slow agent receipt path.
      pacer = new ProjectBrokerSendPacer(projectId, (message) =>
        Promise.resolve(bridge.sendMessage(projectId, message))
      )
      this.brokerSendPacers.set(projectId, pacer)
    }
    if (!options.waitForInjected) {
      await pacer.enqueue(input)
      return {}
    }

    if (!bridge.sendMessageAndWaitForInjected) {
      throw new Error('Broker delivery_injected confirmation is unavailable')
    }

    let injectedConfirmation: Promise<unknown> | undefined
    const timeoutMs = deliveryInjectedConfirmationTimeoutMs()
    await pacer.enqueue(input, (message) => {
      injectedConfirmation = withTimeout(
        bridge.sendMessageAndWaitForInjected!(
          projectId,
          message,
          { timeoutMs }
        ),
        timeoutMs + 250,
        `Timed out waiting for broker delivery_injected confirmation for ${message.to}`
      )
      return Promise.resolve()
    })
    return injectedConfirmation ? { injectedConfirmation } : {}
  }

  private claimRecentInjection(key: string, ttlMs = RECENT_INJECTION_TTL_MS, provisional = false): boolean {
    const now = Date.now()
    for (const [entryKey, entry] of this.recentInjections.entries()) {
      if (entry.expiresAt <= now) this.recentInjections.delete(entryKey)
    }
    if (this.recentInjections.has(key)) return false
    this.recentInjections.set(key, { expiresAt: now + ttlMs, provisional })
    return true
  }

  private claimSlackLogicalInjection(
    key: string,
    contextPreview: EventContextPreview | undefined,
    ttlMs: number,
    provisional: boolean
  ): { claimed: boolean; contentHash?: string } {
    const now = Date.now()
    for (const [entryKey, entry] of this.slackLogicalInjections.entries()) {
      if (entry.expiresAt <= now) this.slackLogicalInjections.delete(entryKey)
    }

    const contentHash = contextPreview?.kind === 'text'
      ? stableContentFingerprint(contextPreview.content)
      : undefined
    const existing = this.slackLogicalInjections.get(key)
    if (existing) {
      if (!contentHash) {
        if (
          existing.committedBlind ||
          existing.provisionalBlind ||
          existing.committedContentHashes.size > 0 ||
          existing.provisionalContentHashes.size > 0
        ) {
          return { claimed: false }
        }
        existing.provisionalBlind = provisional
        existing.committedBlind = !provisional
        existing.expiresAt = now + ttlMs
        return { claimed: true }
      }
      if (
        (existing.committedBlind || existing.provisionalBlind) &&
        existing.committedContentHashes.size === 0 &&
        existing.provisionalContentHashes.size === 0
      ) {
        // A blind claim means the first delivery lacked readable content. Let
        // the first later content-bearing replay through, then use its hash to
        // suppress subsequent alias/retry copies while still allowing edits.
        if (provisional) existing.provisionalContentHashes.add(contentHash)
        else existing.committedContentHashes.add(contentHash)
        existing.expiresAt = now + ttlMs
        return { claimed: true, contentHash }
      }
      if (
        existing.committedContentHashes.has(contentHash) ||
        existing.provisionalContentHashes.has(contentHash)
      ) {
        return { claimed: false }
      }
      if (provisional) {
        existing.provisionalContentHashes.add(contentHash)
      } else {
        existing.committedContentHashes.add(contentHash)
      }
      existing.expiresAt = now + ttlMs
      return { claimed: true, contentHash }
    }

    this.slackLogicalInjections.set(key, {
      expiresAt: now + ttlMs,
      committedBlind: !contentHash && !provisional,
      committedContentHashes: !provisional && contentHash ? new Set([contentHash]) : new Set(),
      provisionalBlind: !contentHash && provisional,
      provisionalContentHashes: provisional && contentHash ? new Set([contentHash]) : new Set()
    })
    return { claimed: true, contentHash }
  }

  private commitDedupeKey(claim: DeliveryDedupeClaim): void {
    const now = Date.now()
    if (!claim.isSlackLogicalKey) {
      const entry = this.recentInjections.get(claim.key)
      if (entry) {
        entry.provisional = false
        entry.expiresAt = now + claim.ttlMs
      }
      return
    }

    const entry = this.slackLogicalInjections.get(claim.key)
    if (!entry) return
    if (claim.contentHash) {
      if (entry.provisionalContentHashes.delete(claim.contentHash)) {
        entry.committedContentHashes.add(claim.contentHash)
      }
    } else if (entry.provisionalBlind) {
      entry.provisionalBlind = false
      entry.committedBlind = true
    }
    entry.expiresAt = now + claim.ttlMs
  }

  private trackInFlightDedupeClaim(key: string): InFlightDedupeClaim {
    let settle: (outcome: DeliveryDedupeClaimOutcome) => void = () => undefined
    const promise = new Promise<DeliveryDedupeClaimOutcome>((resolve) => {
      settle = resolve
    })
    let claims = this.inFlightDedupeClaims.get(key)
    if (!claims) {
      claims = new Set()
      this.inFlightDedupeClaims.set(key, claims)
    }
    claims.add(promise)
    void promise.finally(() => {
      const current = this.inFlightDedupeClaims.get(key)
      current?.delete(promise)
      if (current?.size === 0) this.inFlightDedupeClaims.delete(key)
    })
    return { promise, settle }
  }

  private async waitForInFlightDedupeClaims(key: string): Promise<DeliveryDedupeClaimOutcome | null> {
    const claims = Array.from(this.inFlightDedupeClaims.get(key) ?? [])
    if (claims.length === 0) return null
    const outcomes = await Promise.all(claims)
    return outcomes.includes('released') ? 'released' : 'committed'
  }

  private releaseDedupeKey(key: string, isSlackLogicalKey: boolean, contentHash?: string): void {
    if (isSlackLogicalKey) {
      const entry = this.slackLogicalInjections.get(key)
      if (!entry) return
      if (contentHash) {
        entry.provisionalContentHashes.delete(contentHash)
      } else {
        entry.provisionalBlind = false
      }
      if (
        !entry.committedBlind &&
        !entry.provisionalBlind &&
        entry.committedContentHashes.size === 0 &&
        entry.provisionalContentHashes.size === 0
      ) {
        this.slackLogicalInjections.delete(key)
      }
    } else {
      this.recentInjections.delete(key)
    }
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
      client: () => createWorkspaceScopedEventClient(client, relayWorkspaceId, workspaceTokenProvider, joined.info.relayfileUrl)
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
