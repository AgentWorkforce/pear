/**
 * Relaycast chat client for the Pear desktop chat companion.
 *
 * Mirrors the Relay iOS app's model/transport (AgentWorkforce/relay-app,
 * ipad/native/Sources): HTTPS REST against the Relaycast base URL with a
 * `/v1` prefix, `Bearer <workspaceKey>` for roster calls (agents, nodes),
 * `Bearer at_live_…` agent tokens for agent calls (DMs, channels, messages,
 * files), 3x retry on `503 database_overloaded`, and workspace-key rotation
 * via the Cloud `/workspaces/{id}/resolve` endpoint on 401.
 *
 * No chat streaming or typing indicators (matches iOS). Freshness comes from
 * the {@link RelayChatPoller} below: a 30s refresh (roster+nodes, DM
 * messages, channel list), foreground refresh, and per-open history loads.
 * Channel message history loads only on open / foreground / manual refresh,
 * never on the background tick.
 *
 * This module is intentionally `electron`-free (pure fetch + timers) so it
 * stays unit-testable with fixture HTTP doubles — credential resolution
 * (Cloud sign-in, safeStorage) lives in `auth.ts` and is injected via
 * {@link RelayChatClientOptions}.
 */
import { normalizeRelaycastBaseUrl } from './relay-service-urls'
import type {
  ChatHistoryInput,
  ChatSendInput,
  RelayChatAttachment,
  RelayChatConversation,
  RelayChatMessage
} from '../shared/types/ipc'

export const RELAY_CHAT_API_PREFIX = '/v1'
export const RELAY_CHAT_HISTORY_LIMIT = 100
export const RELAY_CHAT_POLL_INTERVAL_MS = 30_000
export const RELAY_CHAT_MAX_RETRIES = 3
export const RELAY_CHAT_RETRY_BASE_MS = 500
export const RELAY_CHAT_RETRY_MAX_WAIT_MS = 60_000
/** Renderer-optimistic rows carry `local:*` ids until the server echoes them. */
export const RELAY_CHAT_OPTIMISTIC_ID_PREFIX = 'local:'

export const RELAY_AGENT_ID_PREFIX = 'relay:'
export const RELAY_DRIVE_ID_PREFIX = 'drive:'
export const RELAY_CONVERSATION_ID_PREFIX = 'conversation:'
export const RELAY_CHANNEL_ID_PREFIX = 'channel:'

export type RelayAgentStatus = 'active' | 'online' | 'waiting' | 'blocked' | 'idle' | 'offline'

export interface RelayAgent {
  /** Pear-side ref `relay:<name>`. */
  id: string
  /** Bare agent name (host suffix stripped). */
  name: string
  /** Machine suffix parsed from `name@host`, when present. */
  host?: string
  status: RelayAgentStatus
  /** ISO8601 server timestamp, when provided. */
  lastSeen?: string
  /** ISO8601 server timestamp, when provided. */
  createdAt?: string
}

export interface RelayNode {
  name: string
  live: boolean
  status?: string
  lastSeen?: string
  capabilities?: string[]
}

export interface RelayDMThread {
  /** Pear-side ref `conversation:<id>`. */
  id: string
  conversationId: string
  participants: string[]
  lastMessageAt?: string
  unreadCount?: number
}

export interface RelayChannel {
  /** Pear-side ref `channel:<name>`. */
  id: string
  name: string
  topic?: string
  memberCount?: number
  isMember?: boolean
}

export type RelayAttachment = RelayChatAttachment
export type RelayChatThreadMessage = RelayChatMessage

export type RelayChatErrorCode =
  | 'transport_error'
  | 'unauthorized'
  | 'not_found'
  | 'name_conflict'
  | 'rate_limited'
  | 'backpressure'
  | 'database_overloaded'
  | 'unknown_error'

export class RelayChatError extends Error {
  readonly code: RelayChatErrorCode
  readonly status?: number
  readonly retryable: boolean
  readonly rawCode?: string

  constructor(code: RelayChatErrorCode, message: string, options?: { status?: number; retryable?: boolean; rawCode?: string }) {
    super(message)
    this.name = 'RelayChatError'
    this.code = code
    this.status = options?.status
    this.retryable = options?.retryable ?? (options?.status !== undefined && options.status >= 500)
    this.rawCode = options?.rawCode
  }
}

/** Parse a `name@host` machine-qualified agent name. Split on the last `@`. */
export function parseAgentMachine(value: string): { name: string; host?: string } {
  const trimmed = value.trim()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return { name: trimmed }
  return { name: trimmed.slice(0, at), host: trimmed.slice(at + 1) }
}

export function toRelayAgentId(name: string): string {
  return `${RELAY_AGENT_ID_PREFIX}${name.trim().replace(/^relay:/, '')}`
}

export function toConversationId(conversationId: string): string {
  const raw = conversationId.trim()
  return raw.startsWith(RELAY_CONVERSATION_ID_PREFIX) ? raw : `${RELAY_CONVERSATION_ID_PREFIX}${raw}`
}

export function toChannelId(name: string): string {
  const raw = name.trim().replace(/^#+/, '')
  return `${RELAY_CHANNEL_ID_PREFIX}${raw}`
}

export function toDriveId(fileId: string): string {
  const raw = fileId.trim()
  return raw.startsWith(RELAY_DRIVE_ID_PREFIX) ? raw : `${RELAY_DRIVE_ID_PREFIX}${raw}`
}

/** Strip a Pear-side `conversation:` / `channel:` / `#` wrapper to the raw id. */
export function fromConversationId(id: string): string {
  const trimmed = id.trim()
  return trimmed.startsWith(RELAY_CONVERSATION_ID_PREFIX)
    ? trimmed.slice(RELAY_CONVERSATION_ID_PREFIX.length)
    : trimmed.replace(/^#+/, '')
}

export function isServerMessageId(id: string): boolean {
  return !!id && !id.startsWith(RELAY_CHAT_OPTIMISTIC_ID_PREFIX)
}

function normalizeStatus(value: unknown): RelayAgentStatus {
  return value === 'active' ||
    value === 'online' ||
    value === 'waiting' ||
    value === 'blocked' ||
    value === 'idle'
    ? value
    : 'offline'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && !!entry)
}

type CredentialKind = 'workspace' | 'agent'

export interface RelayChatClientOptions {
  /** Relaycast base URL (e.g. `https://cast.agentrelay.com`); normalized. */
  baseUrl?: string
  /** Resolve the current workspace key (`rk_live_…`) for roster calls. */
  getWorkspaceKey: () => string | null | undefined | Promise<string | null | undefined>
  /** Resolve the current companion agent token (`at_live_…`). */
  getAgentToken?: () => string | null | undefined | Promise<string | null | undefined>
  /** Persist a rotated workspace key (e.g. write back to the session cache). */
  setWorkspaceKey?: (key: string) => void | Promise<void>
  /**
   * Rotate credentials after a 401 — e.g. re-resolve the workspace key via
   * Cloud `GET /api/v1/workspaces/{id}/resolve`. Return the fresh key, or
   * null when rotation is unavailable (the 401 then surfaces to the caller).
   */
  rotateWorkspaceKey?: () => Promise<string | null>
  /** Companion agent name used for the `mine` flag. */
  selfName?: string | (() => string | null | undefined | Promise<string | null | undefined>)
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  idempotencyKeyImpl?: () => string
  maxRetries?: number
  retryBaseMs?: number
}

interface RelayChatRequestOptions {
  method?: string
  query?: Record<string, string>
  body?: unknown
  auth: CredentialKind
  /** POST/PUT bodies carry an Idempotency-Key so 503 retries are safe. */
  idempotencyKey?: string
}

function normalizeAttachments(value: unknown): RelayAttachment[] {
  if (!Array.isArray(value)) return []
  const out: RelayAttachment[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const fileId = asString(record.file_id ?? record.fileId ?? record.id)
    const filename = asString(record.filename ?? record.name)
    if (!fileId || !filename) continue
    out.push({
      file_id: fileId,
      filename,
      content_type: asString(record.content_type ?? record.contentType) ?? 'application/octet-stream',
      size_bytes: typeof record.size_bytes === 'number'
        ? record.size_bytes
        : typeof record.sizeBytes === 'number' ? record.sizeBytes : 0
    })
  }
  return out
}

function errorCodeFor(status: number, rawCode?: string): RelayChatErrorCode {
  const normalized = rawCode?.trim().toLowerCase()
  if (normalized === 'database_overloaded' || normalized === 'server_overloaded') return 'database_overloaded'
  if (normalized === 'agent_already_exists') return 'name_conflict'
  if (normalized === 'unauthorized' || normalized === 'agent_token_invalid') return 'unauthorized'
  if (normalized === 'not_found' || normalized === 'agent_not_found' || normalized === 'workspace_not_found') {
    return status === 401 || status === 403 ? 'unauthorized' : 'not_found'
  }
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 409) return 'name_conflict'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'database_overloaded'
  if (status >= 500) return 'transport_error'
  return 'unknown_error'
}

function parseRetryAfterMs(headers: Headers | undefined): number | null {
  const raw = headers?.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const date = Date.parse(raw.trim())
  if (Number.isNaN(date)) return null
  return Math.max(0, date - Date.now())
}

export class RelayChatClient {
  private readonly baseUrl: string
  private readonly options: RelayChatClientOptions
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly retryBaseMs: number

  constructor(options: RelayChatClientOptions) {
    this.options = options
    this.baseUrl = normalizeRelaycastBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxRetries = Number.isFinite(options.maxRetries)
      ? Math.max(0, Math.floor(options.maxRetries as number))
      : RELAY_CHAT_MAX_RETRIES
    this.retryBaseMs = Number.isFinite(options.retryBaseMs)
      ? Math.max(0, Math.floor(options.retryBaseMs as number))
      : RELAY_CHAT_RETRY_BASE_MS
  }

  /** Raw base URL (no `/v1` suffix) — for presigned `upload_url` PUTs etc. */
  getBaseUrl(): string {
    return this.baseUrl
  }

  private async sleep(ms: number): Promise<void> {
    if (this.options.sleepImpl) return this.options.sleepImpl(ms)
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private newIdempotencyKey(): string {
    if (this.options.idempotencyKeyImpl) return this.options.idempotencyKeyImpl()
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
  }

  private async selfName(): Promise<string | undefined> {
    const { selfName } = this.options
    if (!selfName) return undefined
    const resolved = typeof selfName === 'function' ? await selfName() : selfName
    return resolved?.trim() || undefined
  }

  private async bearerToken(kind: CredentialKind): Promise<string> {
    const getter = kind === 'workspace' ? this.options.getWorkspaceKey : this.options.getAgentToken
    if (!getter) {
      throw new RelayChatError('unauthorized', `No ${kind} credential provider configured`, { retryable: false })
    }
    const token = (await getter())?.trim()
    if (!token) {
      throw new RelayChatError('unauthorized', `No ${kind} credential available (signed out?)`, { retryable: false })
    }
    return token
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${RELAY_CHAT_API_PREFIX}${path}`, `${this.baseUrl.replace(/\/+$/, '')}/`)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, value)
      }
    }
    return url.toString()
  }

  /**
   * Core request: Bearer auth, `{ok, data, error}` envelope parsing, 3x
   * retry on 503 `database_overloaded` (honoring `Retry-After`), and one
   * workspace-key rotation via `rotateWorkspaceKey` on 401.
   */
  async request<T>(path: string, options: RelayChatRequestOptions): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase()
    const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const idempotencyKey = options.idempotencyKey ?? (isMutation ? this.newIdempotencyKey() : undefined)
    let rotated = false
    let attempt = 0

    for (;;) {
      const token = await this.bearerToken(options.auth)
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      if (options.body !== undefined) headers['Content-Type'] = 'application/json'
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

      let res: Response
      try {
        res = await this.fetchImpl(this.buildUrl(path, options.query), {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined
        })
      } catch (error) {
        if (attempt < this.maxRetries) {
          attempt += 1
          await this.sleep(this.retryBaseMs * 2 ** (attempt - 1))
          continue
        }
        throw new RelayChatError(
          'transport_error',
          `Relaycast request failed: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: true }
        )
      }

      if (res.status === 401 && options.auth === 'workspace' && !rotated && this.options.rotateWorkspaceKey) {
        const fresh = await this.options.rotateWorkspaceKey().catch(() => null)
        if (fresh?.trim()) {
          rotated = true
          await this.options.setWorkspaceKey?.(fresh.trim())
          continue
        }
      }

      if (res.status === 503 && attempt < this.maxRetries) {
        const retryAfter = parseRetryAfterMs(res.headers ?? undefined)
        const backoff = this.retryBaseMs * 2 ** attempt
        attempt += 1
        await this.sleep(Math.min(retryAfter ?? backoff, RELAY_CHAT_RETRY_MAX_WAIT_MS))
        continue
      }

      if (res.status === 204) return undefined as T

      let payload: unknown = null
      try {
        payload = await res.json()
      } catch {
        throw new RelayChatError('transport_error', `Relaycast returned non-JSON (HTTP ${res.status})`, {
          status: res.status,
          retryable: res.status >= 500
        })
      }

      const envelope = asRecord(payload)
      const ok = envelope?.ok === true
      if (!ok || !res.ok) {
        const errorRecord = asRecord(envelope?.error)
        const rawCode = asString(errorRecord?.code)
        const message = asString(errorRecord?.message) ?? `Relaycast request failed (HTTP ${res.status})`
        const code = errorCodeFor(res.status, rawCode)
        throw new RelayChatError(code, message, {
          status: res.status,
          rawCode,
          retryable: res.status === 429 || res.status >= 500
        })
      }
      return (envelope?.data ?? null) as T
    }
  }

  private async normalizeMessage(record: unknown, fallback: { conversationId?: string; channelName?: string }): Promise<RelayChatMessage> {
    const entry = asRecord(record) ?? {}
    const id = asString(entry.id) ?? ''
    const from = asString(entry.agent_name ?? entry.agentName ?? entry.from) ?? 'unknown'
    const self = await this.selfName()
    return {
      id,
      ...(fallback.conversationId ? { conversationId: fallback.conversationId } : {}),
      ...(fallback.channelName ? { channelName: fallback.channelName } : {}),
      from,
      text: asString(entry.text) ?? '',
      createdAt: asString(entry.created_at ?? entry.createdAt) ?? new Date().toISOString(),
      mine: !!self && from.toLowerCase() === self.toLowerCase(),
      hasServerID: isServerMessageId(id),
      attachments: normalizeAttachments(entry.attachments)
    }
  }

  // --- Roster (workspace key) ---

  async listAgents(status: string = 'all'): Promise<RelayAgent[]> {
    const data = await this.request<unknown[]>('/agents', {
      auth: 'workspace',
      query: { status }
    })
    const rows = Array.isArray(data) ? data : []
    return rows.flatMap((entry) => {
      const record = asRecord(entry)
      const name = asString(record?.name)
      if (!name) return []
      const { name: bare, host } = parseAgentMachine(name)
      return [{
        id: toRelayAgentId(name),
        name: bare,
        ...(host ? { host } : {}),
        status: normalizeStatus(record?.status),
        ...(asString(record?.last_seen ?? record?.lastSeen) ? { lastSeen: asString(record?.last_seen ?? record?.lastSeen) } : {}),
        ...(asString(record?.created_at ?? record?.createdAt) ? { createdAt: asString(record?.created_at ?? record?.createdAt) } : {})
      }]
    })
  }

  async listNodes(): Promise<RelayNode[]> {
    const data = await this.request<unknown>('/nodes', { auth: 'workspace' })
    const rows = Array.isArray(data) ? data : asRecord(data)?.nodes
    if (!Array.isArray(rows)) return []
    return rows.flatMap((entry) => {
      const record = asRecord(entry)
      const name = asString(record?.name)
      if (!name) return []
      return [{
        name,
        live: record?.live === true || asString(record?.status)?.toLowerCase() === 'online',
        ...(asString(record?.status) ? { status: asString(record?.status) } : {}),
        ...(asString(record?.last_seen ?? record?.lastSeen) ? { lastSeen: asString(record?.last_seen ?? record?.lastSeen) } : {}),
        ...(Array.isArray(record?.capabilities) ? { capabilities: asStringArray(record?.capabilities) } : {})
      }]
    })
  }

  /**
   * Register-or-rotate the companion agent identity (mirrors
   * `registerOrRotate`: strict register, then get + rotate-token on 409
   * `agent_already_exists`). Used by the IPC layer to mint `at_live_…`
   * agent tokens without persisting new secrets.
   */
  async ensureAgent(name: string, type: 'agent' | 'human' = 'agent'): Promise<{ name: string; token: string }> {
    const trimmed = name.trim()
    if (!trimmed) throw new RelayChatError('unknown_error', 'Agent name is required', { retryable: false })
    try {
      const created = await this.request<{ name?: unknown; token?: unknown }>('/agents', {
        method: 'POST',
        auth: 'workspace',
        body: { name: trimmed, type }
      })
      const token = asString(created?.token)
      if (!token) throw new RelayChatError('unknown_error', 'Registration did not return an agent token', { retryable: false })
      return { name: asString(created?.name) ?? trimmed, token }
    } catch (error) {
      if (!(error instanceof RelayChatError) || error.code !== 'name_conflict') throw error
      const agent = await this.request<{ name?: unknown }>(`/agents/${encodeURIComponent(trimmed)}`, { auth: 'workspace' })
      const rotated = await this.request<{ token?: unknown }>(`/agents/${encodeURIComponent(trimmed)}/rotate-token`, {
        method: 'POST',
        auth: 'workspace',
        body: {}
      })
      const token = asString(rotated?.token)
      if (!token) throw new RelayChatError('unknown_error', 'Token rotation did not return an agent token', { retryable: false })
      return { name: asString(agent?.name) ?? trimmed, token }
    }
  }

  // --- DM threads + channels (agent token) ---

  async listDMConversations(): Promise<RelayDMThread[]> {
    const data = await this.request<unknown>('/dm/conversations', { auth: 'agent' })
    const rows = Array.isArray(data) ? data : []
    return rows.flatMap((entry) => {
      const record = asRecord(entry)
      const conversationId = asString(record?.id ?? record?.conversation_id ?? record?.conversationId)
      if (!conversationId) return []
      const lastMessageAt = asString(record?.last_message_at ?? record?.lastMessageAt)
      const unreadRaw = record?.unread_count ?? record?.unreadCount
      const unreadCount = typeof unreadRaw === 'number' ? unreadRaw : undefined
      const thread: RelayDMThread = {
        id: toConversationId(conversationId),
        conversationId,
        participants: asStringArray(record?.participant_names ?? record?.participantNames)
      }
      if (lastMessageAt) thread.lastMessageAt = lastMessageAt
      if (unreadCount !== undefined) thread.unreadCount = unreadCount
      return [thread]
    })
  }

  async listChannels(): Promise<RelayChannel[]> {
    const data = await this.request<unknown>('/channels', { auth: 'agent' })
    const rows = Array.isArray(data) ? data : []
    const self = (await this.selfName())?.toLowerCase()
    return rows.flatMap((entry) => {
      const record = asRecord(entry)
      const name = asString(record?.name)
      if (!name) return []
      const members = Array.isArray(record?.members)
        ? (record?.members as unknown[]).map((member) => asString(asRecord(member)?.name)).filter((member): member is string => !!member)
        : []
      return [{
        id: toChannelId(name),
        name,
        ...(asString(record?.topic) ? { topic: asString(record?.topic) } : {}),
        ...(members.length > 0 ? { memberCount: members.length } : {}),
        ...(self ? { isMember: members.some((member) => member.toLowerCase() === self) } : {})
      }]
    })
  }

  async listConversations(): Promise<RelayChatConversation[]> {
    const [threads, channels] = await Promise.all([this.listDMConversations(), this.listChannels()])
    return [
      ...threads.map((thread): RelayChatConversation => ({
        kind: 'dm' as const,
        id: thread.id,
        name: thread.participants.length > 0 ? thread.participants.join(', ') : thread.conversationId,
        participants: thread.participants,
        ...(thread.lastMessageAt ? { lastMessageAt: thread.lastMessageAt } : {}),
        ...(thread.unreadCount !== undefined ? { unreadCount: thread.unreadCount } : {})
      })),
      ...channels.map((channel): RelayChatConversation => ({
        kind: 'channel' as const,
        id: channel.id,
        name: `#${channel.name}`,
        ...(channel.isMember !== undefined ? { isMember: channel.isMember } : {})
      }))
    ]
  }

  /**
   * Join a channel. A 409 means the companion is already a member — treated
   * as success with `alreadyMember: true`, never thrown.
   */
  async joinChannel(name: string): Promise<{ alreadyMember: boolean }> {
    const bare = name.trim().replace(/^#+/, '')
    if (!bare) throw new RelayChatError('unknown_error', 'Channel name is required', { retryable: false })
    try {
      await this.request<unknown>(`/channels/${encodeURIComponent(bare)}/join`, {
        method: 'POST',
        auth: 'agent',
        body: {}
      })
      return { alreadyMember: false }
    } catch (error) {
      if (error instanceof RelayChatError && error.code === 'name_conflict') return { alreadyMember: true }
      throw error
    }
  }

  // --- History (server returns newest-first; clients read oldest-first) ---

  private clampLimit(limit?: number): number {
    if (!Number.isFinite(limit) || !limit || limit <= 0) return RELAY_CHAT_HISTORY_LIMIT
    return Math.min(Math.floor(limit as number), RELAY_CHAT_HISTORY_LIMIT)
  }

  /** Relaycast lists newest-first; reverse to oldest-first for display. */
  private async normalizeHistory(rows: unknown, fallback: { conversationId?: string; channelName?: string }): Promise<RelayChatMessage[]> {
    const list = Array.isArray(rows) ? [...rows].reverse() : []
    const messages: RelayChatMessage[] = []
    for (const entry of list) {
      messages.push(await this.normalizeMessage(entry, fallback))
    }
    return messages
  }

  async getChannelMessages(channel: string, limit?: number): Promise<RelayChatMessage[]> {
    const bare = channel.trim().replace(/^#+/, '')
    if (!bare) throw new RelayChatError('unknown_error', 'Channel name is required', { retryable: false })
    const data = await this.request<unknown>(`/channels/${encodeURIComponent(bare)}/messages`, {
      auth: 'agent',
      query: { limit: String(this.clampLimit(limit)) }
    })
    return this.normalizeHistory(data, { channelName: bare })
  }

  async getDMMessages(conversationId: string, limit?: number): Promise<RelayChatMessage[]> {
    const raw = fromConversationId(conversationId)
    if (!raw) throw new RelayChatError('unknown_error', 'Conversation id is required', { retryable: false })
    const data = await this.request<unknown>(`/dm/${encodeURIComponent(raw)}/messages`, {
      auth: 'agent',
      query: { limit: String(this.clampLimit(limit)) }
    })
    return this.normalizeHistory(data, { conversationId: raw })
  }

  async getHistory(input: ChatHistoryInput): Promise<RelayChatMessage[]> {
    const messages = input.kind === 'channel'
      ? await this.getChannelMessages(input.id, input.limit)
      : await this.getDMMessages(input.id, input.limit)
    if (!input.withDelivery) return messages
    const self = await this.selfName()
    await this.attachDelivery(messages, self)
    return messages
  }

  // --- Send / read receipts ---

  async sendDM(input: ChatSendInput, opts?: { idempotencyKey?: string }): Promise<RelayChatMessage> {
    const to = input.to.trim()
    const text = input.text
    if (!to) throw new RelayChatError('unknown_error', 'DM recipient is required', { retryable: false })
    if (!text.trim()) throw new RelayChatError('unknown_error', 'Message text is required', { retryable: false })
    const data = await this.request<unknown>('/dm', {
      method: 'POST',
      auth: 'agent',
      idempotencyKey: opts?.idempotencyKey ?? input.idempotencyKey,
      body: {
        to,
        text,
        ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {})
      }
    })
    const record = asRecord(data) ?? {}
    // `DmSendResponse` nests the payload under `message`, with legacy flat
    // compatibility fields alongside it.
    const nested = asRecord(record.message) ?? record
    const conversationId = asString(record.conversation_id ?? record.conversationId) ?? ''
    return this.normalizeMessage(
      { ...nested, conversation_id: conversationId || undefined },
      conversationId ? { conversationId } : {}
    )
  }

  async sendChannelMessage(channel: string, input: Omit<ChatSendInput, 'to' | 'kind'>, opts?: { idempotencyKey?: string }): Promise<RelayChatMessage> {
    const bare = channel.trim().replace(/^#+/, '')
    if (!bare) throw new RelayChatError('unknown_error', 'Channel name is required', { retryable: false })
    if (!input.text.trim()) throw new RelayChatError('unknown_error', 'Message text is required', { retryable: false })
    const data = await this.request<unknown>(`/channels/${encodeURIComponent(bare)}/messages`, {
      method: 'POST',
      auth: 'agent',
      idempotencyKey: opts?.idempotencyKey ?? input.idempotencyKey,
      body: {
        text: input.text,
        ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {})
      }
    })
    return this.normalizeMessage(data, { channelName: bare })
  }

  async markRead(messageId: string): Promise<void> {
    const id = messageId.trim()
    if (!id) throw new RelayChatError('unknown_error', 'Message id is required', { retryable: false })
    await this.request<unknown>(`/messages/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      auth: 'agent',
      body: {}
    })
  }

  /**
   * Delivery rule: a message counts as delivered when at least one reader
   * other than the sender has marked it read.
   */
  async getMessageReaders(messageId: string, senderName?: string): Promise<{ readers: string[]; delivered: boolean }> {
    const id = messageId.trim()
    if (!id) throw new RelayChatError('unknown_error', 'Message id is required', { retryable: false })
    const data = await this.request<unknown>(`/messages/${encodeURIComponent(id)}/readers`, { auth: 'agent' })
    const rows = Array.isArray(data) ? data : []
    const readers = rows.flatMap((entry) => {
      const name = asString(asRecord(entry)?.agent_name ?? asRecord(entry)?.agentName)
      return name ? [name] : []
    })
    const sender = senderName?.trim().toLowerCase()
    const delivered = sender
      ? readers.some((reader) => reader.toLowerCase() !== sender)
      : readers.length > 0
    return { readers, delivered }
  }

  /** Best-effort delivery flags for a history page; never rejects the page. */
  async attachDelivery(messages: RelayChatMessage[], senderName?: string): Promise<RelayChatMessage[]> {
    for (const message of messages) {
      if (!isServerMessageId(message.id)) continue
      try {
        const { delivered } = await this.getMessageReaders(message.id, message.from || senderName)
        message.delivered = delivered
      } catch {
        // Readers are advisory — a failure must not fail the history load.
      }
    }
    return messages
  }

  // --- Files: POST /files/upload → PUT upload_url → POST /files/{id}/complete ---

  async uploadFile(input: { filename: string; contentType: string; bytes: Uint8Array }): Promise<RelayAttachment> {
    const filename = input.filename.trim()
    if (!filename) throw new RelayChatError('unknown_error', 'Filename is required', { retryable: false })
    const contentType = input.contentType.trim() || 'application/octet-stream'
    const started = await this.request<{ id?: unknown; upload_url?: unknown; uploadUrl?: unknown }>('/files/upload', {
      method: 'POST',
      auth: 'agent',
      body: { filename, content_type: contentType, size_bytes: input.bytes.byteLength }
    })
    const fileId = asString(started?.id)
    const uploadUrl = asString(started?.upload_url ?? started?.uploadUrl)
    if (!fileId || !uploadUrl) {
      throw new RelayChatError('unknown_error', 'Upload initialization did not return an upload URL', { retryable: false })
    }
    const putRes = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      // `Uint8Array` is a valid fetch body; copy to detach from any pool.
      body: new Uint8Array(input.bytes)
    }).catch((error: unknown) => {
      throw new RelayChatError(
        'transport_error',
        `File bytes upload failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true }
      )
    })
    if (!putRes.ok) {
      throw new RelayChatError('transport_error', `File bytes upload failed (HTTP ${putRes.status})`, {
        status: putRes.status,
        retryable: putRes.status >= 500
      })
    }
    const completed = await this.request<{ id?: unknown; filename?: unknown; content_type?: unknown; contentType?: unknown; size_bytes?: unknown; sizeBytes?: unknown; download_url?: unknown; downloadUrl?: unknown }>(
      `/files/${encodeURIComponent(fileId)}/complete`,
      { method: 'POST', auth: 'agent', body: {} }
    )
    const attachment: RelayAttachment = {
      file_id: asString(completed?.id) ?? fileId,
      filename: asString(completed?.filename) ?? filename,
      content_type: asString(completed?.content_type ?? completed?.contentType) ?? contentType,
      size_bytes: typeof completed?.size_bytes === 'number'
        ? completed.size_bytes
        : typeof completed?.sizeBytes === 'number' ? (completed.sizeBytes as number) : input.bytes.byteLength
    }
    const downloadUrl = asString(completed?.download_url ?? completed?.downloadUrl)
    return downloadUrl ? { ...attachment, downloadUrl } : attachment
  }

  async getFile(fileId: string): Promise<RelayAttachment> {
    const id = fileId.trim().replace(/^drive:/, '')
    if (!id) throw new RelayChatError('unknown_error', 'File id is required', { retryable: false })
    const data = await this.request<Record<string, unknown>>(
      `/files/${encodeURIComponent(id)}`,
      { auth: 'agent' }
    )
    const record = asRecord(data) ?? {}
    const downloadUrl = asString(record.download_url ?? record.downloadUrl)
    const sizeRaw = record.size_bytes ?? record.sizeBytes
    const file: RelayAttachment = {
      file_id: asString(record.id) ?? id,
      filename: asString(record.filename) ?? id,
      content_type: asString(record.content_type ?? record.contentType) ?? 'application/octet-stream',
      size_bytes: typeof sizeRaw === 'number' ? sizeRaw : 0
    }
    return downloadUrl ? { ...file, downloadUrl } : file
  }
}

export type RelayChatPollReason = 'interval' | 'foreground' | 'manual' | 'open'

export interface RelayChatPollTasks {
  /** Roster + nodes refresh (workspace key). */
  pollRoster?: () => Promise<unknown>
  /** DM thread/message refresh (agent token). */
  pollMessages?: () => Promise<unknown>
  /** Channel list refresh — never full channel history on the tick. */
  pollChannels?: () => Promise<unknown>
  /** Full history for the currently open conversation (open/foreground/manual only). */
  loadOpenChannelHistory?: () => Promise<unknown>
  /** Called after a successful refresh cycle so the IPC layer can broadcast. */
  onRefreshed?: (reason: RelayChatPollReason) => void
  onError?: (error: unknown, reason: RelayChatPollReason) => void
}

export interface RelayChatPollerOptions {
  intervalMs?: number
  setIntervalImpl?: (fn: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
}

/**
 * 30s poll scheduler. The background tick refreshes roster+nodes, DM
 * messages, and the channel list — channel message history loads only on
 * open / foreground / manual refresh via `refreshNow`, plus the per-open
 * `chat.getHistory` IPC call the renderer makes itself.
 */
export class RelayChatPoller {
  private readonly tasks: RelayChatPollTasks
  private readonly intervalMs: number
  private readonly setIntervalImpl: (fn: () => void, ms: number) => unknown
  private readonly clearIntervalImpl: (handle: unknown) => void
  private timer: unknown = null
  private inFlight: Promise<void> | null = null
  private openChannel: string | null = null

  constructor(tasks: RelayChatPollTasks, options?: RelayChatPollerOptions) {
    this.tasks = tasks
    const interval = options?.intervalMs ?? RELAY_CHAT_POLL_INTERVAL_MS
    this.intervalMs = Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : RELAY_CHAT_POLL_INTERVAL_MS
    this.setIntervalImpl = options?.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalImpl = options?.clearIntervalImpl ?? ((handle) => { clearInterval(handle as never) })
  }

  get running(): boolean {
    return this.timer !== null
  }

  setOpenChannel(channel: string | null): void {
    this.openChannel = channel?.trim() || null
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = this.setIntervalImpl(() => {
      void this.refreshNow('interval')
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer)
      this.timer = null
    }
  }

  /** Foreground / manual / per-open refresh: tick tasks + open history. */
  refreshNow(reason: Exclude<RelayChatPollReason, 'interval'> | 'interval' = 'manual'): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runCycle(reason).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async runCycle(reason: RelayChatPollReason): Promise<void> {
    const withHistory = reason !== 'interval'
    const steps: Array<() => Promise<unknown>> = []
    if (this.tasks.pollRoster) steps.push(this.tasks.pollRoster)
    if (this.tasks.pollMessages) steps.push(this.tasks.pollMessages)
    if (this.tasks.pollChannels) steps.push(this.tasks.pollChannels)
    if (withHistory && this.openChannel && this.tasks.loadOpenChannelHistory) {
      steps.push(this.tasks.loadOpenChannelHistory)
    }
    // Sequential: a rotated workspace key from roster refresh must settle
    // before agent calls reuse it.
    for (const step of steps) {
      try {
        await step()
      } catch (error) {
        this.tasks.onError?.(error, reason)
        return
      }
    }
    this.tasks.onRefreshed?.(reason)
  }
}
