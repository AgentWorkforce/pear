import { describe, expect, it, vi } from 'vitest'
import { RelayChatLive, type LiveEventMessage, type RelayChatLiveSocket } from './relay-chat-live'
import type { RelayChatMessage } from '../shared/types/ipc'

type Handler = (...args: never[]) => void

function fakeSocket() {
  const handlers = new Map<string, Set<Handler>>()
  const register = (name: string) => (handler: Handler) => {
    if (!handlers.has(name)) handlers.set(name, new Set())
    handlers.get(name)!.add(handler)
    return () => { handlers.get(name)!.delete(handler) }
  }
  const socket = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    on: {
      dmReceived: register('dm'),
      groupDmReceived: register('groupDm'),
      messageCreated: register('channel'),
      messageRead: register('read'),
      connected: register('connected'),
      disconnected: register('disconnected'),
      resynced: register('resynced')
    }
  }
  const emit = (name: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(name) ?? []) handler(...(args as never[]))
  }
  return { socket: socket as unknown as RelayChatLiveSocket & typeof socket, emit, handlers }
}

function setup() {
  const sockets: ReturnType<typeof fakeSocket>[] = []
  const onMessage = vi.fn<(conversationId: string, message: RelayChatMessage) => void>()
  const onRead = vi.fn()
  const onResync = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn() }
  const live = new RelayChatLive({
    createSocket: () => {
      const fake = fakeSocket()
      sockets.push(fake)
      return fake.socket
    },
    selfName: () => 'pear-chat-host',
    toMessage: async (record: LiveEventMessage, fallback) => ({
      id: record.id ?? '',
      ...(fallback.conversationId ? { conversationId: fallback.conversationId } : {}),
      ...(fallback.channelName ? { channelName: fallback.channelName } : {}),
      from: record.agentName ?? 'unknown',
      text: record.text ?? '',
      createdAt: '2026-11-13T00:00:00.000Z',
      mine: record.agentName === 'pear-chat-host',
      hasServerID: !!record.id,
      attachments: []
    }),
    onMessage,
    onRead,
    onResync,
    log
  })
  return { live, sockets, onMessage, onRead, onResync, log }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('RelayChatLive', () => {
  it('pushes a received DM keyed by the Pear conversation id', async () => {
    const { live, sockets, onMessage } = setup()
    await live.start()
    sockets[0].emit('dm', { conversationId: 'dm_1', message: { id: 'm1', agentName: 'grok', text: 'hi' } })
    await flush()
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage.mock.calls[0][0]).toBe('conversation:dm_1')
    expect(onMessage.mock.calls[0][1]).toMatchObject({ id: 'm1', from: 'grok', text: 'hi', conversationId: 'dm_1' })
  })

  it('suppresses a replayed message with the same id and text', async () => {
    const { live, sockets, onMessage } = setup()
    await live.start()
    const event = { conversationId: 'dm_1', message: { id: 'm1', agentName: 'grok', text: 'hi' } }
    sockets[0].emit('dm', event)
    sockets[0].emit('dm', event)
    sockets[0].emit('connected')
    sockets[0].emit('connected')
    sockets[0].emit('dm', event)
    await flush()
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(live.duplicatesSuppressed).toBe(2)
  })

  it('delivers identical text under different ids', async () => {
    const { live, sockets, onMessage } = setup()
    await live.start()
    sockets[0].emit('dm', { conversationId: 'dm_1', message: { id: 'm1', agentName: 'grok', text: 'ok' } })
    sockets[0].emit('dm', { conversationId: 'dm_1', message: { id: 'm2', agentName: 'grok', text: 'ok' } })
    await flush()
    expect(onMessage).toHaveBeenCalledTimes(2)
  })

  it('delivers id-less messages and warns once per window', async () => {
    const { live, sockets, onMessage, log } = setup()
    await live.start()
    sockets[0].emit('dm', { conversationId: 'dm_1', message: { agentName: 'grok', text: 'a' } })
    sockets[0].emit('dm', { conversationId: 'dm_1', message: { agentName: 'grok', text: 'a' } })
    await flush()
    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent starts into one socket', async () => {
    const { live, sockets } = setup()
    await Promise.all([live.start(), live.start(), live.start()])
    await live.start()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].socket.connect).toHaveBeenCalledTimes(1)
  })

  it('drops events from a stopped generation', async () => {
    const { live, sockets, onMessage } = setup()
    await live.start()
    const stale = sockets[0]
    live.stop()
    await live.start()
    stale.emit('dm', { conversationId: 'dm_1', message: { id: 'm1', agentName: 'grok', text: 'hi' } })
    await flush()
    expect(onMessage).not.toHaveBeenCalled()
    expect(stale.socket.disconnect).toHaveBeenCalled()
    sockets[1].emit('dm', { conversationId: 'dm_1', message: { id: 'm1', agentName: 'grok', text: 'hi' } })
    await flush()
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('reports read receipts from others, not the companion', async () => {
    const { live, sockets, onRead } = setup()
    await live.start()
    sockets[0].emit('read', { messageId: 'm1', agentName: 'pear-chat-host' })
    sockets[0].emit('read', { messageId: 'm1', agentName: 'grok' })
    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead).toHaveBeenCalledWith('m1', 'grok')
  })

  it('asks for a reload after a reconnect or a replay gap, not on first connect', async () => {
    const { live, sockets, onResync } = setup()
    await live.start()
    sockets[0].emit('connected')
    expect(onResync).not.toHaveBeenCalled()
    sockets[0].emit('disconnected')
    expect(live.connected).toBe(false)
    sockets[0].emit('connected')
    sockets[0].emit('resynced', { replayed: 0, gapDetected: false })
    sockets[0].emit('resynced', { replayed: 500, gapDetected: true })
    expect(onResync.mock.calls).toEqual([['reconnect'], ['gap']])
  })

  it('keys channel posts by channel and subscribes each channel once', async () => {
    const { live, sockets, onMessage } = setup()
    await live.start()
    live.subscribeChannels(['#general', 'general', 'ops'])
    live.subscribeChannels(['ops'])
    expect(sockets[0].socket.subscribe).toHaveBeenCalledTimes(1)
    expect(sockets[0].socket.subscribe).toHaveBeenCalledWith(['general', 'ops'])
    sockets[0].emit('channel', { channel: 'general', message: { id: 'c1', agentName: 'grok', text: 'yo' } })
    await flush()
    expect(onMessage.mock.calls[0][0]).toBe('channel:general')
  })
})
