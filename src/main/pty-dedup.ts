import type { BrokerEvent } from '@agent-relay/harness-driver'

// PTY chunk replay-dedupe, keyed on the correlation metadata that relay
// `worker_stream` chunks ACTUALLY carry: the cumulative per-worker byte
// `offset` (present 5/5 on PTY streams; absent only on headless workers and
// pre-offset brokers) plus the broker event-stream `generation` supplied by
// the caller. seq/event_id are NOT on worker_stream chunks — they are excluded
// from the daemon replay buffer, so an earlier identity keyed on them was
// structurally inert (it could never match) and this layer said so once and
// suppressed nothing. See AGENTS.md "Duplicate Event Hardening".
//
// Identity = `${generation}:${offset}`. We remember (identity → content hash)
// for the last PTY_CHUNK_REPLAY_WINDOW chunks per agent stream and drop a chunk
// only when BOTH the identity AND the content hash match a remembered entry.
// Invariants (never violated):
//   - Never drop on content alone. Consecutive byte-identical chunks are normal
//     terminal traffic (repeated keystroke echoes, byte-identical TUI repaint
//     frames); dropping them mangles the screen. A duplicate repaint is safe;
//     a dropped chunk corrupts until the next full repaint.
//   - Never drop when correlation metadata is absent. No `offset` → no identity
//     → we cannot tell a transport replay from genuinely repeated output, so we
//     DELIVER and surface the blind spot with a rate-limited loud log + counter.
//   - `generation` is part of the identity so an `offset` that resets across a
//     new worker stream / generation (offset is cumulative WITHIN a worker's
//     lifetime) cannot collide with a stale remembered offset and cause a
//     false suppression. When in doubt: DELIVER.
const PTY_CHUNK_REPLAY_WINDOW = 512
const MAX_PTY_STREAM_DEDUPE_STATES = 2_000
// Rate-limit for the loud "no offset — dedup is blind" warning, per stream.
// The first blind chunk warns immediately; further blind chunks on the same
// stream warn at most once per interval, always carrying the running count so
// a burst is visible from a single line without flooding the terminal.
const MISSING_OFFSET_LOG_INTERVAL_MS = 60_000

interface PtyStreamDedupeState {
  // identity key (`${generation}:${offset}`) → content hash for the most recent
  // PTY_CHUNK_REPLAY_WINDOW chunks, insertion-ordered for FIFO eviction.
  recentByIdentity: Map<string, string>
  // Telemetry: replayed chunks suppressed for this stream.
  suppressedReplays: number
  // Telemetry: chunks delivered with no `offset` (dedup blind for them).
  identityLessDelivered: number
  // Timestamp of the last loud missing-offset warning for this stream (0 until
  // the first one), for rate limiting.
  lastMissingOffsetLogAt: number
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
  private readonly debugEnabled: () => boolean
  private readonly now: () => number

  constructor(opts: { debugEnabled?: () => boolean; now?: () => number } = {}) {
    this.debugEnabled = opts.debugEnabled ?? (() => false)
    this.now = opts.now ?? (() => Date.now())
  }

  // Drop a PTY chunk ONLY when it is provably a replay of one we already
  // delivered: same identity (`${generation}:${offset}`) AND same content hash,
  // within the remembered window. Everything else is delivered — losing real
  // bytes mangles escape sequences and corrupts the screen until the next full
  // repaint, which is strictly worse than rendering a rare duplicate.
  //
  // `generation` is the broker event-stream generation for the delivering
  // listener (BrokerManager.eventStreamGeneration). It scopes the offset so a
  // fresh worker stream (offset restarts near zero) can never be mistaken for a
  // replay of an earlier stream that happened to reach the same offset.
  isDuplicatePtyChunk(
    sessionKey: string,
    name: string,
    event: BrokerEvent,
    generation?: number
  ): boolean {
    const eventRecord = event as Record<string, unknown>
    const offsetRaw = eventRecord.offset
    const offset =
      typeof offsetRaw === 'number' && Number.isFinite(offsetRaw) ? offsetRaw : undefined
    const streamKey = `${sessionKey}:${name}`

    // No offset → no correlation metadata → we cannot distinguish a transport
    // replay from genuinely repeated output. Always deliver, but surface the
    // blind spot with a rate-limited loud log + running counter (per stream).
    if (offset === undefined) {
      const state = this.ensureState(streamKey)
      state.identityLessDelivered += 1
      const at = this.now()
      if (
        state.lastMissingOffsetLogAt === 0 ||
        at - state.lastMissingOffsetLogAt >= MISSING_OFFSET_LOG_INTERVAL_MS
      ) {
        state.lastMissingOffsetLogAt = at
        console.warn(
          `[broker] PTY chunks for ${name} carry no offset — replay dedup is blind for this stream ` +
            `(${state.identityLessDelivered} delivered without correlation metadata)`
        )
      }
      return false
    }

    const identity = `${generation ?? 'g?'}:${offset}`
    const chunk = typeof eventRecord.chunk === 'string' ? eventRecord.chunk : ''
    const hash = ptyChunkHash(chunk)
    const state = this.ensureState(streamKey)

    const remembered = state.recentByIdentity.get(identity)
    if (remembered !== undefined) {
      if (remembered === hash) {
        // Full identity + content match within the window: a provable replay.
        state.suppressedReplays += 1
        // Low-noise replay telemetry (AGENTS.md): only the debug channel sees
        // per-drop logs; the running count rides along so a burst is visible
        // from a single line.
        if (this.debugEnabled()) {
          console.info('[broker] suppressed replayed PTY chunk', {
            name,
            identity,
            suppressedTotal: state.suppressedReplays
          })
        }
        return true
      }
      // Same identity, DIFFERENT bytes. offset is meant to be unique within a
      // (generation, worker) — this is an anomaly, not a replay. DELIVER (never
      // drop real bytes) and refresh the remembered hash to the latest.
    }

    state.recentByIdentity.set(identity, hash)
    if (state.recentByIdentity.size > PTY_CHUNK_REPLAY_WINDOW) {
      const oldest = state.recentByIdentity.keys().next().value
      if (oldest !== undefined) state.recentByIdentity.delete(oldest)
    }
    return false
  }

  private ensureState(streamKey: string): PtyStreamDedupeState {
    let state = this.ptyStreamDedupe.get(streamKey)
    if (!state) {
      if (this.ptyStreamDedupe.size >= MAX_PTY_STREAM_DEDUPE_STATES) {
        const oldest = this.ptyStreamDedupe.keys().next().value
        if (oldest !== undefined) this.ptyStreamDedupe.delete(oldest)
      }
      state = {
        recentByIdentity: new Map(),
        suppressedReplays: 0,
        identityLessDelivered: 0,
        lastMissingOffsetLogAt: 0
      }
      this.ptyStreamDedupe.set(streamKey, state)
    }
    return state
  }

  // Drop per-stream state when an agent session goes away so a respawned
  // agent (fresh PTY, fresh offset space) starts with a clean window.
  forgetStream(sessionKey: string, name: string): void {
    this.ptyStreamDedupe.delete(`${sessionKey}:${name}`)
  }
}
