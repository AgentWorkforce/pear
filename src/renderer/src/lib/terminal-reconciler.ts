// Quiet-time screen reconciliation against the broker's authoritative PTY
// emulation.
//
// Why this exists: the rendering pipeline has had repeated rounds of
// corruption fixes, each closing one *creation* vector (dropped chunks,
// resize gating, echo ordering, prediction strands). But the class has a
// nastier property than any single vector: modern TUIs (Claude Code's
// renderer in particular) repaint by DIFFING against their own model of the
// screen — they skip cells they believe unchanged, using cursor-forward
// moves instead of rewriting. So a single divergence between the renderer's
// xterm grid and the PTY-side truth (e.g. an xterm reflow scroll during a
// width resize that the PTY-side emulator doesn't perform) is never healed
// by subsequent output: every diff-repaint preserves the stale cells, and
// the corruption compounds (stacked panels, old glyphs bleeding through the
// spaces of new rows).
//
// The broker daemon maintains its own emulation of every worker PTY — the
// same screen it serves as the attach snapshot, observable via
// `agent-relay-broker dump-pty`. That emulation consumes the byte stream
// in-order, atomically with resizes, and is the ground truth the renderer
// must converge to. This module polls it when the terminal is QUIET and the
// screen is suspect, and repaints the viewport from the broker's ANSI
// reproduction stream when a divergence is confirmed — mosh-style state
// convergence layered over the existing event stream.
//
// Safety invariants (each guards a real re-corruption vector):
// - Only check while quiet: no server output for RECONCILE_QUIET_MS, window
//   visible (a hidden window stalls the rAF chunk flush, so "no output" is
//   not trustworthy there), no outstanding optimistic-echo predictions.
// - A repair write only lands if the activity serial is unchanged across
//   the snapshot fetch AND after a forced flush of staged chunks — a chunk
//   that raced the fetch may already be inside the snapshot; replaying it on
//   top of the repaired screen would double-apply bytes.
// - Dimensions must match exactly (snapshot rows/cols == grid rows/cols);
//   a mismatch means a resize is still propagating and a repaint would be
//   framed for the wrong grid.
// - A divergence must be confirmed on two consecutive checks before a
//   repair, and repairs are rate-limited; this thing must never flap.
//
// The repair payload is the broker's ANSI snapshot, which is self-framing
// (leading reset + home + erase-display + absolute row addressing + cursor
// restore), so writing it onto a dirty grid fully replaces the viewport
// without touching scrollback.

export const RECONCILE_CHECK_INTERVAL_MS = 4_000
export const RECONCILE_QUIET_MS = 1_500
export const RECONCILE_MIN_REPAIR_GAP_MS = 15_000
// Confirmations required on consecutive checks before repairing.
export const RECONCILE_CONFIRM_CHECKS = 2

export interface ReconcileSnapshot {
  rows: number
  cols: number
  /** Row text for `plain`; ANSI reproduction stream for `ansi`. */
  screen: string
}

export interface ReconcileViewport {
  rows: number
  cols: number
  /** Right-trimmed text of each viewport row. */
  lines: string[]
}

export interface TerminalReconcilerDeps {
  fetchSnapshot(format: 'plain' | 'ansi'): Promise<ReconcileSnapshot | null>
  readViewport(): ReconcileViewport | null
  /** Write the ANSI repair stream to the live terminal (ordered sink). */
  writeRepair(ansi: string): void
  /** All quiet-gate conditions: see module doc. */
  isQuiet(): boolean
  /** Monotonic counter, bumped once per server-output delivery. */
  activitySerial(): number
  /** Force rAF-staged chunks out so the serial reflects everything received. */
  flushPending(): void
  log?(message: string): void
  now?(): number
}

export interface TerminalReconciler {
  /** Run one check cycle now (the interval calls this internally). */
  checkNow(): Promise<void>
  repairs(): number
  dispose(): void
}

export function createTerminalReconciler(deps: TerminalReconcilerDeps): TerminalReconciler {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => undefined)
  let disposed = false
  let checking = false
  let mismatchStreak = 0
  let lastRepairAt = 0
  let repairCount = 0

  const timer = setInterval(() => {
    void check()
  }, RECONCILE_CHECK_INTERVAL_MS)

  const check = async (): Promise<void> => {
    if (disposed || checking) return
    if (!deps.isQuiet()) return
    checking = true
    try {
      await checkInner()
    } finally {
      checking = false
    }
  }

  const checkInner = async (): Promise<void> => {
    const serial = deps.activitySerial()
    const plain = await deps.fetchSnapshot('plain')
    if (disposed || !plain) return
    // Output during the fetch (or a quiet-gate change) invalidates the
    // comparison: the two screens were captured at different stream points.
    if (deps.activitySerial() !== serial || !deps.isQuiet()) return
    const viewport = deps.readViewport()
    if (!viewport) return
    if (plain.rows !== viewport.rows || plain.cols !== viewport.cols) return
    if (screensMatch(plain.screen, viewport.lines)) {
      mismatchStreak = 0
      return
    }
    mismatchStreak += 1
    if (mismatchStreak < RECONCILE_CONFIRM_CHECKS) return
    if (now() - lastRepairAt < RECONCILE_MIN_REPAIR_GAP_MS) return

    const ansi = await deps.fetchSnapshot('ansi')
    if (disposed || !ansi) return
    if (deps.activitySerial() !== serial || !deps.isQuiet()) return
    if (ansi.rows !== viewport.rows || ansi.cols !== viewport.cols) return
    // Final gate, synchronous with the write: force any staged chunks out.
    // If one lands, its bytes may already be inside the snapshot we are
    // about to paint — abort and let the next cycle re-verify.
    deps.flushPending()
    if (disposed || deps.activitySerial() !== serial) return
    deps.writeRepair(ansi.screen)
    lastRepairAt = now()
    mismatchStreak = 0
    repairCount += 1
    log(
      `[terminal] viewport diverged from broker screen; repainted from snapshot (repair #${repairCount})`
    )
  }

  return {
    checkNow: check,
    repairs: () => repairCount,
    dispose(): void {
      disposed = true
      clearInterval(timer)
    }
  }
}

// Plain snapshots are newline-joined rows; xterm viewport lines come in
// right-trimmed. Compare row-by-row, right-trimmed, treating absent rows as
// blank — trailing blank rows are representational noise, not divergence.
export function screensMatch(plainScreen: string, viewportLines: string[]): boolean {
  const snapshotLines = plainScreen.split('\n')
  const rows = Math.max(snapshotLines.length, viewportLines.length)
  for (let row = 0; row < rows; row += 1) {
    const expected = (snapshotLines[row] ?? '').replace(/\s+$/, '')
    const actual = (viewportLines[row] ?? '').replace(/\s+$/, '')
    if (expected !== actual) return false
  }
  return true
}
