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
  dispose(): void
}

export function createEchoRouter(deps: EchoRouterDeps): EchoRouter {
  let route: 'direct' | 'engine' = 'direct'
  let reseedPending = false
  let heldChunks: string[] = []
  let reseedTimeout: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const writePinnedAware = (data: string, sink: (data: string) => void): void => {
    const wasPinned = deps.isViewportPinned()
    sink(data)
    if (wasPinned) deps.scrollToBottom()
  }

  const releaseHeldDirect = (): void => {
    const held = heldChunks
    heldChunks = []
    if (held.length === 0 || disposed) return
    writePinnedAware(held.join(''), (data) => deps.write(data))
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
    // the byte stream consumed so far.
    deps.write('', () => {
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
        writePinnedAware(held.join(''), (data) => void engine.onServerOutput(data))
      }
    })
  }

  return {
    onServerOutput(combined: string): void {
      if (disposed || combined.length === 0) return
      if (reseedPending) {
        heldChunks.push(combined)
        return
      }
      const engine = route === 'engine' ? deps.getEngine() : null
      if (engine) {
        if (combined.length > ENGINE_FLOOD_BYPASS_BYTES && !engine.hasPredictions) {
          // Output flood with nothing predicted on screen: the model
          // double-parse only delays the drain. Drop to direct; the next
          // engaged keystroke reseeds the model before predicting again.
          route = 'direct'
          writePinnedAware(combined, (data) => deps.write(data))
        } else {
          writePinnedAware(combined, (data) => void engine.onServerOutput(data))
        }
      } else {
        writePinnedAware(combined, (data) => deps.write(data))
      }
    },
    onUserInput(data: string): void {
      if (disposed) return
      // While a reseed capture is in flight predictions stay off — the
      // engine's model isn't authoritative yet. Only the optimistic echo is
      // skipped; the keystroke still reaches the PTY via the send path.
      if (reseedPending) return
      const engine = deps.getEngine()
      if (!engine) return
      if (route === 'engine') {
        engine.onUserInput(data)
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
    dispose(): void {
      disposed = true
      reseedPending = false
      heldChunks = []
      if (reseedTimeout) {
        clearTimeout(reseedTimeout)
        reseedTimeout = null
      }
    }
  }
}
