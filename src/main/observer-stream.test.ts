import { describe, expect, it } from 'vitest'
import {
  filterAndSortObserverEvents,
  isObserverStreamEnabled,
  maxObserverSeq,
  ObserverStreamManager,
  ObserverStreamUnsupportedError,
  observerWsUrl,
  parseObserverFrame,
  parseWorkspaceEventsResponse,
  translateObserverEvents,
  workspaceEventsUrl,
  type ObserverSocketLike,
  type ObserverStreamEvent,
  type ObserverStreamManagerOptions
} from './observer-stream'
import type { ObserverChatUpdate } from '../shared/types/ipc'

function channelEvent(seq: number | undefined, overrides: Record<string, unknown> = {}): ObserverStreamEvent {
  return {
    ...(seq !== undefined ? { seq } : {}),
    type: 'message.created',
    payload: {
      type: 'message.created',
      channel: 'general',
      message: {
        id: `msg-${seq ?? 'noseq'}`,
        agent_id: 'a1',
        agent_name: 'worker-1',
        text: `hello ${seq ?? 'noseq'}`
      },
      ...overrides
    }
  }
}

describe('isObserverStreamEnabled', () => {
  it('defaults OFF and honors 1/true', () => {
    expect(isObserverStreamEnabled({})).toBe(false)
    expect(isObserverStreamEnabled({ PEAR_OBSERVER_STREAM: '0' })).toBe(false)
    expect(isObserverStreamEnabled({ PEAR_OBSERVER_STREAM: '1' })).toBe(true)
    expect(isObserverStreamEnabled({ PEAR_OBSERVER_STREAM: 'true' })).toBe(true)
  })
})

describe('observer URLs', () => {
  it('derives the ws url from the relay base', () => {
    expect(observerWsUrl('https://cast.agentrelay.com', 'ot_live_x')).toBe(
      'wss://cast.agentrelay.com/v1/ws?token=ot_live_x'
    )
    expect(observerWsUrl('http://localhost:8787/', 'tok')).toBe('ws://localhost:8787/v1/ws?token=tok')
  })

  it('derives the backfill url with since/limit', () => {
    expect(workspaceEventsUrl('https://cast.agentrelay.com/', 42, 500)).toBe(
      'https://cast.agentrelay.com/v1/workspace/events?since=42&limit=500'
    )
  })
})

describe('parseObserverFrame', () => {
  it('parses a live frame with a top-level seq', () => {
    const frame = parseObserverFrame(JSON.stringify({ type: 'message.created', seq: 7, channel: 'general' }))
    expect(frame).toMatchObject({ type: 'message.created', seq: 7 })
  })

  it('keeps frames whose seq is absent (server log append failed)', () => {
    const frame = parseObserverFrame(JSON.stringify({ type: 'message.created', channel: 'general' }))
    expect(frame).toMatchObject({ type: 'message.created' })
    expect(frame?.seq).toBeUndefined()
  })

  it('rejects non-event frames and malformed JSON', () => {
    expect(parseObserverFrame('not json')).toBeNull()
    expect(parseObserverFrame(JSON.stringify({ nope: true }))).toBeNull()
  })
})

describe('parseWorkspaceEventsResponse', () => {
  it('parses the documented envelope shape', () => {
    const page = parseWorkspaceEventsResponse({
      ok: true,
      data: {
        events: [
          {
            seq: 3,
            type: 'message.created',
            channel_id: 'c1',
            created_at: '2026-07-01T00:00:00Z',
            payload: { type: 'message.created', channel: 'general', message: { id: 'm1', agent_name: 'a', text: 't' } }
          }
        ],
        latest_seq: 9
      }
    })
    expect(page).not.toBeNull()
    expect(page?.latestSeq).toBe(9)
    expect(page?.events).toHaveLength(1)
    expect(page?.events[0]).toMatchObject({ seq: 3, type: 'message.created', createdAt: '2026-07-01T00:00:00Z' })
  })

  it('rejects unexpected bodies', () => {
    expect(parseWorkspaceEventsResponse({ ok: false })).toBeNull()
    expect(parseWorkspaceEventsResponse({ ok: true, data: { events: 'nope' } })).toBeNull()
    expect(parseWorkspaceEventsResponse(undefined)).toBeNull()
  })
})

describe('filterAndSortObserverEvents', () => {
  it('drops events at or below the cursor, dedupes seqs, and sorts ascending', () => {
    const merged = filterAndSortObserverEvents(
      [channelEvent(7), channelEvent(5), channelEvent(6), channelEvent(6), channelEvent(4)],
      5
    )
    expect(merged.map((event) => event.seq)).toEqual([6, 7])
  })

  it('keeps seq-less events (renderer merge dedupes by message id)', () => {
    const merged = filterAndSortObserverEvents([channelEvent(undefined), channelEvent(6)], 5)
    expect(merged.map((event) => event.seq)).toEqual([6, undefined])
  })

  it('keeps everything when there is no cursor yet', () => {
    const merged = filterAndSortObserverEvents([channelEvent(2), channelEvent(1)], undefined)
    expect(merged.map((event) => event.seq)).toEqual([1, 2])
  })
})

describe('maxObserverSeq', () => {
  it('returns the highest seq, ignoring seq-less events', () => {
    expect(maxObserverSeq([channelEvent(3), channelEvent(undefined), channelEvent(9)])).toBe(9)
    expect(maxObserverSeq([channelEvent(undefined)])).toBeUndefined()
  })
})

describe('translateObserverEvents', () => {
  const now = (): number => 1_750_000_000_000

  it('translates message.created into the reconciled channel-message shape', () => {
    const update = translateObserverEvents(
      [
        {
          seq: 5,
          type: 'message.created',
          createdAt: '2026-07-01T12:00:00.000Z',
          payload: {
            type: 'message.created',
            channel: 'general',
            message: { id: 'm1', agent_id: 'a1', agent_name: 'worker-1', text: 'hi there' }
          }
        }
      ],
      'proj-1',
      now
    )
    expect(update?.messages).toEqual([
      {
        id: 'm1',
        kind: 'message',
        from: 'worker-1',
        to: '#general',
        body: 'hi there',
        timestamp: Date.parse('2026-07-01T12:00:00.000Z'),
        isHuman: false,
        projectId: 'proj-1'
      }
    ])
    expect(update?.directMessages).toEqual([])
    expect(update?.threadReplies).toEqual([])
  })

  it('flags human senders and falls back to now() without timestamps', () => {
    const update = translateObserverEvents(
      [
        {
          type: 'message.created',
          payload: {
            type: 'message.created',
            channel: '#general',
            message: { id: 'm2', agent_name: 'Human', text: 'from me' }
          }
        }
      ],
      'proj-1',
      now
    )
    expect(update?.messages[0]).toMatchObject({ isHuman: true, to: '#general', timestamp: now() })
  })

  it('translates dm/group_dm events with the conversation id preserved', () => {
    const update = translateObserverEvents(
      [
        {
          seq: 6,
          type: 'dm.received',
          payload: {
            type: 'dm.received',
            conversation_id: 'conv-1',
            message: { id: 'm3', agent_name: 'worker-2', text: 'psst' }
          }
        },
        {
          seq: 7,
          type: 'group_dm.received',
          payload: {
            type: 'group_dm.received',
            conversation_id: 'conv-2',
            message: { id: 'm4', agent_name: 'worker-3', text: 'group ping' }
          }
        }
      ],
      'proj-1',
      now
    )
    expect(update?.directMessages.map((entry) => entry.conversationId)).toEqual(['conv-1', 'conv-2'])
    expect(update?.directMessages[0].message).toMatchObject({
      id: 'm3',
      conversationId: 'conv-1',
      projectId: 'proj-1'
    })
  })

  it('translates thread.reply keyed by the parent message id', () => {
    const update = translateObserverEvents(
      [
        {
          seq: 8,
          type: 'thread.reply',
          payload: {
            type: 'thread.reply',
            channel: 'general',
            parent_id: 'm1',
            message: { id: 'r1', agent_name: 'worker-1', text: 'reply body' }
          }
        }
      ],
      'proj-1',
      now
    )
    expect(update?.threadReplies).toEqual([
      {
        parentId: 'm1',
        reply: {
          id: 'r1',
          from: 'worker-1',
          body: 'reply body',
          timestamp: now(),
          isHuman: false,
          projectId: 'proj-1'
        }
      }
    ])
  })

  it('ignores non-message events and returns null for empty batches', () => {
    expect(
      translateObserverEvents(
        [
          { seq: 9, type: 'message.reacted', payload: { type: 'message.reacted', message_id: 'm1', emoji: '👍' } },
          { seq: 10, type: 'agent.status.idle', payload: { type: 'agent.status.idle' } },
          { seq: 11, type: 'message.read', payload: { type: 'message.read', message_id: 'm1' } }
        ],
        'proj-1',
        now
      )
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Manager integration (fake socket + fake fetch + manual timers)
// ---------------------------------------------------------------------------

class FakeSocket implements ObserverSocketLike {
  closed = false
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.handlers.get(event) || []
    list.push(listener as (...args: unknown[]) => void)
    this.handlers.set(event, list)
    return this
  }

  close(): void {
    this.closed = true
  }

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) || []) {
      handler(...args)
    }
  }
}

interface ScheduledTimer {
  handler: () => void
  ms: number
  cleared: boolean
}

/** Fire a captured timer manually, marking it consumed for later assertions. */
function fireTimer(timer: ScheduledTimer | undefined): void {
  if (!timer) return
  timer.cleared = true
  timer.handler()
}

interface Harness {
  manager: ObserverStreamManager
  sockets: FakeSocket[]
  fetchCalls: Array<{ url: string; authorization?: string }>
  emitted: ObserverChatUpdate[]
  timers: ScheduledTimer[]
  mintCalls: Array<{ forceFresh: boolean }>
  savedCursors: Array<{ key: string; seq: number }>
  flush: () => Promise<void>
  openSocket: (index?: number) => Promise<void>
}

type FetchResponder = (url: string) => { status: number; body?: unknown }

function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body ?? null)
  } as unknown as Response
}

function createHarness(
  respond: FetchResponder,
  overrides: Partial<ObserverStreamManagerOptions> = {}
): Harness {
  const sockets: FakeSocket[] = []
  const fetchCalls: Harness['fetchCalls'] = []
  const emitted: ObserverChatUpdate[] = []
  const timers: ScheduledTimer[] = []
  const mintCalls: Harness['mintCalls'] = []
  const savedCursors: Harness['savedCursors'] = []

  const manager = new ObserverStreamManager({
    projectId: 'proj-1',
    relayBaseUrl: 'https://cast.example.test',
    mintToken: async (input) => {
      mintCalls.push(input)
      return 'ot_live_test'
    },
    getWorkspaceId: async () => 'ws-1',
    loadCursor: () => undefined,
    saveCursor: (key, seq) => savedCursors.push({ key, seq }),
    emit: (update) => emitted.push(update),
    fetchFn: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = (init?.headers || {}) as Record<string, string>
      fetchCalls.push({ url: String(url), authorization: headers.Authorization })
      const { status, body } = respond(String(url))
      return jsonResponse(status, body)
    }) as typeof fetch,
    createWebSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    setTimeoutFn: (handler, ms) => {
      const timer: ScheduledTimer = { handler, ms, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutFn: (handle) => {
      ;(handle as unknown as ScheduledTimer).cleared = true
    },
    ...overrides
  })

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  return {
    manager,
    sockets,
    fetchCalls,
    emitted,
    timers,
    mintCalls,
    savedCursors,
    flush,
    openSocket: async (index = sockets.length - 1) => {
      sockets[index].fire('open')
      await flush()
    }
  }
}

function backfillBody(events: Array<Record<string, unknown>>, latestSeq: number): unknown {
  return { ok: true, data: { events, latest_seq: latestSeq } }
}

function backfillEvent(seq: number, text = `event ${seq}`): Record<string, unknown> {
  return {
    seq,
    type: 'message.created',
    channel_id: 'c1',
    created_at: '2026-07-01T00:00:00Z',
    payload: {
      type: 'message.created',
      channel: 'general',
      message: { id: `m${seq}`, agent_name: 'worker-1', text }
    }
  }
}

describe('ObserverStreamManager', () => {
  it('initializes the cursor from latest_seq on first run without emitting history', async () => {
    const harness = createHarness(() => ({ status: 200, body: backfillBody([backfillEvent(1)], 41) }))
    harness.manager.start()
    await harness.flush()
    await harness.openSocket()

    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0].url).toContain('/v1/workspace/events?since=0&limit=1')
    expect(harness.fetchCalls[0].authorization).toBe('Bearer ot_live_test')
    expect(harness.emitted).toHaveLength(0)

    harness.manager.stop()
    expect(harness.savedCursors).toEqual([{ key: 'ws-1', seq: 41 }])
  })

  it('backfills from the persisted cursor with pagination and emits in seq order', async () => {
    const pages = new Map<string, unknown>([
      ['since=5&limit=2', backfillBody([backfillEvent(6), backfillEvent(7)], 8)],
      ['since=7&limit=2', backfillBody([backfillEvent(8)], 8)]
    ])
    const harness = createHarness(
      (url) => {
        const page = [...pages.entries()].find(([suffix]) => url.includes(suffix))?.[1]
        return page ? { status: 200, body: page } : { status: 500 }
      },
      { loadCursor: () => 5, backfillPageLimit: 2 }
    )
    harness.manager.start()
    await harness.flush()
    await harness.openSocket()

    expect(harness.fetchCalls.map((call) => call.url)).toEqual([
      'https://cast.example.test/v1/workspace/events?since=5&limit=2',
      'https://cast.example.test/v1/workspace/events?since=7&limit=2'
    ])
    const ids = harness.emitted.flatMap((update) => update.messages.map((message) => message.id))
    expect(ids).toEqual(['m6', 'm7', 'm8'])

    harness.manager.stop()
    expect(harness.savedCursors.at(-1)).toEqual({ key: 'ws-1', seq: 8 })
  })

  it('dedupes live frames buffered during backfill against the backfilled seqs', async () => {
    const harness = createHarness(
      () => ({ status: 200, body: backfillBody([backfillEvent(6)], 6) }),
      { loadCursor: () => 5 }
    )
    harness.manager.start()
    await harness.flush()

    const socket = harness.sockets[0]
    // Buffered while the backfill has not completed yet: a replay of seq 6
    // and a genuinely new seq 7.
    socket.fire('open')
    socket.fire(
      'message',
      JSON.stringify({
        type: 'message.created',
        seq: 6,
        channel: 'general',
        message: { id: 'm6', agent_name: 'worker-1', text: 'event 6' }
      })
    )
    socket.fire(
      'message',
      JSON.stringify({
        type: 'message.created',
        seq: 7,
        channel: 'general',
        message: { id: 'm7', agent_name: 'worker-1', text: 'event 7' }
      })
    )
    await harness.flush()

    const ids = harness.emitted.flatMap((update) => update.messages.map((message) => message.id))
    expect(ids).toEqual(['m6', 'm7'])

    // Live now: a duplicate replay of seq 7 is dropped, seq 8 advances.
    socket.fire(
      'message',
      JSON.stringify({
        type: 'message.created',
        seq: 7,
        channel: 'general',
        message: { id: 'm7', agent_name: 'worker-1', text: 'event 7' }
      })
    )
    socket.fire(
      'message',
      JSON.stringify({
        type: 'message.created',
        seq: 8,
        channel: 'general',
        message: { id: 'm8', agent_name: 'worker-1', text: 'event 8' }
      })
    )
    await harness.flush()

    const allIds = harness.emitted.flatMap((update) => update.messages.map((message) => message.id))
    expect(allIds).toEqual(['m6', 'm7', 'm8'])

    harness.manager.stop()
    expect(harness.savedCursors.at(-1)).toEqual({ key: 'ws-1', seq: 8 })
  })

  it('permanently disables on a 404 backfill (older engine) without scheduling reconnects', async () => {
    const harness = createHarness(() => ({ status: 404 }))
    harness.manager.start()
    await harness.flush()
    await harness.openSocket()

    expect(harness.manager.status).toBe('unsupported')
    expect(harness.emitted).toHaveLength(0)
    expect(harness.timers.filter((timer) => !timer.cleared)).toHaveLength(0)
    expect(harness.sockets[0].closed).toBe(true)
  })

  it('permanently disables when the observer-token endpoint is missing', async () => {
    const harness = createHarness(() => ({ status: 200, body: backfillBody([], 0) }), {
      mintToken: async () => {
        throw new ObserverStreamUnsupportedError('broker predates /api/observer-token')
      }
    })
    harness.manager.start()
    await harness.flush()

    expect(harness.manager.status).toBe('unsupported')
    expect(harness.sockets).toHaveLength(0)
    expect(harness.timers.filter((timer) => !timer.cleared)).toHaveLength(0)
  })

  it('mints a fresh token after an auth failure and reconnects with backoff', async () => {
    let failAuth = true
    const harness = createHarness(() =>
      failAuth ? { status: 401 } : { status: 200, body: backfillBody([backfillEvent(6)], 6) }
    , { loadCursor: () => 5 })
    harness.manager.start()
    await harness.flush()
    await harness.openSocket()

    expect(harness.mintCalls).toEqual([{ forceFresh: false }])
    const reconnect = harness.timers.find((timer) => !timer.cleared)
    expect(reconnect).toBeDefined()

    failAuth = false
    fireTimer(reconnect)
    await harness.flush()
    await harness.openSocket()

    expect(harness.mintCalls).toEqual([{ forceFresh: false }, { forceFresh: true }])
    const ids = harness.emitted.flatMap((update) => update.messages.map((message) => message.id))
    expect(ids).toEqual(['m6'])
  })

  it('treats a 401 WS rejection as an auth failure and re-mints on reconnect', async () => {
    const harness = createHarness(() => ({ status: 200, body: backfillBody([], 0) }), {
      loadCursor: () => 5
    })
    harness.manager.start()
    await harness.flush()

    harness.sockets[0].fire('unexpected-response', {}, { statusCode: 401 })
    await harness.flush()

    const reconnect = harness.timers.find((timer) => !timer.cleared)
    expect(reconnect).toBeDefined()
    fireTimer(reconnect)
    await harness.flush()

    expect(harness.mintCalls).toEqual([{ forceFresh: false }, { forceFresh: true }])
  })

  it('does not emit after stop()', async () => {
    const harness = createHarness(() => ({ status: 200, body: backfillBody([], 5) }), {
      loadCursor: () => 5
    })
    harness.manager.start()
    await harness.flush()
    await harness.openSocket()

    const socket = harness.sockets[0]
    harness.manager.stop()
    socket.fire(
      'message',
      JSON.stringify({
        type: 'message.created',
        seq: 9,
        channel: 'general',
        message: { id: 'm9', agent_name: 'worker-1', text: 'late' }
      })
    )
    await harness.flush()

    expect(harness.emitted).toHaveLength(0)
    expect(harness.manager.status).toBe('stopped')
  })

  it('uses exponential backoff between failed cycles', async () => {
    const harness = createHarness(() => ({ status: 500 }), { loadCursor: () => 5 })
    harness.manager.start()
    await harness.flush()
    await harness.openSocket()

    const first = harness.timers.filter((timer) => !timer.cleared)
    expect(first.map((timer) => timer.ms)).toEqual([1_000])

    fireTimer(first[0])
    await harness.flush()
    await harness.openSocket(1)

    const delays = harness.timers.filter((timer) => !timer.cleared).map((timer) => timer.ms)
    expect(delays).toEqual([2_000])
  })
})
