// STRESS TEST — pty-buffer-store
//
// Drives the per-key PTY chunk fan-out at the volumes the renderer sees when
// many agents stream output simultaneously. Uses fake timers + tight burst
// loops so 50k+ appends complete in well under a second of wall time.
//
// Invariants exercised:
//   1. Exactly-once delivery per chunk per always-on subscriber, even across
//      trim events and rapid subscribe/unsubscribe churn on sibling listeners.
//   2. Buffer trim cap (MAX_PTY_BUFFER_CHUNKS = 10_000) is never exceeded for
//      any key, regardless of burst rate.
//   3. Tail-only semantics: a listener that subscribes mid-stream sees ONLY
//      the chunks that arrive after its subscribe, even when intermediate
//      chunks have been trimmed out of the canonical buffer.
//   4. No leak in the internal `pending` / `pendingFrames` maps — once the
//      burst settles, advancing time produces no further listener fires for
//      any key (proxy for "queues fully drained").
//   5. `clearPtyBuffer` cancels any pending rAF flush — no stale data fires
//      after a clear, even under heavy in-flight load.
//   6. A listener that throws does not break delivery to its siblings — every
//      well-behaved listener still receives every chunk.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendPtyChunk,
  clearPtyBuffer,
  flushPtyChunksNow,
  getPtyChunks,
  subscribePtyBuffer
} from './pty-buffer-store'

const MAX_PTY_BUFFER_CHUNKS = 10_000

// Drives the rAF→setTimeout fallback path that the store uses in node.
function flushRaf(): void {
  vi.advanceTimersByTime(20)
}

function makeChunk(size: number, marker: string): string {
  // Marker at the start so we can identify a chunk's origin in tail-only
  // assertions without storing the entire body.
  const filler = 'x'.repeat(Math.max(0, size - marker.length))
  return `${marker}${filler}`
}

describe('pty-buffer-store stress', () => {
  // Each test uses its own key set so a missed teardown can't leak state
  // between tests. We still clear at the end to keep the module-level maps
  // empty for the next file in the run.
  const testKeys: string[] = []
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    vi.useFakeTimers()
    testKeys.length = 0
  })

  afterEach(() => {
    for (const key of testKeys) clearPtyBuffer(key)
    vi.useRealTimers()
  })

  it('delivers exactly-once to always-on subscribers across 10 agents × 5000 chunks', () => {
    const agentCount = 10
    const chunksPerAgent = 5_000
    const subscribersPerAgent = 5
    const keys = Array.from({ length: agentCount }, (_, i) => `stress-deliver-${i}`)
    testKeys.push(...keys)

    // Per-listener received counters. Index: keyIndex * subscribersPerAgent + listenerIndex.
    const counters = new Array(agentCount * subscribersPerAgent).fill(0)
    for (let k = 0; k < agentCount; k++) {
      for (let s = 0; s < subscribersPerAgent; s++) {
        const counterIdx = k * subscribersPerAgent + s
        subscribePtyBuffer(keys[k]!, (newChunks) => {
          counters[counterIdx] += newChunks.length
        })
      }
    }

    // Vary chunk size from 1B to 4KB across the deck.
    const chunkSizes = [1, 16, 256, 1024, 4096]

    // Tight burst loop. Flush every 50 iterations to mimic the ~one-frame
    // cadence the renderer actually sees, instead of flushing once at the end
    // (which would mask coalescing bugs).
    for (let i = 0; i < chunksPerAgent; i++) {
      for (let k = 0; k < agentCount; k++) {
        const size = chunkSizes[(i + k) % chunkSizes.length]!
        appendPtyChunk(keys[k]!, makeChunk(size, `c${i}`))
      }
      if (i > 0 && i % 50 === 0) flushRaf()
    }
    flushRaf()

    // Exactly-once delivery: every always-on listener saw every chunk.
    for (let k = 0; k < agentCount; k++) {
      for (let s = 0; s < subscribersPerAgent; s++) {
        const counterIdx = k * subscribersPerAgent + s
        expect(counters[counterIdx]).toBe(chunksPerAgent)
      }
    }

    // Trim cap holds for every key.
    for (const key of keys) {
      expect(getPtyChunks(key).length).toBeLessThanOrEqual(MAX_PTY_BUFFER_CHUNKS)
    }

    // After the burst settles, no further listener fires regardless of how
    // far we advance time — pending / pendingFrames are drained. We snapshot
    // the counts and assert they don't change.
    const snapshot = counters.slice()
    vi.advanceTimersByTime(5_000)
    expect(counters).toEqual(snapshot)
  })

  it('survives rapid subscribe/unsubscribe churn without losing chunks for always-on listeners', () => {
    const key = 'stress-churn'
    testKeys.push(key)

    let alwaysOnCount = 0
    subscribePtyBuffer(key, (newChunks) => {
      alwaysOnCount += newChunks.length
    })

    // Churn loop: 1000 chunks, with a fresh subscriber added + removed every
    // 10 iterations. The always-on listener must still see exactly 1000.
    const chunkCount = 1_000
    for (let i = 0; i < chunkCount; i++) {
      const churnUnsub = subscribePtyBuffer(key, () => { /* noop */ })
      appendPtyChunk(key, `chunk-${i}`)
      churnUnsub()
      if (i % 10 === 0) flushRaf()
    }
    flushRaf()

    expect(alwaysOnCount).toBe(chunkCount)
  })

  it('respects MAX_PTY_BUFFER_CHUNKS even under sustained burst above the cap', () => {
    const key = 'stress-trim-cap'
    testKeys.push(key)
    const totalChunks = MAX_PTY_BUFFER_CHUNKS * 3

    let listenerCount = 0
    subscribePtyBuffer(key, (newChunks) => {
      listenerCount += newChunks.length
    })

    // Push 3x the cap; flush periodically so trim runs across many flushes,
    // not just at the very end.
    for (let i = 0; i < totalChunks; i++) {
      appendPtyChunk(key, `t${i}`)
      if (i % 200 === 0) flushRaf()
    }
    flushRaf()

    // Canonical buffer never exceeds the cap.
    expect(getPtyChunks(key).length).toBe(MAX_PTY_BUFFER_CHUNKS)

    // The listener received every chunk (exactly-once-per-flush semantics).
    // Tail-only delivery means the listener gets ALL appended chunks even
    // when trim drops older entries from the canonical buffer.
    expect(listenerCount).toBe(totalChunks)
  })

  it('tail-only: a mid-stream subscriber receives only chunks after its subscribe, even across trim', () => {
    const key = 'stress-tail-trim'
    testKeys.push(key)
    const preSubscribeCount = 9_000
    const postSubscribeCount = 5_000

    // Phase 1 — fill the buffer close to the cap with "pre" chunks.
    for (let i = 0; i < preSubscribeCount; i++) {
      appendPtyChunk(key, `pre-${i}`)
      if (i % 1000 === 0) flushRaf()
    }
    flushRaf()
    expect(getPtyChunks(key).length).toBe(preSubscribeCount)

    // Phase 2 — subscribe a mid-stream listener; collect every chunk it sees.
    const seen: string[] = []
    subscribePtyBuffer(key, (newChunks) => {
      seen.push(...newChunks)
    })

    // Phase 3 — push enough chunks to force trim (pre + post > cap).
    for (let i = 0; i < postSubscribeCount; i++) {
      appendPtyChunk(key, `post-${i}`)
      if (i % 500 === 0) flushRaf()
    }
    flushRaf()

    // The buffer was trimmed to the cap.
    expect(getPtyChunks(key).length).toBe(MAX_PTY_BUFFER_CHUNKS)

    // Mid-stream listener saw exactly the post-subscribe chunks, in order,
    // and zero pre-subscribe chunks — even though the canonical buffer was
    // trimmed during the burst.
    expect(seen.length).toBe(postSubscribeCount)
    expect(seen[0]).toBe('post-0')
    expect(seen[seen.length - 1]).toBe(`post-${postSubscribeCount - 1}`)
    for (const chunk of seen) {
      expect(chunk.startsWith('post-')).toBe(true)
    }
  })

  it('clearPtyBuffer cancels in-flight flushes under load — no stale data fires after clear', () => {
    const key = 'stress-clear-cancel'
    testKeys.push(key)

    const tails: string[][] = []
    subscribePtyBuffer(key, (newChunks) => {
      tails.push(newChunks)
    })

    // Stage chunks then clear before the rAF fires.
    for (let i = 0; i < 500; i++) {
      appendPtyChunk(key, `staged-${i}`)
    }
    expect(tails.length).toBe(0) // not yet flushed

    clearPtyBuffer(key)
    // The clear callback fires synchronously with an empty tail.
    expect(tails.length).toBe(1)
    expect(tails[0]).toEqual([])

    // Advance time — the cancelled rAF must not fire stale data.
    vi.advanceTimersByTime(1_000)
    expect(tails.length).toBe(1)
    expect(getPtyChunks(key)).toEqual([])

    // And the listener still works after clear — new appends flow through.
    for (let i = 0; i < 10; i++) {
      appendPtyChunk(key, `fresh-${i}`)
    }
    flushRaf()
    expect(tails.length).toBe(2)
    expect(tails[1]).toHaveLength(10)
    expect(tails[1]![0]).toBe('fresh-0')
  })

  it('an always-throwing listener does not block delivery to well-behaved siblings under load', () => {
    const key = 'stress-throw-isolation'
    testKeys.push(key)

    const bad = vi.fn(() => { throw new Error('boom') })
    let goodCount = 0
    subscribePtyBuffer(key, bad)
    subscribePtyBuffer(key, (newChunks) => {
      goodCount += newChunks.length
    })

    const chunkCount = 2_000
    for (let i = 0; i < chunkCount; i++) {
      appendPtyChunk(key, `chunk-${i}`)
      if (i % 100 === 0) flushRaf()
    }
    flushRaf()

    expect(goodCount).toBe(chunkCount)
    // The bad listener was called every flush (its throws were caught and
    // logged via console.error, which we've stubbed).
    expect(bad.mock.calls.length).toBeGreaterThan(0)
    expect(errSpy).toHaveBeenCalled()
  })

  it('flushPtyChunksNow drains pending immediately and prevents a duplicate rAF fire', () => {
    const key = 'stress-flush-now'
    testKeys.push(key)
    const tails: string[][] = []
    subscribePtyBuffer(key, (newChunks) => {
      tails.push(newChunks)
    })

    // 100 staged chunks across the burst, draining synchronously each batch.
    for (let burst = 0; burst < 10; burst++) {
      for (let i = 0; i < 10; i++) {
        appendPtyChunk(key, `b${burst}-i${i}`)
      }
      flushPtyChunksNow(key)
      // Advancing time MUST NOT fire a second flush for the same chunks.
      vi.advanceTimersByTime(50)
    }

    expect(tails.length).toBe(10)
    for (const tail of tails) {
      expect(tail.length).toBe(10)
    }
    expect(getPtyChunks(key).length).toBe(100)
  })
})
