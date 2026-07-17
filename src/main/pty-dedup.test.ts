import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerEvent } from '@agent-relay/harness-driver'
import { PtyChunkDeduper } from './pty-dedup'

// The deduper reads chunk/offset off the event and takes the broker
// event-stream `generation` from the caller; the suite hands it loosely-shaped
// worker_stream records cast to BrokerEvent, mirroring how broker.ts forwards
// raw SDK events. Identity = `${generation}:${offset}`.
function chunkEvent(fields: Record<string, unknown>): BrokerEvent {
  return { kind: 'worker_stream', stream: 'stdout', ...fields } as unknown as BrokerEvent
}

// Hardened invariants (AGENTS.md "Duplicate Event Hardening"): drop ONLY on a
// full identity (generation + offset) AND content-hash match within the replay
// window. Never on content alone (identical consecutive chunks are normal
// terminal traffic), never when correlation metadata (offset) is absent. The
// broker.test.ts PTY suite covers the same invariants end-to-end through the
// IPC path; this suite pins the deduper unit.
describe('PtyChunkDeduper', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    infoSpy.mockRestore()
    warnSpy.mockRestore()
  })

  describe('suppress path', () => {
    it('suppresses a replay with the same generation+offset and the same bytes', () => {
      const deduper = new PtyChunkDeduper()
      const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', offset: 42 })
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(true)
    })

    it('drops a delayed replay of an earlier offset with identical bytes', () => {
      const deduper = new PtyChunkDeduper()
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'a\n', offset: 10 }), 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'b\n', offset: 11 }), 1)).toBe(false)
      // A double-emit replays the tail with the same offsets and bytes.
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'a\n', offset: 10 }), 1)).toBe(true)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'b\n', offset: 11 }), 1)).toBe(true)
    })
  })

  describe('deliver path', () => {
    it('keeps chunks that share content but carry distinct offsets', () => {
      const deduper = new PtyChunkDeduper()
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'tick\n', offset: 1 }), 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'tick\n', offset: 2 }), 1)).toBe(false)
    })

    it('delivers a chunk whose offset repeats with different bytes (never drop on identity alone)', () => {
      const deduper = new PtyChunkDeduper()
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'before\n', offset: 90 }), 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'after\n', offset: 90 }), 1)).toBe(false)
    })

    it('does not suppress across a generation bump even at the same offset with the same bytes', () => {
      // offset is cumulative WITHIN a (generation, worker); scoping identity by
      // generation prevents a fresh stream's low offset from colliding with a
      // stale remembered one. When in doubt: DELIVER.
      const deduper = new PtyChunkDeduper()
      const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', offset: 42 })
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 2)).toBe(false)
    })

    it('tracks replay windows per session and agent stream', () => {
      const deduper = new PtyChunkDeduper()
      const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', offset: 100 })
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-2', chunkEvent({ name: 'claude-2', chunk: 'pong\n', offset: 100 }), 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('other', 'claude-1', event, 1)).toBe(false)
    })

    it('forgetStream resets the replay window so a respawned agent replays cleanly', () => {
      const deduper = new PtyChunkDeduper()
      const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', offset: 5 })
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(false)
      deduper.forgetStream('proj', 'claude-1')
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(false)
    })
  })

  describe('loud (no-offset) path', () => {
    it('always delivers offset-less chunks, even byte-identical ones', () => {
      // Without an offset a transport replay is indistinguishable from real
      // repeated output (same keystroke echoed twice, byte-identical repaint
      // frames). Dropping real bytes mangles escape sequences — never dedupe
      // on content alone.
      const deduper = new PtyChunkDeduper()
      const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n' })
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(false)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(false)
    })

    it('loudly warns the first time a stream delivers an offset-less chunk, with a running count', () => {
      const deduper = new PtyChunkDeduper()
      deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'one\n' }), 1)
      const warns = warnSpy.mock.calls.filter(([first]: unknown[]) =>
        typeof first === 'string' && first.includes('no offset')
      )
      expect(warns).toHaveLength(1)
      expect(warns[0][0]).toContain('claude-1')
      expect(warns[0][0]).toContain('1 delivered')
    })

    it('rate-limits the loud warning per stream but keeps counting', () => {
      // Deterministic clock: all chunks land inside one interval, so only the
      // first warns, but every one increments the running counter.
      let clock = 1_000_000
      const deduper = new PtyChunkDeduper({ now: () => clock })
      for (let i = 0; i < 5; i += 1) {
        deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: `x${i}\n` }), 1)
        clock += 1_000 // < 60s interval
      }
      const warns = warnSpy.mock.calls.filter(([first]: unknown[]) =>
        typeof first === 'string' && first.includes('no offset')
      )
      expect(warns).toHaveLength(1)

      // Cross the interval → warn again, now reporting the full running count.
      clock += 60_000
      deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'late\n' }), 1)
      const warnsAfter = warnSpy.mock.calls.filter(([first]: unknown[]) =>
        typeof first === 'string' && first.includes('no offset')
      )
      expect(warnsAfter).toHaveLength(2)
      expect(warnsAfter[1][0]).toContain('6 delivered')
    })

    it('warns independently per stream', () => {
      const deduper = new PtyChunkDeduper()
      deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'one\n' }), 1)
      deduper.isDuplicatePtyChunk('proj', 'codex-1', chunkEvent({ name: 'codex-1', chunk: 'two\n' }), 1)
      const warns = warnSpy.mock.calls.filter(([first]: unknown[]) =>
        typeof first === 'string' && first.includes('no offset')
      )
      expect(warns).toHaveLength(2)
      expect(warns[0][0]).toContain('claude-1')
      expect(warns[1][0]).toContain('codex-1')
    })
  })

  describe('debug replay telemetry', () => {
    it('logs a suppressed replay only when debug is enabled, with a running total', () => {
      const deduper = new PtyChunkDeduper({ debugEnabled: () => true })
      const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', offset: 7 })
      deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)
      deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)
      const drops = infoSpy.mock.calls.filter(([first]: unknown[]) =>
        typeof first === 'string' && first.includes('suppressed replayed PTY chunk')
      )
      expect(drops).toHaveLength(1)
      expect(drops[0][1]).toMatchObject({ name: 'claude-1', suppressedTotal: 1 })
    })

    it('stays silent about suppressed replays when debug is disabled', () => {
      const deduper = new PtyChunkDeduper()
      const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', offset: 7 })
      deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)
      expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event, 1)).toBe(true)
      const drops = infoSpy.mock.calls.filter(([first]: unknown[]) =>
        typeof first === 'string' && first.includes('suppressed replayed PTY chunk')
      )
      expect(drops).toHaveLength(0)
    })
  })
})
