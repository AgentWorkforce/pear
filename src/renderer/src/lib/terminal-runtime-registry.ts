// Module-level registry of long-lived xterm runtimes, keyed by agent.
//
// Background: previously the `Terminal` instance lived inside a React
// useEffect. Every tab switch unmounted and remounted the host component,
// which tore down xterm and re-attached + replayed the chunk buffer. While
// the new mount was replaying, the broker kept streaming more bytes into
// the snapshot pipeline — those bytes would be written *again* on the next
// frame, producing the "duplicate text" the user reported.
//
// The fix is to decouple the xterm lifecycle from React: each agent gets a
// runtime that owns its `Terminal`, its addons, its PTY subscription, and
// its parked DOM host. React `mount(container)` calls return ownership
// tokens, and `detach(token)` only parks the host for the current token.
// This lets a newer cross-tree mount win while stale React cleanup no-ops;
// xterm never tears down until the agent is fully released.
//
// Model is based on superset-sh/superset's `terminal-runtime-registry.ts`.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { getAgentKey } from '@/stores/agent-store'
import {
  clearPtyBuffer,
  diagPtyEnabled,
  flushPtyChunksNow,
  getPtyChunks,
  subscribePtyBuffer
} from '@/stores/pty-buffer-store'
import { recordChunkEchoed } from '@/lib/typing-trace'
import { createPredictiveEcho } from '@/lib/predictive-echo'
import type { PredictiveEcho } from '@agent-relay/harness-driver/predictive-echo'
import { awaitFontSettle } from '@/lib/font-settle'
import type { Theme } from '@/stores/ui-store'

const DARK_THEME = {
  background: '#0b1017',
  foreground: '#d7e0ea',
  cursor: '#74b8e2',
  selectionBackground: '#203247',
  black: '#121a24',
  red: '#f0727f',
  green: '#6bd4bc',
  yellow: '#e6d78d',
  blue: '#74b8e2',
  magenta: '#c9a7ff',
  cyan: '#04d1f6',
  white: '#d7e0ea',
  brightBlack: '#64707d',
  brightRed: '#ff8a96',
  brightGreen: '#89e4cb',
  brightYellow: '#f1e5a7',
  brightBlue: '#94cbef',
  brightMagenta: '#dcc6ff',
  brightCyan: '#6fe7ff',
  brightWhite: '#edf4fb'
}

const LIGHT_THEME = {
  background: '#f7fafc',
  foreground: '#111827',
  cursor: '#4a90c2',
  selectionBackground: '#d7e7f4',
  black: '#111827',
  red: '#d95b63',
  green: '#2e9f92',
  yellow: '#c89934',
  blue: '#4a90c2',
  magenta: '#8b72d8',
  cyan: '#2e9f92',
  white: '#f7fafc',
  brightBlack: '#6b7280',
  brightRed: '#ea717a',
  brightGreen: '#4fb4a7',
  brightYellow: '#d8ac4f',
  brightBlue: '#6aa7d2',
  brightMagenta: '#a28ae7',
  brightCyan: '#4fbab0',
  brightWhite: '#ffffff'
}

export function getXtermTheme(theme: Theme): typeof DARK_THEME {
  return theme === 'light' ? LIGHT_THEME : DARK_THEME
}

const TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace"
const IDLE_DISPOSE_MS = 5 * 60_000
const IDLE_SWEEP_MS = 30_000

// Default-on, demoted to DOM after the first webgl failure for the rest of
// the session. We don't recover: if webgl construction blew up once we
// assume the context is unhealthy.
let suggestedRenderer: 'webgl' | 'dom' = 'webgl'

function hasLayout(el: HTMLElement): boolean {
  return el.clientWidth > 0 && el.clientHeight > 0
}

function isViewportPinnedToBottom(term: Terminal): boolean {
  const buffer = term.buffer.active
  return buffer.viewportY === buffer.baseY
}

// Off-DOM parking area for detached runtime hosts. We need them in the
// document so xterm's internal measurements stay valid, but invisible and
// non-interactive while their owning React component is unmounted.
let parkedContainer: HTMLDivElement | null = null

function getParkedContainer(): HTMLDivElement {
  if (parkedContainer && parkedContainer.isConnected) return parkedContainer
  const node = document.createElement('div')
  node.setAttribute('data-pear-terminal-park', 'true')
  node.style.position = 'absolute'
  node.style.width = '0'
  node.style.height = '0'
  node.style.overflow = 'hidden'
  node.style.pointerEvents = 'none'
  node.style.visibility = 'hidden'
  node.setAttribute('aria-hidden', 'true')
  document.body.appendChild(node)
  parkedContainer = node
  return node
}

export interface TerminalRuntime {
  readonly key: string
  readonly term: Terminal
  readonly host: HTMLDivElement
  mount(container: HTMLElement): symbol
  detach(token: symbol): void
  dispose(): void
  isMounted(): boolean
  setTheme(theme: Theme): void
  setTerminalMode(mode: TerminalAttachMode): void
  getTerminalMode(): TerminalAttachMode
  fit(): { rows: number; cols: number } | null
  fitAndSync(): { rows: number; cols: number } | null
  // Redraw the live canvas (e.g. after the host was display:none and is
  // becoming visible again — WebGL doesn't repaint until something forces
  // a refresh).
  refreshOnShow(): void
  // Swap in a fresh getter for the input-SRTT polled by predictive echo.
  // The engine captures its callback at construction, so we trampoline
  // through a runtime-owned slot to allow rebinding on each hook effect.
  setInputSrttGetter(getter: () => number | null): void
  getPredictiveEcho(): PredictiveEcho | null
  // Install a handler for `term.onData`. Returns the previous handler so the
  // caller can re-install it later (e.g. on unmount while keeping the
  // runtime alive). The runtime forwards via an internal mutable slot, so
  // setting null disables forwarding without tearing down the xterm
  // listener.
  setOnData(handler: ((data: string) => void) | null): void
  // Identity-checked clear used by cleanup paths. See implementation.
  clearOnDataIf(handler: (data: string) => void): void
}

interface AcquireOptions {
  projectId: string | undefined
  agentName: string
  terminalMode: TerminalAttachMode
  theme: Theme
  getInputSrtt: () => number | null
}

interface RuntimeRecord {
  runtime: TerminalRuntime
  lastDetachedAt: number | null
}

interface RuntimeLifecycle {
  markMounted(): void
  markDetached(): void
}

const runtimes = new Map<string, RuntimeRecord>()
let idleSweepTimer: ReturnType<typeof setInterval> | null = null

function startIdleSweepTimer(): void {
  if (idleSweepTimer !== null) return
  idleSweepTimer = setInterval(disposeIdleRuntimes, IDLE_SWEEP_MS)
}

function stopIdleSweepTimerIfEmpty(): void {
  if (runtimes.size > 0 || idleSweepTimer === null) return
  clearInterval(idleSweepTimer)
  idleSweepTimer = null
}

function disposeIdleRuntimes(): void {
  const now = Date.now()
  for (const [key, record] of Array.from(runtimes)) {
    if (
      record.lastDetachedAt !== null &&
      now - record.lastDetachedAt > IDLE_DISPOSE_MS
    ) {
      disposeTerminalRuntime(key)
    }
  }
  stopIdleSweepTimerIfEmpty()
}

export function acquireTerminalRuntime(opts: AcquireOptions): TerminalRuntime {
  const key = getAgentKey(opts.projectId, opts.agentName)
  const existingRecord = runtimes.get(key)
  if (existingRecord) {
    startIdleSweepTimer()
    existingRecord.runtime.setTheme(opts.theme)
    existingRecord.runtime.setTerminalMode(opts.terminalMode)
    return existingRecord.runtime
  }
  const record: RuntimeRecord = {
    runtime: null as unknown as TerminalRuntime,
    lastDetachedAt: null
  }
  const runtime = createRuntime(key, opts, {
    markMounted: () => {
      record.lastDetachedAt = null
    },
    markDetached: () => {
      record.lastDetachedAt = Date.now()
    }
  })
  record.runtime = runtime
  runtimes.set(key, record)
  startIdleSweepTimer()
  return runtime
}

export function disposeTerminalRuntime(key: string): void {
  const record = runtimes.get(key)
  if (!record) return
  runtimes.delete(key)
  record.runtime.dispose()
  stopIdleSweepTimerIfEmpty()
}

export function hasTerminalRuntime(key: string): boolean {
  return runtimes.has(key)
}

export function getTerminalRuntime(key: string): TerminalRuntime | null {
  return runtimes.get(key)?.runtime ?? null
}

function createRuntime(
  key: string,
  opts: AcquireOptions,
  lifecycle: RuntimeLifecycle
): TerminalRuntime {
  const host = document.createElement('div')
  host.setAttribute('data-pear-terminal-runtime', key)
  host.style.width = '100%'
  host.style.height = '100%'
  // Park immediately so xterm can attach without React having to provide a
  // container on the first frame.
  getParkedContainer().appendChild(host)

  let term: Terminal | null = new Terminal({
    theme: getXtermTheme(opts.theme),
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0.5,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 3000,
    fastScrollModifier: 'alt',
    macOptionIsMeta: false,
    allowProposedApi: true
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())

  let onDataHandler: ((data: string) => void) | null = null
  term.onData((data) => {
    onDataHandler?.(data)
  })

  // Track current attach mode + theme so re-acquires can update without
  // re-creating the runtime.
  let currentMode: TerminalAttachMode = opts.terminalMode
  let currentTheme: Theme = opts.theme
  let disposed = false
  let currentToken: symbol | null = null
  let webglAddon: WebglAddon | null = null
  let predictiveEcho: PredictiveEcho | null = null
  let disposePredictiveEcho: (() => void) | null = null
  let unsubBuffer: (() => void) | null = null
  let writtenChunks = 0
  let attachSeeded = false
  let attachInFlight = false
  let pendingInitFrame: number | null = null
  // Last rows/cols actually sent to the PTY. fitAndSync drops the IPC when
  // the size hasn't changed — observers fire on every dragged pixel and the
  // backend reacts to no-op resizes by reflowing.
  let lastSentRows = -1
  let lastSentCols = -1
  // Holder for the current input-SRTT getter. The predictive echo engine
  // captures this once on construction, so we wrap it in a trampoline and
  // let setInputSrttGetter swap the underlying getter on each effect run.
  let currentSrttGetter: () => number | null = opts.getInputSrtt

  const cancelPendingInit = (): void => {
    if (pendingInitFrame !== null) {
      cancelAnimationFrame(pendingInitFrame)
      pendingInitFrame = null
    }
  }

  // xterm has only ever been opened into `host`. React containers come and
  // go, but the `host` div is the immutable parent of the xterm canvas.
  // Reparenting `host` between containers (in mount/detach) keeps xterm
  // measuring against the same DOM node it was opened with.
  let opened = false
  const openOnce = (): void => {
    if (!term || opened) return
    if (!hasLayout(host)) return
    term.open(host)
    opened = true
  }

  const tryFit = (): { rows: number; cols: number } | null => {
    if (!term) return null
    const container = host
    if (!hasLayout(container)) return null
    try {
      fitAddon.fit()
    } catch {
      return null
    }
    const { rows, cols } = term
    if (rows > 0 && cols > 0) {
      return { rows, cols }
    }
    return null
  }

  // Lazy-load WebGL on the next frame so the terminal opens with the DOM
  // renderer first (avoiding a hard sync boot on the GPU path) and upgrades
  // only after the first frame paints. If WebGL fails for any reason we
  // demote the whole session to the DOM renderer.
  const loadWebglOnNextFrame = (): void => {
    if (suggestedRenderer === 'dom' || !term) return
    requestAnimationFrame(() => {
      if (!term || disposed || webglAddon) return
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          suggestedRenderer = 'dom'
          try {
            addon.dispose()
          } catch {
            // Disposing an addon whose WebGL context is already lost can throw;
            // we are tearing it down anyway, so there is nothing to recover or report.
          }
          if (webglAddon === addon) webglAddon = null
        })
        term.loadAddon(addon)
        webglAddon = addon
      } catch (err) {
        console.warn('[terminal] WebGL renderer unavailable, falling back to DOM:', err)
        suggestedRenderer = 'dom'
      }
    })
  }

  const seedBufferSubscription = (): void => {
    if (unsubBuffer || !term || disposed) return
    const liveTerm = term

    const writeChunks = (newChunks: string[]): void => {
      if (disposed || !term) return
      if (newChunks.length === 0) return
      // Optional diagnostic, gated on localStorage.PEAR_DIAG_PTY === '1'.
      // See pty-buffer-store.ts for the enable instructions. Flag is
      // cached to avoid a per-batch localStorage read.
      if (diagPtyEnabled()) {
        // eslint-disable-next-line no-console
        console.log(`[diag:runtime:writeChunks] key=${key} count=${newChunks.length} firstPreview="${newChunks[0]?.slice(0, 80).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1b/g, '\\e')}"`)
      }
      const wasPinned = isViewportPinnedToBottom(liveTerm)
      // Typing-trace accounting stays per-chunk: recordChunkEchoed consumes
      // one pending keystroke per call, so coalescing it would under-count.
      for (const chunk of newChunks) recordChunkEchoed(chunk)
      // Coalesce the frame's chunks into a single write. xterm's VT parser is
      // a streaming state machine, so write(a)+write(b) ≡ write(a+b) — for the
      // live terminal AND the predictive-echo headless model (which parses the
      // bytes a second time). One write collapses N parser passes + N model
      // writes + N promise ticks into one. Under heavy TUI redraw streaming
      // that per-chunk fan-out was the drain hot path: the renderer couldn't
      // keep up and input lagged. Byte content and order are unchanged, so the
      // one-write-per-byte invariant holds.
      const combined = newChunks.length === 1 ? newChunks[0] : newChunks.join('')
      if (predictiveEcho) {
        void predictiveEcho.onServerOutput(combined)
      } else {
        liveTerm.write(combined)
      }
      if (wasPinned) liveTerm.scrollToBottom()
    }

    unsubBuffer = subscribePtyBuffer(key, writeChunks)
    // Initial replay: pull whatever is already in the buffer past the
    // snapshot baseline (writtenChunks). The listener only receives tails
    // from this point on, so we have to do the catch-up explicitly here.
    const buffered = getPtyChunks(key)
    if (writtenChunks > buffered.length) writtenChunks = 0
    writeChunks(buffered.slice(writtenChunks))
  }

  const attachAndSeed = async (
    initialSize: { rows: number; cols: number } | null
  ): Promise<void> => {
    if (!term || disposed || attachSeeded || attachInFlight) return
    attachInFlight = true

    let shouldReplay = true
    try {
      const result = await pear.broker.attachTerminal({
        projectId: opts.projectId,
        name: opts.agentName,
        rows: initialSize?.rows,
        cols: initialSize?.cols,
        mode: currentMode
      })
      if (disposed || !term) {
        attachInFlight = false
        return
      }
      if (
        result.snapshot?.screen &&
        hasVisibleTerminalContent(result.snapshot.screen)
      ) {
        term.write(result.snapshot.screen)
        await predictiveEcho?.seed(result.snapshot.screen)
        // Drain any chunks that arrived during the IPC roundtrip but are
        // still staged in pending. Without this, the next rAF would push
        // them into the buffer AFTER we capture writtenChunks, and the
        // subsequent subscribe would replay them on top of the snapshot.
        flushPtyChunksNow(key)
        writtenChunks = getPtyChunks(key).length
        shouldReplay = false
      }
      attachSeeded = true
    } catch (err) {
      console.error('[terminal] attachTerminal failed:', err)
      // Don't latch attachSeeded — the next init/mount cycle should retry.
    } finally {
      attachInFlight = false
    }

    if (disposed || !term) return

    if (shouldReplay) {
      writtenChunks = 0
      await predictiveEcho?.seed('')
    }

    seedBufferSubscription()

    // SIGWINCH bounce: 200ms after attach completes, send a one-pixel
    // size change then back. Some TUIs (notably Ink-based, including
    // Claude Code) cache their row/col count from initial state and
    // only recompute on a winsize *change*. Without this bounce, their
    // cursor-positioning sequences in subsequent redraws can land at
    // the wrong row — the visible failure is each redraw appending to
    // scrollback instead of overwriting in place, producing stacked
    // duplicate cards. The bounce was dropped in Fix #8/#9 as a
    // perceived perf optimization but is load-bearing for this class
    // of TUI. lastSentRows/Cols are intentionally NOT updated for the
    // (rows-1) intermediate, so the second resize re-fires.
    const liveTerm = term
    setTimeout(() => {
      if (disposed || !liveTerm) return
      const { rows, cols } = liveTerm
      if (rows <= 1 || cols <= 0) return
      pear.broker
        .resizePty(opts.projectId, opts.agentName, rows - 1, cols)
        .then(() => {
          if (disposed || !liveTerm) return
          // Re-read dimensions across the async boundary — the user may
          // have resized the pane between the first and second IPC.
          // Sending stale dims would regress the PTY size.
          const currentRows = liveTerm.rows
          const currentCols = liveTerm.cols
          if (currentRows <= 0 || currentCols <= 0) return
          return pear.broker.resizePty(opts.projectId, opts.agentName, currentRows, currentCols)
        })
        .catch(() => {})
    }, 200)
  }

  // Initial open into the parked host. We need the host in the document
  // for xterm's renderers to measure, but layout() inside the parked area
  // returns 0×0. We defer the actual open() + size sync to the first
  // mount() that has real layout.
  // However, xterm's loadAddon(WebglAddon) needs the renderer running and
  // wants the terminal opened first; we therefore lazy-init the
  // GPU/DOM-bound bits in initIfReady, called from mount().

  const initIfReady = async (container: HTMLElement): Promise<void> => {
    if (!term || disposed) return
    if (!hasLayout(container)) {
      // Split-page / hidden-tab mount: the container is 0×0 right now
      // (e.g. display:none). Schedule a retry next frame so we don't sit
      // forever waiting for a mount() that never comes back.
      if (pendingInitFrame !== null) return
      pendingInitFrame = requestAnimationFrame(() => {
        pendingInitFrame = null
        if (disposed) return
        void initIfReady(container)
      })
      return
    }
    cancelPendingInit()

    openOnce()
    let initialSize = tryFit()

    // Spin up predictive echo and SRTT once we have real measurements.
    if (!predictiveEcho) {
      const liveTerm = term
      const handle = createPredictiveEcho({
        write: (data) => liveTerm.write(data),
        cols: term.cols,
        rows: term.rows,
        getInputSrtt: () => currentSrttGetter()
      })
      predictiveEcho = handle.engine
      disposePredictiveEcho = handle.dispose
    }

    loadWebglOnNextFrame()

    // Wait for the actual font to load before locking in cell metrics.
    // If JetBrains Mono lands later the fallback measurement is wrong and
    // glyphs appear smeared until the next resize.
    await awaitFontSettle(TERMINAL_FONT_FAMILY)
    if (disposed || !term) return

    const refitted = tryFit()
    if (refitted) {
      try {
        term.refresh(0, term.rows - 1)
      } catch {
        // A repaint can throw if the term was disposed between scheduling and
        // running this fit; benign for a redraw, nothing to recover.
      }
      // Post-settle metrics may differ from the pre-settle ones the
      // predictor was constructed with. Sync it so column wraps and row
      // counts line up with the real grid.
      predictiveEcho?.onResize(refitted.cols, refitted.rows)
      initialSize = refitted
    }

    if (!attachSeeded) {
      void attachAndSeed(initialSize)
    }
  }

  const runtime: TerminalRuntime = {
    key,
    get term() {
      // We expose `term` as non-null since callers only interact with the
      // runtime while it's alive; dispose() flips a flag and clears it
      // immediately after.
      return term as Terminal
    },
    host,
    mount(container: HTMLElement): symbol {
      if (disposed || !term) return Symbol('disposed')
      lifecycle.markMounted()
      if (host.parentElement !== container) {
        container.appendChild(host)
      }
      const token = Symbol('mount')
      currentToken = token
      // Always run initIfReady so a split-page / hidden-tab mount that
      // landed without layout gets a retry once it becomes visible.
      void initIfReady(container)
      return token
    },
    detach(token: symbol): void {
      if (disposed) return
      if (token !== currentToken) return
      currentToken = null
      lifecycle.markDetached()
      // Cancel any pending initIfReady rAF. Without this, a split-page
      // mount that never gained layout would spin forever against a
      // detached/old container — a permanent rAF loop per parked page.
      cancelPendingInit()
      const park = getParkedContainer()
      if (host.parentElement !== park) {
        park.appendChild(host)
      }
    },
    dispose(): void {
      if (disposed) return
      // Cancel any rAF that would otherwise fire a flush into a disposed
      // terminal. Do this BEFORE flipping `disposed`/nulling `term` so the
      // writeFromBuffer notification triggered by clearPtyBuffer (with [])
      // runs while the closure is still consistent.
      cancelPendingInit()
      clearPtyBuffer(key)
      disposed = true
      currentToken = null
      unsubBuffer?.()
      unsubBuffer = null
      disposePredictiveEcho?.()
      disposePredictiveEcho = null
      predictiveEcho = null
      try {
        webglAddon?.dispose()
      } catch {
        // Teardown: an already-disposed or context-lost WebGL addon can throw
        // on dispose; we null it out next regardless, so silence is correct.
      }
      webglAddon = null
      try {
        term?.dispose()
      } catch {
        // Teardown: disposing an xterm instance twice (or after its host was
        // detached) can throw; we null it out next regardless, so silence is correct.
      }
      term = null
      if (host.parentElement) {
        host.parentElement.removeChild(host)
      }
    },
    isMounted(): boolean {
      return currentToken !== null
    },
    setTheme(theme: Theme): void {
      if (!term) return
      if (currentTheme === theme) return
      currentTheme = theme
      term.options.theme = getXtermTheme(theme)
    },
    setTerminalMode(mode: TerminalAttachMode): void {
      currentMode = mode
    },
    getTerminalMode(): TerminalAttachMode {
      return currentMode
    },
    fit(): { rows: number; cols: number } | null {
      return tryFit()
    },
    fitAndSync(): { rows: number; cols: number } | null {
      const size = tryFit()
      if (size) {
        predictiveEcho?.onResize(size.cols, size.rows)
        // Fix #9: ResizeObserver fires on every dragged pixel; only
        // round-trip to the backend when the cell grid actually changed.
        if (size.rows !== lastSentRows || size.cols !== lastSentCols) {
          lastSentRows = size.rows
          lastSentCols = size.cols
          pear.broker
            .resizePty(opts.projectId, opts.agentName, size.rows, size.cols)
            .catch(() => {})
        }
      }
      return size
    },
    refreshOnShow(): void {
      if (!term || disposed) return
      try {
        term.refresh(0, term.rows - 1)
      } catch {
        // A forced repaint can throw if the term was disposed; benign for a
        // redraw request, nothing to recover.
      }
    },
    setInputSrttGetter(getter: () => number | null): void {
      currentSrttGetter = getter
    },
    getPredictiveEcho(): PredictiveEcho | null {
      return predictiveEcho
    },
    setOnData(handler: ((data: string) => void) | null): void {
      onDataHandler = handler
    },
    // Clear `setOnData(null)` only when the caller's handler reference
    // is still the one currently installed. Cross-tree React commit
    // ordering can fire an old hook's cleanup *after* a new hook
    // already installed its own handler; without this guard the old
    // cleanup wipes the new hook's input forwarding for the still-live
    // mount. Used in place of `setOnData(null)` from cleanup paths.
    clearOnDataIf(handler: (data: string) => void): void {
      if (onDataHandler === handler) onDataHandler = null
    }
  }

  return runtime
}

function hasVisibleTerminalContent(screen: string): boolean {
  const stripped = screen.replace(
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g,
    ''
  )
  return /\S/.test(stripped)
}

// --- Measurement probe (redraw-drain harness) ----------------------------
// Read-only accessor that returns the live xterm viewport text for a mounted
// runtime. Reading the parsed grid (term.buffer) — rather than scraping the
// renderer-specific `.xterm-rows` DOM — lets the redraw-drain harness extract
// the latest rendered frame regardless of whether the DOM or WebGL renderer is
// active in the headless Playwright Chrome. It never mutates terminal state.
//
// Gated on the mock-IPC build flag so it is tree-shaken out of the production
// (Electron) bundle: the harness only runs against the web/mock build served
// by vite.web.config.ts.
export function readRuntimeViewportText(projectId: string | undefined, name: string): string | null {
  const record = runtimes.get(getAgentKey(projectId, name))
  if (!record) return null
  const term = record.runtime.term
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n')
}

if (import.meta.env.VITE_PEAR_MOCK_IPC === 'true' && typeof window !== 'undefined') {
  ;(window as unknown as {
    __pearReadTerminalViewport?: (projectId: string | undefined, name: string) => string | null
  }).__pearReadTerminalViewport = readRuntimeViewportText
}
