import WebSocket from 'ws'
import { isRecord } from './guards'
import { toErrorMessage } from './errors'
import type { BrokerReconciledChatMessage, ObserverChatUpdate } from '../shared/types/ipc'

/**
 * Relaycast observer-stream consumer (feature-flagged, default OFF).
 *
 * When `PEAR_OBSERVER_STREAM` is enabled, one manager per broker session mints
 * a scoped read-only observer token via the local broker
 * (`POST /api/observer-token`), opens the engine's observer WebSocket
 * (`wss://<relay base>/v1/ws?token=<ot_live_...>`), REST-backfills missed
 * events from the persisted per-workspace cursor
 * (`GET <relay base>/v1/workspace/events?since=<seq>&limit=<n>`), and
 * translates message-class events into the exact `BrokerReconciledChatMessage`
 * shape the renderer already merges through
 * `useAgentStore.getState().reconcileMessages` — the same path the REST
 * polling reconciliation feeds. No new renderer store; the observer plane is
 * purely an additional producer for the existing merge.
 *
 * Everything degrades silently to the existing polling path: flag off means
 * no manager is created; a 404 from the observer-token route or the
 * workspace-events route marks the stream unsupported and stops for good; a
 * WS that will not authenticate retries with a freshly minted token and backs
 * off. The 3s active-room polling reconciliation is untouched and remains the
 * source of truth.
 */

const DEFAULT_BACKFILL_PAGE_LIMIT = 500
const MAX_BACKFILL_PAGE_LIMIT = 500
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000
const CURSOR_SAVE_DEBOUNCE_MS = 1_000

/** Feature flag: default OFF. Same env-var pattern as PEAR_BROKER_DEBUG. */
export function isObserverStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PEAR_OBSERVER_STREAM === '1' || env.PEAR_OBSERVER_STREAM === 'true'
}

/**
 * The server side of the observer plane is missing (older broker without
 * `/api/observer-token`, or older engine without `/v1/workspace/events`).
 * Permanently disables the manager — the polling path stays primary.
 */
export class ObserverStreamUnsupportedError extends Error {}

/** The observer token was rejected (expired/revoked) — mint a fresh one. */
export class ObserverStreamAuthError extends Error {}

/**
 * A single observer-plane event, normalized from either source:
 * - a live WS frame (the relaycast client event itself, with top-level `seq`)
 * - a backfill envelope (`{ seq, type, payload, created_at }` where `payload`
 *   is the same client event JSON)
 *
 * `seq` may be absent when the server's log append failed for that event.
 */
export interface ObserverStreamEvent {
  seq?: number
  type: string
  payload: Record<string, unknown>
  createdAt?: string
}

export interface ObserverBackfillPage {
  events: ObserverStreamEvent[]
  latestSeq?: number
}

export interface ObserverSocketLike {
  on(event: string, listener: (...args: never[]) => void): unknown
  close(): void
}

export interface ObserverStreamManagerOptions {
  projectId: string
  /** Relaycast engine base URL (same one reconcileMessages talks to). */
  relayBaseUrl: string
  /** Mint (or re-mint, when `forceFresh`) the scoped observer token. */
  mintToken: (input: { forceFresh: boolean }) => Promise<string>
  /** Resolve the workspace id used to key the persisted cursor. */
  getWorkspaceId: () => Promise<string | undefined>
  loadCursor: (workspaceKey: string) => number | undefined
  saveCursor: (workspaceKey: string, seq: number) => void
  /** Deliver translated message-class events to the renderer. */
  emit: (update: ObserverChatUpdate) => void
  fetchFn?: typeof fetch
  createWebSocket?: (url: string) => ObserverSocketLike
  log?: (message: string) => void
  warn?: (message: string) => void
  backfillPageLimit?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isHumanSenderName(sender: string): boolean {
  return sender.trim().toLowerCase() === 'human'
}

function normalizeChannelTarget(channelName: string): string {
  const normalized = channelName.trim().replace(/^#/, '')
  return normalized ? `#${normalized}` : '#general'
}

function eventTimestamp(message: Record<string, unknown>, event: ObserverStreamEvent, now: () => number): number {
  const raw = toNonEmptyString(message.created_at) || toNonEmptyString(message.createdAt) || event.createdAt
  if (raw) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return now()
}

interface ObserverMessagePayload {
  id: string
  from: string
  body: string
}

function coerceMessagePayload(value: unknown): ObserverMessagePayload | null {
  if (!isRecord(value)) return null
  const id = toNonEmptyString(value.id)
  const from = toNonEmptyString(value.agent_name) || toNonEmptyString(value.agentName)
  const body = toNonEmptyString(value.text)
  if (!id || !from || !body) return null
  return { id, from, body }
}

/**
 * Normalize a live WS frame into an ObserverStreamEvent. Returns null for
 * frames that are not workspace events (pong, malformed JSON, ...).
 */
export function parseObserverFrame(raw: unknown): ObserverStreamEvent | null {
  let value: unknown = raw
  if (typeof raw === 'string' || raw instanceof Buffer) {
    try {
      value = JSON.parse(raw.toString())
    } catch {
      return null
    }
  }
  if (!isRecord(value)) return null
  const type = toNonEmptyString(value.type)
  if (!type) return null
  return {
    type,
    payload: value,
    ...(toFiniteNumber(value.seq) !== undefined ? { seq: toFiniteNumber(value.seq) } : {}),
    ...(toNonEmptyString(value.created_at) ? { createdAt: value.created_at as string } : {})
  }
}

/**
 * Parse the `GET /v1/workspace/events` response body
 * (`{ ok, data: { events: [{ seq, type, channel_id, payload, created_at }], latest_seq } }`).
 * Returns null when the body does not match the contract.
 */
export function parseWorkspaceEventsResponse(body: unknown): ObserverBackfillPage | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null
  const rawEvents = body.data.events
  if (!Array.isArray(rawEvents)) return null

  const events: ObserverStreamEvent[] = []
  for (const entry of rawEvents) {
    if (!isRecord(entry)) continue
    const type = toNonEmptyString(entry.type)
    const payload = isRecord(entry.payload) ? entry.payload : undefined
    if (!type || !payload) continue
    events.push({
      type,
      payload,
      ...(toFiniteNumber(entry.seq) !== undefined ? { seq: toFiniteNumber(entry.seq) } : {}),
      ...(toNonEmptyString(entry.created_at) ? { createdAt: entry.created_at as string } : {})
    })
  }

  const latestSeq = toFiniteNumber(body.data.latest_seq)
  return { events, ...(latestSeq !== undefined ? { latestSeq } : {}) }
}

/**
 * Merge/dedupe observer events against the cursor: drop events already
 * processed (`seq <= cursor`), collapse duplicate seqs (backfill + buffered
 * WS frames overlap by design), and return them seq-ascending. Events without
 * a seq (server log append failed) are kept — the renderer merge dedupes by
 * message id, so a rare duplicate is harmless while a dropped message is not.
 */
export function filterAndSortObserverEvents(
  events: ObserverStreamEvent[],
  cursor: number | undefined
): ObserverStreamEvent[] {
  const seen = new Set<number>()
  const withSeq: ObserverStreamEvent[] = []
  const withoutSeq: ObserverStreamEvent[] = []
  for (const event of events) {
    if (event.seq === undefined) {
      withoutSeq.push(event)
      continue
    }
    if (cursor !== undefined && event.seq <= cursor) continue
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    withSeq.push(event)
  }
  withSeq.sort((left, right) => (left.seq as number) - (right.seq as number))
  return [...withSeq, ...withoutSeq]
}

/** Highest seq present in a batch, or undefined when none carry one. */
export function maxObserverSeq(events: ObserverStreamEvent[]): number | undefined {
  let max: number | undefined
  for (const event of events) {
    if (event.seq !== undefined && (max === undefined || event.seq > max)) max = event.seq
  }
  return max
}

/**
 * Translate message-class observer events into the shapes the renderer's
 * existing reconciled-message merge consumes. Non-message events (presence,
 * channel lifecycle, ...) are ignored here — the cursor still advances past
 * them in the manager.
 *
 * TODO(observer-stream): `message.reacted` and `message.read` are not
 * translated — the renderer store has no incremental merge path for a
 * reaction/read-receipt keyed by message id (reactions only ride full
 * reconciled messages today). Wire them once agent-store grows one.
 */
export function translateObserverEvents(
  events: ObserverStreamEvent[],
  projectId: string,
  now: () => number = () => Date.now()
): ObserverChatUpdate | null {
  const messages: BrokerReconciledChatMessage[] = []
  const directMessages: ObserverChatUpdate['directMessages'] = []
  const threadReplies: ObserverChatUpdate['threadReplies'] = []

  for (const event of events) {
    const payload = event.payload
    if (event.type === 'message.created' || event.type === 'message.updated') {
      const message = coerceMessagePayload(payload.message)
      const channel = toNonEmptyString(payload.channel)
      if (!message || !channel) continue
      messages.push({
        id: message.id,
        kind: 'message',
        from: message.from,
        to: normalizeChannelTarget(channel),
        body: message.body,
        timestamp: eventTimestamp(payload.message as Record<string, unknown>, event, now),
        isHuman: isHumanSenderName(message.from),
        projectId
      })
    } else if (event.type === 'dm.received' || event.type === 'group_dm.received') {
      const message = coerceMessagePayload(payload.message)
      const conversationId = toNonEmptyString(payload.conversation_id)
      if (!message || !conversationId) continue
      directMessages.push({
        conversationId,
        message: {
          id: message.id,
          kind: 'message',
          from: message.from,
          // The event carries only the sender + conversation id; the renderer
          // bridge resolves `to` from the conversation's known participants
          // before merging (see observer-chat.ts).
          to: conversationId,
          body: message.body,
          timestamp: eventTimestamp(payload.message as Record<string, unknown>, event, now),
          isHuman: isHumanSenderName(message.from),
          projectId,
          conversationId
        }
      })
    } else if (event.type === 'thread.reply') {
      const message = coerceMessagePayload(payload.message)
      const parentId = toNonEmptyString(payload.parent_id)
      if (!message || !parentId) continue
      threadReplies.push({
        parentId,
        reply: {
          id: message.id,
          from: message.from,
          body: message.body,
          timestamp: eventTimestamp(payload.message as Record<string, unknown>, event, now),
          isHuman: isHumanSenderName(message.from),
          projectId
        }
      })
    }
  }

  if (messages.length === 0 && directMessages.length === 0 && threadReplies.length === 0) return null
  return { projectId, messages, directMessages, threadReplies }
}

/** `https://cast.agentrelay.com` → `wss://cast.agentrelay.com/v1/ws?token=...` */
export function observerWsUrl(relayBaseUrl: string, token: string): string {
  const url = new URL(relayBaseUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/ws`
  url.search = `?token=${encodeURIComponent(token)}`
  return url.toString()
}

export function workspaceEventsUrl(relayBaseUrl: string, since: number, limit: number): string {
  const base = relayBaseUrl.replace(/\/+$/, '')
  return `${base}/v1/workspace/events?since=${since}&limit=${limit}`
}

type ManagerState = 'idle' | 'running' | 'unsupported' | 'stopped'

export class ObserverStreamManager {
  private readonly options: ObserverStreamManagerOptions
  private state: ManagerState = 'idle'
  private cursor: number | undefined
  private cursorKey: string | undefined
  private cursorDirty = false
  private cursorSaveTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private nextMintForceFresh = false
  private socket: ObserverSocketLike | null = null

  constructor(options: ObserverStreamManagerOptions) {
    this.options = options
  }

  get status(): ManagerState {
    return this.state
  }

  start(): void {
    if (this.state !== 'idle') return
    this.state = 'running'
    void this.runCycle()
  }

  stop(): void {
    if (this.state === 'stopped') return
    this.state = 'stopped'
    this.clearReconnectTimer()
    this.flushCursorSave()
    this.closeSocket()
  }

  private log(message: string): void {
    this.options.log?.(message)
  }

  private warn(message: string): void {
    this.options.warn?.(message)
  }

  private setTimeoutFn(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.options.setTimeoutFn ?? setTimeout)(handler, ms)
  }

  private clearTimeoutFn(handle: ReturnType<typeof setTimeout>): void {
    ;(this.options.clearTimeoutFn ?? clearTimeout)(handle)
  }

  private async runCycle(): Promise<void> {
    if (this.state !== 'running') return
    try {
      const token = await this.options.mintToken({ forceFresh: this.nextMintForceFresh })
      this.nextMintForceFresh = false
      await this.ensureCursorLoaded()
      await this.connectAndStream(token)
      // Socket closed after a healthy run — reconnect promptly.
      this.reconnectAttempts = 0
    } catch (err) {
      if (this.state !== 'running') return
      if (err instanceof ObserverStreamUnsupportedError) {
        this.disableUnsupported(err.message)
        return
      }
      if (err instanceof ObserverStreamAuthError) {
        // Token expired or was revoked — the next cycle mints a fresh one.
        this.nextMintForceFresh = true
      }
      this.warn(`observer stream cycle failed: ${toErrorMessage(err)}`)
    }
    this.scheduleReconnect()
  }

  private async ensureCursorLoaded(): Promise<void> {
    const workspaceId = await this.options.getWorkspaceId().catch(() => undefined)
    const nextKey = workspaceId || this.options.projectId
    if (this.cursorKey !== nextKey) {
      this.flushCursorSave()
      this.cursorKey = nextKey
      this.cursor = this.options.loadCursor(nextKey)
    }
  }

  private disableUnsupported(reason: string): void {
    if (this.state === 'stopped') return
    this.state = 'unsupported'
    this.clearReconnectTimer()
    this.flushCursorSave()
    this.closeSocket()
    this.log(`observer stream unsupported by server — staying on polling reconciliation (${reason})`)
  }

  private scheduleReconnect(): void {
    if (this.state !== 'running' || this.reconnectTimer) return
    const base = this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS
    const max = this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
    const delay = Math.min(base * 2 ** Math.min(this.reconnectAttempts, 10), max)
    this.reconnectAttempts += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null
      void this.runCycle()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch {
        // Best-effort teardown.
      }
    }
  }

  /**
   * Open the WS first (buffering frames), backfill from the cursor over REST,
   * then drain the buffer and go live. Resolves when the socket closes;
   * rejects on connect/auth/backfill errors.
   */
  private async connectAndStream(token: string): Promise<void> {
    const createWebSocket =
      this.options.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as ObserverSocketLike)
    const socket = createWebSocket(observerWsUrl(this.options.relayBaseUrl, token))
    this.socket = socket

    let buffering = true
    let buffered: ObserverStreamEvent[] = []

    return new Promise<void>((resolve, reject) => {
      let settledOpen = false
      const failBeforeOpen = (err: Error): void => {
        if (settledOpen) return
        settledOpen = true
        this.closeSocket()
        reject(err)
      }

      socket.on('unexpected-response', ((_req: unknown, res: { statusCode?: number }) => {
        const status = res?.statusCode
        if (status === 401 || status === 403) {
          failBeforeOpen(new ObserverStreamAuthError(`observer WS rejected (HTTP ${status})`))
        } else if (status === 404) {
          failBeforeOpen(new ObserverStreamUnsupportedError('observer WS endpoint missing (HTTP 404)'))
        } else {
          failBeforeOpen(new Error(`observer WS unexpected response (HTTP ${status ?? 'unknown'})`))
        }
      }) as never)

      socket.on('error', ((err: unknown) => {
        failBeforeOpen(err instanceof Error ? err : new Error(toErrorMessage(err)))
      }) as never)

      socket.on('close', ((code: unknown) => {
        if (settledOpen) {
          if (this.socket === socket) this.socket = null
          resolve()
        } else {
          const numericCode = typeof code === 'number' ? code : undefined
          if (numericCode === 4401 || numericCode === 4403 || numericCode === 1008) {
            failBeforeOpen(new ObserverStreamAuthError(`observer WS closed with auth code ${numericCode}`))
          } else {
            failBeforeOpen(new Error(`observer WS closed before opening (code ${numericCode ?? 'unknown'})`))
          }
        }
      }) as never)

      socket.on('message', ((data: unknown) => {
        if (this.state !== 'running') return
        const event = parseObserverFrame(data)
        if (!event) return
        if (buffering) {
          buffered.push(event)
          return
        }
        this.processEvents([event])
      }) as never)

      socket.on('open', (() => {
        void (async () => {
          try {
            await this.backfill(token)
            if (this.state !== 'running' || this.socket !== socket) return
            buffering = false
            const pending = buffered
            buffered = []
            this.processEvents(pending)
            settledOpen = true
            this.reconnectAttempts = 0
            this.log('observer stream live')
          } catch (err) {
            failBeforeOpen(err instanceof Error ? err : new Error(toErrorMessage(err)))
          }
        })()
      }) as never)
    })
  }

  private async backfill(token: string): Promise<void> {
    if (this.cursor === undefined) {
      // First run for this workspace: don't replay the entire history — adopt
      // the current head and stream from here on. The REST reconciliation
      // already hydrates canonical room history on demand.
      const page = await this.fetchEventsPage(token, 0, 1)
      this.setCursor(page.latestSeq ?? 0)
      this.log(`observer stream cursor initialized at seq ${this.cursor}`)
      return
    }

    const limit = Math.min(this.options.backfillPageLimit ?? DEFAULT_BACKFILL_PAGE_LIMIT, MAX_BACKFILL_PAGE_LIMIT)
    let since = this.cursor
    for (;;) {
      const page = await this.fetchEventsPage(token, since, limit)
      this.processEvents(page.events)
      const pageMax = maxObserverSeq(page.events)
      if (page.events.length < limit) break
      if (pageMax === undefined || pageMax <= since) break
      since = pageMax
    }
  }

  private async fetchEventsPage(token: string, since: number, limit: number): Promise<ObserverBackfillPage> {
    const fetchFn = this.options.fetchFn ?? fetch
    let response: Response
    try {
      response = await fetchFn(workspaceEventsUrl(this.options.relayBaseUrl, since, limit), {
        headers: { Authorization: `Bearer ${token}` }
      })
    } catch (err) {
      throw new Error(`observer backfill request failed: ${toErrorMessage(err)}`)
    }

    if (response.status === 404) {
      throw new ObserverStreamUnsupportedError('GET /v1/workspace/events returned 404 (older engine)')
    }
    if (response.status === 401 || response.status === 403) {
      throw new ObserverStreamAuthError(`observer backfill rejected (HTTP ${response.status})`)
    }
    if (!response.ok) {
      throw new Error(`observer backfill failed (HTTP ${response.status})`)
    }

    const body = await response.json().catch(() => undefined)
    const page = parseWorkspaceEventsResponse(body)
    if (!page) {
      throw new Error('observer backfill returned an unexpected response shape')
    }
    return page
  }

  /**
   * Dedupe against the cursor, emit translated message-class events, and
   * advance + persist the cursor past every event that carried a seq.
   */
  private processEvents(events: ObserverStreamEvent[]): void {
    if (this.state !== 'running' || events.length === 0) return
    const fresh = filterAndSortObserverEvents(events, this.cursor)
    if (fresh.length === 0) return

    const update = translateObserverEvents(fresh, this.options.projectId)
    if (update) {
      try {
        this.options.emit(update)
      } catch (err) {
        this.warn(`observer stream emit failed: ${toErrorMessage(err)}`)
      }
    }

    const max = maxObserverSeq(fresh)
    if (max !== undefined && (this.cursor === undefined || max > this.cursor)) {
      this.setCursor(max)
    }
  }

  private setCursor(seq: number): void {
    this.cursor = seq
    this.cursorDirty = true
    if (this.cursorSaveTimer) return
    this.cursorSaveTimer = this.setTimeoutFn(() => {
      this.cursorSaveTimer = null
      this.flushCursorSave()
    }, CURSOR_SAVE_DEBOUNCE_MS)
  }

  private flushCursorSave(): void {
    if (this.cursorSaveTimer) {
      this.clearTimeoutFn(this.cursorSaveTimer)
      this.cursorSaveTimer = null
    }
    if (!this.cursorDirty || this.cursor === undefined || !this.cursorKey) return
    this.cursorDirty = false
    try {
      this.options.saveCursor(this.cursorKey, this.cursor)
    } catch (err) {
      this.warn(`observer stream failed to persist cursor: ${toErrorMessage(err)}`)
    }
  }
}
