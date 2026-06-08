import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TypingStoreModule = typeof import('./typing-store')

let typingStoreModule: TypingStoreModule

function flushRaf(): void {
  vi.advanceTimersByTime(20)
}

async function loadTypingStore(): Promise<TypingStoreModule> {
  vi.resetModules()
  typingStoreModule = await import('./typing-store')
  return typingStoreModule
}

describe('typing-store', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    )
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout
    })
    await loadTypingStore()
  })

  afterEach(() => {
    for (const key of ['p1:agent-a', 'p1:agent-b']) {
      typingStoreModule?.useTypingStore.getState().clear(key)
    }
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('coalesces noteActivity bursts into one per-frame entries update', () => {
    const { useTypingStore } = typingStoreModule
    const updates: unknown[] = []
    const unsubscribe = useTypingStore.subscribe((state) => {
      updates.push(state.entries)
    })

    const store = useTypingStore.getState()
    store.noteActivity('p1:agent-a')
    store.noteActivity('p1:agent-a')
    store.noteActivity('p1:agent-b')
    expect(updates).toHaveLength(0)

    flushRaf()
    expect(updates).toHaveLength(1)
    expect(Object.keys(useTypingStore.getState().entries).sort()).toEqual([
      'p1:agent-a',
      'p1:agent-b'
    ])

    updates.length = 0
    vi.advanceTimersByTime(500)
    store.noteActivity('p1:agent-a')
    flushRaf()
    expect(updates).toHaveLength(0)

    vi.advanceTimersByTime(500)
    store.noteActivity('p1:agent-a')
    flushRaf()
    expect(updates).toHaveLength(1)
    unsubscribe()
  })

  it('clear cancels pending noteActivity before the frame flushes', () => {
    const { useTypingStore } = typingStoreModule
    const store = useTypingStore.getState()
    store.noteActivity('p1:agent-a')
    store.clear('p1:agent-a')
    flushRaf()

    expect(useTypingStore.getState().entries['p1:agent-a']).toBeUndefined()
  })

  it('expires typing entries after the activity window', () => {
    const { TYPING_ACTIVITY_WINDOW_MS, useTypingStore } = typingStoreModule
    const store = useTypingStore.getState()
    store.noteActivity('p1:agent-a')
    flushRaf()
    expect(useTypingStore.getState().entries['p1:agent-a']).toBeDefined()

    vi.advanceTimersByTime(TYPING_ACTIVITY_WINDOW_MS + 60)
    expect(useTypingStore.getState().entries['p1:agent-a']).toBeUndefined()
  })

  it('setFromState overrides a pending noteActivity without stale frame writes', () => {
    const { TYPING_ACTIVITY_WINDOW_MS, useTypingStore } = typingStoreModule
    const store = useTypingStore.getState()
    store.noteActivity('p1:agent-a')

    const lastActivityAtMs = Date.now() + 200
    store.setFromState('p1:agent-a', 'working', lastActivityAtMs)
    flushRaf()

    expect(useTypingStore.getState().entries['p1:agent-a']).toEqual({
      lastActivityAtMs,
      typingUntilMs: lastActivityAtMs + TYPING_ACTIVITY_WINDOW_MS
    })
  })
})
