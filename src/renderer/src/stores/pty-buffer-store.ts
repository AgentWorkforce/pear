// Per-agent PTY output buffer kept outside zustand so that the high-volume
// worker_stream events don't force a re-render of every component subscribed
// to the agents array. Subscribers register against a single agent key and
// receive only that agent's chunks.

const MAX_PTY_BUFFER_CHUNKS = 10_000

type Listener = (chunks: string[]) => void

const buffers = new Map<string, string[]>()
const listeners = new Map<string, Set<Listener>>()

export function getPtyChunks(key: string): string[] {
  return buffers.get(key) ?? []
}

export function appendPtyChunk(key: string, chunk: string): void {
  // Always allocate a fresh array so React subscribers (e.g. AgentNode's
  // useState) don't bail out on Object.is reference equality and freeze
  // the preview tile after the first chunk.
  const existing = buffers.get(key) ?? []
  const trimmed = existing.length >= MAX_PTY_BUFFER_CHUNKS
    ? existing.slice(existing.length - MAX_PTY_BUFFER_CHUNKS + 1)
    : existing
  const next = [...trimmed, chunk]
  buffers.set(key, next)

  const keyListeners = listeners.get(key)
  if (!keyListeners || keyListeners.size === 0) return
  for (const listener of keyListeners) {
    listener(next)
  }
}

export function clearPtyBuffer(key: string): void {
  buffers.delete(key)
  const keyListeners = listeners.get(key)
  if (keyListeners) {
    for (const listener of keyListeners) {
      listener([])
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
