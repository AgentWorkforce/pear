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
//
// Detection is reported separately from repair. This module is two things at
// once: the convergence backstop (repair) and the only always-on divergence
// DETECTOR in the app (the signal that a creation vector exists upstream —
// see AGENTS.md "Terminal Screen Convergence"). Those have different
// audiences, and gating the only telemetry on a completed repair conflated
// them: a confirmed divergence whose repair was deferred by the rate limit,
// or that was observed on a screen that went busy again before the second
// confirmation, was healed-or-not in silence. Worse, the repair path is slow
// by design — quiet 1.5s, then up to one check interval to align, then a
// second confirming check — so any observer sampling a terminal for less
// than ~10s of quiet could see 100% of a screen diverged and read back zero
// telemetry, which reads as "the pipeline is clean". So: report at CONFIRMED
// divergence, before deciding whether to repair, and say why a repair was
// skipped. Both lines carry the documented `[terminal] viewport diverged
// from broker screen` prefix, because that string's documented meaning is
// "a creation vector exists and is worth hunting" — which is true at
// detection, not only at repair.

export const RECONCILE_CHECK_INTERVAL_MS = 4_000
export const RECONCILE_QUIET_MS = 1_500
export const RECONCILE_MIN_REPAIR_GAP_MS = 15_000
// Confirmations required on consecutive checks before repairing.
export const RECONCILE_CONFIRM_CHECKS = 2
// Gap between confirmed-divergence reports. MUST stay strictly below
// RECONCILE_MIN_REPAIR_GAP_MS: a divergence confirmed inside the repair gap
// is precisely the case this telemetry exists to surface, so a log gap at or
// above the repair gap would silence the one state worth hearing about (the
// first draft of this used 15_000 and did exactly that). The ceiling is one
// line per gap per diverged terminal, and only while CONFIRMED diverged —
// a screen that stays broken should keep saying so.
export const RECONCILE_DIVERGENCE_LOG_GAP_MS = 5_000
// Consecutive quiet checks with snapshot dims ≠ grid dims before the
// mismatch counts as persistent rather than a resize in flight (one check
// interval is ample time for the size-sync loop to settle a real resize).
export const RECONCILE_DIMS_MISMATCH_CHECKS = 2
export const RECONCILE_DIMS_KICK_GAP_MS = 30_000
export const RECONCILE_ERROR_LOG_GAP_MS = 60_000

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

export interface ConfirmedTerminalDivergence {
  plain: ReconcileSnapshot
  viewport: ReconcileViewport
  telemetryLines: string[]
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
  /**
   * The PTY and the rendered grid have disagreed on dimensions for
   * RECONCILE_DIMS_MISMATCH_CHECKS consecutive quiet checks. The dims gate
   * exists to skip repairs while a resize is propagating — but a PERSISTENT
   * mismatch means the size-sync loop lost the PTY: the TUI frames its
   * repaints for the wrong row count (the exact state that creates
   * stacked-frame corruption), and the gate would otherwise disable this
   * backstop silently, forever. Wire this to a forced size resync.
   * Rate-limited by RECONCILE_DIMS_KICK_GAP_MS.
   */
  onPersistentDimsMismatch?(
    grid: { rows: number; cols: number },
    snapshot: { rows: number; cols: number }
  ): void
  /**
   * Best-effort observation hook. Its snapshot pair is retained when the
   * confirm-twice gate is met, then the hook is queued after the repair
   * decision/write. It must never affect or delay repair.
   */
  onConfirmedDivergence?(divergence: ConfirmedTerminalDivergence): void
  log?(message: string): void
  now?(): number
}

export interface TerminalReconciler {
  /** Run one check cycle now (the interval calls this internally). */
  checkNow(): Promise<void>
  repairs(): number
  /** Confirmed divergences observed, whether or not they were repaired. */
  divergences(): number
  dispose(): void
}

export function createTerminalReconciler(deps: TerminalReconcilerDeps): TerminalReconciler {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => undefined)
  let disposed = false
  let checking = false
  let mismatchStreak = 0
  let dimsMismatchStreak = 0
  let lastDimsKickAt = 0
  let lastErrorLogAt = 0
  let lastRepairAt = 0
  let repairCount = 0
  let pendingConfirmedDivergence: ConfirmedTerminalDivergence | null = null
  let divergenceCount = 0
  let lastDivergenceLogAt = 0

  // Report a confirmed divergence. `outcome` states what happened to the
  // repair, so a reader can tell "detected and healed" from "detected and
  // deliberately left alone" without correlating two lines.
  const reportDivergence = (
    plain: ReconcileSnapshot,
    viewport: ReconcileViewport,
    outcome: string
  ): void => {
    const rows = divergentRowCount(plain.screen, viewport.lines)
    log(
      `[terminal] viewport diverged from broker screen; ${rows}/${viewport.rows} rows differ ` +
        `at ${viewport.rows}x${viewport.cols} (divergence #${divergenceCount}, ${outcome})`
    )
  }

  const timer = setInterval(() => {
    void check()
  }, RECONCILE_CHECK_INTERVAL_MS)

  const check = async (): Promise<void> => {
    if (disposed || checking) return
    if (!deps.isQuiet()) return
    checking = true
    try {
      await checkInner()
    } catch (err) {
      // A thrown check must never kill the interval loop (snapshotTerminal
      // degrades to null, but the IPC bridge itself can still reject).
      if (now() - lastErrorLogAt >= RECONCILE_ERROR_LOG_GAP_MS) {
        lastErrorLogAt = now()
        log(`[terminal] reconcile check failed: ${String(err)}`)
      }
    } finally {
      checking = false
      const confirmedDivergence = pendingConfirmedDivergence
      pendingConfirmedDivergence = null
      if (confirmedDivergence) {
        // Corpus persistence starts only after the repair decision/write and
        // is never awaited. A slow capturePage or disk cannot delay
        // convergence.
        queueMicrotask(() => {
          try {
            deps.onConfirmedDivergence?.(confirmedDivergence)
          } catch {
            // Diagnostic observer only: never alter the repair path.
          }
        })
      }
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
    if (plain.rows !== viewport.rows || plain.cols !== viewport.cols) {
      mismatchStreak = 0
      dimsMismatchStreak += 1
      if (
        dimsMismatchStreak >= RECONCILE_DIMS_MISMATCH_CHECKS &&
        now() - lastDimsKickAt >= RECONCILE_DIMS_KICK_GAP_MS
      ) {
        lastDimsKickAt = now()
        log(
          `[terminal] PTY ${plain.rows}x${plain.cols} disagrees with grid ${viewport.rows}x${viewport.cols} across ${dimsMismatchStreak} quiet checks; forcing size resync`
        )
        deps.onPersistentDimsMismatch?.(
          { rows: viewport.rows, cols: viewport.cols },
          { rows: plain.rows, cols: plain.cols }
        )
      }
      return
    }
    dimsMismatchStreak = 0
    if (screensMatch(plain.screen, viewport.lines)) {
      mismatchStreak = 0
      return
    }
    mismatchStreak += 1
    if (mismatchStreak < RECONCILE_CONFIRM_CHECKS) return

    // Confirmed: two consecutive quiet checks at matching dims disagree with
    // the broker. Count it now — the divergence is a fact about the pipeline
    // regardless of what the repair does next.
    divergenceCount += 1
    const reportable = now() - lastDivergenceLogAt >= RECONCILE_DIVERGENCE_LOG_GAP_MS
    if (reportable) lastDivergenceLogAt = now()

    // Capture for the corpus dump before any repair branch: a confirmed
    // divergence is dumped even when the repair is rate-limited or skipped.
    pendingConfirmedDivergence = {
      plain: { ...plain },
      viewport: { ...viewport, lines: [...viewport.lines] },
      telemetryLines: [
        `[terminal] viewport diverged from broker screen; confirmed after ` +
        `${mismatchStreak} quiet checks at ${viewport.rows}x${viewport.cols}`
      ]
    }

    if (now() - lastRepairAt < RECONCILE_MIN_REPAIR_GAP_MS) {
      // Deliberate: repairs must never flap. But the screen IS diverged and
      // the user is looking at it, so this must not be silent.
      if (reportable) reportDivergence(plain, viewport, 'repair rate-limited')
      return
    }

    const ansi = await deps.fetchSnapshot('ansi')
    if (disposed || !ansi) {
      if (reportable) reportDivergence(plain, viewport, 'repair skipped: no ansi snapshot')
      return
    }
    if (deps.activitySerial() !== serial || !deps.isQuiet()) {
      if (reportable) reportDivergence(plain, viewport, 'repair skipped: output raced the snapshot')
      return
    }
    if (ansi.rows !== viewport.rows || ansi.cols !== viewport.cols) {
      if (reportable) reportDivergence(plain, viewport, 'repair skipped: ansi snapshot dims moved')
      return
    }
    // Final gate, synchronous with the write: force any staged chunks out.
    // If one lands, its bytes may already be inside the snapshot we are
    // about to paint — abort and let the next cycle re-verify.
    deps.flushPending()
    if (disposed || deps.activitySerial() !== serial) {
      if (reportable) reportDivergence(plain, viewport, 'repair skipped: staged chunk raced the flush')
      return
    }
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
    divergences: () => divergenceCount,
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
  return divergentRowCount(plainScreen, viewportLines) === 0
}

// How many rows differ, by the same right-trimmed comparison screensMatch
// uses. Reported with each divergence so a reader can tell a one-row drift
// from a whole-screen shift (the row-shift signature a diff-painting TUI
// produces once its model and the grid disagree) without a bundle diff.
export function divergentRowCount(plainScreen: string, viewportLines: string[]): number {
  const snapshotLines = plainScreen.split('\n')
  const rows = Math.max(snapshotLines.length, viewportLines.length)
  let divergent = 0
  for (let row = 0; row < rows; row += 1) {
    const expected = (snapshotLines[row] ?? '').replace(/\s+$/, '')
    const actual = (viewportLines[row] ?? '').replace(/\s+$/, '')
    if (expected !== actual) divergent += 1
  }
  return divergent
}
