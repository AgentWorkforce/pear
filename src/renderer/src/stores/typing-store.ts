import { create } from 'zustand'
import type { AgentCurrentState } from '@/lib/ipc'

export const TYPING_ACTIVITY_WINDOW_MS = 12_000

export interface TypingEntry {
  lastActivityAtMs: number
  typingUntilMs: number
}

interface TypingState {
  entries: Record<string, TypingEntry>
  noteActivity: (key: string, now?: number) => void
  clear: (key: string) => void
  setFromState: (key: string, currentState: AgentCurrentState, lastActivityAtMs?: number) => void
}

const expiryTimers = new Map<string, number>()
const pendingActivity = new Map<string, number>()
let pendingActivityFrame: number | null = null

const scheduleAnimationFrame: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number)

const cancelScheduledAnimationFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : ((handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>))

function clearExpiryTimer(key: string): void {
  const existing = expiryTimers.get(key)
  if (existing !== undefined) {
    window.clearTimeout(existing)
    expiryTimers.delete(key)
  }
}

function scheduleExpiry(
  key: string,
  typingUntilMs: number,
  expire: (key: string, typingUntilMs: number) => void
): void {
  clearExpiryTimer(key)
  const delay = typingUntilMs - Date.now()
  if (delay <= 0) return
  const timer = window.setTimeout(() => {
    expiryTimers.delete(key)
    expire(key, typingUntilMs)
  }, delay + 50)
  expiryTimers.set(key, timer as unknown as number)
}

function expireTypingEntry(key: string, expectedTypingUntilMs: number): void {
  useTypingStore.setState((state) => {
    const entry = state.entries[key]
    if (!entry || entry.typingUntilMs !== expectedTypingUntilMs) return state
    const { [key]: _removed, ...rest } = state.entries
    return { entries: rest }
  })
}

function flushPendingActivity(): void {
  pendingActivityFrame = null
  const queued = Array.from(pendingActivity.entries())
  pendingActivity.clear()
  if (queued.length === 0) return

  const updatedEntries: Array<[string, TypingEntry]> = []
  useTypingStore.setState((state) => {
    let entries = state.entries
    for (const [key, now] of queued) {
      const existing = state.entries[key]
      if (existing && now - existing.lastActivityAtMs < 1_000) continue

      const typingUntilMs = now + TYPING_ACTIVITY_WINDOW_MS
      const entry = { lastActivityAtMs: now, typingUntilMs }
      if (entries === state.entries) entries = { ...state.entries }
      entries[key] = entry
      updatedEntries.push([key, entry])
    }

    return entries === state.entries ? state : { entries }
  })

  for (const [key, entry] of updatedEntries) {
    scheduleExpiry(key, entry.typingUntilMs, expireTypingEntry)
  }
}

function queueActivity(key: string, now: number): void {
  pendingActivity.set(key, Math.max(pendingActivity.get(key) ?? now, now))
  if (pendingActivityFrame !== null) return
  pendingActivityFrame = scheduleAnimationFrame(flushPendingActivity)
}

function clearPendingActivity(key: string): void {
  pendingActivity.delete(key)
  if (pendingActivity.size === 0 && pendingActivityFrame !== null) {
    cancelScheduledAnimationFrame(pendingActivityFrame)
    pendingActivityFrame = null
  }
}

export const useTypingStore = create<TypingState>((set, get) => ({
  entries: {},

  noteActivity: (key, now = Date.now()) => {
    // Bursty PTY output can produce 100+ chunks/sec; only refresh the typing
    // entry once per second, and batch the actual state rebuild + timer
    // reschedule to one animation frame across all agents.
    const existing = get().entries[key]
    if (existing && now - existing.lastActivityAtMs < 1_000) return

    queueActivity(key, now)
  },

  clear: (key) => {
    clearPendingActivity(key)
    clearExpiryTimer(key)
    set((state) => {
      if (!(key in state.entries)) return state
      const { [key]: _removed, ...rest } = state.entries
      return { entries: rest }
    })
  },

  setFromState: (key, currentState, lastActivityAtMs) => {
    clearPendingActivity(key)
    if (currentState !== 'working' || typeof lastActivityAtMs !== 'number') {
      clearExpiryTimer(key)
      set((state) => {
        if (!(key in state.entries)) return state
        const { [key]: _removed, ...rest } = state.entries
        return { entries: rest }
      })
      return
    }
    const typingUntilMs = lastActivityAtMs + TYPING_ACTIVITY_WINDOW_MS
    if (typingUntilMs <= Date.now()) {
      clearExpiryTimer(key)
      set((state) => {
        if (!(key in state.entries)) return state
        const { [key]: _removed, ...rest } = state.entries
        return { entries: rest }
      })
      return
    }
    set((state) => ({
      entries: { ...state.entries, [key]: { lastActivityAtMs, typingUntilMs } }
    }))
    scheduleExpiry(key, typingUntilMs, expireTypingEntry)
  }
}))

export function useIsAgentTyping(
  agent: { projectId?: string; name: string; currentState: AgentCurrentState }
): boolean {
  const key = `${agent.projectId || 'unknown'}:${agent.name}`
  return useTypingStore((state) => {
    if (agent.currentState !== 'working') return false
    const entry = state.entries[key]
    if (!entry) return false
    return Date.now() < entry.typingUntilMs
  })
}
