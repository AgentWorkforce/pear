// Retrying desired/acked PTY size synchronizer.
//
// The terminal grid (xterm) and the PTY winsize must converge to the same
// rows×cols. When they diverge persistently, a TUI computes its repaint
// cursor positions against a row count the renderer doesn't have — repaints
// land mid-screen and stack in scrollback instead of overwriting in place.
//
// The failure mode this kills: a resizePty IPC fails transiently (broker
// busy, stream rebind, agent restarting) while the caller records the size
// as "sent" — the gate then suppresses every subsequent identical resize and
// the mismatch becomes permanent. Here a size only graduates from `desired`
// to `acked` when the IPC RESOLVES; failures retry with capped backoff until
// the current desired size lands or a newer one supersedes it.

export interface PtySizeSync {
  /** The grid measured rows×cols; sync (or queue a retrying sync) to the PTY. */
  setDesired(rows: number, cols: number): void
  /**
   * Record that the PTY is known to be at rows×cols via a side channel
   * (e.g. the size carried on attachTerminal), without sending an IPC.
   * Re-asserts `desired` if it diverged while the side channel was in flight.
   */
  noteAcked(rows: number, cols: number): void
  /**
   * Forget the ack after a deliberate out-of-band resize (the SIGWINCH
   * bounce), so the next setDesired re-sends even an unchanged size.
   */
  invalidateAck(): void
  /** Cancel any pending retry. Further calls are no-ops. */
  dispose(): void
}

const INITIAL_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 5_000

export function createPtySizeSync(
  send: (rows: number, cols: number) => Promise<unknown>
): PtySizeSync {
  let desiredRows = -1
  let desiredCols = -1
  let ackedRows = -1
  let ackedCols = -1
  let inFlight = false
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelayMs = INITIAL_RETRY_DELAY_MS

  const sync = (): void => {
    if (disposed || inFlight) return
    if (desiredRows <= 0 || desiredCols <= 0) return
    if (desiredRows === ackedRows && desiredCols === ackedCols) return
    const rows = desiredRows
    const cols = desiredCols
    inFlight = true
    send(rows, cols)
      .then(() => {
        inFlight = false
        ackedRows = rows
        ackedCols = cols
        retryDelayMs = INITIAL_RETRY_DELAY_MS
        // Desired may have moved while this send was in flight.
        sync()
      })
      .catch(() => {
        inFlight = false
        if (disposed) return
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          retryTimer = null
          sync()
        }, retryDelayMs)
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
      })
  }

  return {
    setDesired(rows: number, cols: number): void {
      desiredRows = rows
      desiredCols = cols
      sync()
    },
    noteAcked(rows: number, cols: number): void {
      ackedRows = rows
      ackedCols = cols
      if (desiredRows <= 0) {
        desiredRows = rows
        desiredCols = cols
      }
      sync()
    },
    invalidateAck(): void {
      ackedRows = -1
      ackedCols = -1
    },
    dispose(): void {
      disposed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }
  }
}
