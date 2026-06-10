import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendPtyChunk,
  clearPtyBuffer,
  flushPtyChunksNow,
  getPtyChunks,
  getPtyChunkTotal,
  getPtyChunksSinceTotal,
  subscribePtyBuffer
} from './pty-buffer-store'

// rAF in the store falls back to setTimeout(_, 16) when requestAnimationFrame
// isn't on globalThis. The tests run a fake-timer schedule so we can drive
// the flush deterministically without a real animation frame.
function flushRaf(): void {
  vi.advanceTimersByTime(20)
}

describe('pty-buffer-store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Reset any state from earlier tests by clearing every key we use.
    for (const key of ['k1', 'k2', 'k3', 'k-no-subscriber', 'k-throw']) clearPtyBuffer(key)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces multiple appendPtyChunk calls into a single per-frame flush', () => {
    const listener = vi.fn()
    subscribePtyBuffer('k1', listener)

    appendPtyChunk('k1', 'A')
    appendPtyChunk('k1', 'B')
    appendPtyChunk('k1', 'C')
    expect(listener).not.toHaveBeenCalled()

    flushRaf()
    expect(listener).toHaveBeenCalledTimes(1)
    // Tail-only semantics: the listener receives just the new chunks.
    expect(listener).toHaveBeenCalledWith(['A', 'B', 'C'])
  })

  it('notifies listeners with only the new tail, not the full buffer history', () => {
    const listener = vi.fn()
    subscribePtyBuffer('k2', listener)

    appendPtyChunk('k2', 'A')
    flushRaf()
    listener.mockClear()

    appendPtyChunk('k2', 'B')
    appendPtyChunk('k2', 'C')
    flushRaf()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(['B', 'C'])

    // The canonical buffer still contains the full history.
    expect(getPtyChunks('k2')).toEqual(['A', 'B', 'C'])
  })

  it('clearPtyBuffer cancels a pending flush and notifies subscribers with an empty tail', () => {
    const listener = vi.fn()
    subscribePtyBuffer('k3', listener)

    appendPtyChunk('k3', 'will-not-flush')
    expect(listener).not.toHaveBeenCalled()

    clearPtyBuffer('k3')
    // The flush is cancelled — only the clear notification fired.
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith([])

    flushRaf()
    // Advancing the timer does NOT fire a stale flush — the rAF was cancelled.
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getPtyChunks('k3')).toEqual([])
  })

  it('flushPtyChunksNow drains pending chunks synchronously', () => {
    const listener = vi.fn()
    subscribePtyBuffer('k1', listener)

    appendPtyChunk('k1', 'sync-drain')
    expect(listener).not.toHaveBeenCalled()

    flushPtyChunksNow('k1')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(['sync-drain'])
    expect(getPtyChunks('k1')).toEqual(['sync-drain'])

    flushRaf()
    // The scheduled rAF was cancelled by flushPtyChunksNow — no duplicate
    // flush fires (the snapshot-vs-replay duplicate-text class).
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('flushes immediately without subscribers and preserves chunks for future subscribers', () => {
    appendPtyChunk('k-no-subscriber', 'before-subscribe')

    expect(getPtyChunks('k-no-subscriber')).toEqual(['before-subscribe'])
    expect(vi.getTimerCount()).toBe(0)

    const listener = vi.fn()
    subscribePtyBuffer('k-no-subscriber', listener)
    expect(listener).not.toHaveBeenCalled()

    appendPtyChunk('k-no-subscriber', 'after-subscribe')
    expect(listener).not.toHaveBeenCalled()

    flushRaf()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(['after-subscribe'])
    expect(getPtyChunks('k-no-subscriber')).toEqual(['before-subscribe', 'after-subscribe'])
  })

  it('a listener that throws does not abort delivery to siblings or escape the rAF', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()
    subscribePtyBuffer('k-throw', bad)
    subscribePtyBuffer('k-throw', good)

    appendPtyChunk('k-throw', 'x')
    expect(() => flushRaf()).not.toThrow()

    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledWith(['x'])
    errSpy.mockRestore()
  })

  it('subscribePtyBuffer returns an unsubscribe that stops further deliveries', () => {
    const listener = vi.fn()
    const unsub = subscribePtyBuffer('k1', listener)

    appendPtyChunk('k1', 'first')
    flushRaf()
    expect(listener).toHaveBeenCalledTimes(1)

    unsub()
    appendPtyChunk('k1', 'second')
    flushRaf()
    expect(listener).toHaveBeenCalledTimes(1)
    // But the canonical buffer still accumulates regardless of subscribers.
    expect(getPtyChunks('k1')).toEqual(['first', 'second'])
  })

  it('duplicate appendPtyChunk replay arrives once at the listener per chunk', () => {
    // AGENTS.md: "Add regression tests when touching PTY buffering. Include
    // duplicate/replay cases." Renderer-side guarantee is: every appendPtyChunk
    // call adds exactly one chunk to the buffer; if the broker sends the same
    // chunk twice the listener sees two distinct entries — dedup is the
    // broker/main's responsibility, NOT the renderer buffer's.
    const listener = vi.fn()
    subscribePtyBuffer('k1', listener)

    appendPtyChunk('k1', 'dup')
    appendPtyChunk('k1', 'dup')
    flushRaf()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(['dup', 'dup'])
    expect(getPtyChunks('k1')).toEqual(['dup', 'dup'])
  })
})

// Invariants for the monotonic replay-baseline API (getPtyChunkTotal /
// getPtyChunksSinceTotal). The terminal runtime paints an attach snapshot,
// captures a baseline, then replays only chunks that arrived after it. The
// baseline must stay valid across the 10k buffer trim: a length-based
// baseline goes stale when the buffer slides, and the old recovery path
// (reset to 0, replay the whole buffer) painted duplicate screen content on
// top of the snapshot. Totals are monotonic per key for the renderer's
// lifetime — including across clearPtyBuffer — so these tests use unique
// keys instead of clearing shared ones.
describe('pty-buffer-store replay baselines', () => {
  const MAX_PTY_BUFFER_CHUNKS = 10_000
  let keySerial = 0
  const testKeys: string[] = []

  function trackedKey(label: string): string {
    keySerial += 1
    const key = `baseline:${label}:${keySerial}`
    testKeys.push(key)
    return key
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const key of testKeys.splice(0)) clearPtyBuffer(key)
    vi.useRealTimers()
  })

  it('counts flushed chunks monotonically with and without subscribers', () => {
    const key = trackedKey('totals')
    expect(getPtyChunkTotal(key)).toBe(0)

    // No subscriber: inline flush.
    appendPtyChunk(key, 'a')
    appendPtyChunk(key, 'b')
    expect(getPtyChunkTotal(key)).toBe(2)

    // With subscriber: rAF-batched flush counts at flush time.
    const unsub = subscribePtyBuffer(key, () => {})
    appendPtyChunk(key, 'c')
    expect(getPtyChunkTotal(key)).toBe(2)
    flushRaf()
    expect(getPtyChunkTotal(key)).toBe(3)
    unsub()
  })

  it('returns only post-baseline chunks', () => {
    const key = trackedKey('since')
    appendPtyChunk(key, 'before-1')
    appendPtyChunk(key, 'before-2')
    const baseline = getPtyChunkTotal(key)

    appendPtyChunk(key, 'after-1')
    appendPtyChunk(key, 'after-2')

    expect(getPtyChunksSinceTotal(key, baseline)).toEqual(['after-1', 'after-2'])
    expect(getPtyChunksSinceTotal(key, getPtyChunkTotal(key))).toEqual([])
  })

  it('never replays pre-baseline chunks after the buffer trims', () => {
    const key = trackedKey('trim')
    appendPtyChunk(key, 'snapshot-covered')
    const baseline = getPtyChunkTotal(key)

    // Overflow the buffer so the pre-baseline chunk is trimmed away.
    const appended = MAX_PTY_BUFFER_CHUNKS + 50
    for (let i = 0; i < appended; i += 1) {
      appendPtyChunk(key, `post-${i}`)
    }

    const replay = getPtyChunksSinceTotal(key, baseline)
    // Everything retained is post-baseline; the trimmed-away middle is
    // unrecoverable, but nothing from before the baseline is re-returned.
    expect(replay.length).toBe(MAX_PTY_BUFFER_CHUNKS)
    expect(replay[0]).toBe(`post-${appended - MAX_PTY_BUFFER_CHUNKS}`)
    expect(replay.at(-1)).toBe(`post-${appended - 1}`)
    expect(replay).not.toContain('snapshot-covered')
  })

  it('keeps totals monotonic across clearPtyBuffer', () => {
    const key = trackedKey('clear')
    appendPtyChunk(key, 'one')
    const baseline = getPtyChunkTotal(key)

    clearPtyBuffer(key)
    expect(getPtyChunks(key)).toEqual([])
    // A baseline captured before the clear stays valid: nothing new yet.
    expect(getPtyChunksSinceTotal(key, baseline)).toEqual([])

    appendPtyChunk(key, 'two')
    expect(getPtyChunkTotal(key)).toBe(baseline + 1)
    expect(getPtyChunksSinceTotal(key, baseline)).toEqual(['two'])
  })

  it('flushPtyChunksNow drains staged chunks into the total before a baseline capture', () => {
    const key = trackedKey('drain')
    const unsub = subscribePtyBuffer(key, () => {})
    appendPtyChunk(key, 'staged')
    // Without the synchronous drain the staged chunk would be invisible to
    // the baseline and replayed on top of the snapshot.
    flushPtyChunksNow(key)
    const baseline = getPtyChunkTotal(key)
    expect(baseline).toBe(1)
    expect(getPtyChunksSinceTotal(key, baseline)).toEqual([])
    unsub()
  })
})
