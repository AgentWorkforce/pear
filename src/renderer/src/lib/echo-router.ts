// Echo routing between the live terminal and the predictive-echo engine.
//
// The predictive-echo engine parses every server byte a second time into its
// headless confirmed model. On a fast local link the engine never engages
// (it needs >= PREDICTION_ENGAGE_THRESHOLD_MS echo SRTT), so that second
// parse is pure overhead — under heavy multi-agent streaming it is renderer
// main-thread time stolen from keystroke echo (the "typing lag" class).
//
// Server output therefore flows DIRECT to the terminal until measured
// latency says predictions are worth having. The direct→engine transition
// must not let the engine predict against a stale model: it reseeds the
// model from the live screen at a write-queue quiescent point (an empty
// write's callback fires only after everything already queued has parsed),
// holding any chunks that arrive during the capture so every byte lands
// either in the captured seed or in the model replay — exactly once, never
// both, never neither.
//
// Invariant that must hold for any input sequence: the bytes reaching the
// live terminal are exactly the bytes received, in order (the engine's own
// pass-through guarantees this on the engine route). The equivalence tests
// in echo-router.test.ts assert this against the real engine + real parser.

import type { PredictiveEchoWithStatus } from '@/lib/predictive-echo'

// Mirrors the engine's DEFAULT_PREDICTION_CONFIG.engageThresholdMs.
export const PREDICTION_ENGAGE_THRESHOLD_MS = 30
// Predictions are a quiet-prompt tool (mosh's regime: you type, the line
// echoes back). While a TUI is actively streaming repaint frames, the engine
// would erase/re-render its optimistic glyphs around EVERY frame — any
// model/live divergence then erases real rows and strands glyphs inside
// repainted panels (the interleaved-rows corruption class). So: a server
// chunk bigger than PREDICTION_SAFE_CHUNK_BYTES marks the stream "active",
// outstanding predictions are rolled back at that moment, and no new
// predictions render until the stream has been quiet for
// PREDICTION_QUIET_MS. Keystroke echo (tiny chunks) never trips this.
export const PREDICTION_SAFE_CHUNK_BYTES = 1_024
export const PREDICTION_QUIET_MS = 300
// On the engine route, one coalesced frame bigger than this with no
// outstanding predictions drops back to direct: during output floods the
// model double-parse only adds drain time, and there is nothing on screen
// for the engine to reconcile.
export const ENGINE_FLOOD_BYPASS_BYTES = 32_768
// Reseed capture safety net: if the live terminal's write callback hasn't
// fired by then (disposed mid-flight, renderer stalled), abort the
// transition and release any held chunks directly.
export const RESEED_CAPTURE_TIMEOUT_MS = 1_000

// Structural slice of an xterm Terminal sufficient to rebuild the engine's
// confirmed-model state: full reset, alt-screen flag, viewport row text,
// cursor position. The model only ever reads text/cursor/alt-screen (never
// colors), so this is sufficient fidelity for safe predictions. Accepting
// the slice (rather than Terminal) lets tests drive @xterm/headless.
export interface SeedSource {
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly type: string
      readonly cursorX: number
      readonly cursorY: number
      readonly baseY: number
      getLine(y: number): { translateToString(trimRight: boolean): string } | undefined
    }
  }
}

export function buildModelSeedFromTerminal(term: SeedSource): string {
  const buffer = term.buffer.active
  let seed = '\x1bc'
  if (buffer.type === 'alternate') seed += '\x1b[?1049h'
  const lines: string[] = []
  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    lines.push(line ? line.translateToString(true) : '')
  }
  seed += lines.join('\r\n')
  seed += `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`
  return seed
}

export interface EchoRouterDeps {
  // Write to the live terminal. The optional callback fires after the data
  // (and everything queued before it) has been parsed.
  write(data: string, callback?: () => void): void
  // The engine, or null while it hasn't been constructed yet.
  getEngine(): PredictiveEchoWithStatus | null
  buildModelSeed(): string
  getInputSrtt(): number | null
  isViewportPinned(): boolean
  scrollToBottom(): void
}

export interface EchoRouter {
  // One coalesced frame of server output. Owns the pinned-viewport scroll.
  onServerOutput(combined: string): void
  // User keystrokes destined for the PTY (visual echo only — the input send
  // path is independent).
  onUserInput(data: string): void
  // Which sink server bytes currently take. Exposed for tests/diagnostics.
  route(): 'direct' | 'engine'
  // Stop accepting new work and resolve only after every already-accepted
  // server byte has reached the live terminal. Callers must await this before
  // resetting the v10 engine, whose reset discards queued server output.
  dispose(): Promise<void>
}

export function createEchoRouter(deps: EchoRouterDeps): EchoRouter {
  let route: 'direct' | 'engine' = 'direct'
  let reseedPending = false
  let heldChunks: string[] = []
  let reseedTimeout: ReturnType<typeof setTimeout> | null = null
  let closing = false
  let disposed = false
  let disposePromise: Promise<void> | null = null

  // Single ordering domain for everything that reaches the live terminal.
  // Engine writes happen inside the engine's ASYNC tail (its model parse
  // awaits between chunks), so a direct write issued while engine work is
  // still queued — e.g. a flood-bypass route flip — would overtake bytes
  // that arrived earlier. Out-of-order bytes shear escape sequences and
  // overlay row text (character-interleaved lines). Any operation enqueued
  // while the chain is non-empty chains behind it; the chain collapses back
  // to synchronous direct writes once it drains.
  let queuedOps = 0
  let opChain: Promise<void> = Promise.resolve()

  const enqueueOp = (op: () => Promise<void> | void): void => {
    queuedOps += 1
    opChain = opChain
      .then(() => (disposed ? undefined : op()))
      .catch(() => {})
      .then(() => {
        queuedOps -= 1
      })
  }

  const writePinnedAware = (data: string, sink: (data: string) => void): void => {
    const wasPinned = deps.isViewportPinned()
    sink(data)
    if (wasPinned) deps.scrollToBottom()
  }

  // Engine route: always enqueued (the engine's tail is asynchronous).
  const writeViaEngine = (engine: PredictiveEchoWithStatus, data: string): void => {
    enqueueOp(() => {
      if (deps.getEngine() !== engine) {
        // Engine torn down while queued; the bytes still must render.
        writePinnedAware(data, (chunk) => deps.write(chunk))
        return
      }
      let done: Promise<void> = Promise.resolve()
      writePinnedAware(data, (chunk) => {
        done = engine.onServerOutput(chunk)
      })
      return done
    })
  }

  // Direct route: synchronous while the chain is empty (the common case —
  // zero overhead on local sessions), ordered behind it otherwise.
  const writeDirectOrdered = (data: string, callback?: () => void): void => {
    if (queuedOps === 0) {
      writePinnedAware(data, (chunk) => deps.write(chunk, callback))
      return
    }
    enqueueOp(() => {
      writePinnedAware(data, (chunk) => deps.write(chunk, callback))
    })
  }

  const releaseHeldDirect = (): void => {
    const held = heldChunks
    heldChunks = []
    if (held.length === 0 || disposed) return
    writeDirectOrdered(held.join(''))
  }

  const beginEngineTransition = (): void => {
    const engine = deps.getEngine()
    if (disposed || reseedPending || !engine) return
    reseedPending = true
    heldChunks = []
    reseedTimeout = setTimeout(() => {
      reseedTimeout = null
      if (!reseedPending) return
      // Capture never completed — stay on the direct route; a later
      // keystroke retries the transition.
      reseedPending = false
      releaseHeldDirect()
    }, RESEED_CAPTURE_TIMEOUT_MS)
    // Quiescent-point capture: the callback fires after everything already
    // queued to the live terminal has parsed, so the visible grid equals
    // the byte stream consumed so far. Ordered, so it also lands after any
    // writes still chained from a recent flood bypass.
    writeDirectOrdered('', () => {
      if (!reseedPending) return // timed out and aborted
      reseedPending = false
      if (reseedTimeout) {
        clearTimeout(reseedTimeout)
        reseedTimeout = null
      }
      if (disposed) {
        heldChunks = []
        return
      }
      if (deps.getEngine() !== engine) {
        // The engine changed mid-transition (today only possible via
        // dispose, but defend anyway): the terminal is still live, so the
        // held bytes must render — release them directly and stay on the
        // direct route rather than dropping live PTY output.
        releaseHeldDirect()
        return
      }
      void engine.seed(deps.buildModelSeed())
      route = 'engine'
      const held = heldChunks
      heldChunks = []
      if (held.length > 0) {
        writeViaEngine(engine, held.join(''))
      }
    })
  }

  // Timestamp of the last streaming-sized server chunk. 0 = never.
  let lastStreamOutputAt = 0
  const streamIsActive = (): boolean =>
    lastStreamOutputAt !== 0 && Date.now() - lastStreamOutputAt < PREDICTION_QUIET_MS

  return {
    onServerOutput(combined: string): void {
      if (closing || disposed || combined.length === 0) return
      if (reseedPending) {
        heldChunks.push(combined)
        return
      }
      const streamingChunk = combined.length > PREDICTION_SAFE_CHUNK_BYTES
      if (streamingChunk) lastStreamOutputAt = Date.now()
      const engine = route === 'engine' ? deps.getEngine() : null
      if (engine) {
        if (streamingChunk && engine.hasPredictions) {
          // The TUI started streaming with optimistic glyphs on screen.
          // Erase them NOW, at positions that are still valid, instead of
          // letting the engine erase/re-render them around every repaint
          // frame — that cycle is what strands glyphs inside repainted
          // panels and erases real rows when model and live drift.
          enqueueOp(() => {
            if (deps.getEngine() === engine) engine.rollback()
          })
        }
        if (combined.length > ENGINE_FLOOD_BYPASS_BYTES && !engine.hasPredictions) {
          // Output flood with nothing predicted on screen: the model
          // double-parse only delays the drain. Drop to direct; the next
          // engaged keystroke reseeds the model before predicting again.
          // Ordered: this write chains behind chunks still queued in the
          // engine's tail — overtaking them would interleave row bytes.
          route = 'direct'
          writeDirectOrdered(combined)
        } else {
          writeViaEngine(engine, combined)
        }
      } else {
        writeDirectOrdered(combined)
      }
    },
    onUserInput(data: string): void {
      if (closing || disposed) return
      // While a reseed capture is in flight predictions stay off — the
      // engine's model isn't authoritative yet. Only the optimistic echo is
      // skipped; the keystroke still reaches the PTY via the send path.
      if (reseedPending) return
      // Predictions stay off while the server is actively streaming — the
      // user sees output flowing (their echo included); optimistic glyphs
      // only add an erase/re-render cycle per repaint frame.
      if (streamIsActive()) return
      const engine = deps.getEngine()
      if (!engine) return
      if (route === 'engine') {
        // Only hand keystrokes to the engine at a chain-quiescent point.
        // The engine places optimistic glyphs by reading its confirmed
        // model's cursor SYNCHRONOUSLY, but while ops are queued a server
        // chunk has already reached the live terminal whose model parse is
        // still in flight — the model cursor is stale. A prediction placed
        // then renders on the wrong row, and the engine's cleanup skips
        // erasing glyphs whose row no longer matches its prediction row,
        // stranding them on screen (the stacked-frame-remnant / displaced-
        // echo corruption class). Skipping only costs the optimistic echo;
        // the keystroke still reaches the PTY and echoes back.
        if (queuedOps === 0) engine.onUserInput(data)
        return
      }
      const srtt = deps.getInputSrtt()
      if (srtt === null || srtt < PREDICTION_ENGAGE_THRESHOLD_MS) return
      // Latency crossed the engage threshold while on the direct route:
      // bring the engine's model up to date, then let predictions resume.
      beginEngineTransition()
    },
    route(): 'direct' | 'engine' {
      return route
    },
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise
      closing = true
      reseedPending = false
      if (reseedTimeout) {
        clearTimeout(reseedTimeout)
        reseedTimeout = null
      }
      // A direct→engine capture may be holding accepted server chunks outside
      // opChain. Queue them on the direct sink before sealing the chain.
      releaseHeldDirect()
      disposePromise = opChain.then(() => {
        disposed = true
      })
      return disposePromise
    }
  }
}
