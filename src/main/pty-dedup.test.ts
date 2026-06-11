import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerEvent } from '@agent-relay/harness-driver'
import { PtyChunkDeduper } from './pty-dedup'

// The deduper reads chunk/identity fields dynamically off the event; the suite
// hands it loosely-shaped worker_stream records cast to BrokerEvent, mirroring
// how broker.ts forwards raw SDK events.
function chunkEvent(fields: Record<string, unknown>): BrokerEvent {
  return { kind: 'worker_stream', stream: 'stdout', ...fields } as unknown as BrokerEvent
}

// Hardened invariants (AGENTS.md "Duplicate Event Hardening"): drop ONLY on
// identity (seq/event_id) AND content-hash match within the replay window.
// Never on content alone (identical consecutive chunks are normal terminal
// traffic), never on identity alone (a daemon restart resets seq). The
// broker.test.ts PTY suite covers the same invariants end-to-end through the
// IPC path; this suite pins the deduper unit.
describe('PtyChunkDeduper', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    infoSpy.mockRestore()
  })

  it('suppresses a replay with the same identity and the same bytes', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', event_id: 'e1' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(true)
  })

  it('keeps chunks that share content but carry distinct broker sequences', () => {
    const deduper = new PtyChunkDeduper()
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'tick\n', seq: 1 }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'tick\n', seq: 2 }))).toBe(false)
  })

  it('always delivers identity-less chunks, even byte-identical ones', () => {
    // Without identity a transport replay is indistinguishable from real
    // repeated output (same keystroke echoed twice, byte-identical repaint
    // frames). Dropping real bytes mangles escape sequences — never dedupe
    // on content alone.
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
  })

  it('logs the identity-less blind spot once per stream', () => {
    const deduper = new PtyChunkDeduper()
    deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'one\n' }))
    deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'two\n' }))
    deduper.isDuplicatePtyChunk('proj', 'codex-1', chunkEvent({ name: 'codex-1', chunk: 'three\n' }))

    const blindSpotLogs = infoSpy.mock.calls.filter(([first]: unknown[]) =>
      typeof first === 'string' && first.includes('no seq/event_id')
    )
    expect(blindSpotLogs).toHaveLength(2)
    expect(blindSpotLogs[0][0]).toContain('claude-1')
    expect(blindSpotLogs[1][0]).toContain('codex-1')
  })

  it('delivers a chunk whose seq repeats with different bytes (daemon seq reset)', () => {
    const deduper = new PtyChunkDeduper()
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'before restart\n', seq: 90 }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'after restart\n', seq: 90 }))).toBe(false)
  })

  it('delivers low-seq chunks after a watermark reset instead of dropping a window', () => {
    const deduper = new PtyChunkDeduper()
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'old-high\n', seq: 5_000 }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'fresh-1\n', seq: 1 }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'fresh-2\n', seq: 2 }))).toBe(false)
  })

  it('drops a delayed replay of an older seq with identical bytes', () => {
    const deduper = new PtyChunkDeduper()
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'a\n', seq: 10 }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'b\n', seq: 11 }))).toBe(false)
    // Rebind replays the tail of the stream.
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'a\n', seq: 10 }))).toBe(true)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'b\n', seq: 11 }))).toBe(true)
  })

  it('tracks replay windows per session and agent stream', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', seq: 100 })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-2', chunkEvent({ name: 'claude-2', chunk: 'pong\n', seq: 100 }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('other', 'claude-1', event)).toBe(false)
  })

  it('prefers event_id over seq for identity', () => {
    const deduper = new PtyChunkDeduper()
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'x\n', event_id: 'e1', seq: 1 }))).toBe(false)
    // Same event_id, same bytes, different seq: still the same event.
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'x\n', event_id: 'e1', seq: 2 }))).toBe(true)
  })

  it('treats an event with neither identity nor chunk as never-duplicate', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
  })

  it('forgetStream resets the replay window so a respawned agent replays cleanly', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', seq: 5 })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    deduper.forgetStream('proj', 'claude-1')
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
  })
})
