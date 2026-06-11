import type { BrokerEvent } from '@agent-relay/harness-driver'

// PTY chunk replay-dedupe. An event-stream rebind reconnects with
// `sinceSeq = lastEventSeq`, so the daemon may re-deliver the most recent
// events; those replays carry the SAME seq and the SAME bytes as the first
// delivery. We remember (identity → content hash) for the last
// PTY_CHUNK_REPLAY_WINDOW chunks per agent stream and drop a chunk only when
// BOTH match — a chunk is never dropped on content alone (consecutive
// identical chunks are normal terminal traffic: repeated keystroke echoes,
// byte-identical TUI repaint frames) and never on seq alone (a daemon
// restart resets seq; dropping fresh low-seq chunks for a TTL corrupts the
// stream — dropped repaint bytes are exactly the "stacked duplicate lines /
// stray escape-sequence fragments" rendering corruption class). See
// AGENTS.md "Duplicate Event Hardening".
const PTY_CHUNK_REPLAY_WINDOW = 512
const MAX_PTY_STREAM_DEDUPE_STATES = 2_000

interface PtyStreamDedupeState {
  // Highest numeric seq delivered for this agent stream. -Infinity until the
  // first numeric seq arrives.
  lastSeq: number
  // identity key (seq or event_id) → content hash for the most recent
  // PTY_CHUNK_REPLAY_WINDOW chunks, insertion-ordered for FIFO eviction.
  recentByIdentity: Map<string, string>
  // Telemetry: replayed chunks suppressed for this stream.
  suppressedReplays: number
}

// Cheap, allocation-free content fingerprint (FNV-1a 32-bit + length). A
// false "duplicate" verdict requires an identity match AND a hash collision
// AND identical length — and only ever suppresses one chunk that renders the
// same bytes we already delivered for that identity.
function ptyChunkHash(chunk: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < chunk.length; i += 1) {
    hash ^= chunk.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${chunk.length}:${hash >>> 0}`
}

export class PtyChunkDeduper {
  private ptyStreamDedupe = new Map<string, PtyStreamDedupeState>()
  // Streams already flagged for identity-less PTY chunks (one log per stream).
  private ptyStreamsMissingIdentity = new Set<string>()
  private readonly debugEnabled: () => boolean

  constructor(opts: { debugEnabled?: () => boolean } = {}) {
    this.debugEnabled = opts.debugEnabled ?? (() => false)
  }

  // Drop a PTY chunk ONLY when it is provably a replay of one we already
  // delivered: same identity (seq or event_id) AND same content hash, within
  // the remembered window. Everything else is delivered — losing real bytes
  // mangles escape sequences and corrupts the screen until the next full
  // repaint, which is strictly worse than rendering a rare duplicate.
  isDuplicatePtyChunk(sessionKey: string, name: string, event: BrokerEvent): boolean {
    const eventRecord = event as Record<string, unknown>
    const seqRaw = eventRecord.seq
    const numericSeq =
      typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : undefined
    const seqIdentity =
      numericSeq !== undefined
        ? `seq:${numericSeq}`
        : typeof seqRaw === 'string' && seqRaw.trim()
          ? `seq:${seqRaw}`
          : ''
    const eventId = typeof eventRecord.event_id === 'string' && eventRecord.event_id
      ? eventRecord.event_id
      : typeof eventRecord.id === 'string' && eventRecord.id
        ? eventRecord.id
        : ''
    const identity = eventId ? `id:${eventId}` : seqIdentity
    // No identity → we cannot distinguish a transport replay from genuinely
    // repeated output (e.g. the same keystroke echoed twice, byte-identical
    // repaint frames). Always deliver, but surface the blind spot once per
    // stream (AGENTS.md low-noise telemetry: per-chunk logging would flood —
    // an identity-less stream hits this branch on every chunk).
    if (!identity) {
      const streamKey = `${sessionKey}:${name}`
      if (!this.ptyStreamsMissingIdentity.has(streamKey)) {
        if (this.ptyStreamsMissingIdentity.size >= MAX_PTY_STREAM_DEDUPE_STATES) {
          this.ptyStreamsMissingIdentity.clear()
        }
        this.ptyStreamsMissingIdentity.add(streamKey)
        console.info(
          `[broker] PTY chunks for ${name} carry no seq/event_id — replay dedup is blind for this stream`
        )
      }
      return false
    }

    const chunk = typeof eventRecord.chunk === 'string' ? eventRecord.chunk : ''
    const hash = ptyChunkHash(chunk)
    const streamKey = `${sessionKey}:${name}`
    let state = this.ptyStreamDedupe.get(streamKey)
    if (!state) {
      if (this.ptyStreamDedupe.size >= MAX_PTY_STREAM_DEDUPE_STATES) {
        const oldest = this.ptyStreamDedupe.keys().next().value
        if (oldest !== undefined) this.ptyStreamDedupe.delete(oldest)
      }
      state = {
        lastSeq: Number.NEGATIVE_INFINITY,
        recentByIdentity: new Map(),
        suppressedReplays: 0
      }
      this.ptyStreamDedupe.set(streamKey, state)
    }

    const remembered = state.recentByIdentity.get(identity)
    if (remembered !== undefined) {
      if (remembered === hash) {
        state.suppressedReplays += 1
        // Low-noise replay telemetry (AGENTS.md): only the debug channel
        // sees per-drop logs; the running count rides along so a burst is
        // visible from a single line.
        if (this.debugEnabled()) {
          console.info('[broker] suppressed replayed PTY chunk', {
            name,
            identity,
            suppressedTotal: state.suppressedReplays
          })
        }
        return true
      }
      // Same identity, different bytes: the daemon restarted and its seq
      // counter reset. This is a fresh stream — forget the stale window so
      // the new seq range isn't misjudged against the old one.
      state.lastSeq = Number.NEGATIVE_INFINITY
      state.recentByIdentity.clear()
    } else if (numericSeq !== undefined && numericSeq <= state.lastSeq) {
      // Seq at or below the watermark but outside the remembered window:
      // either a replay deeper than the window (rare) or a daemon seq reset.
      // Both must be delivered — dropping fresh bytes corrupts the screen,
      // while a deep-replay duplicate at worst repaints content once.
      state.lastSeq = Number.NEGATIVE_INFINITY
      state.recentByIdentity.clear()
    }

    if (numericSeq !== undefined && numericSeq > state.lastSeq) {
      state.lastSeq = numericSeq
    }
    state.recentByIdentity.set(identity, hash)
    if (state.recentByIdentity.size > PTY_CHUNK_REPLAY_WINDOW) {
      const oldest = state.recentByIdentity.keys().next().value
      if (oldest !== undefined) state.recentByIdentity.delete(oldest)
    }
    return false
  }

  // Drop per-stream state when an agent session goes away so a respawned
  // agent (fresh PTY, fresh seq space) starts with a clean window.
  forgetStream(sessionKey: string, name: string): void {
    this.ptyStreamDedupe.delete(`${sessionKey}:${name}`)
    this.ptyStreamsMissingIdentity.delete(`${sessionKey}:${name}`)
  }
}
