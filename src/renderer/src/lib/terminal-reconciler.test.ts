import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalReconciler,
  screensMatch,
  RECONCILE_CONFIRM_CHECKS,
  RECONCILE_MIN_REPAIR_GAP_MS,
  type ReconcileSnapshot,
  type ReconcileViewport,
  type TerminalReconcilerDeps
} from './terminal-reconciler'

interface Harness {
  deps: TerminalReconcilerDeps
  repairs: string[]
  state: {
    plain: ReconcileSnapshot | null
    ansi: ReconcileSnapshot | null
    viewport: ReconcileViewport | null
    quiet: boolean
    serial: number
    now: number
    flushBumpsSerial: boolean
    onFetch?: (format: 'plain' | 'ansi') => void
  }
}

function makeHarness(): Harness {
  const repairs: string[] = []
  const state: Harness['state'] = {
    plain: { rows: 2, cols: 10, screen: 'row one\nrow two' },
    ansi: { rows: 2, cols: 10, screen: '\x1b[0m\x1b[H\x1b[2J\x1b[1;1Hrow one\x1b[2;1Hrow two' },
    viewport: { rows: 2, cols: 10, lines: ['row one', 'row two'] },
    quiet: true,
    serial: 0,
    now: 1_000_000,
    flushBumpsSerial: false
  }
  const deps: TerminalReconcilerDeps = {
    fetchSnapshot: async (format) => {
      state.onFetch?.(format)
      return format === 'plain' ? state.plain : state.ansi
    },
    readViewport: () => state.viewport,
    writeRepair: (ansi) => repairs.push(ansi),
    isQuiet: () => state.quiet,
    activitySerial: () => state.serial,
    flushPending: () => {
      if (state.flushBumpsSerial) state.serial += 1
    },
    now: () => state.now
  }
  return { deps, repairs, state }
}

function diverge(state: Harness['state']): void {
  state.viewport = { rows: 2, cols: 10, lines: ['row one', 'GARBAGE tw'] }
}

async function confirmCycles(reconciler: { checkNow(): Promise<void> }): Promise<void> {
  for (let i = 0; i < RECONCILE_CONFIRM_CHECKS; i += 1) {
    await reconciler.checkNow()
  }
}

describe('screensMatch', () => {
  it('matches identical screens and ignores trailing whitespace + blank tail rows', () => {
    expect(screensMatch('a\nb', ['a', 'b'])).toBe(true)
    expect(screensMatch('a   \nb', ['a', 'b  '])).toBe(true)
    expect(screensMatch('a\nb\n\n', ['a', 'b'])).toBe(true)
    expect(screensMatch('a\nb', ['a', 'b', '', ''])).toBe(true)
  })

  it('detects divergent rows', () => {
    expect(screensMatch('a\nb', ['a', 'x'])).toBe(false)
    expect(screensMatch('a\nb', ['a'])).toBe(false)
    // Stale glyphs bleeding through spaces — the real-world signature.
    expect(screensMatch('Do you want to proceed?', ['Do3youowant to proceed?'])).toBe(false)
  })
})

describe('createTerminalReconciler', () => {
  it('does not repair when screens match', async () => {
    const { deps, repairs } = makeHarness()
    const reconciler = createTerminalReconciler(deps)
    await confirmCycles(reconciler)
    expect(repairs).toEqual([])
    reconciler.dispose()
  })

  it('repairs a divergence after the confirmation streak, exactly once', async () => {
    const { deps, repairs, state } = makeHarness()
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await reconciler.checkNow()
    expect(repairs).toEqual([]) // first sighting: not yet confirmed
    await reconciler.checkNow()
    expect(repairs).toEqual([state.ansi!.screen])
    expect(reconciler.repairs()).toBe(1)
    // Streak reset: the next mismatch sighting starts over.
    await reconciler.checkNow()
    expect(repairs).toHaveLength(1)
    reconciler.dispose()
  })

  it('never fetches while not quiet', async () => {
    const { deps, state } = makeHarness()
    const fetches: string[] = []
    state.onFetch = (format) => fetches.push(format)
    state.quiet = false
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await confirmCycles(reconciler)
    expect(fetches).toEqual([])
    reconciler.dispose()
  })

  it('aborts when output arrives during the plain fetch', async () => {
    const { deps, repairs, state } = makeHarness()
    state.onFetch = (format) => {
      if (format === 'plain') state.serial += 1
    }
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await confirmCycles(reconciler)
    expect(repairs).toEqual([])
    reconciler.dispose()
  })

  it('aborts when output arrives during the ansi fetch', async () => {
    const { deps, repairs, state } = makeHarness()
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await reconciler.checkNow()
    state.onFetch = (format) => {
      if (format === 'ansi') state.serial += 1
    }
    await reconciler.checkNow()
    expect(repairs).toEqual([])
    reconciler.dispose()
  })

  it('aborts when the pre-write flush surfaces staged chunks', async () => {
    const { deps, repairs, state } = makeHarness()
    state.flushBumpsSerial = true
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await confirmCycles(reconciler)
    expect(repairs).toEqual([])
    reconciler.dispose()
  })

  it('skips while snapshot and grid dimensions disagree (resize in flight)', async () => {
    const { deps, repairs, state } = makeHarness()
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    state.viewport!.rows = 3
    state.viewport!.lines.push('')
    await confirmCycles(reconciler)
    expect(repairs).toEqual([])
    reconciler.dispose()
  })

  it('rate-limits repairs', async () => {
    const { deps, repairs, state } = makeHarness()
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await confirmCycles(reconciler)
    expect(repairs).toHaveLength(1)
    // Still divergent (repair write didn't fix the fake viewport): confirm
    // again — inside the gap window nothing happens, past it a second
    // repair lands.
    await confirmCycles(reconciler)
    expect(repairs).toHaveLength(1)
    state.now += RECONCILE_MIN_REPAIR_GAP_MS + 1
    await confirmCycles(reconciler)
    expect(repairs).toHaveLength(2)
    reconciler.dispose()
  })

  it('treats a null snapshot as a skipped check', async () => {
    const { deps, repairs, state } = makeHarness()
    state.plain = null
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await confirmCycles(reconciler)
    expect(repairs).toEqual([])
    reconciler.dispose()
  })

  it('stops checking after dispose', async () => {
    const { deps, state } = makeHarness()
    const fetches: string[] = []
    state.onFetch = (format) => fetches.push(format)
    const reconciler = createTerminalReconciler(deps)
    reconciler.dispose()
    await reconciler.checkNow()
    expect(fetches).toEqual([])
  })

  it('runs on an interval without overlapping checks', async () => {
    vi.useFakeTimers()
    try {
      const { deps, state } = makeHarness()
      let inFlight = 0
      let maxInFlight = 0
      let release: (() => void) | null = null
      deps.fetchSnapshot = async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => {
          release = resolve
        })
        inFlight -= 1
        return state.plain
      }
      const reconciler = createTerminalReconciler(deps)
      await vi.advanceTimersByTimeAsync(4_000)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(maxInFlight).toBe(1)
      release?.()
      reconciler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
