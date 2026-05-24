import { pear } from '@/lib/ipc'

/**
 * High-frequency PTY output is intentionally kept out of the React/Zustand
 * store. Storing the byte stream in the store meant every chunk copied the
 * entire (up to 10k element) buffer immutably and notified every subscriber,
 * which saturated the renderer main thread and froze input.
 *
 * Instead, raw chunks arrive on the dedicated `broker:pty` channel and are
 * buffered here, outside React. Terminals subscribe per-agent and write
 * straight to xterm; only lightweight activity metadata flows into the store
 * (throttled — see the activity handler wiring in use-broker-events).
 */

const MAX_PTY_BUFFER_CHUNKS = 10_000
const ACTIVITY_THROTTLE_MS = 150

type ChunkListener = () => void
type ActivityHandler = (projectId: string | undefined, name: string) => void

const buffers = new Map<string, string[]>()
const listeners = new Map<string, Set<ChunkListener>>()
const lastActivityNotifiedAt = new Map<string, number>()

let unsubscribeIpc: (() => void) | null = null
let activityHandler: ActivityHandler | null = null

function bufferKey(projectId: string | undefined, name: string): string {
  return `${projectId ?? ''}::${name}`
}

function appendChunk(key: string, chunk: string): void {
  let buffer = buffers.get(key)
  if (!buffer) {
    buffer = []
    buffers.set(key, buffer)
  }
  buffer.push(chunk)
  if (buffer.length > MAX_PTY_BUFFER_CHUNKS) {
    buffer.splice(0, buffer.length - MAX_PTY_BUFFER_CHUNKS)
  }
}

/**
 * Begin routing `broker:pty` chunks into the per-agent buffers. Idempotent.
 * `onActivity` is invoked at most once per ACTIVITY_THROTTLE_MS per agent so
 * the store can mark the agent as actively streaming without a per-chunk
 * re-render storm.
 */
export function startPtyStream(onActivity: ActivityHandler): void {
  activityHandler = onActivity
  if (unsubscribeIpc) return

  unsubscribeIpc = pear.broker.onPty(({ projectId, name, chunk }) => {
    if (!name || !chunk) return
    const key = bufferKey(projectId, name)

    appendChunk(key, chunk)

    const agentListeners = listeners.get(key)
    if (agentListeners) {
      for (const listener of agentListeners) listener()
    }

    const now = Date.now()
    if (now - (lastActivityNotifiedAt.get(key) ?? 0) >= ACTIVITY_THROTTLE_MS) {
      lastActivityNotifiedAt.set(key, now)
      activityHandler?.(projectId, name)
    }
  })
}

export function stopPtyStream(): void {
  unsubscribeIpc?.()
  unsubscribeIpc = null
  activityHandler = null
}

/**
 * The agent's current chunk buffer. Returns the live array (read-only); callers
 * must not mutate it. Reading `.length` and `.slice()` synchronously is safe.
 */
export function getPtyChunks(projectId: string | undefined, name: string): readonly string[] {
  return buffers.get(bufferKey(projectId, name)) ?? []
}

/** Subscribe to "new chunk arrived" notifications for one agent. */
export function subscribePty(
  projectId: string | undefined,
  name: string,
  listener: ChunkListener
): () => void {
  const key = bufferKey(projectId, name)
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
    if (current.size === 0) listeners.delete(key)
  }
}

/** Drop a released/exited agent's buffer so it doesn't leak. */
export function clearPtyBuffer(projectId: string | undefined, name: string): void {
  const key = bufferKey(projectId, name)
  buffers.delete(key)
  lastActivityNotifiedAt.delete(key)
}
