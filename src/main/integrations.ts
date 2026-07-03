import { randomUUID } from 'node:crypto'
import { toErrorMessage } from './errors'
import { isRecord } from './guards'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { RelayfileSetup, type FileReadResponse, type TreeResponse, type WorkspaceHandle } from '@relayfile/sdk'
import { accountWorkspaceReadyRetryOptions, getAccountWorkspaceId, getApiUrl, resolveCloudAuth } from './auth'
import { brokerManager } from './broker'
import { cloudAgentManager } from './cloud-agent'
import * as filesystem from './filesystem'
import { integrationEventBridge, integrationSubscriptionSummaries, slackListenDms } from './integration-event-bridge'
import {
  integrationLocalPathForRemote,
  integrationMountManager,
  integrationMountRootForWorkspace,
  MAX_LOCAL_INTEGRATION_MOUNT_PATHS
} from './integration-mounts'
import {
  fullInjectInstructions as buildIntegrationsUpdateSnippet,
  parseWritableResources as parsePackageWritableResources
} from '@agent-relay/integration-prompts'
import type { IntegrationDescriptor, WritableResourceDescriptor } from '@agent-relay/integration-prompts'
import {
  canListRemoteDirectoryForMountPaths,
  canShowRemoteDirectoryEntryForMountPaths,
  isRelayfilePathWithinRoot,
  isLinearStatesListablePath,
  isSlackDmListablePath,
  normalizeRemoteDirectoryPath,
  remotePathName
} from './integration-remote-paths'
import {
  PROJECT_INTEGRATIONS_LINK_NAME,
  ensureProjectIntegrationsLink,
  removeProjectIntegrationsLink
} from './integration-symlinks'
import { INTEGRATIONS_CATALOG } from './integrations.catalog'
import { ACTIVE_PROVIDERS } from './integration-providers'
import { slackWritebackCommandMountPathFor } from './slack-writeback-command-roots'
import { getRelayWorkspaceManager } from './relay-workspace'
import { normalizeRelayWorkspaceInfo } from './relay-service-urls'
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
  subscribeAgentConfigured?: boolean
  downloadHistoricalData?: boolean
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

export type IntegrationOption = {
  value: string
  label: string
  hint?: string
}

type SlackChannelOptionResponse = {
  channels?: unknown
  nextCursor?: unknown
}

export type IntegrationsEvent =
  | { type: 'session-update'; sessionId: string; session: IntegrationConnectSession }
  | { type: 'integration-added'; projectId: string; integration: ConnectedIntegration }
  | { type: 'integration-removed'; projectId: string; integrationId: string }
  | { type: 'integration-error'; projectId: string; integrationId: string; message: string }
  | { type: 'integrations-hydrated'; projectId: string }
  | { type: 'mount-auth-stall'; remotePath: string; status: string | null; pendingWriteback: number; message: string }
  | { type: 'integration-auth-required'; reason: 'cloud-auth-required' | 'account-workspace-required'; message: string }
  | { type: 'integration-auth-recovered' }

export type IntegrationAuthRecoveryState = {
  reason: 'cloud-auth-required' | 'account-workspace-required'
  since: number
  failureClass?: string
  message: string
}

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

type IntegrationSystemMessageOptions = {
  waitForAgent?: boolean
}

const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 5 * 60_000
const CATALOG_CACHE_MS = 5 * 60_000
interface AgentSystemMessageRecord {
  text: string
  // Set when the record came from a spawn-embedded snippet rather than a
  // broadcast send; grants the grace window below.
  fromSpawnAt: number | null
}

const SYSTEM_MESSAGE_DEBOUNCE_MS = 1_000
// Minimum gap between integrations-update broadcasts to the same project.
// Staged state convergence (channel-name discovery, subscription readiness)
// otherwise re-broadcasts a slightly-different full update every few seconds.
const SYSTEM_MESSAGE_REBROADCAST_COOLDOWN_MS = 60_000
const SYSTEM_MESSAGE_AGENT_WAIT_TIMEOUT_MS = 8_000
const SYSTEM_MESSAGE_AGENT_WAIT_INTERVAL_MS = 500
const LOCAL_MOUNT_CLOUD_HYDRATION_THROTTLE_MS = 30_000
// Throttle for the per-project settings-list cloud hydration. Long enough that a
// renderer refresh on `integrations-hydrated` (which re-calls the settings list)
// cannot spin a fetch loop, short enough that reopening the page re-checks cloud.
const PROJECT_CLOUD_HYDRATION_THROTTLE_MS = 30_000
const AUTH_RECOVERY_RETRY_INTERVAL_MS = 30_000
const LOCAL_INTEGRATION_WORKSPACE_ID_RETRY_MS = 60_000
const CATALOG_PATH = '/api/v1/integrations/catalog'
const MAX_REMOTE_DIRECTORY_ENTRIES = 5_000
const MAX_REMOTE_FILE_PREVIEW_BYTES = 1024 * 1024

function isActiveProvider(provider: string): boolean {
  return ACTIVE_PROVIDERS.has(provider.trim().toLowerCase())
}

function normalizeApiUrl(url: string | undefined): string {
  return (url || getApiUrl()).trim().replace(/\/+$/, '')
}

function buildApiUrl(apiUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), `${apiUrl}/`).toString()
}


function isCloudAuthRequiredError(error: unknown): boolean {
  return /cloud-auth-required/i.test(toErrorMessage(error))
}

function isAccountWorkspaceRequiredError(error: unknown): boolean {
  return /account-workspace-required/i.test(toErrorMessage(error))
}

function isIntegrationAuthRecoveryError(error: unknown): boolean {
  return isCloudAuthRequiredError(error) || isAccountWorkspaceRequiredError(error)
}

function integrationAuthRecoveryReason(error: unknown): IntegrationAuthRecoveryState['reason'] {
  return isAccountWorkspaceRequiredError(error) ? 'account-workspace-required' : 'cloud-auth-required'
}

function integrationAuthRecoveryFailureClass(error: unknown): string | undefined {
  const message = toErrorMessage(error)
  const match = message.match(/\b(?:cloud-auth-required|account-workspace-required):([a-z0-9-]+)/i)
  return match?.[1]
}

function integrationAuthRecoveryMessage(reason: IntegrationAuthRecoveryState['reason'], failureClass?: string): string {
  return failureClass ? `${reason}:${failureClass}` : reason
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

function httpError(message: string, status: number): Error & { status: number; httpStatus: number } {
  const error = new Error(message) as Error & { status: number; httpStatus: number }
  error.status = status
  error.httpStatus = status
  return error
}

// Provider adapters materialize data at the workspace ROOT — `/github/...`,
// `/linear/...` (see each adapter's LAYOUT.md in the relayfile workspace).
// The catalog historically assumed `/integrations/<provider>/...`, which does
// not exist on the server, so every mount mirrored an empty tree. Rewrite
// both forms to the real root-level layout.
function rewriteIntegrationMountPath(mountPath: string, relayfileProvider: string): string {
  const discovery = mountPath.match(/^\/discovery(?:\/.*)?$/u)
  if (discovery) {
    const normalized = mountPath.replace(/\/+$/u, '')
    return normalized === '/discovery' ? `/discovery/${relayfileProvider}` : normalized
  }
  const prefixed = mountPath.match(/^\/integrations\/[^/]+(\/.*)?$/)
  if (prefixed) return `/${relayfileProvider}${prefixed[1] ?? ''}`
  const rootLevel = mountPath.match(/^\/[^/]+(\/.*)?$/)
  if (rootLevel) return `/${relayfileProvider}${rootLevel[1] ?? ''}`
  return mountPath
}

function projectIntegrationPathForRelayfilePath(mountPath: string): string {
  const trimmed = mountPath.trim()
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return `${PROJECT_INTEGRATIONS_LINK_NAME}${normalized}`
}

function discoveryMountPathForProvider(provider: string): string {
  return `/discovery/${toRelayfileProvider(provider)}`
}

/** One writable resource declared by an adapter's discovery doc. */
interface WritableResource {
  /** Human label from the adapter doc, e.g. "messages", "direct-messages". */
  name: string
  /** Remote path template (may contain {placeholder} id segments), e.g. /slack/channels/{channelId}/messages. */
  pathTemplate: string
}

// Split out so it can be kept when the package parser falls through.
const ADAPTER_WRITABLE_RESOURCE_RE = /^###\s+(.+?)\s+[—-]\s+`(\/[^`]+)`/u

function parseLegacyHeadingResources(adapterDoc: string): WritableResource[] {
  const lines = adapterDoc.split('\n')
  const resources: WritableResource[] = []
  let inWritableSection = false
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/u)
    if (heading) {
      inWritableSection = /writable resources/iu.test(heading[1])
      continue
    }
    if (!inWritableSection) continue
    const match = line.match(ADAPTER_WRITABLE_RESOURCE_RE)
    if (match) resources.push({ name: match[1].trim(), pathTemplate: match[2].trim() })
  }
  return resources
}

function toWritableResource(descriptor: WritableResourceDescriptor): WritableResource {
  const path = descriptor.path.replace(/^\//u, '')
  return { name: descriptor.name ?? lastMeaningfulSegment(path), pathTemplate: path }
}

function lastMeaningfulSegment(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments.at(-1)?.replace(/\.(json|md)$/u, '') ?? segments[0] ?? path
}

// Consume `@agent-relay/integration-prompts` parser (handles markdown tables
// and write-field-contract formats), then fall back to the legacy heading
// format still used in some adapter docs.
function parseWritableResources(adapterDoc: string, providerHint?: string): WritableResource[] {
  const packageResults = parsePackageWritableResources(adapterDoc, providerHint)
  if (packageResults.length > 0) return packageResults.map(toWritableResource)
  return parseLegacyHeadingResources(adapterDoc)
}

function isTemplatePlaceholder(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}')
}

// True when concrete root `R` is the resolved form of template `T` (same depth),
// e.g. R=/slack/channels/C123__general/messages, T=/slack/channels/{channelId}/messages.
function templateMatchesConcrete(templateSegs: string[], concreteSegs: string[]): boolean {
  if (templateSegs.length !== concreteSegs.length) return false
  return templateSegs.every((seg, i) => isTemplatePlaceholder(seg) || seg === concreteSegs[i])
}

// True when concrete root `R` is a prefix of template `T` (T is nested under R),
// e.g. R=/linear/issues, T=/linear/issues/{issueId}/comments.
function concreteIsPrefixOfTemplate(templateSegs: string[], concreteSegs: string[]): boolean {
  if (concreteSegs.length >= templateSegs.length) return false
  return concreteSegs.every((seg, i) => isTemplatePlaceholder(templateSegs[i]) || templateSegs[i] === seg)
}

function canonicalMountPathsForConnectedIntegration(integration: ConnectedIntegration): string[] {
  return dedupeStrings(
    integration.mountPaths.map((mountPath) =>
      rewriteIntegrationMountPath(mountPath, toRelayfileProvider(integration.provider))
    )
  )
}

function isNarrowHistoricalMountPath(mountPath: string): boolean {
  const segments = mountPath.split('/').filter(Boolean)
  return segments[0] !== 'discovery' && segments.length >= 3
}

function isNarrowHistoricalMountPathForProvider(provider: string, mountPath: string): boolean {
  const segments = mountPath.split('/').filter(Boolean)
  if (segments[0] === 'discovery') return false
  if (toRelayfileProvider(provider) === 'slack') return segments.length >= 3
  return segments.length >= 2
}

function isDiscoveryMountPath(mountPath: string): boolean {
  return mountPath.split('/').filter(Boolean)[0] === 'discovery'
}

function writebackCommandMountPathsForIntegration(integration: ConnectedIntegration): string[] {
  return canonicalMountPathsForConnectedIntegration(integration)
    .filter((mountPath) => isNarrowHistoricalMountPathForProvider(integration.provider, mountPath))
    .map((mountPath) =>
      slackWritebackCommandMountPathFor(toRelayfileProvider(integration.provider), mountPath) ??
      (toRelayfileProvider(integration.provider) === 'slack' ? null : mountPath)
    )
    .filter((mountPath): mountPath is string => !!mountPath)
}

function slackThreadContextMountPathsForIntegration(integration: ConnectedIntegration): string[] {
  if (toRelayfileProvider(integration.provider) !== 'slack') return []
  return canonicalMountPathsForConnectedIntegration(integration)
    .filter(isNarrowHistoricalMountPath)
    .flatMap((mountPath) => {
      const segments = mountPath.split('/').filter(Boolean)
      if (segments[0] !== 'slack') return []
      const collection = segments[1]
      if (!['channels', 'dms', 'users'].includes(collection || '')) return []
      if (segments.length === 3) return [`${mountPath}/threads`]
      return []
    })
}

export function localSyncMountPathsForIntegration(integration: ConnectedIntegration): string[] {
  const discoveryPath = discoveryMountPathForProvider(integration.provider)
  const historicalPaths = integration.downloadHistoricalData === true
    ? canonicalMountPathsForConnectedIntegration(integration)
      .filter((mountPath) => isNarrowHistoricalMountPathForProvider(integration.provider, mountPath))
    : writebackCommandMountPathsForIntegration(integration)
  const liveContextPaths = integration.downloadHistoricalData === true
    ? []
    : slackThreadContextMountPathsForIntegration(integration)
  return dedupeStrings([discoveryPath, ...historicalPaths, ...liveContextPaths])
}

function skippedHistoricalMountPathsForIntegration(integration: ConnectedIntegration): string[] {
  if (integration.downloadHistoricalData !== true) return []
  return canonicalMountPathsForConnectedIntegration(integration)
    .filter((mountPath) =>
      !isDiscoveryMountPath(mountPath) &&
      !isNarrowHistoricalMountPathForProvider(integration.provider, mountPath)
    )
}

function skippedCappedLocalSyncMountPathsForIntegration(integration: ConnectedIntegration): string[] {
  const mountPaths = [...localSyncMountPathsForIntegration(integration)].sort()
  return mountPaths.length > MAX_LOCAL_INTEGRATION_MOUNT_PATHS
    ? mountPaths.slice(MAX_LOCAL_INTEGRATION_MOUNT_PATHS)
    : []
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

  const subscription = normalizeSubscribeAgent(value)

  return {
    provider,
    integrationId,
    scope: normalizeScope(value.scope),
    mountPaths: dedupeStrings(stringList(value.mountPaths)),
    connectedAt: typeof value.connectedAt === 'string' && value.connectedAt.trim()
      ? value.connectedAt.trim()
      : new Date(0).toISOString(),
    notifyAgent: typeof value.notifyAgent === 'boolean' ? value.notifyAgent : true,
    subscribeAgent: subscription.subscribeAgent,
    ...(subscription.subscribeAgentConfigured !== undefined
      ? { subscribeAgentConfigured: subscription.subscribeAgentConfigured }
      : {}),
    downloadHistoricalData: typeof value.downloadHistoricalData === 'boolean'
      ? value.downloadHistoricalData
      : typeof value.syncHistoricalData === 'boolean'
        ? value.syncHistoricalData
        : false,
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
    subscribeAgentConfigured: integration.subscribeAgentConfigured === true,
    downloadHistoricalData: integration.downloadHistoricalData === true,
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

function normalizeSubscribeAgent(value: Record<string, unknown>): {
  subscribeAgent: boolean
  subscribeAgentConfigured?: boolean
} {
  const configured = typeof value.subscribeAgentConfigured === 'boolean'
    ? value.subscribeAgentConfigured
    : false
  if (configured && typeof value.subscribeAgent === 'boolean') {
    return { subscribeAgent: value.subscribeAgent, subscribeAgentConfigured: true }
  }
  if (typeof value.subscribeAgent === 'boolean' && value.subscribeAgent === true) {
    return { subscribeAgent: true, subscribeAgentConfigured: true }
  }
  return { subscribeAgent: false, subscribeAgentConfigured: false }
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

function remoteFileReadToPreview(file: FileReadResponse): filesystem.FilePreview {
  const rawContent = file.content || ''
  const buffer = file.encoding === 'base64'
    ? Buffer.from(rawContent, 'base64')
    : Buffer.from(rawContent, 'utf8')
  const size = buffer.byteLength
  if (size > MAX_REMOTE_FILE_PREVIEW_BYTES) {
    return {
      kind: 'too-large',
      content: '',
      size
    }
  }
  if (buffer.includes(0)) {
    return {
      kind: 'binary',
      content: '',
      size
    }
  }
  return {
    kind: 'text',
    content: buffer.toString('utf8'),
    size
  }
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
  private integrationRemoteReaderHandle: WorkspaceHandle | null = null
  private integrationRemoteReaderKey: string | null = null
  private integrationRemoteReaderPromise: Promise<WorkspaceHandle> | null = null
  private integrationRemoteWriterHandle: WorkspaceHandle | null = null
  private integrationRemoteWriterKey: string | null = null
  private integrationRemoteWriterPromise: Promise<WorkspaceHandle> | null = null
  private listeners = new Set<(event: IntegrationsEvent) => void>()
  private sessions = new Map<string, IntegrationConnectSession>()
  private sessionMetadata = new Map<string, SessionMetadata>()
  private pollTimers = new Map<string, NodeJS.Timeout>()
  private systemMessageTimers = new Map<string, NodeJS.Timeout>()
  // Last integrations-update text each agent has CONFIRMED-SENT, per project.
  // Content-keyed and per-agent (not per-project): a project-level signature
  // recorded only when every send succeeded meant one flaky agent send
  // re-broadcast the identical update to EVERY agent on the next reconcile —
  // the agents that already received it replied again (the duplicated
  // "<integrations-update>…" / duplicated acknowledgment transcripts). With
  // per-agent records, retries target only the agents that missed it, and a
  // newly spawned agent receives the current update without re-sending it to
  // everyone else.
  private lastAgentSystemMessages = new Map<string, Map<string, AgentSystemMessageRecord>>()
  // When each project's last broadcast went out. Mount-path discovery and
  // subscription readiness converge in stages (e.g. bare → suffixed Slack
  // channel ids), each stage changing the rendered text slightly; without a
  // cooldown every stage re-broadcast the full update mid-task.
  private lastSystemMessageBroadcastAt = new Map<string, number>()
  // Snippet most recently embedded into spawn instructions, per project, so
  // the spawn path can record it as already-delivered for the new agent.
  private lastSpawnInstructionSnippets = new Map<string, string>()
  // Projects that have broadcast (or spawned with) a non-empty integrations
  // update. When such a project transitions to having no active integrations
  // (e.g. the last one is disconnected), we broadcast one clearing update so
  // already-notified agents stop relying on the stale context — idle context is
  // only suppressed for spawn/no-op, not for state changes that clear it.
  private projectsWithActiveSnippet = new Set<string>()
  private catalogCache: IntegrationAdapter[] | null = null
  private catalogFetchedAt = 0
  private localMountCloudHydrationStartedAt = 0
  private localMountCloudHydrationPromise: Promise<void> | null = null
  private localMountSyncPromise: Promise<void> | null = null
  private localMountSyncIncludesCloud = false
  private settingsLocalMountSyncPromises = new Map<string, Promise<void>>()
  private projectCloudHydrationStartedAt = new Map<string, number>()
  private projectCloudHydrationPromises = new Map<string, Promise<void>>()
  private authRecoveryState: IntegrationAuthRecoveryState | null = null
  private authRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null
  private cachedLocalIntegrationWorkspaceId: string | null = null
  private localIntegrationWorkspaceIdPromise: Promise<string | null> | null = null
  private localIntegrationWorkspaceIdFailedAt = 0

  constructor() {
    // Surface mount auth stalls (expired token + queued writeback) to the
    // renderer; the mount manager restarts the mount itself, this is the
    // user-visible signal that writebacks were paused meanwhile.
    integrationMountManager.setHealthObserver((alert) => {
      if (alert.type === 'auth-required') {
        this.setAuthRecoveryState(alert.reason, undefined, alert.message)
        return
      }
      // A mount that exhausted its restart cap is paused, not recovering — five
      // consecutive restarts failed, so this is not a transient blip the loop
      // will fix on its own. Surface it to the user (the documented remedy for a
      // wedged integration mount is re-auth) instead of letting the alert drop
      // silently and the mount cycle every reset window forever.
      if (alert.type === 'restart-cap-exceeded') {
        this.setAuthRecoveryState(
          'cloud-auth-required',
          'mount-recovery-exhausted',
          `Integration sync for ${alert.remotePath} stopped recovering after ${alert.attempts} restarts (${alert.reason}). Re-authenticate to resume writebacks.`
        )
        return
      }
      // Only auth-stall alerts carry pendingWriteback/message and map to a
      // mount-auth-stall event. reconcile-stalled alerts have neither field, so
      // emitting one here previously produced a malformed event with undefined
      // pendingWriteback/message; ignore them rather than mislabel a reconcile
      // stall as an auth stall.
      if (alert.type !== 'auth-stall') return
      this.emit({
        type: 'mount-auth-stall',
        remotePath: alert.remotePath,
        status: alert.status,
        pendingWriteback: alert.pendingWriteback,
        message: alert.message
      })
    })
  }

  onEvent(handler: (event: IntegrationsEvent) => void): () => void {
    this.listeners.add(handler)
    return () => {
      this.listeners.delete(handler)
    }
  }

  getAuthRecoveryState(): IntegrationAuthRecoveryState | null {
    return this.authRecoveryState
  }

  /**
   * Re-run the cloud auth check after a fresh login and clear the
   * "Cloud sign-in required" banner if the new credentials resolve. The
   * `auth:login` IPC handler calls this on a successful sign-in. Without it,
   * `authRecoveryState` set by an earlier cloud-auth failure stays stale —
   * the background retry only ever re-checks local mounts (`hydrateCloud:
   * false`), so the banner used to linger until the integrations settings
   * page happened to re-hydrate the cloud workspace.
   *
   * No-op when there's no banner to clear. On success `syncLocalMounts`
   * clears the state and emits `integration-auth-recovered`; on a fresh auth
   * failure it re-sets the state — either way this never rejects.
   */
  async retryAuthRecovery(): Promise<void> {
    if (!this.authRecoveryState) return
    // Deliberate user action (just logged in) — bypass the hydration throttle
    // so the cloud re-check isn't skipped as a too-recent attempt, and drop any
    // in-flight hydration so we don't await a check that began before login
    // (hydrateCloudIntegrationsForLocalMounts reuses a pending promise). The
    // older promise's own `finally` only nulls the field when it still points
    // at itself, so clearing it here can't clobber the fresh hydration.
    this.localMountCloudHydrationStartedAt = 0
    this.localMountCloudHydrationPromise = null
    try {
      await this.syncLocalMounts({ hydrateCloud: true })
    } catch (error) {
      if (!isIntegrationAuthRecoveryError(error)) {
        console.warn('[integrations] retryAuthRecovery failed:', toErrorMessage(error))
      }
      // syncLocalMounts re-sets the recovery state on auth errors; the banner
      // stays up correctly and the retry timer keeps trying.
    }
  }

  private setAuthRecoveryState(
    reason: IntegrationAuthRecoveryState['reason'],
    failureClass?: string,
    message = integrationAuthRecoveryMessage(reason, failureClass)
  ): void {
    const previous = this.authRecoveryState
    const state: IntegrationAuthRecoveryState = {
      reason,
      since: previous?.reason === reason && previous.failureClass === failureClass
        ? previous.since
        : Date.now(),
      ...(failureClass ? { failureClass } : {}),
      message
    }
    this.authRecoveryState = state
    this.scheduleAuthRecoveryRetry()
    if (
      previous?.reason === state.reason &&
      previous.failureClass === state.failureClass &&
      previous.message === state.message
    ) {
      return
    }
    this.emit({
      type: 'integration-auth-required',
      reason,
      message
    })
  }

  private clearAuthRecoveryState(): void {
    if (!this.authRecoveryState && !this.authRecoveryRetryTimer) return
    const hadState = !!this.authRecoveryState
    this.authRecoveryState = null
    if (this.authRecoveryRetryTimer) clearTimeout(this.authRecoveryRetryTimer)
    this.authRecoveryRetryTimer = null
    if (hadState) this.emit({ type: 'integration-auth-recovered' })
  }

  private scheduleAuthRecoveryRetry(): void {
    if (this.authRecoveryRetryTimer) return
    const timer = setTimeout(() => {
      this.authRecoveryRetryTimer = null
      const state = this.authRecoveryState
      if (!state) return
      // `cloud-auth-required` originates in the cloud hydration path, so a
      // local-only retry can never clear it — re-run the cloud check. Reset
      // the hydration throttle so this retry isn't skipped as too-recent.
      const hydrateCloud = state.reason === 'cloud-auth-required'
      if (hydrateCloud) this.localMountCloudHydrationStartedAt = 0
      void this.syncLocalMounts({ hydrateCloud })
        .catch((error) => {
          if (!isIntegrationAuthRecoveryError(error)) {
            console.warn('[integrations] Failed to retry integration mount recovery:', toErrorMessage(error))
          }
        })
        .finally(() => {
          if (this.authRecoveryState) this.scheduleAuthRecoveryRetry()
        })
    }, AUTH_RECOVERY_RETRY_INTERVAL_MS)
    timer.unref?.()
    this.authRecoveryRetryTimer = timer
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

  // Local-first: return the on-disk list immediately so the project page paints
  // without waiting on whoami + the workspace-integrations GET (the dominant
  // first-paint latency). Cloud hydration runs in the background and, when it
  // changes the stored list, emits `integrations-hydrated` so the renderer swaps
  // in the merged result. A slow/unavailable cloud no longer blocks first paint
  // and no longer throws — auth failures raise the recovery banner through the
  // existing `integration-auth-required` event instead.
  async listConnectedForSettings(projectId: string): Promise<ConnectedIntegration[]> {
    const local = this.listConnected(projectId)
    const project = this.findProject(projectId)
    if (!project) {
      console.warn(`[integrations] listConnectedForSettings: project ${projectId} not found in local store; returning local list only (${local.length} items)`)
      return this.withCurrentLocalMountPaths(local)
    }

    void this.hydrateProjectCloudIntegrations(projectId)
    this.syncSettingsLocalMountsEventually(projectId)
    return this.withCurrentLocalMountPaths(local)
  }

  // Background cloud hydration for a single project's settings list. Deduped and
  // throttled per project so the renderer re-rendering on `integrations-hydrated`
  // (which calls listConnectedForSettings again) cannot spin a fetch loop. Cloud
  // failures set the auth-recovery banner via setAuthRecoveryState (which emits
  // `integration-auth-required`) rather than throwing; first paint already
  // returned the local list. Returns the in-flight promise so callers/tests can
  // await convergence deterministically.
  hydrateProjectCloudIntegrations(projectId: string): Promise<void> {
    const existing = this.projectCloudHydrationPromises.get(projectId)
    if (existing) return existing
    const lastStartedAt = this.projectCloudHydrationStartedAt.get(projectId) ?? 0
    if (Date.now() - lastStartedAt < PROJECT_CLOUD_HYDRATION_THROTTLE_MS) {
      return Promise.resolve()
    }
    this.projectCloudHydrationStartedAt.set(projectId, Date.now())

    const before = JSON.stringify(this.listConnected(projectId))
    const pending = (async (): Promise<void> => {
      const cloud = await this.listCloudWorkspaceIntegrations()
      if (cloud.length === 0) {
        console.log(`[integrations] hydrateProjectCloudIntegrations: cloud returned 0 integrations; keeping local list for ${projectId}`)
        return
      }
      await this.mergeCloudIntegrationsIntoProject(projectId, cloud)
    })()
      .then(() => {
        const after = JSON.stringify(this.listConnected(projectId))
        if (after !== before) this.emit({ type: 'integrations-hydrated', projectId })
      })
      .catch((error) => {
        if (isAccountWorkspaceRequiredError(error)) {
          console.warn('[integrations] Account workspace unavailable; integration recovery is required')
          this.setAuthRecoveryState('account-workspace-required', integrationAuthRecoveryFailureClass(error))
          return
        }
        if (isCloudAuthRequiredError(error)) {
          this.setAuthRecoveryState('cloud-auth-required', integrationAuthRecoveryFailureClass(error))
          return
        }
        if (isHttpStatus(error, 403)) {
          this.setAuthRecoveryState('cloud-auth-required', 'workspace-access-revoked')
          return
        }
        console.warn('[integrations] Background cloud hydration failed:', toErrorMessage(error))
      })
      .finally(() => {
        if (this.projectCloudHydrationPromises.get(projectId) === pending) {
          this.projectCloudHydrationPromises.delete(projectId)
        }
      })

    this.projectCloudHydrationPromises.set(projectId, pending)
    return pending
  }

  async listMountDirectory(projectId: string, integrationId: string, dirPath: string): Promise<filesystem.ExplorerEntry[]> {
    const resolvedPath = await this.resolveIntegrationMountPath(projectId, integrationId, dirPath)
    return filesystem.listDirectory(resolvedPath)
  }

  async readMountPreview(projectId: string, integrationId: string, filePath: string): Promise<filesystem.FilePreview> {
    const resolvedPath = await this.resolveIntegrationMountPath(projectId, integrationId, filePath)
    return filesystem.readTextPreview(resolvedPath)
  }

  async readRemoteFile(projectId: string, remotePath: string): Promise<filesystem.FilePreview> {
    if (!this.findProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    const path = normalizeRemoteDirectoryPath(remotePath)
    if (!path || path === '/') throw new Error('Integration remote file path is required')
    const mountPaths = this.listableRemoteMountPaths(projectId)
    const allowSlackDms = this.slackDmListingEnabledForProject(projectId)
    const withinScope =
      mountPaths.some((mountPath) => isRelayfilePathWithinRoot(mountPath, path)) ||
      (allowSlackDms && isSlackDmListablePath(path)) ||
      (this.linearStatesListingEnabledForProject(projectId) && isLinearStatesListablePath(path))
    if (!withinScope) {
      throw new Error('Integration remote file is outside this project integration scope')
    }

    try {
      return await this.withIntegrationRemoteHandle(async (handle) => {
        const file = await handle.client().readFile(handle.workspaceId, path)
        return remoteFileReadToPreview(file)
      })
    } catch (error) {
      // A remote 404 means the file was never synced locally (e.g. historical
      // provider records that are not downloaded) or was removed between a
      // directory listing and this read. Mirror the local filesystem behavior
      // (readTextPreview) by reporting it as a missing preview instead of
      // rejecting the IPC handler, so best-effort enrichment readers degrade
      // gracefully rather than logging a handler error.
      if (isHttpStatus(error, 404)) {
        return {
          kind: 'missing',
          content: error instanceof Error ? error.message : 'Remote file not found',
          size: 0
        }
      }
      throw error
    }
  }

  async writeRemoteFile(projectId: string, remotePath: string, content: string): Promise<void> {
    if (!this.findProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    const path = normalizeRemoteDirectoryPath(remotePath)
    if (!path || path === '/') throw new Error('Integration remote file path is required')
    const mountPaths = this.listableRemoteMountPaths(projectId)
    const allowSlackDms = this.slackDmListingEnabledForProject(projectId)
    const withinScope =
      mountPaths.some((mountPath) => isRelayfilePathWithinRoot(mountPath, path)) ||
      (allowSlackDms && isSlackDmListablePath(path))
    if (!withinScope) {
      throw new Error('Integration remote file is outside this project integration scope')
    }

    await this.withIntegrationRemoteWriterHandle(async (handle) => {
      const client = handle.client()
      // The server enforces optimistic concurrency: a write lands only when
      // baseRevision matches the file's current revision, where '0' means
      // "must not exist yet". Creates (e.g. Slack writeback message files)
      // pass on '0', but updates to existing canonical files (e.g. an Issues
      // status change writing stateId onto the issue record) need the live
      // revision — read it first, and retry once if a concurrent sync bumps
      // the file between our read and write.
      const writeAtCurrentRevision = async (): Promise<void> => {
        let baseRevision = '0'
        try {
          const existing = await client.readFile(handle.workspaceId, path)
          baseRevision = existing.revision
        } catch (error) {
          if (!isHttpStatus(error, 404)) throw error
        }
        await client.writeFile({ workspaceId: handle.workspaceId, path, baseRevision, content })
      }
      try {
        await writeAtCurrentRevision()
      } catch (error) {
        if (!isHttpStatus(error, 409)) throw error
        await writeAtCurrentRevision()
      }
    })
  }

  async listRemoteDirectory(projectId: string, remotePath: string): Promise<filesystem.ExplorerEntry[]> {
    if (!this.findProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    const path = normalizeRemoteDirectoryPath(remotePath)
    if (!path || path === '/') throw new Error('Integration remote directory path is required')
    const mountPaths = this.listableRemoteMountPaths(projectId)
    const allowSlackDms = this.slackDmListingEnabledForProject(projectId)
    const allowLinearStates = this.linearStatesListingEnabledForProject(projectId)
    if (
      !canListRemoteDirectoryForMountPaths(path, mountPaths) &&
      !(allowSlackDms && isSlackDmListablePath(path)) &&
      !(allowLinearStates && isLinearStatesListablePath(path))
    ) {
      throw new Error('Integration remote directory is outside this project integration scope')
    }

    return this.withIntegrationRemoteHandle(async (handle) => {
      const entries: filesystem.ExplorerEntry[] = []
      let cursor: string | undefined

      do {
        const tree = await handle.client().listTree(handle.workspaceId, {
          path,
          depth: 1,
          ...(cursor ? { cursor } : {})
        }) as TreeResponse

        for (const entry of tree.entries) {
          if (entry.path === path) continue
          if (
            !canShowRemoteDirectoryEntryForMountPaths(entry.path, mountPaths) &&
            !(allowSlackDms && isSlackDmListablePath(entry.path)) &&
            !(allowLinearStates && isLinearStatesListablePath(entry.path))
          ) {
            continue
          }
          entries.push({
            name: remotePathName(entry.path),
            path: entry.path,
            type: entry.type === 'dir' ? 'directory' : 'file'
          })
        }

        cursor = tree.nextCursor ?? undefined
      } while (cursor && entries.length < MAX_REMOTE_DIRECTORY_ENTRIES)

      return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    })
  }

  async listOptions(projectId: string, provider: string, resource: string): Promise<IntegrationOption[]> {
    if (!this.findProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    const normalizedProvider = toRelayfileProvider(provider)
    const normalizedResource = resource.trim().toLowerCase()
    if (!normalizedResource) throw new Error('Integration option resource is required')
    const workspaceId = await getAccountWorkspaceId(accountWorkspaceReadyRetryOptions())

    let payload: unknown
    try {
      payload = await this.fetchJson<unknown>(
        'GET',
        `api/v1/workspaces/${workspaceId}/integrations/${encodeURIComponent(normalizedProvider)}/options/${encodeURIComponent(normalizedResource)}`
      )
    } catch (error) {
      if (normalizedProvider === 'slack' && normalizedResource === 'channels') {
        payload = await this.listLegacySlackChannelOptions(workspaceId, normalizedProvider, error)
      } else {
        throw error
      }
    }

    const rawOptions = isRecord(payload) && Array.isArray(payload.options) ? payload.options : []
    return rawOptions
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => {
        const value = readString(entry.value)
        const label = readString(entry.label) || value
        const hint = readString(entry.hint)
        return value && label ? { value, label, ...(hint ? { hint } : {}) } : null
      })
      .filter((entry): entry is IntegrationOption => entry !== null)
  }

  private async listLegacySlackChannelOptions(
    workspaceId: string,
    provider: string,
    originalError: unknown
  ): Promise<{ options: IntegrationOption[] }> {
    const options: IntegrationOption[] = []
    let cursor: string | undefined

    try {
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
        const payload = await this.fetchJson<SlackChannelOptionResponse>(
          'GET',
          `api/v1/workspaces/${workspaceId}/integrations/${encodeURIComponent(provider)}/channels/available${query}`
        )
        const channels = Array.isArray(payload.channels) ? payload.channels : []
        for (const channel of channels) {
          if (!isRecord(channel)) continue
          const value = readString(channel.id)
          if (!value) continue
          const name = readString(channel.name) || value
          const isPrivate = channel.isPrivate === true || channel.is_private === true
          options.push({
            value,
            label: `#${name}`,
            ...(isPrivate ? { hint: 'private' } : {})
          })
        }
        cursor = readString(payload.nextCursor)
      } while (cursor)
      return { options }
    } catch (fallbackError) {
      throw new Error(
        `Slack channel options are unavailable: ${toErrorMessage(originalError)}; fallback failed: ${toErrorMessage(fallbackError)}`
      )
    }
  }

  async startLocalMountDaemon(): Promise<void> {
    await this.syncActiveEventSubscriptions()
    void this.syncLocalMounts()
      .then(() => this.syncActiveEventSubscriptions())
      .catch((error) => {
        console.warn('[integrations] Failed to start local integration mounts:', toErrorMessage(error))
      })
  }

  async notifyAgentState(projectId: string): Promise<void> {
    await this.syncAgentState(projectId, true, { waitForAgent: true })
  }

  async refreshAgentState(projectId: string): Promise<void> {
    await this.syncAgentState(projectId, false)
  }

  async shutdownLocalMounts(): Promise<void> {
    for (const timer of this.systemMessageTimers.values()) clearTimeout(timer)
    this.systemMessageTimers.clear()

    // Unlink the per-project `.integrations` symlinks before stopping the
    // mounts so a closed app leaves no dangling links in project trees.
    await Promise.all(
      loadStore().projects.flatMap((project) =>
        this.projectIntegrationRootPaths(project).map((rootPath) =>
          removeProjectIntegrationsLink(rootPath).catch(() => undefined)
        )
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
      await this.openConnectLink(payload.connectLink, {
        projectId,
        provider: normalizedProvider,
        sessionId: normalizedSession.sessionId
      })
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
      // Event injection is opt-in: a newly connected integration never
      // auto-subscribes an agent, regardless of webhook support. The user
      // must explicitly enable it via updateSubscription.
      subscribeAgent: false,
      subscribeAgentConfigured: false,
      downloadHistoricalData: false
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
      subscribeAgentConfigured: existing.subscribeAgentConfigured === true,
      downloadHistoricalData: existing.downloadHistoricalData === true,
      visibleInProject: visibleFromScope(scope)
    }

    await this.persistIntegration(projectId, integration)
    this.emit({ type: 'integration-added', projectId, integration })
    this.syncAgentStateEventually(projectId, integration.notifyAgent)
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
      subscribeAgent,
      subscribeAgentConfigured: true
    }

    await this.persistIntegration(projectId, integration)
    await this.syncAgentState(projectId, true)
    this.emit({ type: 'integration-added', projectId, integration })
    return integration
  }

  async updateHistoricalDownload(
    projectId: string,
    integrationId: string,
    downloadHistoricalData: boolean
  ): Promise<ConnectedIntegration> {
    const existing = this.requireConnectedIntegration(projectId, integrationId)
    const integration: ConnectedIntegration = {
      ...existing,
      downloadHistoricalData
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

  async hydrateActiveProject(projectId: string | null): Promise<void> {
    if (!projectId) {
      await integrationEventBridge.closeAll()
      return
    }
    await this.hydrateProject(projectId)
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
      throw httpError(
        `${method} ${path} failed: ${response.status} ${getPayloadMessage(payload, response.statusText)}`,
        response.status
      )
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

  private async getIntegrationRemoteReaderHandle(): Promise<WorkspaceHandle> {
    return this.getIntegrationRemoteHandle('read')
  }

  private async getIntegrationRemoteWriterHandle(): Promise<WorkspaceHandle> {
    return this.getIntegrationRemoteHandle('write')
  }

  private async getIntegrationRemoteHandle(mode: 'read' | 'write'): Promise<WorkspaceHandle> {
    const auth = await resolveCloudAuth()
    if (!auth) {
      this.clearIntegrationRemoteHandle(mode)
      throw new Error('cloud-auth-required')
    }

    const workspaceId = await getAccountWorkspaceId(accountWorkspaceReadyRetryOptions())
    const handleKey = `${auth.apiUrl}\0${auth.accountKey}\0${workspaceId}`
    const currentHandle = mode === 'read' ? this.integrationRemoteReaderHandle : this.integrationRemoteWriterHandle
    const currentKey = mode === 'read' ? this.integrationRemoteReaderKey : this.integrationRemoteWriterKey
    const currentPromise = mode === 'read' ? this.integrationRemoteReaderPromise : this.integrationRemoteWriterPromise
    if (currentHandle && currentKey === handleKey) {
      return currentHandle
    }

    if (currentPromise && currentKey === handleKey) {
      return currentPromise
    }

    if (mode === 'read') this.integrationRemoteReaderKey = handleKey
    else this.integrationRemoteWriterKey = handleKey

    const pending = (async (): Promise<WorkspaceHandle> => {
      const setup = new RelayfileSetup({
        cloudApiUrl: auth.apiUrl,
        accessToken: () => auth.accessToken
      })
      const handle = normalizeRelayWorkspaceInfo(await setup.joinWorkspace(workspaceId, {
        agentName: mode === 'read' ? 'pear-integrations-reader' : 'pear-integrations-writer',
        scopes: mode === 'read' ? ['relayfile:fs:read:/**'] : ['relayfile:fs:read:/**', 'relayfile:fs:write:/**']
      }))
      if (mode === 'read') this.integrationRemoteReaderHandle = handle
      else this.integrationRemoteWriterHandle = handle
      return handle
    })()

    if (mode === 'read') this.integrationRemoteReaderPromise = pending
    else this.integrationRemoteWriterPromise = pending

    try {
      return await pending
    } finally {
      if (mode === 'read' && this.integrationRemoteReaderPromise === pending) {
        this.integrationRemoteReaderPromise = null
      } else if (mode === 'write' && this.integrationRemoteWriterPromise === pending) {
        this.integrationRemoteWriterPromise = null
      }
    }
  }

  private clearIntegrationRemoteReaderHandle(): void {
    this.clearIntegrationRemoteHandle('read')
  }

  private clearIntegrationRemoteWriterHandle(): void {
    this.clearIntegrationRemoteHandle('write')
  }

  private clearIntegrationRemoteHandle(mode: 'read' | 'write'): void {
    if (mode === 'write') {
      this.integrationRemoteWriterHandle = null
      this.integrationRemoteWriterKey = null
      this.integrationRemoteWriterPromise = null
      return
    }
    this.integrationRemoteReaderHandle = null
    this.integrationRemoteReaderKey = null
    this.integrationRemoteReaderPromise = null
  }

  private async withIntegrationRemoteHandle<T>(fn: (handle: WorkspaceHandle) => Promise<T>): Promise<T> {
    const handle = await this.getIntegrationRemoteReaderHandle()
    try {
      return await fn(handle)
    } catch (error) {
      if (!isHttpStatus(error, 401) && !isHttpStatus(error, 403)) throw error
      await handle.refreshToken().catch(() => undefined)
      try {
        return await fn(handle)
      } catch (refreshError) {
        if (!isHttpStatus(refreshError, 401) && !isHttpStatus(refreshError, 403)) throw refreshError
        this.clearIntegrationRemoteReaderHandle()
        const fresh = await this.getIntegrationRemoteReaderHandle()
        return fn(fresh)
      }
    }
  }

  private async withIntegrationRemoteWriterHandle<T>(fn: (handle: WorkspaceHandle) => Promise<T>): Promise<T> {
    const handle = await this.getIntegrationRemoteWriterHandle()
    try {
      return await fn(handle)
    } catch (error) {
      if (!isHttpStatus(error, 401) && !isHttpStatus(error, 403)) throw error
      await handle.refreshToken().catch(() => undefined)
      try {
        return await fn(handle)
      } catch (refreshError) {
        if (!isHttpStatus(refreshError, 401) && !isHttpStatus(refreshError, 403)) throw refreshError
        this.clearIntegrationRemoteWriterHandle()
        const fresh = await this.getIntegrationRemoteWriterHandle()
        return fn(fresh)
      }
    }
  }

  private async requestConnectSession(relayfileProvider: string): Promise<ConnectSessionPayload> {
    return this.withWorkspaceHandle(async (handle) => await handle.requestJson({
      operation: 'connectIntegration',
      method: 'POST',
      path: `api/v1/workspaces/${handle.workspaceId}/integrations/connect-session`,
      body: { allowedIntegrations: [relayfileProvider] }
    }) as ConnectSessionPayload)
  }

  private async openConnectLink(
    connectLink: string,
    context: { projectId: string; provider: string; sessionId: string }
  ): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(connectLink)
    } catch (error) {
      console.warn('[integrations] Refusing to open integration connect link:', {
        ...context,
        reason: 'invalid-url',
        error: toErrorMessage(error)
      })
      return
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('[integrations] Refusing to open integration connect link:', {
        ...context,
        reason: 'unsupported-scheme',
        scheme: parsed.protocol || '(none)'
      })
      return
    }

    await shell.openExternal(parsed.href)
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
        // Opt-in only — see completeConnect.
        subscribeAgent: false,
        subscribeAgentConfigured: false,
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
            subscribeAgentConfigured: existingIntegration.subscribeAgentConfigured === true,
            downloadHistoricalData: existingIntegration.downloadHistoricalData === true,
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
        .flatMap((integration) => this.mountPathsForAgentWorkspace(integration))
    )
  }

  private isVisibleInProject(projectId: string, integrationId: string): boolean {
    const integration = this.listConnected(projectId).find((entry) => entry.integrationId === integrationId)
    return integration?.visibleInProject !== false
  }

  private syncAgentStateEventually(projectId: string, notifyAgent: boolean): void {
    void this.syncAgentState(projectId, notifyAgent).catch((error) => {
      console.warn('[integrations] Failed to sync integration state:', toErrorMessage(error))
    })
  }

  private async syncAgentState(
    projectId: string,
    notifyAgent: boolean,
    systemMessageOptions: IntegrationSystemMessageOptions = {}
  ): Promise<void> {
    const integrations = this.visibleIntegrationsForProject(projectId)
    await this.syncEventSubscriptions(projectId)

    if (notifyAgent) {
      const snippet = this.buildSystemMessageSnippet(integrations)
      if (snippet) {
        this.projectsWithActiveSnippet.add(projectId)
        this.scheduleSystemMessage(projectId, snippet, systemMessageOptions)
      } else if (this.projectsWithActiveSnippet.delete(projectId)) {
        // Active → none transition: tell already-notified agents the prior
        // integration context is gone, rather than leaving them to attempt
        // stale writebacks or wait on subscriptions that no longer exist.
        this.scheduleSystemMessage(
          projectId,
          buildIntegrationsUpdateSnippet([]),
          systemMessageOptions
        )
      }
    }

    void this.syncLocalIntegrationState(projectId).catch((error) => {
      console.warn('[integrations] Failed to sync local integration state:', toErrorMessage(error))
    })
  }

  private async syncLocalIntegrationState(projectId: string): Promise<void> {
    await this.syncLocalMounts()
    await this.safeUpdateMountPaths(projectId, this.mountPathsFor(projectId))
  }

  // Builds the <integrations-update> narrative via the shared
  // @agent-relay/integration-prompts builder (fullInjectInstructions) instead of
  // a hand-maintained copy. Returns '' when no integration is currently active
  // (see buildActiveIntegrationDescriptors) so callers can skip the message
  // entirely — a visible-but-idle integration adds only noise at spawn.
  private buildSystemMessageSnippet(integrations: ConnectedIntegration[]): string {
    const descriptors = this.buildActiveIntegrationDescriptors(integrations)
    if (descriptors.length === 0) return ''
    return buildIntegrationsUpdateSnippet(descriptors)
  }

  // Maps connected integrations to the package's IntegrationDescriptor shape,
  // keeping only the ones the agent actually needs to know about at spawn:
  //   - syncing: historical download is enabled, OR
  //   - listening: a registered event subscription exists, OR
  //   - actionable: narrow writeback command roots are mounted.
  // Visible integrations with none of the above (no sync, no events, no narrow
  // resources) are omitted; if nothing qualifies the caller suppresses the
  // whole <integrations-update> message.
  private buildActiveIntegrationDescriptors(
    integrations: ConnectedIntegration[]
  ): IntegrationDescriptor[] {
    const descriptors: IntegrationDescriptor[] = []
    for (const integration of integrations) {
      const historyEnabled = integration.downloadHistoricalData === true
      const eventScopePaths = this.canonicalMountPathsForIntegration(integration)
        .map(projectIntegrationPathForRelayfilePath)
      const writebackCommandPaths = writebackCommandMountPathsForIntegration(integration)
        .map(projectIntegrationPathForRelayfilePath)
      // Listening is derived per integration from its own config (subscribeAgent
      // + event globs), independent of whether Relayfile has finished
      // registering it. Scoping the summary to this single integration avoids
      // marking every integration of a provider active when only one of several
      // (e.g. multiple Slack workspaces) actually subscribes.
      const subscriptions = integrationSubscriptionSummaries([integration])

      const isActive = historyEnabled
        || writebackCommandPaths.length > 0
        || subscriptions.length > 0
      if (!isActive) continue

      const writebackPaths = historyEnabled ? eventScopePaths : writebackCommandPaths
      const liveContextPaths = historyEnabled
        ? []
        : slackThreadContextMountPathsForIntegration(integration)
          .map(projectIntegrationPathForRelayfilePath)
      const skippedLocalPaths = dedupeStrings([
        ...skippedHistoricalMountPathsForIntegration(integration).map(projectIntegrationPathForRelayfilePath),
        ...skippedCappedLocalSyncMountPathsForIntegration(integration).map(projectIntegrationPathForRelayfilePath)
      ])

      descriptors.push({
        provider: integration.provider,
        mountRoot: `${PROJECT_INTEGRATIONS_LINK_NAME}/${integration.provider}`,
        writableResources: [],
        discoveryRoot: projectIntegrationPathForRelayfilePath(
          discoveryMountPathForProvider(integration.provider)
        ),
        scopeLabels: collectScopeLabels(integration.scope),
        eventScopePaths,
        writebackPaths,
        downloadHistoricalData: historyEnabled,
        liveContextPaths,
        skippedLocalPaths,
        subscriptions
      })
    }
    return descriptors
  }

  initialSpawnInstructions(projectId: string): string | undefined {
    const integrations = this.visibleIntegrationsForProject(projectId)
    if (integrations.length === 0) return undefined
    const snippet = this.buildSystemMessageSnippet(integrations)
    // No integration is currently syncing/listening/actionable — skip the spawn
    // message entirely rather than inject an empty "- none" narrative.
    if (!snippet) return undefined
    // Remember what this spawn embedded so recordSpawnInstructionDelivery
    // can mark the new agent as already-notified — without it, the next
    // project broadcast re-delivered the same setup context to the agent
    // that just received it in its spawn task ("Setup context received"
    // acknowledged twice).
    this.lastSpawnInstructionSnippets.set(projectId, snippet)
    // A later transition to no active integrations should still clear this for
    // the spawned agent (see projectsWithActiveSnippet).
    this.projectsWithActiveSnippet.add(projectId)
    return [
      'Initial project integration context. Treat this as setup context, not as the user task.',
      snippet
    ].join('\n')
  }

  // Generates a compact write-path table for CLIs that cannot reliably reason
  // from the full narrative integration context (e.g. opencode). Fully data-driven
  // and provider-agnostic: the writable resources + path templates come from each
  // provider's discovery `.adapter.md` (shipped by relayfile-adapters) and payload
  // shape is read from that resource's discovery `.create.example.json`. No
  // per-provider knowledge is hardcoded here, so a new integration works with no
  // code change. (The adapters publish write-shaped examples; cloud's
  // discovery-emitter currently serves read-inferred ones that can drop required
  // write fields — see AgentWorkforce/cloud#2245.)
  prescriptiveSpawnInstructions(projectId: string): string | undefined {
    const integrations = this.visibleIntegrationsForProject(projectId)
    if (integrations.length === 0) return undefined

    const lines: string[] = [
      'To dispatch an integration action, write a JSON file under the resource path — do NOT use relay messaging for these actions.',
      '',
      'Writable resources (read each resource’s create example for the payload, then write a sibling .json):'
    ]
    let usedIdPlaceholder = false

    for (const integration of integrations) {
      const provider = toRelayfileProvider(integration.provider)
      const discoveryDisplay = projectIntegrationPathForRelayfilePath(
        discoveryMountPathForProvider(provider)
      )
      // Concrete, in-scope writeback roots (real channel/user/issue ids resolved).
      const concreteRoots = writebackCommandMountPathsForIntegration(integration)
        .map((p) => p.split('/').filter(Boolean))
      const resources = this.readWritableResources(provider)

      // Pair each adapter-declared resource with a concrete in-scope root so we
      // emit real paths. Resources the integration isn't scoped to are skipped.
      const rows: Array<{ name: string; displaySegs: string[]; templateSegs: string[] }> = []
      for (const resource of resources) {
        const templateSegs = resource.pathTemplate.split('/').filter(Boolean)
        const exact = concreteRoots.find((r) => templateMatchesConcrete(templateSegs, r))
        if (exact) {
          rows.push({ name: resource.name, displaySegs: exact, templateSegs })
          continue
        }
        const parent = concreteRoots.find((r) => concreteIsPrefixOfTemplate(templateSegs, r))
        if (parent) {
          const displaySegs = [...parent, ...templateSegs.slice(parent.length)]
          rows.push({ name: resource.name, displaySegs, templateSegs })
        }
      }

      if (rows.length > 0) {
        lines.push(`${provider}:`)
        for (const row of rows) {
          const displayPath = projectIntegrationPathForRelayfilePath('/' + row.displaySegs.join('/'))
          if (row.displaySegs.some(isTemplatePlaceholder)) usedIdPlaceholder = true
          // Payload shape lives in the adapter's discovery create example, under
          // the template path. No payload is hardcoded here.
          const examplePath = `${discoveryDisplay}/${row.templateSegs.slice(1).join('/')}/.create.example.json`
          lines.push(`  ${row.name} → ${displayPath}/<name>.json`)
          lines.push(`    fields: ${examplePath}`)
        }
        continue
      }

      // Fallback: adapter doc unavailable or no resource matched — point at the
      // concrete writeback roots and the discovery adapter doc for this provider.
      const writebackPaths = writebackCommandMountPathsForIntegration(integration)
        .map(projectIntegrationPathForRelayfilePath)
      if (writebackPaths.length > 0) {
        lines.push(`${provider} — read ${discoveryDisplay}/.adapter.md for writable resources and payload shape:`)
        for (const p of writebackPaths) lines.push(`  ${p}/<name>.json`)
      } else {
        lines.push(`${provider} — see ${discoveryDisplay}/.adapter.md for writable resources and payload shape.`)
      }
    }

    lines.push('', 'Rules:')
    lines.push('- Use any filename ending in .json. Do not write inside discovery/.')
    lines.push('- Read each resource’s “fields:” create example for the payload; omit readOnly (server-managed) fields.')
    if (usedIdPlaceholder) {
      lines.push('- {…} path segments are resource ids: use the exact resource filename from listing the parent directory; never invent one.')
    }
    return lines.join('\n')
  }

  // Reads a provider's discovery `.adapter.md` from the local mount and returns
  // its declared writable resources. Returns [] when the mount/doc isn't present
  // (callers fall back to a discovery pointer), so this never throws at spawn.
  private readWritableResources(provider: string): WritableResource[] {
    const workspaceId = integrationMountManager.currentWorkspaceId()
    if (!workspaceId) return []
    try {
      const discoveryDir = integrationLocalPathForRemote(
        workspaceId,
        discoveryMountPathForProvider(provider)
      )
      const adapterDocPath = resolve(discoveryDir, '.adapter.md')
      if (!existsSync(adapterDocPath)) return []
      return parseWritableResources(readFileSync(adapterDocPath, 'utf8'), provider)
    } catch {
      return []
    }
  }

  // Called after a spawn whose task embedded initialSpawnInstructions: the
  // new agent already has the current integrations snippet, so per-agent
  // delivery records treat it as up to date.
  recordSpawnInstructionDelivery(projectId: string, agentName: string): void {
    const snippet = this.lastSpawnInstructionSnippets.get(projectId)
    if (!snippet) return
    let delivered = this.lastAgentSystemMessages.get(projectId)
    if (!delivered) {
      delivered = new Map()
      this.lastAgentSystemMessages.set(projectId, delivered)
    }
    delivered.set(agentName, { text: snippet, fromSpawnAt: Date.now() })
  }

  private mountPathsForAgentWorkspace(integration: ConnectedIntegration): string[] {
    return dedupeStrings([
      discoveryMountPathForProvider(integration.provider),
      ...this.canonicalMountPathsForIntegration(integration)
    ])
  }

  private mountPathsForLocalSync(integration: ConnectedIntegration): string[] {
    return localSyncMountPathsForIntegration(integration)
  }

  private listableRemoteMountPaths(projectId: string): string[] {
    return dedupeStrings(
      this.visibleIntegrationsForProject(projectId).flatMap((integration) => [
        discoveryMountPathForProvider(integration.provider),
        ...this.canonicalMountPathsForIntegration(integration)
      ])
    )
  }

  private canonicalMountPathsForIntegration(integration: ConnectedIntegration): string[] {
    return canonicalMountPathsForConnectedIntegration(integration)
  }

  // True when any visible Slack integration for the project has DM listening
  // enabled. DM/user message paths are event-subscribed but absent from the
  // canonical channel mount paths, so list/read of those paths is permitted
  // only under this flag (see isSlackDmListablePath).
  private slackDmListingEnabledForProject(projectId: string): boolean {
    return this.visibleIntegrationsForProject(projectId).some((integration) => slackListenDms(integration))
  }

  // True when any visible Linear integration exists for the project. The
  // /linear/states reference subtree is listable/readable (never writable)
  // under exactly this condition — see isLinearStatesListablePath.
  private linearStatesListingEnabledForProject(projectId: string): boolean {
    return this.visibleIntegrationsForProject(projectId).some(
      (integration) => toRelayfileProvider(integration.provider) === 'linear'
    )
  }

  private async listSystemMessageAgents(
    bridge: IntegrationSystemMessageBridge,
    projectId: string,
    waitForAgent: boolean
  ): Promise<Array<{ name: string; projectId?: string }>> {
    const startedAt = Date.now()

    for (;;) {
      const agents = (await bridge.listAgents(projectId))
        .filter((agent) => agent.projectId === undefined || agent.projectId === projectId)
      if (agents.length > 0 || !waitForAgent) return agents
      if (Date.now() - startedAt >= SYSTEM_MESSAGE_AGENT_WAIT_TIMEOUT_MS) return agents
      await new Promise((resolve) => setTimeout(resolve, SYSTEM_MESSAGE_AGENT_WAIT_INTERVAL_MS))
    }
  }

  private async safeInjectSystemMessage(
    projectId: string,
    message: string,
    options: IntegrationSystemMessageOptions = {}
  ): Promise<void> {
    try {
      const bridge = brokerManager as unknown as IntegrationSystemMessageBridge
      const agents = await this.listSystemMessageAgents(bridge, projectId, options.waitForAgent === true)
      if (agents.length === 0) return

      let delivered = this.lastAgentSystemMessages.get(projectId)
      if (!delivered) {
        delivered = new Map()
        this.lastAgentSystemMessages.set(projectId, delivered)
      }
      // Only agents that have not already received THIS text. A retry after
      // a partial failure reaches just the agents that missed it; agents
      // that already acknowledged the update never see it twice.
      const now = Date.now()
      let graceRemainingMs = 0
      const pending = agents.filter((agent) => {
        const record = delivered.get(agent.name)
        if (!record) return true
        if (record.text === message) return false
        // Spawn grace: right after a spawn the broadcast text routinely
        // differs only cosmetically from the snippet embedded in the spawn
        // task (readiness clause, paths still hydrating). Skip the
        // near-identical second setup message; the follow-up below delivers
        // any text that still differs once the grace lapses.
        if (record.fromSpawnAt !== null) {
          const remaining = record.fromSpawnAt + SYSTEM_MESSAGE_REBROADCAST_COOLDOWN_MS - now
          if (remaining > 0) {
            graceRemainingMs = Math.max(graceRemainingMs, remaining)
            return false
          }
        }
        return true
      })
      if (pending.length === 0) {
        if (graceRemainingMs > 0 && !this.systemMessageTimers.has(projectId)) {
          // Re-run after the grace lapses so a real post-spawn change still
          // reaches the fresh agent. Never clobbers a newer pending text —
          // only scheduled when no timer is waiting.
          this.scheduleSystemMessage(projectId, message, options, graceRemainingMs)
        }
        return
      }

      const results = await Promise.allSettled(
        pending.map((agent) => {
          const input = {
            to: agent.name,
            from: 'system',
            text: message,
            priority: 0,
            mode: 'steer',
            data: {
              kind: 'integrations-update',
              system: true
            }
          } as const
          // Delivery confirmations can hang behind inactive PTYs. Integration
          // updates are setup context, so broker send acceptance is the
          // reliable boundary for idempotent notification.
          return bridge.sendMessage(projectId, input)
        })
      )
      let anyDelivered = false
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          delivered.set(pending[index].name, { text: message, fromSpawnAt: null })
          anyDelivered = true
          // Low-noise send telemetry: integrations-update sends are rare by
          // design now, and each one triggers a visible agent turn — keep a
          // breadcrumb so duplicate-transcript reports are diagnosable.
          console.info(
            `[integrations] sent integrations-update to ${pending[index].name} (project ${projectId}, ${message.length} chars)`
          )
        } else {
          console.warn(
            `[integrations] Failed to inject integration system message for ${pending[index].name}:`,
            toErrorMessage(result.reason)
          )
        }
      })
      if (anyDelivered) {
        this.lastSystemMessageBroadcastAt.set(projectId, Date.now())
      }
    } catch (error) {
      console.warn('[integrations] Failed to inject integration system message:', toErrorMessage(error))
    }
  }

  private scheduleSystemMessage(
    projectId: string,
    message: string,
    options: IntegrationSystemMessageOptions = {},
    minDelayMs = 0
  ): void {
    const existing = this.systemMessageTimers.get(projectId)
    if (existing) clearTimeout(existing)

    // Cooldown after a real broadcast: integration text converges in stages
    // (channel-name discovery, subscription readiness), and each stage used
    // to re-broadcast the whole update to every agent mid-task. Later
    // schedules within the cooldown replace the timer, so the trailing
    // broadcast carries the latest text. Per-agent delivery records make
    // the eventual send a no-op for agents already up to date.
    const lastBroadcastAt = this.lastSystemMessageBroadcastAt.get(projectId)
    const cooldownRemaining = lastBroadcastAt === undefined
      ? 0
      : Math.max(0, lastBroadcastAt + SYSTEM_MESSAGE_REBROADCAST_COOLDOWN_MS - Date.now())
    const delay = Math.max(SYSTEM_MESSAGE_DEBOUNCE_MS, cooldownRemaining, minDelayMs)

    const timer = setTimeout(() => {
      this.systemMessageTimers.delete(projectId)
      void this.safeInjectSystemMessage(projectId, message, options)
    }, delay)
    this.systemMessageTimers.set(projectId, timer)
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
      const activeProjectId = loadStore().activeProjectId
      if (projectId !== activeProjectId) {
        await integrationEventBridge.close(projectId)
        return true
      }
      await integrationEventBridge.closeAllExcept(projectId)
      await integrationEventBridge.reconcile(
        projectId,
        this.withCurrentLocalMountPaths(this.visibleIntegrationsForProject(projectId))
      )
      return true
    } catch (error) {
      if (isAccountWorkspaceRequiredError(error)) {
        this.setAuthRecoveryState('account-workspace-required', integrationAuthRecoveryFailureClass(error))
        return false
      }
      if (isCloudAuthRequiredError(error)) {
        this.setAuthRecoveryState('cloud-auth-required', integrationAuthRecoveryFailureClass(error))
        return false
      }
      console.warn('[integrations] Failed to reconcile integration event subscriptions:', toErrorMessage(error))
      return false
    }
  }

  private async syncActiveEventSubscriptions(): Promise<void> {
    const activeProjectId = loadStore().activeProjectId
    if (!activeProjectId) {
      await integrationEventBridge.closeAll()
      return
    }
    await this.syncEventSubscriptions(activeProjectId)
  }

  private async hydrateCloudIntegrationsForLocalMounts(): Promise<void> {
    const now = Date.now()
    if (this.localMountCloudHydrationPromise) return this.localMountCloudHydrationPromise
    if (now - this.localMountCloudHydrationStartedAt < LOCAL_MOUNT_CLOUD_HYDRATION_THROTTLE_MS) return

    this.localMountCloudHydrationStartedAt = now
    const pending = (async () => {
      const projects = loadStore().projects
      if (projects.length === 0) return

      const cloud = await this.listCloudWorkspaceIntegrations()
      if (cloud.length === 0) return

      for (const project of projects) {
        await this.mergeCloudIntegrationsIntoProject(project.id, cloud)
      }
    })()
      .catch((error) => {
        if (isHttpStatus(error, 403)) {
          this.setAuthRecoveryState('cloud-auth-required', 'workspace-access-revoked')
          throw new Error('cloud-auth-required:workspace-access-revoked')
        }
        console.warn('[integrations] Failed to hydrate cloud integrations for local mounts:', toErrorMessage(error))
      })
      .finally(() => {
        if (this.localMountCloudHydrationPromise === pending) {
          this.localMountCloudHydrationPromise = null
        }
      })

    this.localMountCloudHydrationPromise = pending
    return pending
  }

  private syncSettingsLocalMountsEventually(projectId: string): void {
    if (this.settingsLocalMountSyncPromises.has(projectId)) return

    const before = this.settingsLocalMountSignature(projectId)
    const pending = this.syncLocalMounts({ hydrateCloud: false })
      .then(() => {
        if (this.settingsLocalMountSignature(projectId) !== before) {
          this.emit({ type: 'integrations-hydrated', projectId })
        }
      })
      .catch((error) => {
        if (!isIntegrationAuthRecoveryError(error)) {
          console.warn('[integrations] Background local mount sync failed:', toErrorMessage(error))
        }
      })
      .finally(() => {
        if (this.settingsLocalMountSyncPromises.get(projectId) === pending) {
          this.settingsLocalMountSyncPromises.delete(projectId)
        }
      })

    this.settingsLocalMountSyncPromises.set(projectId, pending)
  }

  private async syncLocalMounts(options: { hydrateCloud?: boolean } = {}): Promise<void> {
    const hydrateCloud = options.hydrateCloud !== false
    if (this.localMountSyncPromise) {
      if (!hydrateCloud || this.localMountSyncIncludesCloud) return this.localMountSyncPromise
      return this.localMountSyncPromise
        .catch(() => undefined)
        .then(() => this.syncLocalMounts(options))
    }

    this.localMountSyncIncludesCloud = hydrateCloud
    const pending = this.performSyncLocalMounts(options)
      .finally(() => {
        if (this.localMountSyncPromise === pending) {
          this.localMountSyncPromise = null
          this.localMountSyncIncludesCloud = false
        }
      })
    this.localMountSyncPromise = pending
    return pending
  }

  private async performSyncLocalMounts(options: { hydrateCloud?: boolean } = {}): Promise<void> {
    if (options.hydrateCloud !== false) {
      await this.hydrateCloudIntegrationsForLocalMounts()
    }

    const localEntries = loadStore().projects.flatMap((project) =>
      this.listConnected(project.id).map((integration) => ({
        projectId: project.id,
        integration
      }))
    )
    const byProvider = new Map<string, { integration: ConnectedIntegration; mountPaths: Set<string> }>()
    for (const { projectId, integration } of localEntries) {
      if (!this.isVisibleInProject(projectId, integration.integrationId)) continue
      const key = `${toRelayfileProvider(integration.provider)}:${integration.integrationId}`
      const entry = byProvider.get(key) ?? {
        integration,
        mountPaths: new Set<string>()
      }
      for (const mountPath of this.mountPathsForLocalSync(integration)) {
        entry.mountPaths.add(mountPath)
      }
      byProvider.set(key, entry)
    }
    const integrations = Array.from(byProvider.values())
    try {
      await integrationMountManager.ensureMounted(integrations.map(({ integration, mountPaths }) => ({
        provider: integration.provider,
        mountPaths: Array.from(mountPaths)
      })))
    } catch (error) {
      if (isIntegrationAuthRecoveryError(error)) {
        this.setAuthRecoveryState(
          integrationAuthRecoveryReason(error),
          integrationAuthRecoveryFailureClass(error)
        )
        void this.syncProjectIntegrationLinksForCurrentState({ allowRemove: false })
        throw error
      }
      await this.syncProjectIntegrationLinksForCurrentState({ allowRemove: false })
      console.warn('[integrations] Failed to reconcile local integration mount:', toErrorMessage(error))
      return
    }
    this.clearAuthRecoveryState()
    await this.syncProjectIntegrationLinksForCurrentState({ allowRemove: true })
  }

  // Mirror the workspace's integration data into each project via a
  // git-ignored `.integrations` symlink so local agents can read it from
  // their cwd. Removed on app shutdown (see shutdownLocalMounts).
  private async resolveLocalIntegrationWorkspaceId(): Promise<string | null> {
    const currentWorkspaceId = integrationMountManager.currentWorkspaceId()
    if (currentWorkspaceId) {
      this.cachedLocalIntegrationWorkspaceId = currentWorkspaceId
      return currentWorkspaceId
    }
    if (this.cachedLocalIntegrationWorkspaceId) return this.cachedLocalIntegrationWorkspaceId

    const now = Date.now()
    if (this.localIntegrationWorkspaceIdFailedAt > 0 &&
      now - this.localIntegrationWorkspaceIdFailedAt < LOCAL_INTEGRATION_WORKSPACE_ID_RETRY_MS) {
      return null
    }

    if (!this.localIntegrationWorkspaceIdPromise) {
      const pending = getAccountWorkspaceId({ retryAttempts: 1, retryDelayMs: 0 })
        .then((workspaceId) => {
          this.cachedLocalIntegrationWorkspaceId = workspaceId
          this.localIntegrationWorkspaceIdFailedAt = 0
          return workspaceId
        })
        .catch(() => {
          this.localIntegrationWorkspaceIdFailedAt = Date.now()
          return null
        })
        .finally(() => {
          if (this.localIntegrationWorkspaceIdPromise === pending) {
            this.localIntegrationWorkspaceIdPromise = null
          }
        })
      this.localIntegrationWorkspaceIdPromise = pending
    }

    return this.localIntegrationWorkspaceIdPromise
  }

  private projectHasVisibleIntegrations(project: ReturnType<typeof loadStore>['projects'][number]): boolean {
    return project.integrations
      .map((integration) => normalizeConnectedIntegration(integration))
      .some((integration) => integration !== null && integration.visibleInProject !== false)
  }

  private projectIntegrationRootPaths(project: ReturnType<typeof loadStore>['projects'][number]): string[] {
    const paths = [
      project.rootPath,
      ...project.roots.map((root) => root.path)
    ]
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const path of paths) {
      const trimmed = path.trim()
      if (!trimmed) continue
      const key = resolve(trimmed)
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(trimmed)
    }
    return deduped
  }

  private async syncProjectIntegrationLinksForCurrentState(options: { allowRemove: boolean }): Promise<void> {
    const projects = loadStore().projects
    const hasIntegrations = projects.some((project) => this.projectHasVisibleIntegrations(project))
    if (!hasIntegrations) {
      if (!options.allowRemove) return
      await Promise.all(projects.flatMap((project) => this.projectIntegrationRootPaths(project).map(async (rootPath) => {
        try {
          await removeProjectIntegrationsLink(rootPath)
        } catch (error) {
          console.warn(
            `[integrations] Failed to remove integration symlink for ${rootPath}:`,
            toErrorMessage(error)
          )
        }
      })))
      return
    }

    const workspaceId = await this.resolveLocalIntegrationWorkspaceId()
    if (!workspaceId) return

    const mountRoot = integrationMountRootForWorkspace(workspaceId)
    if (!existsSync(mountRoot)) return

    await Promise.all(projects.flatMap((project) => this.projectIntegrationRootPaths(project).map(async (rootPath) => {
      try {
        await ensureProjectIntegrationsLink(rootPath, workspaceId)
      } catch (error) {
        console.warn(
          `[integrations] Failed to sync integration symlink for ${rootPath}:`,
          toErrorMessage(error)
        )
      }
    })))
  }

  private withCurrentLocalMountPaths(integrations: ConnectedIntegration[]): ConnectedIntegration[] {
    const workspaceId = integrationMountManager.currentWorkspaceId()
    if (!workspaceId) return integrations
    return integrations.map((integration) => {
      return {
        ...integration,
        localMountPaths: integrationMountManager.localPathsFor(workspaceId, {
          provider: integration.provider,
          mountPaths: this.mountPathsForLocalSync(integration)
        })
      }
    })
  }

  private settingsLocalMountSignature(projectId: string): string {
    return JSON.stringify(this.withCurrentLocalMountPaths(this.listConnected(projectId)).map((integration) => ({
      provider: integration.provider,
      integrationId: integration.integrationId,
      localMountPaths: integration.localMountPaths ?? []
    })))
  }

  private async withLocalMountPaths(integrations: ConnectedIntegration[]): Promise<ConnectedIntegration[]> {
    await this.syncLocalMounts({ hydrateCloud: false }).catch((error) => {
      if (!isIntegrationAuthRecoveryError(error)) throw error
    })
    return this.withCurrentLocalMountPaths(integrations)
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
