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

export const useTypingStore = create<TypingState>((set, get) => ({
  entries: {},

  noteActivity: (key, now = Date.now()) => {
    // Bursty PTY output can produce 100+ chunks/sec; only refresh the typing
    // entry once per second so we don't pay for a state rebuild + timer
    // reschedule per character.
    const existing = get().entries[key]
    if (existing && now - existing.lastActivityAtMs < 1_000) return

    const typingUntilMs = now + TYPING_ACTIVITY_WINDOW_MS
    set((state) => ({
      entries: { ...state.entries, [key]: { lastActivityAtMs: now, typingUntilMs } }
    }))
    scheduleExpiry(key, typingUntilMs, (expiringKey, expectedTypingUntilMs) => {
      set((state) => {
        const entry = state.entries[expiringKey]
        if (!entry || entry.typingUntilMs !== expectedTypingUntilMs) return state
        const { [expiringKey]: _removed, ...rest } = state.entries
        return { entries: rest }
      })
    })
  },

  clear: (key) => {
    clearExpiryTimer(key)
    set((state) => {
      if (!(key in state.entries)) return state
      const { [key]: _removed, ...rest } = state.entries
      return { entries: rest }
    })
  },

  setFromState: (key, currentState, lastActivityAtMs) => {
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
    scheduleExpiry(key, typingUntilMs, (expiringKey, expectedTypingUntilMs) => {
      set((state) => {
        const entry = state.entries[expiringKey]
        if (!entry || entry.typingUntilMs !== expectedTypingUntilMs) return state
        const { [expiringKey]: _removed, ...rest } = state.entries
        return { entries: rest }
      })
    })
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
