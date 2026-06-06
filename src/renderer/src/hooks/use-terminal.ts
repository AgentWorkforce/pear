import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { useAgentStore, getAgentKey } from '@/stores/agent-store'
import { getPtyChunks, subscribePtyBuffer } from '@/stores/pty-buffer-store'
import { recordChunkEchoed, recordKeystrokeSent } from '@/lib/typing-trace'
import { createPredictiveEcho } from '@/lib/predictive-echo'
import type { PredictiveEcho } from '@agent-relay/harness-driver/predictive-echo'
import { useUIStore, type Theme } from '@/stores/ui-store'

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

function getXtermTheme(theme: Theme): typeof DARK_THEME {
  return theme === 'light' ? LIGHT_THEME : DARK_THEME
}

function hasLayout(el: HTMLElement): boolean {
  return el.clientWidth > 0 && el.clientHeight > 0
}

const KEY_INPUT_SEQUENCES: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Backspace: '\x7f',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Delete: '\x1b[3~',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~'
}

function getCtrlSequence(key: string): string | null {
  if (key === ' ' || key === '@') return '\x00'
  if (key === '[') return '\x1b'
  if (key === '\\') return '\x1c'
  if (key === ']') return '\x1d'
  if (key === '^') return '\x1e'
  if (key === '_') return '\x1f'
  if (key === '?') return '\x7f'

  if (/^[a-z]$/i.test(key)) {
    return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64)
  }

  return null
}

function getKeyboardInput(event: KeyboardEvent): string | null {
  if (event.metaKey) return null
  if (event.ctrlKey && event.altKey) return null

  const mapped = KEY_INPUT_SEQUENCES[event.key]
  if (mapped) {
    return event.altKey ? `\x1b${mapped}` : mapped
  }

  if (event.ctrlKey) {
    return getCtrlSequence(event.key)
  }

  if (event.key.length === 1) {
    return event.altKey ? `\x1b${event.key}` : event.key
  }

  return null
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true

  const editable = target.closest('input, textarea, select, [contenteditable="true"]')
  return editable instanceof HTMLElement
}

function hasVisibleTerminalContent(screen: string): boolean {
  const stripped = screen.replace(
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g,
    ''
  )
  return /\S/.test(stripped)
}

interface TerminalSize {
  rows: number
  cols: number
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  agentName: string | null,
  projectId: string | undefined,
  visible: boolean,
  active: boolean = visible,
  terminalMode: TerminalAttachMode = 'drive',
  autoHold = false,
  onAutoHoldStart?: () => Promise<void> | void,
  onAutoHoldRelease?: (flush: boolean) => Promise<void> | void
): Terminal | null {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const predictiveEchoRef = useRef<PredictiveEcho | null>(null)
  const writtenChunksRef = useRef<number>(0)
  const activeRef = useRef(active)
  const terminalModeRef = useRef<TerminalAttachMode>(terminalMode)
  const autoHoldRef = useRef(autoHold)
  const onAutoHoldStartRef = useRef(onAutoHoldStart)
  const onAutoHoldReleaseRef = useRef(onAutoHoldRelease)
  const typingActiveRef = useRef(false)
  const theme = useUIStore((s) => s.theme)
  const activeDialog = useUIStore((s) => s.activeDialog)

  useEffect(() => { autoHoldRef.current = autoHold }, [autoHold])
  useEffect(() => { onAutoHoldStartRef.current = onAutoHoldStart }, [onAutoHoldStart])
  useEffect(() => { onAutoHoldReleaseRef.current = onAutoHoldRelease }, [onAutoHoldRelease])

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    terminalModeRef.current = terminalMode
  }, [terminalMode])

  useEffect(() => {
    if (!agentName) return
    pear.broker.setTerminalMode(projectId, agentName, terminalMode).catch((err) => {
      console.error('[terminal] setTerminalMode failed:', err)
    })
  }, [agentName, projectId, terminalMode])

  useEffect(() => {
    if (!containerRef.current || !agentName) return

    const container = containerRef.current
    let unsubStore: (() => void) | null = null
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let resizeObserver: ResizeObserver | null = null
    let disposed = false
    let cleanupBounce: (() => void) | null = null
    let disposePredictiveEcho: (() => void) | null = null
    // Latest broker input→ack SRTT (ms), refreshed by the poll below. Backs the
    // engine's adaptive engage decision; SRTT is a slow-moving EWMA so a ~1s
    // poll is responsive enough and cheap.
    let inputSrttMs: number | null = null
    let srttPoll: ReturnType<typeof setInterval> | null = null

    const sendInput = async (data: string): Promise<void> => {
      if (terminalModeRef.current === 'view') return

      // Auto-hold: on first keystroke with multiple agents running, switch to
      // drive mode so input is queued rather than immediately injected.
      const holdInput = autoHoldRef.current && typingActiveRef.current
      if (autoHoldRef.current && !typingActiveRef.current && terminalModeRef.current === 'passthrough') {
        typingActiveRef.current = true
        await onAutoHoldStartRef.current?.()
      }

      // Optimistically echo before the round trip; the engine reconciles
      // against authoritative output and stays dormant on fast local links.
      predictiveEchoRef.current?.onUserInput(data)
      recordKeystrokeSent(data)
      if (holdInput || typingActiveRef.current) {
        await pear.broker.sendInput(projectId, agentName!, data).catch((err) => {
          console.warn('[terminal] held input failed:', err)
        })
      } else {
        pear.broker.sendInputFast(projectId, agentName!, data)
      }

      // On Enter, flush the queued input and return to live mode.
      if (typingActiveRef.current && data.includes('\r')) {
        typingActiveRef.current = false
        await onAutoHoldReleaseRef.current?.(true)
      }
    }

    const focusTerminal = (requireActive = false): void => {
      if (!term) return
      if (requireActive && !activeRef.current) return
      requestAnimationFrame(() => {
        if (!disposed && (!requireActive || activeRef.current)) {
          container.focus({ preventScroll: true })
          term?.textarea?.focus({ preventScroll: true })
          term?.focus()
        }
      })
    }

    const fitTerminal = (): TerminalSize | null => {
      if (!term || !fitAddon || !hasLayout(container)) return null
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

    const safeFitAndSync = (): TerminalSize | null => {
      const size = fitTerminal()
      if (size) {
        predictiveEchoRef.current?.onResize(size.cols, size.rows)
        pear.broker.resizePty(projectId, agentName!, size.rows, size.cols).catch(() => {})
      }
      return size
    }

    const subscribeToBuffer = (targetTerm: Terminal): void => {
      if (unsubStore) return

      const writeFromBuffer = (ptyBuffer: string[]): void => {
        if (ptyBuffer.length < writtenChunksRef.current) {
          // Buffer was trimmed past our cursor; replay everything we still have.
          writtenChunksRef.current = 0
        }
        const newChunks = ptyBuffer.slice(writtenChunksRef.current)
        if (newChunks.length === 0) return
        for (const chunk of newChunks) {
          recordChunkEchoed(chunk)
          if (predictiveEchoRef.current) {
            // The engine owns pass-through to the live terminal and reconciles
            // outstanding predictions against this confirmed output.
            void predictiveEchoRef.current.onServerOutput(chunk)
          } else {
            targetTerm.write(chunk)
          }
        }
        writtenChunksRef.current = ptyBuffer.length
      }

      const bufferKey = getAgentKey(projectId, agentName!)
      unsubStore = subscribePtyBuffer(bufferKey, writeFromBuffer)
      writeFromBuffer(getPtyChunks(bufferKey))
    }

    const attachAndSeedTerminal = async (
      targetTerm: Terminal,
      initialSize: TerminalSize | null
    ): Promise<void> => {
      let shouldReplayBuffer = true

      try {
        const result = await pear.broker.attachTerminal({
          projectId,
          name: agentName!,
          rows: initialSize?.rows,
          cols: initialSize?.cols,
          mode: terminalModeRef.current
        })

        if (disposed) return

        if (result.snapshot?.screen && hasVisibleTerminalContent(result.snapshot.screen)) {
          targetTerm.write(result.snapshot.screen)
          // Prime the engine's confirmed-screen model with the same bytes (this
          // does not re-write to the terminal) so its cursor matches the real
          // screen before any prediction is made.
          await predictiveEchoRef.current?.seed(result.snapshot.screen)
          writtenChunksRef.current = useAgentStore.getState().getAgentBuffer(projectId, agentName!).length
          shouldReplayBuffer = false
        }
      } catch (err) {
        console.error('[terminal] attachTerminal failed:', err)
      }

      if (disposed) return

      if (shouldReplayBuffer) {
        writtenChunksRef.current = 0
        // No snapshot to prime from; mark the model seeded so predictions can
        // engage. The buffer replay below feeds confirmed output through the
        // engine, keeping the model in sync.
        await predictiveEchoRef.current?.seed('')
      }

      subscribeToBuffer(targetTerm)
    }

    const init = (): void => {
      if (disposed) return
      if (!hasLayout(container)) {
        requestAnimationFrame(init)
        return
      }

      term = new Terminal({
        theme: getXtermTheme(theme),
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
        fontSize: 13,
        lineHeight: 1,
        cursorBlink: true,
        allowProposedApi: true
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())

      // GPU-accelerated renderer: dramatically faster than the default DOM
      // renderer that emits one element per cell. Fall back silently if the
      // host can't initialize WebGL (Electron contexts without GL, headless
      // CI, etc.) — xterm will keep using the DOM renderer in that case.
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
        })
        term.loadAddon(webgl)
      } catch (err) {
        console.warn('[terminal] WebGL renderer unavailable, falling back to DOM:', err)
      }

      // Forward keystrokes + terminal protocol responses to PTY
      term.onData((data) => {
        void sendInput(data)
      })

      term.open(container)
      const initialSize = fitTerminal()

      // Mosh-style predictive local echo: optimistically renders printable
      // keystrokes and reconciles against authoritative server output. Adaptive
      // on measured latency, so it stays dormant (invisible) on fast local
      // links and only engages when driving a high-latency / remote agent.
      const liveTerm = term
      const predictiveEcho = createPredictiveEcho({
        write: (data) => liveTerm.write(data),
        cols: term.cols,
        rows: term.rows,
        getInputSrtt: () => inputSrttMs
      })
      predictiveEchoRef.current = predictiveEcho.engine
      disposePredictiveEcho = predictiveEcho.dispose

      // Keep the SRTT estimate warm so prediction engages promptly. Refresh
      // immediately, then on an interval; failures leave the last value intact.
      const refreshSrtt = (): void => {
        pear.broker
          .inputSrtt(projectId, agentName!)
          .then((srtt) => {
            if (!disposed) inputSrttMs = srtt
          })
          .catch(() => {})
      }
      refreshSrtt()
      srttPoll = setInterval(refreshSrtt, 1000)

      void attachAndSeedTerminal(term, initialSize)

      termRef.current = term
      fitAddonRef.current = fitAddon

      focusTerminal(true)

      // Spawn dialogs and pane layout updates can steal focus immediately after
      // mount. Retry a few times so the xterm textarea reliably becomes active.
      const focusTimers = [0, 50, 150, 300].map((delay) =>
        setTimeout(() => focusTerminal(true), delay)
      )

      resizeObserver = new ResizeObserver(() => safeFitAndSync())
      resizeObserver.observe(container)

      // The PTY starts at a default size before the terminal connects.
      // Bounce the size to force a SIGWINCH so the running process redraws
      // at the correct dimensions.
      const bounceTimer = setTimeout(() => {
        if (!term || !fitAddon || !hasLayout(container)) return
        try {
          fitAddon.fit()
        } catch {
          return
        }
        const { rows, cols } = term
        if (rows > 1 && cols > 0) {
          pear.broker.resizePty(projectId, agentName!, rows - 1, cols).then(() => {
            pear.broker.resizePty(projectId, agentName!, rows, cols)
          }).catch(() => {})
        }
      }, 200)
      cleanupBounce = () => {
        clearTimeout(bounceTimer)
        for (const timer of focusTimers) {
          clearTimeout(timer)
        }
      }
    }

    requestAnimationFrame(init)

    // Click-to-focus
    const handlePointerDown = (): void => {
      focusTerminal()
    }

    const handleBlur = (): void => {
      if (typingActiveRef.current) {
        typingActiveRef.current = false
        void onAutoHoldReleaseRef.current?.(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.target === term?.textarea) {
        return
      }

      const data = getKeyboardInput(event)
      if (!data) return

      event.preventDefault()
      event.stopPropagation()
      void sendInput(data)
      focusTerminal()
    }

    const handlePaste = (event: ClipboardEvent): void => {
      if (document.activeElement === term?.textarea) {
        return
      }

      const text = event.clipboardData?.getData('text')
      if (!text) return

      event.preventDefault()
      event.stopPropagation()
      void sendInput(text)
      focusTerminal()
    }

    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('keydown', handleKeyDown)
    container.addEventListener('paste', handlePaste)
    container.addEventListener('blur', handleBlur, true)

    return () => {
      disposed = true
      cleanupBounce?.()
      unsubStore?.()
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('blur', handleBlur, true)
      resizeObserver?.disconnect()
      if (srttPoll) clearInterval(srttPoll)
      disposePredictiveEcho?.()
      predictiveEchoRef.current = null
      term?.dispose()
      termRef.current = null
      fitAddonRef.current = null
      writtenChunksRef.current = 0
    }
  }, [containerRef, agentName, projectId])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getXtermTheme(theme)
    }
  }, [theme])

  useEffect(() => {
    if (!visible || !termRef.current || !fitAddonRef.current) return
    const container = containerRef.current
    if (!container || !hasLayout(container)) return
    try {
      fitAddonRef.current.fit()
      const { rows, cols } = termRef.current
      if (rows > 0 && cols > 0 && agentName) {
        predictiveEchoRef.current?.onResize(cols, rows)
        pear.broker.resizePty(projectId, agentName, rows, cols)
      }
    } catch {
      // ignore
    }
    if (!active) return
    const timer = setTimeout(() => termRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [visible, active, agentName, projectId])

  useEffect(() => {
    if (!visible || !active) return
    const handleWindowFocus = (): void => {
      setTimeout(() => termRef.current?.focus(), 50)
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [visible, active])

  useEffect(() => {
    if (!visible || !active || terminalMode === 'view' || !agentName || activeDialog) return
    const container = containerRef.current

    const sendInput = async (data: string): Promise<void> => {
      if (terminalModeRef.current === 'view') return
      const holdInput = autoHoldRef.current && typingActiveRef.current
      if (autoHoldRef.current && !typingActiveRef.current && terminalModeRef.current === 'passthrough') {
        typingActiveRef.current = true
        await onAutoHoldStartRef.current?.()
      }
      predictiveEchoRef.current?.onUserInput(data)
      if (holdInput || typingActiveRef.current) {
        await pear.broker.sendInput(projectId, agentName, data).catch((err) => {
          console.warn('[terminal] held input failed:', err)
        })
      } else {
        pear.broker.sendInputFast(projectId, agentName, data)
      }
      if (typingActiveRef.current && data.includes('\r')) {
        typingActiveRef.current = false
        await onAutoHoldReleaseRef.current?.(true)
      }
    }

    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      const term = termRef.current
      if (!term || event.isComposing) {
        return
      }

      const isTerminalEvent = event.target instanceof Node && !!container?.contains(event.target)
      if (isTerminalEvent) {
        return
      }

      if (isEditableElement(event.target) && !isTerminalEvent) {
        return
      }

      const data = getKeyboardInput(event)
      if (!data) return

      event.preventDefault()
      event.stopPropagation()
      void sendInput(data)
      setTimeout(() => term.focus(), 0)
    }

    const handleGlobalPaste = (event: ClipboardEvent): void => {
      const term = termRef.current
      if (!term) {
        return
      }

      const isTerminalEvent = event.target instanceof Node && !!container?.contains(event.target)
      if (isTerminalEvent) {
        return
      }

      if (isEditableElement(event.target) && !isTerminalEvent) {
        return
      }

      const text = event.clipboardData?.getData('text')
      if (!text) return

      event.preventDefault()
      event.stopPropagation()
      void sendInput(text)
      setTimeout(() => term.focus(), 0)
    }

    window.addEventListener('keydown', handleGlobalKeyDown, true)
    window.addEventListener('paste', handleGlobalPaste, true)

    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true)
      window.removeEventListener('paste', handleGlobalPaste, true)
    }
  }, [visible, active, terminalMode, agentName, projectId, activeDialog, containerRef])

  return termRef.current
}
