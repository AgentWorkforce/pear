import { createHash } from 'node:crypto'
import { toChannelId, toConversationId } from './relay-chat-client'
import type { RelayChatMessage } from '../shared/types/ipc'

type Unsubscribe = () => void

export interface LiveEventMessage {
  id?: string
  agentName?: string
  text?: string
  attachments?: unknown
}

/** The slice of the Relaycast SDK `AgentClient` the live stream uses. */
export interface RelayChatLiveSocket {
  connect(): void
  disconnect(): Promise<void> | void
  subscribe(channels: string[]): void
  on: {
    dmReceived(handler: (event: { conversationId: string; message: LiveEventMessage }) => void): Unsubscribe
    groupDmReceived(handler: (event: { conversationId: string; message: LiveEventMessage }) => void): Unsubscribe
    messageCreated(handler: (event: { channel: string; message: LiveEventMessage }) => void): Unsubscribe
    messageRead(handler: (event: { messageId: string; agentName: string }) => void): Unsubscribe
    connected(handler: () => void): Unsubscribe
    disconnected(handler: () => void): Unsubscribe
    resynced(handler: (info: { replayed: number; gapDetected: boolean }) => void): Unsubscribe
  }
}

export interface RelayChatLiveOptions {
  createSocket: () => RelayChatLiveSocket | Promise<RelayChatLiveSocket>
  selfName: () => string | null | undefined
  toMessage: (record: LiveEventMessage, fallback: { conversationId?: string; channelName?: string }) => Promise<RelayChatMessage>
  onMessage: (conversationId: string, message: RelayChatMessage) => void
  /** Someone other than the companion read `messageId`. */
  onRead: (messageId: string, reader: string) => void
  /** A reconnect that may have missed events: reload what's on screen. */
  onResync: (reason: 'reconnect' | 'gap') => void
  now?: () => number
  log?: Pick<Console, 'info' | 'warn'>
}

const SEEN_LIMIT = 2_000
const WARN_GAP_MS = 60_000

/**
 * Relaycast WebSocket stream for the chat companion: pushes received DMs,
 * channel posts, and read receipts the moment Relaycast emits them, instead
 * of waiting for the next list poll. Replays after a reconnect are expected,
 * so every message is deduped by id + content before it reaches the renderer.
 */
export class RelayChatLive {
  private readonly options: RelayChatLiveOptions
  private readonly log: Pick<Console, 'info' | 'warn'>
  private readonly now: () => number
  private socket: RelayChatLiveSocket | null = null
  private starting: Promise<void> | null = null
  private unsubscribes: Unsubscribe[] = []
  private generation = 0
  private hasConnected = false
  private isConnected = false
  private readonly seen = new Set<string>()
  private readonly subscribedChannels = new Set<string>()
  private suppressedDuplicates = 0
  private missingIdentity = 0
  private lastMissingWarnAt = 0

  constructor(options: RelayChatLiveOptions) {
    this.options = options
    this.log = options.log ?? console
    this.now = options.now ?? Date.now
  }

  get connected(): boolean {
    return this.isConnected
  }

  get duplicatesSuppressed(): number {
    return this.suppressedDuplicates
  }

  /** Idempotent: concurrent calls share one connect. */
  start(): Promise<void> {
    if (this.socket) return Promise.resolve()
    if (this.starting) return this.starting
    const generation = ++this.generation
    this.starting = this.open(generation).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  stop(): void {
    this.generation += 1
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    const socket = this.socket
    this.socket = null
    this.isConnected = false
    this.hasConnected = false
    this.subscribedChannels.clear()
    if (socket) void Promise.resolve(socket.disconnect()).catch(() => undefined)
  }

  subscribeChannels(names: readonly string[]): void {
    const fresh = [...new Set(names.map((name) => name.trim().replace(/^#+/, '')))]
      .filter((name) => name && !this.subscribedChannels.has(name))
    if (fresh.length === 0 || !this.socket) return
    for (const name of fresh) this.subscribedChannels.add(name)
    this.socket.subscribe(fresh)
  }

  private async open(generation: number): Promise<void> {
    const socket = await this.options.createSocket()
    if (generation !== this.generation) {
      void Promise.resolve(socket.disconnect()).catch(() => undefined)
      return
    }
    socket.connect()
    const live = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A): void => {
      if (generation === this.generation) fn(...args)
    }
    this.unsubscribes.push(
      socket.on.connected(live(() => {
        this.isConnected = true
        if (this.hasConnected) this.options.onResync('reconnect')
        this.hasConnected = true
        this.log.info('[chat] live stream connected')
      })),
      socket.on.disconnected(live(() => {
        this.isConnected = false
      })),
      socket.on.resynced(live((info: { replayed: number; gapDetected: boolean }) => {
        if (info.gapDetected) this.options.onResync('gap')
      })),
      socket.on.dmReceived(live((event: { conversationId: string; message: LiveEventMessage }) => {
        void this.deliver(generation, toConversationId(event.conversationId), event.message, { conversationId: event.conversationId })
      })),
      socket.on.groupDmReceived(live((event: { conversationId: string; message: LiveEventMessage }) => {
        void this.deliver(generation, toConversationId(event.conversationId), event.message, { conversationId: event.conversationId })
      })),
      socket.on.messageCreated(live((event: { channel: string; message: LiveEventMessage }) => {
        void this.deliver(generation, toChannelId(event.channel), event.message, { channelName: event.channel.replace(/^#+/, '') })
      })),
      socket.on.messageRead(live((event: { messageId: string; agentName: string }) => {
        const self = this.options.selfName()?.toLowerCase()
        if (!event.messageId || !event.agentName || event.agentName.toLowerCase() === self) return
        this.options.onRead(event.messageId, event.agentName)
      }))
    )
    this.socket = socket
  }

  private async deliver(
    generation: number,
    conversationId: string,
    record: LiveEventMessage,
    fallback: { conversationId?: string; channelName?: string }
  ): Promise<void> {
    if (!record) return
    if (record.id) {
      const key = `${record.id}:${createHash('sha1').update(record.text ?? '').digest('hex')}`
      if (this.seen.has(key)) {
        this.suppressedDuplicates += 1
        if (this.suppressedDuplicates % 50 === 1) {
          this.log.info(`[chat] live stream suppressed duplicate ${record.id} (${this.suppressedDuplicates} total)`)
        }
        return
      }
      this.seen.add(key)
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string)
    } else {
      this.missingIdentity += 1
      if (this.now() - this.lastMissingWarnAt >= WARN_GAP_MS) {
        this.lastMissingWarnAt = this.now()
        this.log.warn(`[chat] live message without an id in ${conversationId}; delivered without dedupe (${this.missingIdentity} so far)`)
      }
    }
    const message = await this.options.toMessage(record, fallback)
    if (generation !== this.generation) return
    this.options.onMessage(conversationId, message)
  }
}
