import type { BrokerEvent } from '@agent-relay/harness-driver'

const PTY_CHUNK_IDENTITY_DEDUPE_TTL_MS = 60_000
const PTY_CHUNK_CONTENT_DEDUPE_TTL_MS = 1_000
const MAX_PTY_CHUNK_DEDUPE_ENTRIES = 2_000

// Suppresses duplicate PTY chunks delivered more than once (overlapping event
// streams, reconnect replay). Prefers stable event identity (event_id / id /
// seq) with a 60s window, and falls back to a short 1s content window for
// chunks the broker emitted without identity (AGENTS.md duplicate-event
// hardening). State is a single `${prefix}:${sessionKey}:${name}:...` -> seenAt
// map, pruned lazily on each call.
export class PtyChunkDeduper {
  private recentPtyChunks = new Map<string, number>()

  isDuplicatePtyChunk(sessionKey: string, name: string, event: BrokerEvent): boolean {
    const now = Date.now()
    for (const [key, seenAt] of this.recentPtyChunks) {
      const ttl = key.startsWith('chunk:')
        ? PTY_CHUNK_CONTENT_DEDUPE_TTL_MS
        : PTY_CHUNK_IDENTITY_DEDUPE_TTL_MS
      if (
        now - seenAt > ttl ||
        this.recentPtyChunks.size > MAX_PTY_CHUNK_DEDUPE_ENTRIES
      ) {
        this.recentPtyChunks.delete(key)
      }
    }

    const eventRecord = event as Record<string, unknown>
    const seq = typeof eventRecord.seq === 'number' || typeof eventRecord.seq === 'string'
      ? String(eventRecord.seq)
      : ''
    const eventId = typeof eventRecord.event_id === 'string'
      ? eventRecord.event_id
      : typeof eventRecord.id === 'string'
        ? eventRecord.id
        : ''
    const identity = eventId || (seq ? `seq:${seq}` : '')
    const chunk = typeof eventRecord.chunk === 'string' ? eventRecord.chunk : ''
    if (!identity && !chunk) return false

    const contentKeyPrefix = `chunk:${sessionKey}:${name}:`
    const key = identity
      ? `identity:${sessionKey}:${name}:${identity}`
      : `${contentKeyPrefix}${chunk}`
    const ttl = identity
      ? PTY_CHUNK_IDENTITY_DEDUPE_TTL_MS
      : PTY_CHUNK_CONTENT_DEDUPE_TTL_MS
    const previous = this.recentPtyChunks.get(key)
    if (previous !== undefined && now - previous <= ttl) {
      return true
    }

    if (!identity) {
      for (const previousKey of this.recentPtyChunks.keys()) {
        if (previousKey.startsWith(contentKeyPrefix)) {
          this.recentPtyChunks.delete(previousKey)
        }
      }
    }
    this.recentPtyChunks.set(key, now)
    return false
  }
}
