import { Terminal } from '@xterm/xterm'
// Import the engine from the dedicated subpath rather than the package root:
// the root barrel re-exports the broker transport, which imports `ws` and can't
// run in the renderer. The `./predictive-echo` subpath (added in harness-driver
// 8.1.2) maps to a self-contained module with zero node-only imports.
import {
  PredictiveEchoEngine,
  type PredictiveEcho,
  type ScreenModel
} from '@agent-relay/harness-driver/predictive-echo'

/**
 * Confirmed-screen model backing {@link PredictiveEchoEngine}. The engine writes
 * its optimistic (unconfirmed) glyphs to the *live* xterm, so the model that
 * tracks authoritative state must be a *separate* headless terminal fed only the
 * confirmed server bytes — reading cursor/row off the live terminal would see
 * predicted glyphs and corrupt reconciliation.
 */
class HeadlessScreenModel implements ScreenModel {
  private readonly term: Terminal

  constructor(cols: number, rows: number) {
    // No scrollback: the model only needs the current viewport, and keeping
    // baseY pinned at 0 lets viewport-relative rows index the buffer directly.
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
  }

  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve))
  }

  cursor(): { row: number; col: number } {
    const buffer = this.term.buffer.active
    return { row: buffer.cursorY, col: buffer.cursorX }
  }

  rowText(row: number): string {
    const buffer = this.term.buffer.active
    const line = buffer.getLine(buffer.baseY + row)
    return line ? line.translateToString(true) : ''
  }

  isAltScreen(): boolean {
    return this.term.buffer.active.type === 'alternate'
  }

  cols(): number {
    return this.term.cols
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  dispose(): void {
    this.term.dispose()
  }
}

export interface PredictiveEchoHandle {
  engine: PredictiveEcho
  dispose: () => void
}

/**
 * Build a predictive-echo engine for one attach session. `write` is the sink for
 * predicted/reconciled bytes — point it at the live xterm. Predictions are
 * adaptive on measured echo latency, so on a fast local link the engine stays
 * dormant and invisible.
 */
export function createPredictiveEcho(opts: {
  write: (data: string) => void
  cols: number
  rows: number
  // Latest broker input→ack SRTT (ms), or null if unknown. The engine prefers
  // this over its own echo-confirmation EWMA so it engages from the first acked
  // keystroke and re-engages promptly when latency spikes. Must be cheap — it's
  // read on every input/output; back it with a polled ref, not an async call.
  getInputSrtt: () => number | null
}): PredictiveEchoHandle {
  const model = new HeadlessScreenModel(opts.cols, opts.rows)
  const engine = new PredictiveEchoEngine({
    model,
    write: opts.write,
    now: () => performance.now(),
    getInputSrtt: opts.getInputSrtt
  })
  return {
    engine,
    dispose: () => {
      engine.reset()
      model.dispose()
    }
  }
}
