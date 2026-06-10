import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyInputStream } from '@agent-relay/harness-driver'
import { PtyInputStreamManager, type InputStreamClient } from './pty-input-stream'

// A controllable stand-in for the SDK's PtyInputStream: the open handshake is a
// deferred promise the test resolves (broker acked pty_input_ready) or rejects
// (open failed) on demand, so we can exercise the WS fast-path / HTTP-fallback
// state machine without a real WebSocket.
interface FakeStream {
  closed: boolean
  srttMs: number | null
  waitUntilOpen: () => Promise<void>
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  resolveOpen: () => void
  rejectOpen: () => void
}

function makeStream(): FakeStream {
  let resolveOpen!: () => void
  let rejectOpen!: () => void
  const open = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = () => reject(new Error('open failed'))
  })
  // The manager only consumes the rejection via its own `.then(onFail)`, so
  // guard against an unhandled-rejection warning when a test ignores it.
  open.catch(() => {})
  const stream: FakeStream = {
    closed: false,
    srttMs: null,
    waitUntilOpen: () => open,
    send: vi.fn(async () => ({ name: 'agent', bytes_written: 1 })),
    close: vi.fn(() => {
      stream.closed = true
    }),
    resolveOpen,
    rejectOpen
  }
  return stream
}

type MockClient = InputStreamClient & { openInputStream: ReturnType<typeof vi.fn> }

function makeClient(streams: FakeStream[]): MockClient {
  let index = 0
  return {
    openInputStream: vi.fn(() => streams[index++] as unknown as PtyInputStream)
  } as MockClient
}

// Flush the microtask/macrotask queue so the manager's background
// `waitUntilOpen().then(...)` handlers run before assertions.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('PtyInputStreamManager', () => {
  let now: number

  beforeEach(() => {
    now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keys streams by session and agent name', () => {
    const manager = new PtyInputStreamManager()
    expect(manager.getInputStreamKey('proj', 'claude-1')).toBe('proj:claude-1')
  })

  it('opens a stream once on first keystroke and reuses it until the broker acks', async () => {
    const stream = makeStream()
    const client = makeClient([stream])
    const manager = new PtyInputStreamManager()
    const key = manager.getInputStreamKey('proj', 'claude-1')

    const first = manager.ensureInputStream(client, key, 'claude-1')
    expect(first.stream).toBe(stream as unknown as PtyInputStream)
    expect(first.ready).toBe(false)
    expect(client.openInputStream).toHaveBeenCalledTimes(1)
    expect(manager.getStream(key)).toBe(stream as unknown as PtyInputStream)

    // Before the handshake completes the same (not-ready) stream is reused —
    // no second open per keystroke.
    const second = manager.ensureInputStream(client, key, 'claude-1')
    expect(second.stream).toBe(stream as unknown as PtyInputStream)
    expect(second.ready).toBe(false)
    expect(client.openInputStream).toHaveBeenCalledTimes(1)

    stream.resolveOpen()
    await flush()

    const third = manager.ensureInputStream(client, key, 'claude-1')
    expect(third.ready).toBe(true)
    expect(client.openInputStream).toHaveBeenCalledTimes(1)
  })

  it('counts consecutive open failures and trips the HTTP fallback once at the threshold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streams = [makeStream(), makeStream(), makeStream()]
    const client = makeClient(streams)
    const manager = new PtyInputStreamManager()
    const key = manager.getInputStreamKey('proj', 'claude-1')

    // First two failures stay on the WS fast path (under the threshold).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      manager.ensureInputStream(client, key, 'claude-1')
      streams[attempt].rejectOpen()
      await flush()
      expect(manager.hasFallback(key)).toBe(false)
    }
    expect(warn).not.toHaveBeenCalled()

    // Third failure crosses MAX_INPUT_STREAM_OPEN_FAILURES (3): fallback engages
    // and the one-time warning fires.
    manager.ensureInputStream(client, key, 'claude-1')
    streams[2].rejectOpen()
    await flush()

    expect(manager.hasFallback(key)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(client.openInputStream).toHaveBeenCalledTimes(3)
  })

  it('clears the fallback only after the retry cooldown elapses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streams = [makeStream(), makeStream(), makeStream()]
    const client = makeClient(streams)
    const manager = new PtyInputStreamManager()
    const key = manager.getInputStreamKey('proj', 'claude-1')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      manager.ensureInputStream(client, key, 'claude-1')
      streams[attempt].rejectOpen()
      await flush()
    }
    expect(manager.hasFallback(key)).toBe(true)

    // Still within the 15s cooldown — refresh is a no-op.
    now += 14_999
    manager.refreshExpiredInputStreamFallback(key)
    expect(manager.hasFallback(key)).toBe(true)

    // Past the cooldown — the WS fast path is given another chance.
    now += 2
    manager.refreshExpiredInputStreamFallback(key)
    expect(manager.hasFallback(key)).toBe(false)
  })

  it('resets the fallback on re-attach so the WS fast path is retried', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streams = [makeStream(), makeStream(), makeStream()]
    const client = makeClient(streams)
    const manager = new PtyInputStreamManager()
    const key = manager.getInputStreamKey('proj', 'claude-1')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      manager.ensureInputStream(client, key, 'claude-1')
      streams[attempt].rejectOpen()
      await flush()
    }
    expect(manager.hasFallback(key)).toBe(true)

    manager.resetInputStreamFallback(key)
    expect(manager.hasFallback(key)).toBe(false)
  })

  it('closes and forgets a stream, with the requested close code/reason', () => {
    const stream = makeStream()
    const client = makeClient([stream])
    const manager = new PtyInputStreamManager()
    const key = manager.getInputStreamKey('proj', 'claude-1')

    manager.ensureInputStream(client, key, 'claude-1')
    manager.closeInputStream(key, 1011, 'stream send failed')

    expect(stream.close).toHaveBeenCalledWith(1011, 'stream send failed')
    expect(manager.getStream(key)).toBeUndefined()
  })

  it('closes only the streams belonging to a session on session teardown', () => {
    const mine = makeStream()
    const other = makeStream()
    const client = makeClient([mine, other])
    const manager = new PtyInputStreamManager()
    const myKey = manager.getInputStreamKey('proj', 'claude-1')
    const otherKey = manager.getInputStreamKey('other', 'claude-1')

    manager.ensureInputStream(client, myKey, 'claude-1')
    manager.ensureInputStream(client, otherKey, 'claude-1')

    manager.closeInputStreamsForSession('proj')

    expect(mine.close).toHaveBeenCalledWith(1000, 'project closed')
    expect(manager.getStream(myKey)).toBeUndefined()
    expect(other.close).not.toHaveBeenCalled()
    expect(manager.getStream(otherKey)).toBe(other as unknown as PtyInputStream)
  })
})
