/**
 * Shared helpers for sanitizing BrokerEvent payloads before storing them in
 * memory or shipping them to the renderer. Used by both the main process
 * (`src/main/broker.ts`) and the renderer agent store
 * (`src/renderer/src/stores/agent-store.ts`).
 */

const MAX_EVENT_TEXT_CHARS = 1_200
const TRUNCATABLE_EVENT_KEYS = ['body', 'chunk', 'message', 'reason', 'lastError'] as const

export function normalizeEventTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value
}

function truncate(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= MAX_EVENT_TEXT_CHARS) return value
  return `${value.slice(0, MAX_EVENT_TEXT_CHARS)}...`
}

export function compactBrokerEvent<T extends Record<string, unknown>>(event: T): T {
  const compacted = { ...event }
  for (const key of TRUNCATABLE_EVENT_KEYS) {
    if (key in compacted) {
      compacted[key as keyof T] = truncate(compacted[key as keyof T]) as T[keyof T]
    }
  }
  return compacted
}
