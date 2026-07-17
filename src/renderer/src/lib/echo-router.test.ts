// Real-engine equivalence tests for the echo router.
//
// The router decides whether server bytes reach the live terminal directly
// or through the predictive-echo engine, and owns the direct→engine
// transition (model reseed at a write-queue quiescent point, with chunks
// held during the capture). The property every scenario must preserve: the
// final screen TEXT equals a reference terminal fed the same byte stream in
// one write — across route flips, held-chunk windows, flood bypasses, and
// reseed aborts. Runs against the REAL PredictiveEchoEngine and the REAL
// xterm VT parser (@xterm/headless), so an engine or parser behavior change
// that breaks the routing assumptions fails here, not on a user's screen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  PredictiveEchoEngine,
  type ScreenModel
} from '@agent-relay/harness-driver/predictive-echo'
import {
  buildModelSeedFromTerminal,
  createEchoRouter,
  ENGINE_FLOOD_BYPASS_BYTES,
  PREDICTION_QUIET_MS,
  RESEED_CAPTURE_TIMEOUT_MS,
  type EchoRouter,
  type SeedSource
} from './echo-router'
import type { PredictiveEchoWithStatus } from './predictive-echo'

const ROWS = 24
const COLS = 80

class HeadlessModel implements ScreenModel {
  private readonly term: Terminal
  // Test hook: when set, model bytes sit in a backlog for this many ms
  // BEFORE being parsed — the model's cursor/rows stay stale meanwhile.
  // This is what a busy renderer looks like: xterm's WriteBuffer queues
  // the chunk and the parse (cursor advance included) happens ticks later.
  writeDelayMs = 0

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
  }

  write(data: string): Promise<void> {
    if (this.writeDelayMs <= 0) {
      return new Promise<void>((resolve) => this.term.write(data, resolve))
    }
    const delay = this.writeDelayMs
    return new Promise<void>((resolve) =>
      setTimeout(() => this.term.write(data, resolve), delay)
    )
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

function readScreen(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < term.rows; i += 1) {
    const line = buf.getLine(buf.baseY + i)
    lines.push((line ? line.translateToString(true) : '').replace(/[ \t]+$/, ''))
  }
  return lines.join('\n')
}

function drain(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write('', () => resolve()))
}

function buildRedrawFrame(frame: number): string {
  let out = '\x1b[H'
  for (let r = 1; r <= ROWS; r += 1) {
    out += `\x1b[${r};1H\x1b[2K\x1b[36mframe ${frame
      .toString()
      .padStart(3, '0')} row ${r.toString().padStart(2, '0')}\x1b[0m`
  }
  return out
}

interface Harness {
  router: EchoRouter
  live: Terminal
  engine: PredictiveEchoEngine
  model: HeadlessModel
  setSrtt(value: number | null): void
  disposeEngine(): void
  dispose(): Promise<void>
}

function makeHarness(): Harness {
  const live = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  const model = new HeadlessModel(COLS, ROWS)
  let srtt: number | null = null
  const engine = new PredictiveEchoEngine({
    model,
    write: (data: string) => {
      live.write(data)
    },
    now: () => performance.now(),
    getInputSrtt: () => srtt
  })
  const router = createEchoRouter({
    write: (data, callback) => live.write(data, callback),
    getEngine: () => engine as unknown as PredictiveEchoWithStatus,
    buildModelSeed: () => buildModelSeedFromTerminal(live as unknown as SeedSource),
    getInputSrtt: () => srtt,
    isViewportPinned: () => false,
    scrollToBottom: () => {}
  })
  let engineDisposed = false
  let disposePromise: Promise<void> | null = null
  const disposeEngine = (): void => {
    if (engineDisposed) return
    engineDisposed = true
    engine.reset()
  }
  return {
    router,
    live,
    engine,
    model,
    setSrtt: (value) => {
      srtt = value
    },
    disposeEngine,
    dispose: () => {
      if (!disposePromise) {
        disposePromise = router.dispose().then(() => {
          disposeEngine()
          live.dispose()
        })
      }
      return disposePromise
    }
  }
}

// Settle the engine's internal promise chain AND the live terminal's write
// queue (each engine step enqueues live writes; interleave a few rounds).
async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await h.engine.onServerOutput('')
    await drain(h.live)
  }
}

async function reference(stream: string): Promise<string> {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(stream, () => resolve()))
  const screen = readScreen(term)
  term.dispose()
  return screen
}

// Predictions require the stream to have been quiet; streaming-sized chunks
// arm a real-time window (Date.now-based).
function waitForQuietWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PREDICTION_QUIET_MS + 50))
}

describe('echo-router — real engine + real parser equivalence', () => {
  let harness: Harness

  beforeEach(() => {
    harness = makeHarness()
  })

  afterEach(async () => {
    await harness.dispose()
  })

  it('starts on the direct route and passes bytes through byte-for-byte', async () => {
    const frames = [1, 2, 3].map(buildRedrawFrame)
    for (const frame of frames) harness.router.onServerOutput(frame)
    await settle(harness)

    expect(harness.router.route()).toBe('direct')
    expect(readScreen(harness.live)).toBe(await reference(frames.join('')))
  })

  it('stays direct (no engine work, no transition) while latency is low', async () => {
    harness.setSrtt(5)
    const seedSpy = vi.spyOn(harness.engine, 'seed')
    const outputSpy = vi.spyOn(harness.engine, 'onServerOutput')

    harness.router.onUserInput('a')
    harness.router.onServerOutput(buildRedrawFrame(1))
    await drain(harness.live)

    expect(harness.router.route()).toBe('direct')
    expect(seedSpy).not.toHaveBeenCalled()
    expect(outputSpy).not.toHaveBeenCalled()
  })

  it('transitions to the engine route on an engaged keystroke and preserves the screen, including chunks held during the capture', async () => {
    const pre = [1, 2].map(buildRedrawFrame)
    for (const frame of pre) harness.router.onServerOutput(frame)

    // Latency spike → keystroke triggers the transition. Chunks that arrive
    // while the quiescent-point capture is in flight are held and must land
    // exactly once. (Transition requires a quiet stream.)
    await waitForQuietWindow()
    harness.setSrtt(80)
    harness.router.onUserInput('x')
    const during = [3, 4].map(buildRedrawFrame)
    for (const frame of during) harness.router.onServerOutput(frame)

    await drain(harness.live) // capture callback fires in write-queue order
    await settle(harness)

    expect(harness.router.route()).toBe('engine')
    const post = buildRedrawFrame(5)
    harness.router.onServerOutput(post)
    await settle(harness)

    expect(readScreen(harness.live)).toBe(
      await reference([...pre, ...during, post].join(''))
    )
  })

  it('renders a correct optimistic prediction after the transition reseed', async () => {
    // Paint a prompt, cursor parked at end of row 0.
    harness.router.onServerOutput('\x1b[2J\x1b[H$ ')
    harness.setSrtt(80)
    harness.router.onUserInput('q') // triggers transition; no prediction yet
    await drain(harness.live)
    await settle(harness)
    expect(harness.router.route()).toBe('engine')

    // Now predictions are live against the reseeded model.
    harness.router.onUserInput('a')
    await settle(harness)
    expect((harness.engine as PredictiveEchoEngine).hasPredictions).toBe(true)
    expect(readScreen(harness.live).split('\n')[0]).toBe('$ a')

    // Authoritative echo confirms the glyph; the screen text is unchanged.
    harness.router.onServerOutput('a')
    await settle(harness)
    expect(readScreen(harness.live).split('\n')[0]).toBe('$ a')
  })

  it('drops back to direct on an output flood with no outstanding predictions', async () => {
    harness.setSrtt(80)
    harness.router.onUserInput('x')
    await drain(harness.live)
    await settle(harness)
    expect(harness.router.route()).toBe('engine')

    // A flood frame larger than the bypass threshold with nothing predicted.
    let flood = ''
    let i = 0
    while (flood.length <= ENGINE_FLOOD_BYPASS_BYTES) {
      flood += buildRedrawFrame(i % 1000)
      i += 1
    }
    harness.router.onServerOutput(flood)
    await settle(harness)

    expect(harness.router.route()).toBe('direct')
    expect(readScreen(harness.live)).toBe(await reference(flood))
  })

  it('rolls back on-screen predictions when streaming starts and stays byte-faithful', async () => {
    harness.router.onServerOutput('\x1b[2J\x1b[H$ ')
    harness.setSrtt(80)
    harness.router.onUserInput('q')
    await drain(harness.live)
    await settle(harness)
    harness.router.onUserInput('a') // outstanding prediction
    await settle(harness)
    expect((harness.engine as PredictiveEchoEngine).hasPredictions).toBe(true)

    let flood = ''
    let i = 0
    while (flood.length <= ENGINE_FLOOD_BYPASS_BYTES) {
      flood += buildRedrawFrame(i % 1000)
      i += 1
    }
    harness.router.onServerOutput(flood)
    await settle(harness)

    // Streaming started with a glyph on screen: the router rolled it back
    // at still-valid positions instead of letting the engine erase/repaint
    // it around every frame. The screen equals pure pass-through of the
    // confirmed bytes, and no prediction survives the storm.
    expect((harness.engine as PredictiveEchoEngine).hasPredictions).toBe(false)
    expect(readScreen(harness.live)).toBe(
      await reference('\x1b[2J\x1b[H$ ' + flood)
    )

    // New keystrokes during the active stream stay prediction-free.
    harness.router.onUserInput('b')
    await settle(harness)
    expect((harness.engine as PredictiveEchoEngine).hasPredictions).toBe(false)
    expect(readScreen(harness.live)).toBe(
      await reference('\x1b[2J\x1b[H$ ' + flood)
    )
  })

  it('preserves byte order when a flood bypass races chunks still queued in the engine tail', async () => {
    // The interleaved-rows corruption class: chunk B is queued inside the
    // engine's async tail (model write of A still in flight) when flood
    // chunk C trips the bypass. A direct write of C MUST NOT overtake B —
    // out-of-order bytes shear escape sequences and overlay row text.
    harness.setSrtt(80)
    harness.router.onUserInput('x')
    await drain(harness.live)
    await settle(harness)
    expect(harness.router.route()).toBe('engine')

    harness.model.writeDelayMs = 30 // back up the engine tail
    const a = buildRedrawFrame(1)
    const b = buildRedrawFrame(2)
    let flood = ''
    let i = 0
    while (flood.length <= ENGINE_FLOOD_BYPASS_BYTES) {
      flood += buildRedrawFrame(100 + (i % 100))
      i += 1
    }
    harness.router.onServerOutput(a)
    harness.router.onServerOutput(b) // queued behind A's slow model write
    harness.router.onServerOutput(flood) // bypass: must still land after B

    await new Promise((resolve) => setTimeout(resolve, 250))
    harness.model.writeDelayMs = 0
    await settle(harness)

    expect(readScreen(harness.live)).toBe(await reference(a + b + flood))
  })

  it('drains accepted engine bytes before v10 reset can discard them', async () => {
    harness.setSrtt(80)
    harness.router.onUserInput('x')
    await drain(harness.live)
    await settle(harness)
    expect(harness.router.route()).toBe('engine')

    // Back up the real v10 engine tail, enqueue authoritative bytes, then
    // begin teardown immediately. v10 reset drops a chunk whose processing
    // has not started, so this assertion fails unless router.dispose waits for
    // its accepted ordering chain before the owner resets the engine.
    harness.model.writeDelayMs = 30
    const chunk = '\x1b[2J\x1b[Hqueued-before-dispose'
    harness.router.onServerOutput(chunk)
    await harness.router.dispose()
    harness.disposeEngine()
    await drain(harness.live)

    expect(readScreen(harness.live)).toBe(await reference(chunk))
  })

  it('skips optimistic echo while a chunk is mid-flight in the engine tail (stale-cursor strand)', async () => {
    // Get on the engine route with a prompt at row 0.
    harness.router.onServerOutput('\x1b[2J\x1b[H$ ')
    harness.setSrtt(80)
    harness.router.onUserInput('q')
    await drain(harness.live)
    await settle(harness)
    expect(harness.router.route()).toBe('engine')

    // Back up the model parse, deliver a chunk that moves the cursor to a
    // new row, and type while that chunk's model parse is still backlogged.
    // The live terminal already shows the chunk (pass-through precedes the
    // model parse) but the model cursor is still on the OLD row — a
    // prediction placed now renders at the stale row, overwriting real
    // content, and the engine's cleanup skips erasing glyphs whose row no
    // longer matches its prediction row, stranding them on screen.
    harness.model.writeDelayMs = 30
    harness.router.onServerOutput('hello\r\nworld$ ')
    // Let the op start (live write issued, model parse backlogged) …
    await new Promise((resolve) => setTimeout(resolve, 5))
    harness.router.onUserInput('a') // mid-flight: optimistic echo must be skipped
    harness.model.writeDelayMs = 0
    await new Promise((resolve) => setTimeout(resolve, 80))
    await settle(harness)
    expect((harness.engine as PredictiveEchoEngine).hasPredictions).toBe(false)

    // The authoritative echo arrives later and lands at the real cursor.
    harness.router.onServerOutput('a')
    await settle(harness)

    expect(readScreen(harness.live)).toBe(
      await reference('\x1b[2J\x1b[H$ hello\r\nworld$ a')
    )
  })

  it('re-engages predictions after a flood bypass via a fresh reseed', async () => {
    harness.setSrtt(80)
    harness.router.onUserInput('x')
    await drain(harness.live)
    await settle(harness)

    let flood = ''
    let i = 0
    while (flood.length <= ENGINE_FLOOD_BYPASS_BYTES) {
      flood += buildRedrawFrame(i % 1000)
      i += 1
    }
    harness.router.onServerOutput(flood)
    await settle(harness)
    expect(harness.router.route()).toBe('direct')

    // Paint a fresh prompt directly (model is stale now), wait out the
    // streaming quiet window, then type.
    harness.router.onServerOutput('\x1b[2J\x1b[H$ ')
    await waitForQuietWindow()
    harness.router.onUserInput('q') // reseeds from the live screen
    await drain(harness.live)
    await settle(harness)
    expect(harness.router.route()).toBe('engine')

    harness.router.onUserInput('z')
    await settle(harness)
    expect(readScreen(harness.live).split('\n')[0]).toBe('$ z')
  })
})

describe('echo-router — reseed capture timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts a stalled capture, releases held chunks directly, and stays direct', async () => {
    const written: string[] = []
    const engine = {
      seed: vi.fn(() => Promise.resolve()),
      onUserInput: vi.fn(),
      onServerOutput: vi.fn(() => Promise.resolve()),
      rollback: vi.fn(),
      onResize: vi.fn(),
      reset: vi.fn(),
      hasPredictions: false
    } satisfies PredictiveEchoWithStatus

    const router = createEchoRouter({
      // Never invoke the capture callback — a stalled live terminal.
      write: (data) => {
        if (data) written.push(data)
      },
      getEngine: () => engine,
      buildModelSeed: () => '\x1bc',
      getInputSrtt: () => 80,
      isViewportPinned: () => false,
      scrollToBottom: () => {}
    })

    router.onUserInput('a') // begins the transition; capture never completes
    router.onServerOutput('held-1')
    router.onServerOutput('held-2')
    expect(written).toEqual([]) // held while the capture is pending

    vi.advanceTimersByTime(RESEED_CAPTURE_TIMEOUT_MS)
    expect(written).toEqual(['held-1held-2'])
    expect(router.route()).toBe('direct')
    expect(engine.seed).not.toHaveBeenCalled()

    // Later output flows normally on the direct route.
    router.onServerOutput('after')
    expect(written).toEqual(['held-1held-2', 'after'])
    await router.dispose()
  })

  it('releases held chunks directly when the engine changes during the capture', async () => {
    const written: string[] = []
    let captureCallback: (() => void) | null = null
    const makeEngine = (): PredictiveEchoWithStatus => ({
      seed: vi.fn(() => Promise.resolve()),
      onUserInput: vi.fn(),
      onServerOutput: vi.fn(() => Promise.resolve()),
      rollback: vi.fn(),
      onResize: vi.fn(),
      reset: vi.fn(),
      hasPredictions: false
    })
    let engine = makeEngine()
    const firstEngine = engine

    const router = createEchoRouter({
      write: (data, callback) => {
        if (callback) captureCallback = callback
        else if (data) written.push(data)
      },
      getEngine: () => engine,
      buildModelSeed: () => '\x1bc',
      getInputSrtt: () => 80,
      isViewportPinned: () => false,
      scrollToBottom: () => {}
    })

    router.onUserInput('a') // begins the transition
    router.onServerOutput('held-1')
    router.onServerOutput('held-2')

    // The engine is swapped out before the capture completes; the held
    // bytes are live PTY output and must still render.
    engine = makeEngine()
    captureCallback?.()

    expect(written).toEqual(['held-1held-2'])
    expect(router.route()).toBe('direct')
    expect(firstEngine.seed).not.toHaveBeenCalled()
    expect(engine.seed).not.toHaveBeenCalled()
    await router.dispose()
  })

  it('dispose flushes held chunks and cancels the capture timeout', async () => {
    const written: string[] = []
    const router = createEchoRouter({
      write: (data) => {
        if (data) written.push(data)
      },
      getEngine: () => ({
        seed: () => Promise.resolve(),
        onUserInput: () => {},
        onServerOutput: () => Promise.resolve(),
        rollback: () => {},
        onResize: () => {},
        reset: () => {},
        hasPredictions: false
      }),
      buildModelSeed: () => '\x1bc',
      getInputSrtt: () => 80,
      isViewportPinned: () => false,
      scrollToBottom: () => {}
    })

    router.onUserInput('a')
    router.onServerOutput('held')
    await router.dispose()
    vi.advanceTimersByTime(RESEED_CAPTURE_TIMEOUT_MS * 2)
    expect(written).toEqual(['held'])
  })
})

// pear#403: on the direct route the viewport re-pin must fire from the write
// COMPLETION callback (after xterm parses the chunk), not synchronously before
// it. term.write is async: a chunk can scroll the viewport off the bottom
// during its own parse (a TUI SIGWINCH full-screen redraw rewrites scrollback
// and resets ydisp). A synchronous scrollToBottom issued before that parse is
// undone by it; the viewport is then stranded off-bottom, isViewportPinned()
// reads false, and every later chunk stops re-pinning — the grid freezes in
// scrollback with byte-correct content (codex resize-mid-stream, viewport
// [0,baseY] at quiet). These lock the post-parse re-pin, gated on the
// pre-write follow intent so a deliberate scrollback read is never yanked down.
describe('echo-router — #403 direct-route viewport re-pin after parse', () => {
  function makeRepinHarness() {
    const writes: string[] = []
    let pendingCb: (() => void) | null = null
    let pinned = true
    const scrollToBottom = vi.fn()
    const router = createEchoRouter({
      // Defer the completion callback so the test controls the parse boundary,
      // exactly like xterm's async WriteBuffer.
      write: (data, callback) => {
        writes.push(data)
        pendingCb = callback ?? null
      },
      getEngine: () => null,
      buildModelSeed: () => '\x1bc',
      getInputSrtt: () => null,
      isViewportPinned: () => pinned,
      scrollToBottom
    })
    return {
      router,
      writes,
      scrollToBottom,
      setPinned: (value: boolean) => {
        pinned = value
      },
      completeParse: () => {
        const cb = pendingCb
        pendingCb = null
        cb?.()
      }
    }
  }

  it('re-pins only AFTER the chunk is parsed, never synchronously before it', async () => {
    const h = makeRepinHarness()
    // A full-screen redraw: the kind of chunk whose parse moves the viewport.
    h.router.onServerOutput('\x1b[2J\x1b[Hfull redraw at new size')
    // Write issued, parse not yet complete → a synchronous (pre-parse) re-pin
    // would already have fired here. It must not.
    expect(h.writes).toHaveLength(1)
    expect(h.scrollToBottom).not.toHaveBeenCalled()
    // Parse completes (viewport may now be off-bottom); the completion callback
    // re-pins, so the stranding cascade never starts.
    h.completeParse()
    expect(h.scrollToBottom).toHaveBeenCalledTimes(1)
    await h.router.dispose()
  })

  it('does not re-pin when the user has scrolled into scrollback', async () => {
    const h = makeRepinHarness()
    h.setPinned(false)
    h.router.onServerOutput('another streamed row\r\n')
    h.completeParse()
    expect(h.scrollToBottom).not.toHaveBeenCalled()
    await h.router.dispose()
  })
})
