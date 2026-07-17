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
  getPtyChunkTotal,
  getPtyChunksAfterOffset,
  getPtyChunksSinceTotal,
  subscribePtyBuffer
} from '@/stores/pty-buffer-store'
import { recordChunkEchoed } from '@/lib/typing-trace'
import { createPredictiveEcho, type PredictiveEchoWithStatus } from '@/lib/predictive-echo'
import { createPtySizeSync } from '@/lib/pty-size-sync'
import { buildModelSeedFromTerminal, createEchoRouter } from '@/lib/echo-router'
import { createTerminalReconciler, RECONCILE_QUIET_MS } from '@/lib/terminal-reconciler'
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
// Outstanding optimistic-echo predictions close the reconciler's quiet gate
// (the screen comparison would see unconfirmed glyphs). But a prediction is
// only ever confirmed or dropped by server output — if none arrives for this
// long, the echo is never coming (keystroke swallowed by the TUI, or typed
// into a hung agent) and the gate would stay closed FOREVER, silently
// disabling the convergence backstop. Rolling back only erases the
// optimistic glyphs; confirmed bytes are untouched, and a real echo that
// arrives later repaints the characters authoritatively.
export const STRANDED_PREDICTION_ROLLBACK_MS = 10_000

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
  // Forward user keystrokes for optimistic echo. Routes through the
  // predictive-echo engine only when measured latency warrants predictions,
  // transitioning (and reseeding the engine's confirmed model) on demand.
  noteUserInput(data: string): void
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
  cli?: string
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

  // #403: sticky "user is following the bottom" intent. The instantaneous
  // `viewportY === baseY` is NOT a reliable follow signal: a width/height
  // reflow (resize) or a TUI's SIGWINCH full-screen redraw can transiently
  // scroll the viewport off the bottom, and once it is off, that instantaneous
  // check reads false, so every subsequent write/fit stops re-pinning and the
  // grid freezes in scrollback with byte-correct content (codex
  // resize-mid-stream: viewport ends at [0, baseY] though every cell matches
  // the broker). `followBottom` is flipped ONLY by a real user wheel scroll, so
  // reflow/redraw unpins are always corrected while a deliberate scrollback
  // read is respected. The echo-router and tryFit re-pin against this intent.
  let followBottom = true
  host.addEventListener(
    'wheel',
    () => {
      // Read after xterm has applied the scroll, so a wheel-to-bottom re-arms
      // following and a wheel-up (into scrollback) suspends it.
      requestAnimationFrame(() => {
        if (term) followBottom = isViewportPinnedToBottom(term)
      })
    },
    { passive: true }
  )

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
  let predictiveEcho: PredictiveEchoWithStatus | null = null
  let disposePredictiveEcho: (() => void) | null = null
  let unsubBuffer: (() => void) | null = null
  // Replay baseline: the buffer's monotonic chunk total at the moment the
  // attach snapshot was painted. Chunks at or below this total are already
  // on screen (inside the snapshot); only chunks past it get replayed.
  let writtenTotal = 0
  // Reconciler activity tracking: serial bumps once per server-output
  // delivery; lastOutputAt gates the quiet window. Both are read by the
  // quiet-time screen reconciler below.
  let activitySerial = 0
  let lastOutputAt = 0
  let attachSeeded = false
  let attachInFlight = false
  let pendingInitFrame: number | null = null
  // PTY size sync: a size only counts as delivered when the resizePty IPC
  // RESOLVES; failures retry with backoff until the current desired size
  // lands. The previous change-gate recorded a size as "sent" even when the
  // IPC failed, leaving the PTY permanently mismatched with the rendered
  // grid — a TUI then positions repaints against the wrong row count, so
  // content lands mid-screen and repaints stack in scrollback instead of
  // overwriting. See pty-size-sync.ts for the invariants (unit-tested).
  const sizeSync = createPtySizeSync((rows, cols) =>
    pear.broker.resizePty(opts.projectId, opts.agentName, rows, cols)
  )
  // Holder for the current input-SRTT getter. The predictive echo engine
  // captures this once on construction, so we wrap it in a trampoline and
  // let setInputSrttGetter swap the underlying getter on each effect run.
  let currentSrttGetter: () => number | null = opts.getInputSrtt
  // Routes server output direct-to-xterm while the predictive-echo engine
  // is dormant and through the engine once latency warrants predictions.
  // See echo-router.ts for the invariants (equivalence-tested against the
  // real engine + parser).
  const echoRouter = createEchoRouter({
    write: (data, callback) => {
      // Teardown marks the public runtime disposed before awaiting the router
      // drain. Keep this private sink alive until that drain completes so
      // Relay v10 reset cannot discard already-accepted server output.
      if (!term) return
      term.write(data, callback)
    },
    getEngine: () => predictiveEcho,
    buildModelSeed: () => (term ? buildModelSeedFromTerminal(term) : '\x1bc'),
    getInputSrtt: () => currentSrttGetter(),
    // Re-pin against the sticky follow intent, not the instantaneous viewport
    // position: a chunk that scrolls the viewport off the bottom during its
    // own async parse must still be re-pinned by the completion callback
    // (pear#403). A user who scrolled into scrollback (wheel-up) clears the
    // intent and is left alone.
    isViewportPinned: () => followBottom,
    scrollToBottom: () => term?.scrollToBottom()
  })
  // Quiet-time convergence to the broker's authoritative screen. Catches the
  // divergence class no creation-vector fix can: once the grid and a diffing
  // TUI's model disagree (e.g. an xterm reflow scroll during a width
  // resize), every subsequent diff-repaint preserves the stale cells. See
  // terminal-reconciler.ts for the gating invariants.
  const reconciler = createTerminalReconciler({
    fetchSnapshot: (format) => pear.broker.snapshotTerminal(opts.projectId, opts.agentName, format),
    readViewport: () => {
      if (!term || !opened) return null
      const buffer = term.buffer.active
      const lines: string[] = []
      for (let row = 0; row < term.rows; row += 1) {
        const line = buffer.getLine(buffer.baseY + row)
        lines.push(line ? line.translateToString(true) : '')
      }
      return { rows: term.rows, cols: term.cols, lines }
    },
    writeRepair: (ansi) => {
      // Through the router so the repair is ordered behind any queued engine
      // writes and, on the engine route, also repairs the engine's model.
      echoRouter.onServerOutput(ansi)
    },
    onConfirmedDivergence: ({ plain, viewport, telemetryLines }) => {
      void pear.app.dumpTermFidelityCorpus({
        projectId: opts.projectId,
        agentName: opts.agentName,
        cli: opts.cli?.trim() || 'unknown',
        renderer: {
          rows: viewport.rows,
          cols: viewport.cols,
          text: viewport.lines.join('\n')
        },
        broker: {
          rows: plain.rows,
          cols: plain.cols,
          text: plain.screen
        },
        telemetryLines
      }).catch(() => {
        // Corpus persistence is best-effort diagnostics. The main process
        // owns failure reporting; never perturb terminal reconciliation.
      })
    },
    isQuiet: () => {
      if (disposed || !attachSeeded || currentToken === null || !opened) return false
      // A hidden window stalls the rAF chunk flush, so "no recent output"
      // says nothing about what is actually pending — never reconcile there.
      if (document.visibilityState !== 'visible') return false
      const sinceOutput = Date.now() - lastOutputAt
      if (predictiveEcho?.hasPredictions) {
        if (sinceOutput < STRANDED_PREDICTION_ROLLBACK_MS) return false
        // See STRANDED_PREDICTION_ROLLBACK_MS: the confirming echo is never
        // coming; without this escape the quiet gate never reopens.
        console.warn(
          '[terminal] rolling back stranded optimistic-echo predictions (no confirming output)'
        )
        predictiveEcho.rollback()
        if (predictiveEcho.hasPredictions) return false
      }
      return sinceOutput >= RECONCILE_QUIET_MS
    },
    onPersistentDimsMismatch: () => {
      // The size-sync loop believes the PTY is at the last acked size, but
      // the broker snapshot says otherwise. Invalidate the ack so the
      // re-send isn't swallowed by the change gate, refit against the live
      // container, and re-assert the rendered grid as the PTY size.
      sizeSync.invalidateAck()
      const size = tryFit()
      if (size) {
        predictiveEcho?.onResize(size.cols, size.rows)
        sizeSync.setDesired(size.rows, size.cols)
      } else if (term && term.rows > 0 && term.cols > 0) {
        sizeSync.setDesired(term.rows, term.cols)
      }
    },
    activitySerial: () => activitySerial,
    flushPending: () => flushPtyChunksNow(key),
    log: (message) => console.warn(message)
  })

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
    // #403: a width/height reflow can scroll the viewport off the bottom (a
    // narrower grid rewraps lines into scrollback, bumping baseY past
    // viewportY). Centralize the re-pin here so EVERY reflow site — the
    // ResizeObserver fit, the reconciler's onPersistentDimsMismatch resync,
    // init, and refreshOnShow — keeps a following viewport at the tail. Gated
    // on the sticky follow intent, so a resize while the user is reading
    // scrollback does not yank them down.
    if (followBottom) term.scrollToBottom()
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

  const writeChunks = (newChunks: string[]): void => {
    if (disposed || !term) return
    if (newChunks.length === 0) return
    activitySerial += 1
    lastOutputAt = Date.now()
    // Optional diagnostic, gated on localStorage.PEAR_DIAG_PTY === '1'.
    // See pty-buffer-store.ts for the enable instructions. Flag is
    // cached to avoid a per-batch localStorage read.
    if (diagPtyEnabled()) {
      console.log(`[diag:runtime:writeChunks] key=${key} count=${newChunks.length} firstPreview="${newChunks[0]?.slice(0, 80).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1b/g, '\\e')}"`)
    }
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
    echoRouter.onServerOutput(combined)
  }

  const seedBufferSubscription = (): void => {
    if (unsubBuffer || !term || disposed) return

    unsubBuffer = subscribePtyBuffer(key, writeChunks)
    // Initial replay: pull whatever is already in the buffer past the
    // snapshot baseline (writtenTotal). The listener only receives tails
    // from this point on, so we have to do the catch-up explicitly here.
    // The monotonic-total slice can never replay pre-baseline chunks on top
    // of the snapshot, even if the buffer trimmed during the attach window.
    writeChunks(getPtyChunksSinceTotal(key, writtenTotal))
  }

  const attachAndSeed = async (
    initialSize: { rows: number; cols: number } | null
  ): Promise<void> => {
    if (!term || disposed || attachSeeded || attachInFlight) return
    attachInFlight = true

    let shouldReplay = true
    let postSnapshotChunks: string[] = []
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
        // Drain chunks staged during the IPC roundtrip before capturing the
        // buffer total. Relay v10 snapshots and worker_stream events share a
        // cumulative raw-PTY offset, so preserve chunks strictly after the
        // snapshot instead of treating the entire roundtrip window as covered
        // (which could drop output emitted after snapshot capture).
        flushPtyChunksNow(key)
        if (typeof result.snapshot.offset === 'number') {
          postSnapshotChunks = getPtyChunksAfterOffset(
            key,
            result.snapshot.offset,
            result.snapshot.generation
          )
        }
        writtenTotal = getPtyChunkTotal(key)
        shouldReplay = false
      }
      attachSeeded = true
      if (initialSize) {
        // attachTerminal carried rows/cols, so the PTY is at initialSize
        // now. Record the ack; if a refit moved `desired` during the IPC
        // roundtrip, the sync loop re-asserts it immediately.
        sizeSync.noteAcked(initialSize.rows, initialSize.cols)
      }
    } catch (err) {
      console.error('[terminal] attachTerminal failed:', err)
      // Don't latch attachSeeded — the next init/mount cycle should retry.
    } finally {
      attachInFlight = false
    }

    if (disposed || !term) return

    if (shouldReplay) {
      writtenTotal = 0
      await predictiveEcho?.seed('')
    }

    // These chunks were buffered before `writtenTotal` but landed after the
    // authoritative v10 snapshot. Write them in byte order before subscribing;
    // the subscription then catches anything that arrived after the baseline.
    writeChunks(postSnapshotChunks)
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
      // The (rows-1) intermediate is best-effort and deliberately bypasses
      // the sync loop; the restore below ALWAYS runs (even when the
      // intermediate fails) and goes through the retrying sync loop, so a
      // dropped restore IPC can never strand the PTY one row short — the
      // exact mismatch that makes TUI repaints stack down the screen.
      void pear.broker
        .resizePty(opts.projectId, opts.agentName, rows - 1, cols)
        .catch(() => {})
        .then(() => {
          if (disposed) return
          // The PTY may now be at the bounce size; invalidate the ack so the
          // sync loop re-asserts the real size even if it matches the last
          // acked value. Re-read dimensions across the async boundary — the
          // user may have resized the pane since the first IPC.
          sizeSync.invalidateAck()
          const currentRows = liveTerm.rows
          const currentCols = liveTerm.cols
          if (currentRows <= 0 || currentCols <= 0) return
          sizeSync.setDesired(currentRows, currentCols)
        })
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
      reconciler.dispose()
      sizeSync.dispose()
      disposed = true
      currentToken = null
      unsubBuffer?.()
      unsubBuffer = null
      clearPtyBuffer(key)
      // Relay v10 intentionally drops queued engine output after reset. Drain
      // the router ordering chain first, then reset/dispose the engine, model,
      // and live terminal. The registry record is already gone, so this old
      // runtime cannot be reacquired while its accepted bytes finish parsing.
      void echoRouter.dispose().finally(() => {
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
      })
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
        // Fix #9: ResizeObserver fires on every dragged pixel; the sync
        // loop only round-trips when the grid differs from the last ACKED
        // size, and keeps retrying until the PTY confirms it.
        sizeSync.setDesired(size.rows, size.cols)
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
      return disposed ? null : predictiveEcho
    },
    noteUserInput(data: string): void {
      if (disposed || !term) return
      echoRouter.onUserInput(data)
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

export function readRuntimeViewportDims(
  projectId: string | undefined,
  name: string
): { rows: number; cols: number } | null {
  const record = runtimes.get(getAgentKey(projectId, name))
  if (!record) return null
  const term = record.runtime.term
  return { rows: term.rows, cols: term.cols }
}

if (import.meta.env.VITE_PEAR_MOCK_IPC === 'true' && typeof window !== 'undefined') {
  ;(window as unknown as {
    __pearReadTerminalViewport?: (projectId: string | undefined, name: string) => string | null
    __pearReadTerminalDims?: (projectId: string | undefined, name: string) => { rows: number; cols: number } | null
  }).__pearReadTerminalViewport = readRuntimeViewportText
  ;(window as unknown as {
    __pearReadTerminalDims?: (projectId: string | undefined, name: string) => { rows: number; cols: number } | null
  }).__pearReadTerminalDims = readRuntimeViewportDims
}
