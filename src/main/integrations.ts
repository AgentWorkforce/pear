import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import type { WorkspaceHandle } from '@relayfile/sdk'
import { accountWorkspaceReadyRetryOptions, getAccountWorkspaceId, getApiUrl, resolveCloudAuth } from './auth'
import { brokerManager } from './broker'
import { cloudAgentManager } from './cloud-agent'
import * as filesystem from './filesystem'
import { integrationEventBridge, integrationSubscriptionSummaries } from './integration-event-bridge'
import { integrationMountManager, integrationMountRootForWorkspace } from './integration-mounts'
import { ensureProjectIntegrationsLink, removeProjectIntegrationsLink } from './integration-symlinks'
import { INTEGRATIONS_CATALOG } from './integrations.catalog'
import { getRelayWorkspaceManager } from './relay-workspace'
import { loadStore, saveStore, type ProjectIntegration } from './store'

export type IntegrationAuthMethod = 'oauth' | 'token' | 'apikey'

export type IntegrationCapabilities = {
  webhook: boolean
  poll: boolean
  writeback: boolean
}

export type IntegrationAdapter = {
  provider: string
  displayName: string
  iconUrl?: string
  version: string
  capabilities: IntegrationCapabilities
  authMethod: IntegrationAuthMethod
  requiredScopes?: string[]
  defaultMountPaths: string[]
  description: string
}

export type ConnectedIntegration = {
  provider: string
  integrationId: string
  scope: Record<string, unknown>
  mountPaths: string[]
  connectedAt: string
  notifyAgent: boolean
  subscribeAgent?: boolean
  visibleInProject?: boolean
  localMountPaths?: string[]
  lastSyncAt?: string
  lastError?: string
}

export type IntegrationConnectStatus =
  | 'pending'
  | 'awaiting-user'
  | 'choosing-scope'
  | 'completed'
  | 'error'
  | 'expired'

export type IntegrationConnectSession = {
  sessionId: string
  provider: string
  status: IntegrationConnectStatus
  authUrl?: string
  scopeChoices?: Record<string, unknown>
  integrationId?: string
  error?: string
}

export type IntegrationsEvent =
  | { type: 'session-update'; sessionId: string; session: IntegrationConnectSession }
  | { type: 'integration-added'; projectId: string; integration: ConnectedIntegration }
  | { type: 'integration-removed'; projectId: string; integrationId: string }
  | { type: 'integration-error'; projectId: string; integrationId: string; message: string }

type StoredIntegration = ProjectIntegration & Partial<ConnectedIntegration> & {
  provider?: string
  integrationId?: string
}

type SessionMetadata = {
  projectId: string
  provider: string
  relayfileProvider: string
  startedAt: number
}

type ConnectSessionPayload = {
  connectLink: string | null
  connectionId?: string
  token?: string
  expiresAt?: string
}

type IntegrationStatusPayload = {
  ready?: boolean
  status?: string
  state?: string
  integrationId?: string
  connectionId?: string
  currentConnectionId?: string | null
  connectedAt?: string
  error?: string
  errorMessage?: string
  message?: string
  connection?: {
    id?: string
    integrationId?: string
    connectionId?: string
    currentConnectionId?: string | null
    ready?: boolean
    status?: string
    state?: string
    connectedAt?: string
    error?: string
    errorMessage?: string
    message?: string
  }
}

type WorkspaceIntegrationPayload = {
  provider?: unknown
  id?: unknown
  integrationId?: unknown
  connectionId?: unknown
  currentConnectionId?: unknown
  providerConfigKey?: unknown
  status?: unknown
  state?: unknown
  connectedAt?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  webhookHealth?: {
    healthy?: unknown
    lastError?: unknown
    lastEventAt?: unknown
  }
}

type IntegrationReadyPayload = {
  ready?: unknown
  status?: unknown
  state?: unknown
  connectedAt?: unknown
  connection?: {
    ready?: unknown
    status?: unknown
    state?: unknown
    connectedAt?: unknown
  }
}

type CloudAgentIntegrationsBridge = {
  updateMountPaths: (projectId: string, paths: string[]) => Promise<void> | void
}

type IntegrationSystemMessageBridge = {
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
}

const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 5 * 60_000
const CATALOG_CACHE_MS = 5 * 60_000
const CATALOG_PATH = '/api/v1/integrations/catalog'

// Only providers currently active in ../cloud are surfaced. This mirrors the
// non-deprecated relayfile providers in
// cloud/packages/web/lib/integrations/providers.ts
// (WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS). Both id spellings for Google
// Mail are included because the live cloud catalog uses `google-mail` while
// pear's static catalog uses `gmail`. Keep this in sync when cloud adds/removes
// a relayfile integration.
const ACTIVE_PROVIDERS = new Set([
  'github',
  'gitlab',
  'slack',
  'notion',
  'linear',
  'jira',
  'confluence',
  'gmail',
  'google-mail',
  'google-calendar',
  'hubspot',
  'granola',
  'fathom',
  'docker-hub'
])

function isActiveProvider(provider: string): boolean {
  return ACTIVE_PROVIDERS.has(provider.trim().toLowerCase())
}

function normalizeApiUrl(url: string | undefined): string {
  return (url || getApiUrl()).trim().replace(/\/+$/, '')
}

function buildApiUrl(apiUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), `${apiUrl}/`).toString()
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath)
  return child === '' || (!!child && !child.startsWith('..') && !isAbsolute(child))
}

function toRelayfileProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  return normalized === 'gmail' ? 'google-mail' : normalized
}

function isHttpStatus(error: unknown, status: number): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as {
    status?: unknown
    statusCode?: unknown
    httpStatus?: unknown
    response?: { status?: unknown }
  }
  return record.status === status
    || record.statusCode === status
    || record.httpStatus === status
    || record.response?.status === status
}

// Provider adapters materialize data at the workspace ROOT — `/github/...`,
// `/linear/...` (see each adapter's LAYOUT.md in the relayfile workspace).
// The catalog historically assumed `/integrations/<provider>/...`, which does
// not exist on the server, so every mount mirrored an empty tree. Rewrite
// both forms to the real root-level layout.
function rewriteIntegrationMountPath(mountPath: string, relayfileProvider: string): string {
  const prefixed = mountPath.match(/^\/integrations\/[^/]+(\/.*)?$/)
  if (prefixed) return `/${relayfileProvider}${prefixed[1] ?? ''}`
  const rootLevel = mountPath.match(/^\/[^/]+(\/.*)?$/)
  if (rootLevel) return `/${relayfileProvider}${rootLevel[1] ?? ''}`
  return mountPath
}

function normalizeCapabilities(value: unknown): IntegrationCapabilities {
  const record = isRecord(value) ? value : {}
  return {
    webhook: record.webhook === true,
    poll: record.poll === true,
    writeback: record.writeback === true
  }
}

function normalizeAuthMethod(value: unknown): IntegrationAuthMethod {
  return value === 'token' || value === 'apikey' ? value : 'oauth'
}

// Static metadata keyed by provider id (lowercased). The cloud catalog
// response only carries `id`/`displayName`/`backends`/etc.; it does NOT
// carry `iconUrl`, `capabilities`, or `description`. Without merging in
// the static catalog's entries for those, every cloud-catalog provider
// renders with a generic plug icon and a "Read only" label (capabilities
// all default to false).
const STATIC_METADATA_BY_PROVIDER: Map<string, IntegrationAdapter> = new Map(
  INTEGRATIONS_CATALOG.map((entry) => [entry.provider.trim().toLowerCase(), entry])
)

// Cloud's response lists each provider's `backends` (`["nango"]` and/or
// `["composio"]`). All currently-shipped nango/composio integrations are
// bidirectional (webhook + poll + writeback), so a missing
// `capabilities` field is treated as "all three" rather than the
// `normalizeCapabilities` "all three false" default. Without this
// override, cloud-only providers (granola, docker-hub) that have no
// static entry show as "Read only" even though they support full
// two-way sync via Relayfile.
function capabilitiesForCloudEntry(
  value: Record<string, unknown>,
  staticEntry: IntegrationAdapter | undefined,
): IntegrationCapabilities {
  if (isRecord(value.capabilities)) {
    return normalizeCapabilities(value.capabilities)
  }
  if (staticEntry) {
    return staticEntry.capabilities
  }
  const backends = stringList(value.backends)
  const isManagedBackend = backends.some((entry) => entry === 'nango' || entry === 'composio')
  if (isManagedBackend) {
    return { webhook: true, poll: true, writeback: true }
  }
  return normalizeCapabilities(value.capabilities)
}

// Synthesize a Nango template-logo URL for cloud-only providers that
// don't have a static-catalog entry. Pear's static catalog already
// points iconUrl at `https://app.nango.dev/images/template-logos/{id}.svg`
// for nango-backed providers, so reuse the same convention. Nango uses
// underscores in some slugs (`docker_hub`); the static catalog hard-codes
// the right URL per provider where the slug differs from cloud's id.
function nangoTemplateLogoUrl(id: string): string | undefined {
  const trimmed = id.trim().toLowerCase()
  if (!trimmed) return undefined
  const nangoSlug = trimmed === 'docker-hub' ? 'docker_hub' : trimmed
  return `https://app.nango.dev/images/template-logos/${nangoSlug}.svg`
}

function normalizeAdapter(value: unknown): IntegrationAdapter | null {
  if (!isRecord(value)) return null

  // Cloud's `/api/v1/integrations/catalog` response uses `id` per entry
  // (`cloud/packages/web/app/api/v1/integrations/catalog/route.ts`);
  // Pear's static fallback catalog uses `provider`. Accept either so the
  // live cloud catalog is usable without breaking the static-fallback
  // shape.
  const providerSource =
    typeof value.provider === 'string' && value.provider.trim()
      ? value.provider
      : typeof value.id === 'string'
        ? value.id
        : ''
  const provider = providerSource.trim()
  const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : provider
  if (!provider || !displayName) return null

  const staticEntry = STATIC_METADATA_BY_PROVIDER.get(provider.toLowerCase())

  // Field-by-field merge: prefer the live cloud value when present, fall
  // back to the static-catalog entry, then to a sensible default. Cloud's
  // payload is authoritative for id/displayName/availability; static is
  // authoritative for visual metadata + capabilities the cloud endpoint
  // doesn't yet expose.
  const iconUrl =
    (typeof value.iconUrl === 'string' && value.iconUrl.trim() ? value.iconUrl.trim() : undefined) ??
    staticEntry?.iconUrl ??
    nangoTemplateLogoUrl(provider)
  const version =
    typeof value.version === 'string' && value.version.trim()
      ? value.version.trim()
      : staticEntry?.version ?? '1.0.0'
  const description =
    typeof value.description === 'string' && value.description.trim()
      ? value.description
      : staticEntry?.description ?? ''
  const defaultMountPaths =
    stringList(value.defaultMountPaths).length > 0
      ? stringList(value.defaultMountPaths)
      : staticEntry?.defaultMountPaths ?? []
  const requiredScopes =
    stringList(value.requiredScopes).length > 0
      ? stringList(value.requiredScopes)
      : staticEntry?.requiredScopes ?? []
  const authMethod =
    typeof value.authMethod === 'string'
      ? normalizeAuthMethod(value.authMethod)
      : staticEntry?.authMethod ?? 'oauth'

  return {
    provider,
    displayName,
    ...(iconUrl ? { iconUrl } : {}),
    version,
    capabilities: capabilitiesForCloudEntry(value, staticEntry),
    authMethod,
    requiredScopes,
    defaultMountPaths,
    description
  }
}

function normalizeCatalogPayload(payload: unknown): IntegrationAdapter[] {
  // Cloud's live catalog responds with `{ providers: [...], version }`
  // (`cloud/packages/web/app/api/v1/integrations/catalog/route.ts`);
  // the older static and pre-1.0 shapes used `adapters` / `catalog`.
  // Without the `providers` key here the live response is treated as
  // empty and `listCatalog` falls back to the bundled static catalog —
  // which silently drops every cloud-only provider (granola, docker-hub,
  // and anything cloud adds after the last Pear release).
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.providers)
      ? payload.providers
      : isRecord(payload) && Array.isArray(payload.adapters)
        ? payload.adapters
        : isRecord(payload) && Array.isArray(payload.catalog)
          ? payload.catalog
          : []

  return list.map(normalizeAdapter).filter((entry): entry is IntegrationAdapter => entry !== null)
}

function loadStaticCatalog(): IntegrationAdapter[] {
  const result = normalizeCatalogPayload(INTEGRATIONS_CATALOG)
  if (result.length === 0) {
    console.warn('[integrations] Static catalog produced 0 adapters')
  }
  return result
}

function normalizeSessionStatus(value: unknown): IntegrationConnectStatus {
  switch (value) {
    case 'pending':
    case 'awaiting-user':
    case 'choosing-scope':
    case 'completed':
    case 'error':
    case 'expired':
      return value
    default:
      return 'pending'
  }
}

function normalizeSession(
  payload: unknown,
  fallback: Pick<IntegrationConnectSession, 'sessionId' | 'provider'>
): IntegrationConnectSession {
  const record = isRecord(payload) ? payload : {}
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.trim()
    ? record.sessionId.trim()
    : fallback.sessionId
  const provider = typeof record.provider === 'string' && record.provider.trim()
    ? record.provider.trim()
    : fallback.provider
  const authUrl = typeof record.authUrl === 'string' && record.authUrl.trim()
    ? record.authUrl.trim()
    : undefined
  const status = normalizeSessionStatus(record.status || (authUrl ? 'awaiting-user' : 'pending'))
  const scopeChoices = isRecord(record.scopeChoices) ? record.scopeChoices : undefined
  const integrationId = typeof record.integrationId === 'string' && record.integrationId.trim()
    ? record.integrationId.trim()
    : undefined
  const error = typeof record.error === 'string' && record.error.trim() ? record.error.trim() : undefined

  return {
    sessionId,
    provider,
    status,
    ...(authUrl ? { authUrl } : {}),
    ...(scopeChoices ? { scopeChoices } : {}),
    ...(integrationId ? { integrationId } : {}),
    ...(error ? { error } : {})
  }
}

function normalizeScope(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function normalizeConnectedIntegration(value: unknown): ConnectedIntegration | null {
  if (!isRecord(value)) return null

  const provider = typeof value.provider === 'string' && value.provider.trim()
    ? value.provider.trim()
    : typeof value.type === 'string' && value.type.trim()
      ? value.type.trim()
      : ''
  const integrationId = typeof value.integrationId === 'string' && value.integrationId.trim()
    ? value.integrationId.trim()
    : typeof value.id === 'string' && value.id.trim()
      ? value.id.trim()
      : typeof value.connectionId === 'string' && value.connectionId.trim()
        ? value.connectionId.trim()
        : typeof value.currentConnectionId === 'string' && value.currentConnectionId.trim()
          ? value.currentConnectionId.trim()
          : ''

  if (!provider || !integrationId) return null

  return {
    provider,
    integrationId,
    scope: normalizeScope(value.scope),
    mountPaths: dedupeStrings(stringList(value.mountPaths)),
    connectedAt: typeof value.connectedAt === 'string' && value.connectedAt.trim()
      ? value.connectedAt.trim()
      : new Date(0).toISOString(),
    notifyAgent: typeof value.notifyAgent === 'boolean' ? value.notifyAgent : true,
    subscribeAgent: typeof value.subscribeAgent === 'boolean' ? value.subscribeAgent : false,
    visibleInProject: typeof value.visibleInProject === 'boolean'
      ? value.visibleInProject
      : visibleFromScope(normalizeScope(value.scope)),
    localMountPaths: Array.isArray(value.localMountPaths)
      ? value.localMountPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [],
    ...(typeof value.lastSyncAt === 'string' ? { lastSyncAt: value.lastSyncAt } : {}),
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {})
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toStoredIntegration(integration: ConnectedIntegration, displayName?: string): StoredIntegration {
  return {
    id: integration.integrationId,
    name: displayName || integration.provider,
    type: integration.provider,
    provider: integration.provider,
    integrationId: integration.integrationId,
    scope: integration.scope,
    mountPaths: integration.mountPaths,
    connectedAt: integration.connectedAt,
    notifyAgent: integration.notifyAgent,
    subscribeAgent: integration.subscribeAgent === true,
    visibleInProject: integration.visibleInProject !== false,
    ...(integration.lastSyncAt ? { lastSyncAt: integration.lastSyncAt } : {}),
    ...(integration.lastError ? { lastError: integration.lastError } : {})
  }
}

function visibleFromScope(scope: Record<string, unknown>): boolean {
  const visibility = scope.projectVisibility
  if (!visibility || typeof visibility !== 'object' || Array.isArray(visibility)) return true
  const visible = (visibility as Record<string, unknown>).visible
  return typeof visible === 'boolean' ? visible : true
}

function getPayloadMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    for (const key of ['error', 'message', 'detail']) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  return fallback
}

function collectScopeLabels(scope: Record<string, unknown>): string[] {
  const labels: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      labels.push(value.trim())
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (isRecord(value)) {
      for (const entry of Object.values(value)) visit(entry)
    }
  }

  visit(scope)
  return dedupeStrings(labels)
}

export class IntegrationsManager {
  private listeners = new Set<(event: IntegrationsEvent) => void>()
  private sessions = new Map<string, IntegrationConnectSession>()
  private sessionMetadata = new Map<string, SessionMetadata>()
  private pollTimers = new Map<string, NodeJS.Timeout>()
  private catalogCache: IntegrationAdapter[] | null = null
  private catalogFetchedAt = 0

  onEvent(handler: (event: IntegrationsEvent) => void): () => void {
    this.listeners.add(handler)
    return () => {
      this.listeners.delete(handler)
    }
  }

  async listCatalog(): Promise<IntegrationAdapter[]> {
    if (this.catalogCache && Date.now() - this.catalogFetchedAt < CATALOG_CACHE_MS) {
      return this.catalogCache
    }

    try {
      const payload = await this.fetchJson<unknown>('GET', CATALOG_PATH, undefined, false)
      const catalog = normalizeCatalogPayload(payload).filter((adapter) => isActiveProvider(adapter.provider))
      if (catalog.length > 0) {
        this.catalogCache = catalog
        this.catalogFetchedAt = Date.now()
        return catalog
      }
    } catch (error) {
      console.warn('[integrations] Live catalog unavailable, using static fallback:', toErrorMessage(error))
    }

    const fallback = loadStaticCatalog().filter((adapter) => isActiveProvider(adapter.provider))
    this.catalogCache = fallback
    this.catalogFetchedAt = Date.now()
    return fallback
  }

  async listAvailableIntegrations(): Promise<IntegrationAdapter[]> {
    return this.listCatalog()
  }

  listConnected(projectId: string): ConnectedIntegration[] {
    const project = this.findProject(projectId)
    if (!project) return []

    return project.integrations
      .map((integration) => normalizeConnectedIntegration(integration))
      .filter((integration): integration is ConnectedIntegration => integration !== null)
  }

  async listConnectedForSettings(projectId: string): Promise<ConnectedIntegration[]> {
    const local = this.listConnected(projectId)
    const project = this.findProject(projectId)
    if (!project) {
      console.warn(`[integrations] listConnectedForSettings: project ${projectId} not found in local store; returning local list only (${local.length} items)`)
      return this.withLocalMountPaths(local)
    }

    try {
      const cloud = await this.listCloudWorkspaceIntegrations()
      if (cloud.length === 0) {
        console.log(`[integrations] listConnectedForSettings: cloud returned 0 integrations for workspace; using local list only (${local.length} items)`)
        return this.withLocalMountPaths(local)
      }
      return this.withLocalMountPaths(await this.mergeCloudIntegrationsIntoProject(projectId, cloud))
    } catch (error) {
      // Surface the failure to the renderer instead of silently downgrading to
      // an empty list. The UI catches and renders this in the error banner so
      // the user can see "cloud-auth-required" (restart needed) vs "network"
      // vs "workspace mismatch" instead of staring at an empty Connected
      // section with no explanation. Local list is still saved on disk and
      // surfaced through the project-scoped APIs.
      const message = toErrorMessage(error)
      console.warn('[integrations] Failed to hydrate cloud workspace integrations:', message)
      throw new Error(`Cloud integrations unavailable: ${message}`)
    }
  }

  async listMountDirectory(projectId: string, integrationId: string, dirPath: string): Promise<filesystem.ExplorerEntry[]> {
    const resolvedPath = await this.resolveIntegrationMountPath(projectId, integrationId, dirPath)
    return filesystem.listDirectory(resolvedPath)
  }

  async readMountPreview(projectId: string, integrationId: string, filePath: string): Promise<filesystem.FilePreview> {
    const resolvedPath = await this.resolveIntegrationMountPath(projectId, integrationId, filePath)
    return filesystem.readTextPreview(resolvedPath)
  }

  async startLocalMountDaemon(): Promise<void> {
    await this.syncLocalMounts()
    await this.syncAllEventSubscriptions()
  }

  async shutdownLocalMounts(): Promise<void> {
    // Unlink the per-project `.integrations` symlinks before stopping the
    // mounts so a closed app leaves no dangling links in project trees.
    await Promise.all(
      loadStore().projects.map((project) =>
        removeProjectIntegrationsLink(project.rootPath).catch(() => undefined)
      )
    )
    await Promise.all([
      integrationMountManager.stop(),
      integrationEventBridge.closeAll()
    ])
  }

  async startConnect(projectId: string, provider: string): Promise<IntegrationConnectSession> {
    const normalizedProvider = provider.trim()
    if (!normalizedProvider) throw new Error('Integration provider is required')

    const relayfileProvider = toRelayfileProvider(normalizedProvider)
    const alreadyConnected = await this.isAlreadyConnected(normalizedProvider, relayfileProvider)
    if (alreadyConnected) {
      const session = alreadyConnected
      this.sessions.set(session.sessionId, session)
      this.sessionMetadata.set(session.sessionId, {
        projectId,
        provider: normalizedProvider,
        relayfileProvider,
        startedAt: Date.now()
      })
      this.emit({ type: 'session-update', sessionId: session.sessionId, session })
      return session
    }

    const payload = await this.requestConnectSession(relayfileProvider)
    const session = normalizeSession(payload, {
      sessionId: payload.connectionId || payload.token || randomUUID(),
      provider: normalizedProvider
    })
    const normalizedSession: IntegrationConnectSession = {
      ...session,
      status: payload.connectLink ? 'awaiting-user' : session.status,
      ...(payload.connectLink ? { authUrl: payload.connectLink } : {}),
      ...(payload.connectionId ? { integrationId: payload.connectionId } : {})
    }

    this.sessions.set(normalizedSession.sessionId, normalizedSession)
    this.sessionMetadata.set(normalizedSession.sessionId, {
      projectId,
      provider: normalizedProvider,
      relayfileProvider,
      startedAt: Date.now()
    })
    this.emit({ type: 'session-update', sessionId: normalizedSession.sessionId, session: normalizedSession })

    if (payload.connectLink) {
      await shell.openExternal(payload.connectLink)
    }

    if (!this.isTerminalSession(normalizedSession.status)) {
      this.startPolling(normalizedSession.sessionId)
    }

    return normalizedSession
  }

  async pollConnect(sessionId: string): Promise<IntegrationConnectSession> {
    const existing = this.sessions.get(sessionId)
    const metadata = this.sessionMetadata.get(sessionId)
    if (!existing || !metadata) throw new Error(`Unknown integration connect session: ${sessionId}`)

    let payload: IntegrationStatusPayload
    try {
      payload = await this.getIntegrationStatus(metadata.relayfileProvider)
    } catch (error) {
      if (isHttpStatus(error, 404)) return existing

      const failed: IntegrationConnectSession = {
        ...existing,
        status: 'error',
        error: toErrorMessage(error)
      }
      this.sessions.set(sessionId, failed)
      this.emit({ type: 'session-update', sessionId, session: failed })
      this.stopPolling(sessionId)
      return failed
    }

    const session = this.sessionFromStatusPayload(payload, existing, metadata.provider)
    this.sessions.set(session.sessionId, session)
    this.emit({ type: 'session-update', sessionId: session.sessionId, session })

    if (this.isTerminalSession(session.status)) {
      this.stopPolling(session.sessionId)
    }

    return session
  }

  async completeConnect(
    projectId: string,
    sessionId: string,
    scope: Record<string, unknown>,
    mountPaths: string[],
    notifyAgent: boolean
  ): Promise<ConnectedIntegration> {
    const session = await this.ensureCompletedSession(sessionId)
    const provider = session.provider
    const integrationId = session.integrationId
    if (!integrationId) throw new Error('Integration connect session has no integration id')

    const integration: ConnectedIntegration = {
      provider,
      integrationId,
      scope,
      mountPaths,
      connectedAt: new Date().toISOString(),
      notifyAgent,
      subscribeAgent: false
    }

    await this.persistIntegration(projectId, integration)
    await this.syncAgentState(projectId, notifyAgent)
    this.emit({ type: 'integration-added', projectId, integration })
    return integration
  }

  async updateScope(
    projectId: string,
    integrationId: string,
    scope: Record<string, unknown>,
    mountPaths: string[]
  ): Promise<ConnectedIntegration> {
    const existing = this.requireConnectedIntegration(projectId, integrationId)
    const integration: ConnectedIntegration = {
      ...existing,
      scope,
      mountPaths,
      notifyAgent: existing.notifyAgent,
      subscribeAgent: existing.subscribeAgent === true,
      visibleInProject: visibleFromScope(scope)
    }

    await this.persistIntegration(projectId, integration)
    await this.syncAgentState(projectId, integration.notifyAgent)
    this.emit({ type: 'integration-added', projectId, integration })
    return integration
  }

  async updateSubscription(
    projectId: string,
    integrationId: string,
    subscribeAgent: boolean
  ): Promise<ConnectedIntegration> {
    const existing = this.requireConnectedIntegration(projectId, integrationId)
    const integration: ConnectedIntegration = {
      ...existing,
      subscribeAgent
    }

    await this.persistIntegration(projectId, integration)
    await this.syncAgentState(projectId, true)
    this.emit({ type: 'integration-added', projectId, integration })
    return integration
  }

  async disconnect(projectId: string, integrationId: string): Promise<void> {
    const existing = this.requireConnectedIntegration(projectId, integrationId)

    await this.deleteIntegrationConnection(toRelayfileProvider(existing.provider))

    const affectedProjectIds = this.removePersistedIntegrationEverywhere(existing)
    await Promise.all(affectedProjectIds.map((affectedProjectId) => this.syncAgentState(affectedProjectId, true)))
    for (const affectedProjectId of affectedProjectIds) {
      this.emit({ type: 'integration-removed', projectId: affectedProjectId, integrationId: existing.integrationId })
    }
  }

  async hydrateProject(projectId: string): Promise<void> {
    await this.syncAgentState(projectId, true)
    await this.syncEventSubscriptions(projectId)
  }

  private emit(event: IntegrationsEvent): void {
    for (const handler of Array.from(this.listeners)) {
      handler(event)
    }

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('integrations:event', event)
      }
    }
  }

  private async fetchJson<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    requireAuth = true
  ): Promise<T> {
    const auth = await this.authHeaders(requireAuth, body !== undefined)
    const response = await fetch(buildApiUrl(auth.apiUrl, path), {
      method,
      headers: auth.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const payload = await response.json().catch(() => null) as unknown

    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${getPayloadMessage(payload, response.statusText)}`)
    }

    return payload as T
  }

  private async authHeaders(requireAuth: boolean, hasBody = false): Promise<{ apiUrl: string; headers: Record<string, string> }> {
    const auth = await resolveCloudAuth()
    const headers: Record<string, string> = {}
    if (hasBody) headers['Content-Type'] = 'application/json'

    if (auth) {
      headers.Authorization = `Bearer ${auth.accessToken}`
      return { apiUrl: auth.apiUrl, headers }
    }

    if (requireAuth) throw new Error('cloud-auth-required')
    return { apiUrl: normalizeApiUrl(undefined), headers }
  }

  private async withWorkspaceHandle<T>(fn: (handle: WorkspaceHandle) => Promise<T>): Promise<T> {
    return getRelayWorkspaceManager().withHandle(fn)
  }

  private async requestConnectSession(relayfileProvider: string): Promise<ConnectSessionPayload> {
    return this.withWorkspaceHandle(async (handle) => await handle.requestJson({
      operation: 'connectIntegration',
      method: 'POST',
      path: `api/v1/workspaces/${handle.workspaceId}/integrations/connect-session`,
      body: { allowedIntegrations: [relayfileProvider] }
    }) as ConnectSessionPayload)
  }

  private async getIntegrationStatus(relayfileProvider: string): Promise<IntegrationStatusPayload> {
    const handle = await getRelayWorkspaceManager().getWorkspaceHandle()
    const request = async (): Promise<IntegrationStatusPayload> => await handle.requestJson({
      operation: 'waitForConnection',
      method: 'GET',
      path: this.integrationStatusPath(handle, relayfileProvider)
    }) as IntegrationStatusPayload

    try {
      return await request()
    } catch (error) {
      if (!isHttpStatus(error, 401)) throw error
      await handle.refreshToken()
      return request()
    }
  }

  private async listCloudWorkspaceIntegrations(): Promise<ConnectedIntegration[]> {
    const workspaceId = await getAccountWorkspaceId(accountWorkspaceReadyRetryOptions())
    // The list is addressed by the account (app) workspace UUID, so it must be
    // authorized with the account access token, not the Relayfile workspace
    // handle. The handle's JWT is scoped to Pear's locally-created `rw_*`
    // workspace, which the cloud has no binding for, so the cloud's
    // hasWorkspaceAccess check rejects it as 403 Forbidden. (connect-session and
    // status calls still use the handle because they address `handle.workspaceId`
    // directly.) See cloud workspace-integration-identity.ts. The account token
    // resolves to currentWorkspace=workspaceId on cloud (same path as whoami),
    // so this is the authorized way to read account-level integrations.
    const payload = await this.fetchJson<unknown>(
      'GET',
      `api/v1/workspaces/${workspaceId}/integrations`
    )
    const normalized = await this.normalizeWorkspaceIntegrationList(payload)
    const rawCount = Array.isArray(payload)
      ? payload.length
      : isRecord(payload) && Array.isArray(payload.integrations)
        ? payload.integrations.length
        : isRecord(payload) && Array.isArray(payload.data)
          ? payload.data.length
          : 0
    // Quick sanity log so it's obvious from the main-process terminal which
    // workspace is being queried and which providers survived the
    // statusPayloadReady filter (see normalizeWorkspaceIntegrationList).
    console.log(
      `[integrations] cloud workspace=${workspaceId} raw=${rawCount} kept=${normalized.length} providers=${normalized.map((entry) => entry.provider).join(',') || '(none)'}`
    )
    return normalized
  }

  private async normalizeWorkspaceIntegrationList(payload: unknown): Promise<ConnectedIntegration[]> {
    const entries = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.integrations)
        ? payload.integrations
        : isRecord(payload) && Array.isArray(payload.data)
          ? payload.data
          : []

    const catalog = await this.listCatalog()
    const adapterByProvider = new Map(catalog.map((adapter) => [toRelayfileProvider(adapter.provider), adapter]))
    const integrations: ConnectedIntegration[] = []

    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const payloadEntry = entry as WorkspaceIntegrationPayload
      const provider = readString(payloadEntry.provider)
      const integrationId =
        readString(payloadEntry.integrationId) ||
        readString(payloadEntry.id) ||
        readString(payloadEntry.connectionId) ||
        readString(payloadEntry.currentConnectionId)

      if (!provider || !integrationId) continue
      if (!this.statusPayloadReady(payloadEntry)) continue

      const adapter = adapterByProvider.get(toRelayfileProvider(provider))
      const providerConfigKey = readString(payloadEntry.providerConfigKey)
      const lastError =
        payloadEntry.webhookHealth?.healthy === false
          ? readString(payloadEntry.webhookHealth.lastError)
          : undefined

      integrations.push({
        provider,
        integrationId,
        scope: {
          provider,
          ...(providerConfigKey ? { providerConfigKey } : {})
        },
        mountPaths: adapter?.defaultMountPaths ?? [`/integrations/${toRelayfileProvider(provider)}`],
        connectedAt:
          readString(payloadEntry.connectedAt) ||
          readString(payloadEntry.createdAt) ||
          readString(payloadEntry.updatedAt) ||
          new Date(0).toISOString(),
        notifyAgent: true,
        ...(lastError ? { lastError } : {})
      })
    }

    return integrations
  }

  private async deleteIntegrationConnection(relayfileProvider: string): Promise<void> {
    await this.withWorkspaceHandle(async (handle) => {
      await handle.requestJson({
        operation: 'disconnectIntegration',
        method: 'DELETE',
        path: this.integrationResourcePath(handle, relayfileProvider)
      })
    })
  }

  private integrationResourcePath(handle: WorkspaceHandle, relayfileProvider: string): string {
    return `api/v1/workspaces/${handle.workspaceId}/integrations/${encodeURIComponent(relayfileProvider)}`
  }

  private integrationStatusPath(handle: WorkspaceHandle, relayfileProvider: string): string {
    return `api/v1/workspaces/${handle.workspaceId}/integrations/${encodeURIComponent(relayfileProvider)}/status`
  }

  private async isAlreadyConnected(provider: string, relayfileProvider: string): Promise<IntegrationConnectSession | null> {
    try {
      const payload = await this.getIntegrationStatus(relayfileProvider)
      if (!this.statusPayloadReady(payload)) return null

      return {
        sessionId: this.connectionIdFromStatusPayload(payload) || Date.now().toString(36),
        provider,
        status: 'completed',
        integrationId: this.connectionIdFromStatusPayload(payload) || relayfileProvider
      }
    } catch {
      return null
    }
  }

  private sessionFromStatusPayload(
    payload: IntegrationStatusPayload,
    existing: IntegrationConnectSession,
    provider: string
  ): IntegrationConnectSession {
    const error = this.errorFromStatusPayload(payload)
    return normalizeSession({
      ...existing,
      provider,
      status: this.statusFromPayload(payload, existing.status),
      integrationId: this.connectionIdFromStatusPayload(payload) || existing.integrationId,
      ...(error ? { error } : {})
    }, existing)
  }

  private statusPayloadReady(payload: IntegrationReadyPayload): boolean {
    return payload.ready === true ||
      payload.connection?.ready === true ||
      this.isReadyStatus(payload.status) ||
      this.isReadyStatus(payload.state) ||
      this.isReadyStatus(payload.connection?.status) ||
      this.isReadyStatus(payload.connection?.state) ||
      Boolean(payload.connectedAt || payload.connection?.connectedAt)
  }

  private isReadyStatus(value: unknown): boolean {
    if (typeof value !== 'string') return false
    return ['ready', 'connected', 'complete', 'completed', 'success', 'active'].includes(value.trim().toLowerCase())
  }

  private statusFromPayload(
    payload: IntegrationStatusPayload,
    fallback: IntegrationConnectStatus
  ): IntegrationConnectStatus {
    if (this.statusPayloadReady(payload)) return 'completed'
    switch (payload.status) {
      case 'pending':
        return 'pending'
      case 'awaiting-user':
        return 'awaiting-user'
      case 'error':
        return 'error'
      case 'expired':
        return 'expired'
      default:
        return payload.state === 'error' ? 'error' : fallback
    }
  }

  private connectionIdFromStatusPayload(payload: IntegrationStatusPayload): string | undefined {
    const connection = payload.connection
    return payload.integrationId
      || payload.connectionId
      || payload.currentConnectionId
      || connection?.integrationId
      || connection?.connectionId
      || connection?.currentConnectionId
      || connection?.id
      || undefined
  }

  private errorFromStatusPayload(payload: IntegrationStatusPayload): string | undefined {
    const connection = payload.connection
    return payload.errorMessage
      || payload.error
      || payload.message
      || connection?.errorMessage
      || connection?.error
      || connection?.message
      || undefined
  }

  private findProject(projectId: string) {
    return loadStore().projects.find((project) => project.id === projectId) || null
  }

  private async mergeCloudIntegrationsIntoProject(
    projectId: string,
    cloudIntegrations: ConnectedIntegration[]
  ): Promise<ConnectedIntegration[]> {
    const data = loadStore()
    const project = data.projects.find((entry) => entry.id === projectId)
    if (!project) return this.listConnected(projectId)

    const catalog = await this.listCatalog()
    const displayNameByProvider = new Map(catalog.map((adapter) => [adapter.provider, adapter.displayName]))
    const existing = project.integrations
      .map((integration) => normalizeConnectedIntegration(integration))
      .filter((integration): integration is ConnectedIntegration => integration !== null)
    const existingById = new Map(existing.map((integration) => [integration.integrationId, integration]))
    const existingByProvider = new Map(existing.map((integration) => [toRelayfileProvider(integration.provider), integration]))
    let changed = false

    for (const cloudIntegration of cloudIntegrations) {
      const existingIntegration =
        existingById.get(cloudIntegration.integrationId) ||
        existingByProvider.get(toRelayfileProvider(cloudIntegration.provider))
      const existingVisible = existingIntegration?.visibleInProject !== false
      const merged: ConnectedIntegration = existingIntegration
        ? {
            ...cloudIntegration,
            scope: Object.keys(existingIntegration.scope).length > 0 ? existingIntegration.scope : cloudIntegration.scope,
            mountPaths: existingVisible && existingIntegration.mountPaths.length === 0
              ? cloudIntegration.mountPaths
              : existingIntegration.mountPaths,
            notifyAgent: existingIntegration.notifyAgent,
            subscribeAgent: existingIntegration.subscribeAgent === true,
            visibleInProject: existingVisible,
            connectedAt: existingIntegration.connectedAt || cloudIntegration.connectedAt,
            ...(cloudIntegration.lastError ? { lastError: cloudIntegration.lastError } : {})
          }
        : cloudIntegration
      const stored = toStoredIntegration(merged, displayNameByProvider.get(merged.provider) || merged.provider)
      const currentIndex = project.integrations.findIndex((entry) => {
        const current = normalizeConnectedIntegration(entry)
        return current?.integrationId === merged.integrationId ||
          (current ? toRelayfileProvider(current.provider) === toRelayfileProvider(merged.provider) : false)
      })

      if (currentIndex >= 0) {
        const current = JSON.stringify(project.integrations[currentIndex])
        const next = JSON.stringify(stored)
        if (current !== next) {
          project.integrations[currentIndex] = stored
          changed = true
        }
      } else {
        project.integrations.push(stored)
        changed = true
      }
    }

    if (changed) saveStore(data)
    return this.listConnected(projectId)
  }

  private startPolling(sessionId: string): void {
    if (this.pollTimers.has(sessionId)) return

    const tick = (): void => {
      this.pollTimers.delete(sessionId)
      const existing = this.sessions.get(sessionId)
      const metadata = this.sessionMetadata.get(sessionId)
      if (!existing || !metadata || this.isTerminalSession(existing.status)) {
        this.stopPolling(sessionId)
        return
      }

      if (Date.now() - metadata.startedAt > POLL_TIMEOUT_MS) {
        const expired: IntegrationConnectSession = { ...existing, status: 'expired' }
        this.sessions.set(sessionId, expired)
        this.emit({ type: 'session-update', sessionId, session: expired })
        this.stopPolling(sessionId)
        return
      }

      void this.pollConnect(sessionId)
        .catch((error) => {
          const failed: IntegrationConnectSession = {
            ...existing,
            status: 'error',
            error: toErrorMessage(error)
          }
          this.sessions.set(sessionId, failed)
          this.emit({ type: 'session-update', sessionId, session: failed })
          this.stopPolling(sessionId)
        })
        .finally(() => {
          const current = this.sessions.get(sessionId)
          if (current && !this.isTerminalSession(current.status) && !this.pollTimers.has(sessionId)) {
            this.pollTimers.set(sessionId, setTimeout(tick, POLL_INTERVAL_MS))
          }
        })
    }

    this.pollTimers.set(sessionId, setTimeout(tick, POLL_INTERVAL_MS))
  }

  private stopPolling(sessionId: string): void {
    const timer = this.pollTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.pollTimers.delete(sessionId)
  }

  private isTerminalSession(status: IntegrationConnectStatus): boolean {
    return status === 'completed' || status === 'error' || status === 'expired'
  }

  private async ensureCompletedSession(sessionId: string): Promise<IntegrationConnectSession> {
    const existing = this.sessions.get(sessionId)
    if (!existing) throw new Error(`Unknown integration connect session: ${sessionId}`)
    if (existing.status === 'completed' && existing.integrationId) return existing

    const polled = await this.pollConnect(sessionId)
    if (polled.status !== 'completed' || !polled.integrationId) {
      throw new Error(`Integration connect session is ${polled.status}`)
    }

    return polled
  }

  private integrationFromPayload(payload: unknown, fallback: ConnectedIntegration): ConnectedIntegration {
    return normalizeConnectedIntegration({
      ...fallback,
      ...(isRecord(payload) ? payload.integration || payload : {})
    }) || fallback
  }

  private requireConnectedIntegration(projectId: string, integrationId: string): ConnectedIntegration {
    const integration = this.listConnected(projectId).find((entry) => entry.integrationId === integrationId)
    if (!integration) throw new Error(`Integration not found: ${integrationId}`)
    return integration
  }

  private async persistIntegration(projectId: string, integration: ConnectedIntegration): Promise<void> {
    // Resolve the async displayName lookup BEFORE touching the store so the
    // load → modify → save sequence stays synchronous. Otherwise an awaited
    // network fetch (when the 5-minute catalog cache is stale) creates an
    // async gap during which another IPC handler can write to projects.json
    // and have its changes silently overwritten when we save back the stale
    // `data` we loaded before the await. Mirrors removePersistedIntegration's
    // synchronous load/modify/save shape below.
    const displayName = await this.displayNameForProvider(integration.provider)
    const stored = toStoredIntegration(integration, displayName)

    const data = loadStore()
    const project = data.projects.find((entry) => entry.id === projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)

    project.integrations = project.integrations.filter((entry) => {
      const current = normalizeConnectedIntegration(entry)
      return current?.integrationId !== integration.integrationId
    })
    project.integrations.push(stored)
    saveStore(data)
  }

  private removePersistedIntegrationEverywhere(integration: ConnectedIntegration): string[] {
    const data = loadStore()
    const affectedProjectIds: string[] = []
    const provider = toRelayfileProvider(integration.provider)

    for (const project of data.projects) {
      const before = project.integrations.length
      project.integrations = project.integrations.filter((entry) => {
        const current = normalizeConnectedIntegration(entry)
        if (!current) return true
        return current.integrationId !== integration.integrationId &&
          toRelayfileProvider(current.provider) !== provider
      })
      if (project.integrations.length !== before) affectedProjectIds.push(project.id)
    }

    if (affectedProjectIds.length > 0) saveStore(data)
    return affectedProjectIds
  }

  private async displayNameForProvider(provider: string): Promise<string> {
    const adapter = (await this.listCatalog()).find((entry) => entry.provider === provider)
    return adapter?.displayName || provider
  }

  mountPathsFor(projectId: string): string[] {
    return dedupeStrings(
      this.listConnected(projectId)
        .filter((integration) => this.isVisibleInProject(projectId, integration.integrationId))
        .flatMap((integration) => this.canonicalMountPathsForIntegration(integration))
    )
  }

  private isVisibleInProject(projectId: string, integrationId: string): boolean {
    const integration = this.listConnected(projectId).find((entry) => entry.integrationId === integrationId)
    return integration?.visibleInProject !== false
  }

  private async syncAgentState(projectId: string, notifyAgent: boolean): Promise<void> {
    let integrations = this.visibleIntegrationsForProject(projectId)
    await this.syncLocalMounts()
    integrations = await this.withLocalMountPaths(integrations)
    await this.safeUpdateMountPaths(projectId, this.mountPathsFor(projectId))
    const subscriptionsReady = await this.syncEventSubscriptions(projectId)

    if (notifyAgent) {
      await this.safeInjectSystemMessage(projectId, this.buildSystemMessageSnippet(integrations, subscriptionsReady))
    }
  }

  private buildSystemMessageSnippet(integrations: ConnectedIntegration[], subscriptionsReady: boolean): string {
    const lines = [
      '<integrations-update>',
      'The user has connected the following integrations to this project:'
    ]

    if (integrations.length === 0) {
      lines.push('- none')
    } else {
      for (const integration of integrations) {
        const scopeLabels = collectScopeLabels(integration.scope)
        const scopeSummary = scopeLabels.length > 0 ? scopeLabels.join(', ') : 'all configured scope'
        const mountPaths = this.canonicalMountPathsForIntegration(integration)
        const mountClause = mountPaths.length > 0
          ? ` (mounted at ${mountPaths.join(', ')})`
          : ' (no mount paths configured)'
        lines.push(`- ${integration.provider}: ${scopeSummary}${mountClause}.`)
      }
    }

    const subscriptions = integrationSubscriptionSummaries(integrations)
    lines.push('')
    if (!subscriptionsReady && subscriptions.length > 0) {
      lines.push('Integration event subscriptions are requested for this project, but Pear could not register them with Relayfile yet.')
      lines.push('Do not assume notifications will arrive until a later integrations update confirms active subscriptions; read the mounted integration files when the user asks for current state.')
    } else if (subscriptions.length === 0) {
      lines.push('No integration event subscriptions are active for this project.')
    } else {
      lines.push('Active integration event subscriptions for this project:')
      for (const subscription of subscriptions) {
        const parts = [
          subscription.watches.length > 0 ? `file changes at ${subscription.watches.join(', ')}` : '',
          subscription.targets.length > 0 ? `delivered to ${subscription.targets.join(', ')}` : 'delivered to all project agents'
        ].filter(Boolean)
        lines.push(`- ${subscription.provider}: ${parts.join('; ')}`)
      }
      lines.push(
        'You will receive <integration-event> system messages for these subscribed changes. Do not poll these integrations for background changes; wait for the event notification, then read the mounted files for context if needed.'
      )
    }

    lines.push(
      'When relevant to the user\'s request, read these mounts to access live data. Edits to JSON files in writeback-enabled paths will push back to the SaaS API.',
      '</integrations-update>'
    )
    return lines.join('\n')
  }

  private canonicalMountPathsForIntegration(integration: ConnectedIntegration): string[] {
    return dedupeStrings(
      integration.mountPaths.map((mountPath) =>
        rewriteIntegrationMountPath(mountPath, toRelayfileProvider(integration.provider))
      )
    )
  }

  private async safeInjectSystemMessage(projectId: string, message: string): Promise<void> {
    try {
      const bridge = brokerManager as unknown as IntegrationSystemMessageBridge
      const agents = await bridge.listAgents(projectId)
      await Promise.all(
        agents
          .filter((agent) => agent.projectId === undefined || agent.projectId === projectId)
          .map((agent) => bridge.sendMessage(projectId, {
            to: agent.name,
            from: 'system',
            text: message,
            priority: 0,
            mode: 'steer',
            data: {
              kind: 'integrations-update',
              system: true
            }
          }))
      )
    } catch (error) {
      console.warn('[integrations] Failed to inject integration system message:', toErrorMessage(error))
    }
  }

  private async safeUpdateMountPaths(projectId: string, paths: string[]): Promise<void> {
    try {
      const bridge: CloudAgentIntegrationsBridge = cloudAgentManager
      await bridge.updateMountPaths(projectId, paths)
    } catch (error) {
      console.warn('[integrations] Failed to update integration mount paths:', toErrorMessage(error))
    }
  }

  private async syncEventSubscriptions(projectId: string): Promise<boolean> {
    try {
      await integrationEventBridge.reconcile(projectId, this.visibleIntegrationsForProject(projectId))
      return true
    } catch (error) {
      console.warn('[integrations] Failed to reconcile integration event subscriptions:', toErrorMessage(error))
      return false
    }
  }

  private async syncAllEventSubscriptions(): Promise<void> {
    await Promise.all(loadStore().projects.map((project) => this.syncEventSubscriptions(project.id)))
  }

  private async syncLocalMounts(): Promise<void> {
    const localEntries = loadStore().projects.flatMap((project) =>
      this.listConnected(project.id).map((integration) => ({
        projectId: project.id,
        integration
      }))
    )
    const cloudIntegrations = await this.listCloudWorkspaceIntegrations().catch(() => [])
    const byProvider = new Map<string, ConnectedIntegration>()
    const configuredKeys = new Set(localEntries.map(({ integration }) =>
      `${toRelayfileProvider(integration.provider)}:${integration.integrationId}`
    ))
    for (const integration of cloudIntegrations) {
      const key = `${toRelayfileProvider(integration.provider)}:${integration.integrationId}`
      if (!configuredKeys.has(key)) byProvider.set(key, integration)
    }
    for (const { projectId, integration } of localEntries) {
      if (!this.isVisibleInProject(projectId, integration.integrationId)) continue
      byProvider.set(`${toRelayfileProvider(integration.provider)}:${integration.integrationId}`, integration)
    }
    const integrations = Array.from(byProvider.values())
    try {
      await integrationMountManager.ensureMounted(integrations.map((integration) => ({
        provider: integration.provider,
        mountPaths: this.canonicalMountPathsForIntegration(integration)
      })))
    } catch (error) {
      console.warn('[integrations] Failed to reconcile local integration mount:', toErrorMessage(error))
    }
    await this.syncProjectIntegrationLinks(integrations.length > 0)
  }

  // Mirror the workspace's integration data into each project via a
  // git-ignored `.integrations` symlink so local agents can read it from
  // their cwd. Removed on app shutdown (see shutdownLocalMounts).
  private async syncProjectIntegrationLinks(hasIntegrations: boolean): Promise<void> {
    const workspaceId = integrationMountManager.currentWorkspaceId()
    const projects = loadStore().projects
    await Promise.all(projects.map(async (project) => {
      try {
        if (hasIntegrations && workspaceId) {
          await ensureProjectIntegrationsLink(project.rootPath, workspaceId)
        } else {
          await removeProjectIntegrationsLink(project.rootPath)
        }
      } catch (error) {
        console.warn(
          `[integrations] Failed to sync integration symlink for ${project.rootPath}:`,
          toErrorMessage(error)
        )
      }
    }))
  }

  private async withLocalMountPaths(integrations: ConnectedIntegration[]): Promise<ConnectedIntegration[]> {
    await this.syncLocalMounts()
    const workspaceId = integrationMountManager.currentWorkspaceId()
    if (!workspaceId) return integrations
    return integrations.map((integration) => ({
      ...integration,
      localMountPaths: integrationMountManager.localPathsFor(workspaceId, {
        provider: integration.provider,
        mountPaths: this.canonicalMountPathsForIntegration(integration)
      })
    }))
  }

  private async resolveIntegrationMountPath(projectId: string, integrationId: string, targetPath: string): Promise<string> {
    const resolvedPath = resolve(targetPath)
    const localIntegrations = await this.withLocalMountPaths(this.listConnected(projectId))
    let integrations = localIntegrations
    let integration = this.findIntegrationForMountPath(integrations, integrationId, resolvedPath)

    if (!integration) {
      integrations = await this.listConnectedForSettings(projectId).catch((error) => {
        console.warn('[integrations] Failed to refresh integrations for mount browser:', toErrorMessage(error))
        return localIntegrations
      })
      integration = this.findIntegrationForMountPath(integrations, integrationId, resolvedPath)
    }

    if (!integration) {
      // The integration list is refreshed from cloud, and a transient status
      // filter (e.g. webhook health) can drop an integration between the UI
      // render and the click. Its mirrored files are still on disk, so fall
      // back to confining the path to the workspace's integrations mount
      // root — the same boundary the per-integration roots live under.
      const workspaceId = integrationMountManager.currentWorkspaceId()
      if (workspaceId && isPathWithinRoot(resolve(integrationMountRootForWorkspace(workspaceId)), resolvedPath)) {
        return resolvedPath
      }
      throw new Error('Integration is not connected to this project')
    }

    const roots = (integration.localMountPaths || []).map((entry) => resolve(entry)).filter(Boolean)
    if (roots.length === 0) {
      throw new Error('Relayfile mount is not available for this integration')
    }

    if (!roots.some((root) => isPathWithinRoot(root, resolvedPath))) {
      throw new Error('Path is outside this integration Relayfile mount')
    }

    return resolvedPath
  }

  private findIntegrationForMountPath(
    integrations: ConnectedIntegration[],
    integrationId: string,
    resolvedPath: string
  ): ConnectedIntegration | undefined {
    return integrations.find((integration) => integration.integrationId === integrationId)
      || integrations.find((integration) =>
        (integration.localMountPaths || [])
          .map((entry) => resolve(entry))
          .some((root) => isPathWithinRoot(root, resolvedPath))
      )
  }

  private visibleIntegrationsForProject(projectId: string): ConnectedIntegration[] {
    return this.listConnected(projectId)
      .filter((integration) => integration.visibleInProject !== false)
  }
}

export const integrationsManager = new IntegrationsManager()
