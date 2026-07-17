// Per-agent PTY output buffer kept outside zustand so that the high-volume
// worker_stream events don't force a re-render of every component subscribed
// to the agents array. Subscribers register against a single agent key and
// receive only that agent's chunks.
//
// Incoming bytes from the broker arrive at sub-frame granularity. Notifying
// listeners synchronously per chunk means each chunk triggers a synchronous
// `term.write()` and, in some subscribers, a React state update — large
// allocations + per-byte work that pegs the renderer during streaming.
// Instead, we stage incoming chunks per key and flush once per animation
// frame, so subscribers see at most one notification (with the full history)
// per frame.

const MAX_PTY_BUFFER_CHUNKS = 10_000

// Listeners receive only the newly-added chunks (the "tail"), not the full
// buffer. This sidesteps the 10k trim case where a subscriber holding an
// older buffer length would slice past the end of a trimmed window and
// drop the freshly-added chunks. Tail semantics also keep per-flush work
// proportional to the new data, not the buffer size.
type Listener = (newChunks: string[]) => void

const buffers = new Map<string, string[]>()
// Relay v10 attaches a cumulative raw-PTY byte offset to each worker_stream
// chunk. Keep offset + Pear listener generation aligned with `buffers` so
// attach seeding can discard only chunks the broker snapshot proves it already
// contains. Undefined metadata is legacy/unknown and is delivered when
// correlation is requested — a possible duplicate repaint is safer than
// dropping terminal bytes.
const offsets = new Map<string, Array<number | undefined>>()
const generations = new Map<string, Array<number | undefined>>()
const listeners = new Map<string, Set<Listener>>()
// Monotonic count of chunks ever flushed into each key's buffer. Unlike
// `buffers.get(key).length` this never moves backwards on trim, so consumers
// can capture it as a replay baseline that stays valid across the 10k trim —
// comparing against buffer length instead made a trimmed baseline look
// "past the end", and the recovery path replayed the WHOLE buffer on top of
// an already-painted snapshot (the duplicated-screen-content bug class).
const totals = new Map<string, number>()

// Chunks staged for the next animation frame, keyed by agent key.
type BufferedPtyChunk = { chunk: string; offset?: number; generation?: number }
const pending = new Map<string, BufferedPtyChunk[]>()

// Renderer-side final guard for duplicate IPC/listener delivery. Identity is
// the broker-listener generation plus Relay raw-PTY offset; content is hashed
// separately. Never suppress on either component alone.
const PTY_REPLAY_WINDOW = 512
interface RendererPtyDedupeState {
  recentByIdentity: Map<string, string>
  suppressedReplays: number
}
const replayDedupe = new Map<string, RendererPtyDedupeState>()
// Scheduled rAF handles per key so we can cancel on clear/dispose.
type FrameHandle =
  | { kind: 'raf'; handle: number }
  | { kind: 'timeout'; handle: ReturnType<typeof setTimeout> }

const pendingFrames = new Map<string, FrameHandle>()

function scheduleFrame(cb: FrameRequestCallback): FrameHandle {
  if (typeof requestAnimationFrame === 'function') {
    return { kind: 'raf', handle: requestAnimationFrame(cb) }
  }
  return { kind: 'timeout', handle: setTimeout(() => cb(performance.now()), 16) }
}

function cancelFrame(frame: FrameHandle): void {
  if (frame.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame.handle)
    } else {
      clearTimeout(frame.handle)
    }
    return
  }
  clearTimeout(frame.handle)
}

function cancelPendingFlush(key: string): void {
  const handle = pendingFrames.get(key)
  if (handle !== undefined) {
    cancelFrame(handle)
    pendingFrames.delete(key)
  }
  pending.delete(key)
}

function flushPending(key: string): void {
  pendingFrames.delete(key)
  const queued = pending.get(key)
  pending.delete(key)
  if (!queued || queued.length === 0) return

  const existing = buffers.get(key) ?? []
  const existingOffsets = offsets.get(key) ?? []
  const existingGenerations = generations.get(key) ?? []
  const queuedChunks = queued.map((entry) => entry.chunk)
  const queuedOffsets = queued.map((entry) => entry.offset)
  const queuedGenerations = queued.map((entry) => entry.generation)
  const combined = existing.concat(queuedChunks)
  const combinedOffsets = existingOffsets.concat(queuedOffsets)
  const combinedGenerations = existingGenerations.concat(queuedGenerations)
  const trimmed = combined.length > MAX_PTY_BUFFER_CHUNKS
    ? combined.slice(combined.length - MAX_PTY_BUFFER_CHUNKS)
    : combined
  const trimmedOffsets = combinedOffsets.length > MAX_PTY_BUFFER_CHUNKS
    ? combinedOffsets.slice(combinedOffsets.length - MAX_PTY_BUFFER_CHUNKS)
    : combinedOffsets
  const trimmedGenerations = combinedGenerations.length > MAX_PTY_BUFFER_CHUNKS
    ? combinedGenerations.slice(combinedGenerations.length - MAX_PTY_BUFFER_CHUNKS)
    : combinedGenerations
  buffers.set(key, trimmed)
  offsets.set(key, trimmedOffsets)
  generations.set(key, trimmedGenerations)
  totals.set(key, (totals.get(key) ?? 0) + queued.length)

  const keyListeners = listeners.get(key)
  if (!keyListeners || keyListeners.size === 0) return
  for (const listener of [...keyListeners]) {
    try {
      listener(queuedChunks)
    } catch (err) {
      console.error('[pty-buffer-store] listener threw', err)
    }
  }
}

export function getPtyChunks(key: string): string[] {
  return buffers.get(key) ?? []
}

// Monotonic count of chunks ever flushed into this key's buffer. Capture it
// (after flushPtyChunksNow) as a baseline, then read the chunks that arrived
// after the baseline with getPtyChunksSinceTotal.
export function getPtyChunkTotal(key: string): number {
  return totals.get(key) ?? 0
}

// Chunks flushed after `baselineTotal` that are still in the buffer. When
// more chunks arrived than the buffer retains (trim during the window), the
// trimmed-away middle is unrecoverable — return everything retained rather
// than nothing, and never re-return chunks from before the baseline (no
// duplicate replay).
export function getPtyChunksSinceTotal(key: string, baselineTotal: number): string[] {
  const buffer = buffers.get(key) ?? []
  const missed = (totals.get(key) ?? 0) - baselineTotal
  if (missed <= 0) return []
  if (missed >= buffer.length) return buffer.slice()
  return buffer.slice(buffer.length - missed)
}

// Return every retained chunk that is not proven to be represented by a v10
// attach snapshot. `offset > snapshotOffset` is authoritative post-snapshot
// output. Missing offsets are deliberately delivered (legacy broker or mixed
// generation): never drop a PTY chunk on uncertain identity/correlation.
export function getPtyChunksAfterOffset(
  key: string,
  snapshotOffset: number,
  snapshotGeneration?: number
): string[] {
  const buffer = buffers.get(key) ?? []
  const bufferOffsets = offsets.get(key) ?? []
  const bufferGenerations = generations.get(key) ?? []
  return buffer.filter((_, index) => {
    const generation = bufferGenerations[index]
    // Offset counters reset with a daemon/PTY generation. Without both sides
    // of the generation comparison, the numeric offset is not globally safe;
    // deliver the uncertain chunk instead of risking dropped terminal bytes.
    if (snapshotGeneration === undefined || generation === undefined) return true
    if (generation < snapshotGeneration) return false
    if (generation > snapshotGeneration) return true
    const offset = bufferOffsets[index]
    return offset === undefined || offset > snapshotOffset
  })
}

// Synchronously drain any chunks staged for the next rAF into the buffer.
// Used by the terminal runtime right before reading the buffer length as a
// snapshot baseline — otherwise pending chunks would be replayed on top of
// the snapshot we just wrote.
export function flushPtyChunksNow(key: string): void {
  const handle = pendingFrames.get(key)
  if (handle !== undefined) {
    cancelFrame(handle)
    pendingFrames.delete(key)
  }
  if (pending.has(key)) {
    flushPending(key)
  }
}

// Optional diagnostic — enable by running this in DevTools console:
//   localStorage.setItem('PEAR_DIAG_PTY', '1'); location.reload()
// Disable by removing the key. Off by default so production renderers
// don't pay the per-chunk console.log cost.
let __diagPtyChecked = false
let __diagPtyEnabled = false
export function diagPtyEnabled(): boolean {
  if (__diagPtyChecked) return __diagPtyEnabled
  __diagPtyChecked = true
  try {
    __diagPtyEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('PEAR_DIAG_PTY') === '1'
  } catch {
    __diagPtyEnabled = false
  }
  return __diagPtyEnabled
}
let __appendSeq = 0
function __previewChunk(chunk: string): string {
  return chunk.slice(0, 80).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1b/g, '\\e')
}

export function appendPtyChunk(
  key: string,
  chunk: string,
  offset?: number,
  generation?: number
): void {
  if (diagPtyEnabled()) {
    __appendSeq += 1
    console.log(`[diag:pty-append] #${__appendSeq} key=${key} bytes=${chunk.length} preview="${__previewChunk(chunk)}"`)
  }
  const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
    ? offset
    : undefined
  const normalizedGeneration =
    typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
      ? generation
      : undefined
  if (
    normalizedOffset !== undefined &&
    normalizedGeneration !== undefined &&
    isDuplicatePtyChunk(key, chunk, normalizedOffset, normalizedGeneration)
  ) {
    return
  }
  const entry: BufferedPtyChunk = {
    chunk,
    ...(normalizedOffset !== undefined ? { offset: normalizedOffset } : {}),
    ...(normalizedGeneration !== undefined ? { generation: normalizedGeneration } : {})
  }
  const queue = pending.get(key)
  if (queue) {
    queue.push(entry)
  } else {
    pending.set(key, [entry])
  }
  const subscriberCount = listeners.get(key)?.size ?? 0
  if (subscriberCount === 0) {
    // No subscribers (lazy-mount: 999 of 1000 agents have no mounted
    // terminal). Skip the rAF schedule and inline-flush into the canonical
    // buffer. Future subscribers reading getPtyChunks() still see all
    // accumulated chunks. Saves ~1000 rAF callbacks per frame at scale,
    // which was producing GC stalls and 185ms longest frames on 1000-agent
    // stress runs after the lazy-mount fix landed.
    if (pendingFrames.has(key)) {
      // A rAF was scheduled earlier (when a subscriber existed); cancel it
      // since we're about to flush synchronously instead.
      const pendingFrame = pendingFrames.get(key)
      if (pendingFrame) cancelFrame(pendingFrame)
      pendingFrames.delete(key)
    }
    flushPending(key)
    return
  }
  if (pendingFrames.has(key)) return
  const handle = scheduleFrame(() => flushPending(key))
  pendingFrames.set(key, handle)
}

export function clearPtyBuffer(key: string): void {
  cancelPendingFlush(key)
  buffers.delete(key)
  offsets.delete(key)
  generations.delete(key)
  replayDedupe.delete(key)
  const keyListeners = listeners.get(key)
  if (keyListeners) {
    for (const listener of [...keyListeners]) {
      try {
        listener([])
      } catch (err) {
        console.error('[pty-buffer-store] listener threw', err)
      }
    }
  }
}

function isDuplicatePtyChunk(
  key: string,
  chunk: string,
  offset: number,
  generation: number
): boolean {
  let state = replayDedupe.get(key)
  if (!state) {
    state = { recentByIdentity: new Map(), suppressedReplays: 0 }
    replayDedupe.set(key, state)
  }

  const identity = `${generation}:${offset}`
  const hash = ptyChunkHash(chunk)
  if (state.recentByIdentity.get(identity) === hash) {
    state.suppressedReplays += 1
    // Exponential debug telemetry keeps replay storms visible without logging
    // every suppressed terminal chunk.
    if (
      diagPtyEnabled() &&
      (state.suppressedReplays & (state.suppressedReplays - 1)) === 0
    ) {
      console.info('[pty-buffer-store] suppressed replayed PTY chunk', {
        key,
        generation,
        offset,
        suppressedTotal: state.suppressedReplays
      })
    }
    return true
  }

  // Same identity with different bytes is not a duplicate. Remember the most
  // recently delivered content, but deliver both: identity alone is never a
  // safe reason to drop PTY traffic.
  state.recentByIdentity.delete(identity)
  state.recentByIdentity.set(identity, hash)
  if (state.recentByIdentity.size > PTY_REPLAY_WINDOW) {
    const oldest = state.recentByIdentity.keys().next().value
    if (oldest !== undefined) state.recentByIdentity.delete(oldest)
  }
  return false
}

function ptyChunkHash(chunk: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < chunk.length; index += 1) {
    hash ^= chunk.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${chunk.length}:${hash >>> 0}`
}

export function subscribePtyBuffer(key: string, listener: Listener): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      listeners.delete(key)
    }
  }
}
