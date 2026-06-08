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

type Listener = (chunks: string[]) => void

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
      listener(trimmed)
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

export function appendPtyChunk(key: string, chunk: string): void {
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
