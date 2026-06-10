import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerEvent } from '@agent-relay/harness-driver'
import { PtyChunkDeduper } from './pty-dedup'

// The deduper reads chunk/identity fields dynamically off the event; the suite
// hands it loosely-shaped worker_stream records cast to BrokerEvent, mirroring
// how broker.ts forwards raw SDK events.
function chunkEvent(fields: Record<string, unknown>): BrokerEvent {
  return { kind: 'worker_stream', stream: 'stdout', ...fields } as unknown as BrokerEvent
}

describe('PtyChunkDeduper', () => {
  let now: number

  beforeEach(() => {
    now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suppresses a repeat of the same event identity', () => {
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

  it('lets the identity window survive past the short content window', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', event_id: 'e1' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    // Beyond the 1s content TTL but well within the 60s identity TTL: still a dup.
    now += 5_000
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(true)
  })

  it('expires an identity entry after the 60s window', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n', event_id: 'e1' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    now += 60_001
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
  })

  it('dedupes identity-less chunks within the 1s content window', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(true)
  })

  it('re-admits an identity-less chunk once the content window expires', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1', chunk: 'pong\n' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    now += 1_001
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
  })

  it('only remembers the latest identity-less chunk per agent, so a repeat after intervening output is admitted', () => {
    const deduper = new PtyChunkDeduper()
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: '>' }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: ' ' }))).toBe(false)
    // The first '>' content key was evicted when ' ' arrived, so '>' is fresh again.
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: '>' }))).toBe(false)
  })

  it('scopes content dedup per session and agent', () => {
    const deduper = new PtyChunkDeduper()
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'pong\n' }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-2', chunkEvent({ name: 'claude-2', chunk: 'pong\n' }))).toBe(false)
    expect(deduper.isDuplicatePtyChunk('other', 'claude-1', chunkEvent({ name: 'claude-1', chunk: 'pong\n' }))).toBe(false)
  })

  it('treats an event with neither identity nor chunk as never-duplicate', () => {
    const deduper = new PtyChunkDeduper()
    const event = chunkEvent({ name: 'claude-1' })
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
    expect(deduper.isDuplicatePtyChunk('proj', 'claude-1', event)).toBe(false)
  })
})
