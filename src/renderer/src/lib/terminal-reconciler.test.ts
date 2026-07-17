import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalReconciler,
  screensMatch,
  RECONCILE_CONFIRM_CHECKS,
  RECONCILE_DIMS_KICK_GAP_MS,
  RECONCILE_ERROR_LOG_GAP_MS,
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

  it('triggers the corpus hook only after divergence is confirmed', async () => {
    const { deps, repairs, state } = makeHarness()
    const order: string[] = []
    const originalWriteRepair = deps.writeRepair
    deps.writeRepair = (ansi) => {
      order.push('repair')
      originalWriteRepair(ansi)
    }
    const onConfirmedDivergence = vi.fn(() => order.push('corpus'))
    deps.onConfirmedDivergence = onConfirmedDivergence
    const reconciler = createTerminalReconciler(deps)
    diverge(state)

    await reconciler.checkNow()
    expect(onConfirmedDivergence).not.toHaveBeenCalled()
    await reconciler.checkNow()

    expect(onConfirmedDivergence).toHaveBeenCalledTimes(1)
    expect(onConfirmedDivergence).toHaveBeenCalledWith({
      plain: state.plain,
      viewport: state.viewport,
      telemetryLines: [
        '[terminal] viewport diverged from broker screen; confirmed after 2 quiet checks at 2x10'
      ]
    })
    expect(repairs).toHaveLength(1)
    expect(order).toEqual(['repair', 'corpus'])

    // A still-divergent viewport confirms again inside the repair gap. The
    // diagnostic hook still fires, but the convergence repair remains gated.
    await confirmCycles(reconciler)
    expect(onConfirmedDivergence).toHaveBeenCalledTimes(2)
    expect(repairs).toHaveLength(1)
    reconciler.dispose()
  })

  it('keeps repairing when the corpus hook throws', async () => {
    const { deps, repairs, state } = makeHarness()
    deps.onConfirmedDivergence = () => {
      throw new Error('corpus IPC unavailable')
    }
    const reconciler = createTerminalReconciler(deps)
    diverge(state)

    await confirmCycles(reconciler)

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

  it('requires fresh divergence confirmations after a dims-mismatch skip', async () => {
    const { deps, repairs, state } = makeHarness()
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await reconciler.checkNow()
    state.viewport = { rows: 3, cols: 10, lines: ['row one', 'GARBAGE tw', ''] }
    await reconciler.checkNow()
    state.viewport = { rows: 2, cols: 10, lines: ['row one', 'GARBAGE tw'] }
    await reconciler.checkNow()
    expect(repairs).toEqual([])
    await reconciler.checkNow()
    expect(repairs).toHaveLength(1)
    reconciler.dispose()
  })

  it('escalates a persistent dims mismatch to onPersistentDimsMismatch, rate-limited', async () => {
    const { deps, repairs, state } = makeHarness()
    const kicks: Array<{ grid: { rows: number; cols: number }; snapshot: { rows: number; cols: number } }> = []
    deps.onPersistentDimsMismatch = (grid, snapshot) => kicks.push({ grid, snapshot })
    const reconciler = createTerminalReconciler(deps)
    state.viewport = { rows: 3, cols: 10, lines: ['row one', 'row two', ''] }
    await reconciler.checkNow()
    // First sighting could be a resize still propagating — no kick yet.
    expect(kicks).toEqual([])
    await reconciler.checkNow()
    expect(kicks).toEqual([
      { grid: { rows: 3, cols: 10 }, snapshot: { rows: 2, cols: 10 } }
    ])
    // Still mismatched inside the kick gap: no re-kick.
    await reconciler.checkNow()
    expect(kicks).toHaveLength(1)
    state.now += RECONCILE_DIMS_KICK_GAP_MS + 1
    await reconciler.checkNow()
    expect(kicks).toHaveLength(2)
    // Dims mismatch never repaints.
    expect(repairs).toEqual([])
    reconciler.dispose()
  })

  it('resets the dims-mismatch streak once dimensions agree again', async () => {
    const { deps, state } = makeHarness()
    const kicks: number[] = []
    deps.onPersistentDimsMismatch = () => kicks.push(1)
    const reconciler = createTerminalReconciler(deps)
    const matched = state.viewport!
    state.viewport = { rows: 3, cols: 10, lines: ['row one', 'row two', ''] }
    await reconciler.checkNow()
    state.viewport = matched
    await reconciler.checkNow()
    state.viewport = { rows: 3, cols: 10, lines: ['row one', 'row two', ''] }
    await reconciler.checkNow()
    expect(kicks).toEqual([])
    reconciler.dispose()
  })

  it('survives a throwing snapshot fetch and keeps checking (rate-limited log)', async () => {
    const { deps, repairs, state } = makeHarness()
    const logs: string[] = []
    deps.log = (message) => logs.push(message)
    let failNext = true
    const baseFetch = deps.fetchSnapshot
    deps.fetchSnapshot = async (format) => {
      if (failNext) {
        failNext = false
        throw new Error('ipc bridge dead')
      }
      return baseFetch(format)
    }
    const reconciler = createTerminalReconciler(deps)
    diverge(state)
    await reconciler.checkNow() // throws internally; must not propagate
    expect(logs.some((m) => m.includes('reconcile check failed'))).toBe(true)
    await confirmCycles(reconciler)
    expect(repairs).toHaveLength(1)
    // Error log is rate-limited: a second failure inside the gap is silent.
    const logCount = logs.filter((m) => m.includes('reconcile check failed')).length
    failNext = true
    await reconciler.checkNow()
    expect(logs.filter((m) => m.includes('reconcile check failed'))).toHaveLength(logCount)
    state.now += RECONCILE_ERROR_LOG_GAP_MS + 1
    failNext = true
    await reconciler.checkNow()
    expect(logs.filter((m) => m.includes('reconcile check failed'))).toHaveLength(logCount + 1)
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
