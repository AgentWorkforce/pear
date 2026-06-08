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
const listeners = new Map<string, Set<Listener>>()

// Chunks staged for the next animation frame, keyed by agent key.
const pending = new Map<string, string[]>()
// Scheduled rAF handles per key so we can cancel on clear/dispose.
const pendingFrames = new Map<string, number>()

const raf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number)

const cancelRaf: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : ((handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>))

function cancelPendingFlush(key: string): void {
  const handle = pendingFrames.get(key)
  if (handle !== undefined) {
    cancelRaf(handle)
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
  const combined = existing.concat(queued)
  const trimmed = combined.length > MAX_PTY_BUFFER_CHUNKS
    ? combined.slice(combined.length - MAX_PTY_BUFFER_CHUNKS)
    : combined
  buffers.set(key, trimmed)

  const keyListeners = listeners.get(key)
  if (!keyListeners || keyListeners.size === 0) return
  for (const listener of [...keyListeners]) {
    try {
      listener(queued)
    } catch (err) {
      console.error('[pty-buffer-store] listener threw', err)
    }
  }
}

export function getPtyChunks(key: string): string[] {
  return buffers.get(key) ?? []
}

// Synchronously drain any chunks staged for the next rAF into the buffer.
// Used by the terminal runtime right before reading the buffer length as a
// snapshot baseline — otherwise pending chunks would be replayed on top of
// the snapshot we just wrote.
export function flushPtyChunksNow(key: string): void {
  const handle = pendingFrames.get(key)
  if (handle !== undefined) {
    cancelRaf(handle)
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
function __diagPtyOn(): boolean {
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

export function appendPtyChunk(key: string, chunk: string): void {
  if (__diagPtyOn()) {
    __appendSeq += 1
    // eslint-disable-next-line no-console
    console.log(`[diag:pty-append] #${__appendSeq} key=${key} bytes=${chunk.length} preview="${__previewChunk(chunk)}"`)
  }
  const queue = pending.get(key)
  if (queue) {
    queue.push(chunk)
  } else {
    pending.set(key, [chunk])
  }
  if (pendingFrames.has(key)) return
  const handle = raf(() => flushPending(key))
  pendingFrames.set(key, handle)
}

export function clearPtyBuffer(key: string): void {
  cancelPendingFlush(key)
  buffers.delete(key)
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
