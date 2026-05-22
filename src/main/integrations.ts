import { randomUUID } from 'node:crypto'
import { BrowserWindow, shell } from 'electron'
import type { WorkspaceHandle } from '@relayfile/sdk'
import { getApiUrl, resolveCloudAuth } from './auth'
import { cloudAgentManager } from './cloud-agent'
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

type CloudAgentIntegrationsBridge = {
  injectSystemMessage: (projectId: string, message: string) => Promise<void> | void
  updateMountPaths: (projectId: string, paths: string[]) => Promise<void> | void
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

function rewriteIntegrationMountPath(mountPath: string, relayfileProvider: string): string {
  const match = mountPath.match(/^\/integrations\/[^/]+(\/.*)?$/)
  if (!match) return mountPath
  return `/integrations/${relayfileProvider}${match[1] ?? ''}`
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

  return {
    provider,
    displayName,
    ...(typeof value.iconUrl === 'string' && value.iconUrl.trim() ? { iconUrl: value.iconUrl.trim() } : {}),
    version: typeof value.version === 'string' && value.version.trim() ? value.version.trim() : '1.0.0',
    capabilities: normalizeCapabilities(value.capabilities),
    authMethod: normalizeAuthMethod(value.authMethod),
    requiredScopes: stringList(value.requiredScopes),
    defaultMountPaths: stringList(value.defaultMountPaths),
    description: typeof value.description === 'string' ? value.description : ''
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
    ...(typeof value.lastSyncAt === 'string' ? { lastSyncAt: value.lastSyncAt } : {}),
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {})
  }
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
    ...(integration.lastSyncAt ? { lastSyncAt: integration.lastSyncAt } : {}),
    ...(integration.lastError ? { lastError: integration.lastError } : {})
  }
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
      notifyAgent
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
      notifyAgent: existing.notifyAgent
    }

    await this.persistIntegration(projectId, integration)
    await this.syncAgentState(projectId, integration.notifyAgent)
    this.emit({ type: 'integration-added', projectId, integration })
    return integration
  }

  async disconnect(projectId: string, integrationId: string): Promise<void> {
    const existing = this.requireConnectedIntegration(projectId, integrationId)

    await this.deleteIntegrationConnection(toRelayfileProvider(existing.provider))

    this.removePersistedIntegration(projectId, existing.integrationId)
    await this.syncAgentState(projectId, existing.notifyAgent)
    this.emit({ type: 'integration-removed', projectId, integrationId: existing.integrationId })
  }

  async hydrateProject(projectId: string): Promise<void> {
    await this.syncAgentState(projectId, true)
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

  private statusPayloadReady(payload: IntegrationStatusPayload): boolean {
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

  private removePersistedIntegration(projectId: string, integrationId: string): void {
    const data = loadStore()
    const project = data.projects.find((entry) => entry.id === projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)

    project.integrations = project.integrations.filter((entry) => {
      const current = normalizeConnectedIntegration(entry)
      return current?.integrationId !== integrationId
    })
    saveStore(data)
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

  private isVisibleInProject(_projectId: string, _integrationId: string): boolean {
    // TODO(coordinate with update-store): read the project visibility map once that sibling lands.
    return true
  }

  private async syncAgentState(projectId: string, notifyAgent: boolean): Promise<void> {
    const integrations = this.listConnected(projectId)
    await this.safeUpdateMountPaths(projectId, this.mountPathsFor(projectId))

    if (notifyAgent) {
      await this.safeInjectSystemMessage(projectId, this.buildSystemMessageSnippet(integrations))
    }
  }

  private buildSystemMessageSnippet(integrations: ConnectedIntegration[]): string {
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
        lines.push(`- ${integration.provider}: ${scopeSummary}${mountClause}`)
      }
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
      const bridge: CloudAgentIntegrationsBridge = cloudAgentManager
      await bridge.injectSystemMessage(projectId, message)
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
}

export const integrationsManager = new IntegrationsManager()
