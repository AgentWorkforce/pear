import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendPtyChunk,
  clearPtyBuffer,
  flushPtyChunksNow,
  getPtyChunks,
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
    for (const key of ['k1', 'k2', 'k3', 'k-throw']) clearPtyBuffer(key)
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
