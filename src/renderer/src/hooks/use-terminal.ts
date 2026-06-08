import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { useAgentStore, getAgentKey } from '@/stores/agent-store'
import { recordKeystrokeSent } from '@/lib/typing-trace'
import {
  acquireTerminalRuntime,
  disposeTerminalRuntime,
  type TerminalRuntime
} from '@/lib/terminal-runtime-registry'
import { useUIStore } from '@/stores/ui-store'

function hasLayout(el: HTMLElement): boolean {
  return el.clientWidth > 0 && el.clientHeight > 0
}

function isViewportPinnedToBottom(term: Terminal): boolean {
  const buffer = term.buffer.active
  return buffer.viewportY === buffer.baseY
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
  const runtimeRef = useRef<TerminalRuntime | null>(null)
  const activeRef = useRef(active)
  const terminalModeRef = useRef<TerminalAttachMode>(terminalMode)
  const autoHoldRef = useRef(autoHold)
  const onAutoHoldStartRef = useRef(onAutoHoldStart)
  const onAutoHoldReleaseRef = useRef(onAutoHoldRelease)
  const typingActiveRef = useRef(false)
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve())
  // Backs the runtime's predictive echo `getInputSrtt` callback. The
  // runtime holds the function reference for life; we just keep the
  // latest value in this ref and poll while the hook is mounted.
  const inputSrttRef = useRef<number | null>(null)
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
    runtimeRef.current?.setTerminalMode(terminalMode)
  }, [terminalMode])

  useEffect(() => {
    if (!agentName) return
    pear.broker.setTerminalMode(projectId, agentName, terminalMode).catch((err) => {
      console.error('[terminal] setTerminalMode failed:', err)
    })
  }, [agentName, projectId, terminalMode])

  const sendInputNow = useCallback(async (data: string): Promise<void> => {
    if (!agentName || terminalModeRef.current === 'view') return

    // Auto-hold: on first keystroke with multiple agents running, switch to
    // drive mode so input is queued rather than immediately injected.
    const holdInput = autoHoldRef.current && typingActiveRef.current
    if (autoHoldRef.current && !typingActiveRef.current && terminalModeRef.current === 'passthrough') {
      typingActiveRef.current = true
      await onAutoHoldStartRef.current?.()
    }

    // Optimistically echo before the round trip; the engine reconciles
    // against authoritative output and stays dormant on fast local links.
    runtimeRef.current?.getPredictiveEcho()?.onUserInput(data)
    recordKeystrokeSent(data)
    if (holdInput || typingActiveRef.current) {
      await pear.broker.sendInput(projectId, agentName, data).catch((err) => {
        console.warn('[terminal] held input failed:', err)
        throw err
      })
    } else {
      pear.broker.sendInputFast(projectId, agentName, data)
    }

    // On Enter, flush the queued input and return to live mode.
    if (typingActiveRef.current && data.includes('\r')) {
      typingActiveRef.current = false
      await onAutoHoldReleaseRef.current?.(true)
    }
  }, [agentName, projectId])

  const sendInput = useCallback((data: string): void => {
    const next = inputQueueRef.current.then(() => sendInputNow(data))
    inputQueueRef.current = next.catch((err) => {
      console.warn('[terminal] input failed:', err)
    })
  }, [sendInputNow])

  // Read the latest theme via a ref so the main acquisition effect can be
  // independent of theme changes; the dedicated setTheme effect below
  // propagates theme updates to the live runtime.
  const themeRef = useRef(theme)
  useEffect(() => {
    themeRef.current = theme
  }, [theme])

  useEffect(() => {
    if (!agentName) {
      runtimeRef.current = null
      return
    }

    // Acquire the persistent runtime for this agent. Tab switches /
    // re-mounts return the same runtime instance, so xterm + PTY
    // subscription survive across React lifecycle churn — this is what
    // kills the duplicate-text class of bugs.
    const runtime = acquireTerminalRuntime({
      projectId,
      agentName,
      terminalMode: terminalModeRef.current,
      theme: themeRef.current,
      getInputSrtt: () => inputSrttRef.current
    })
    runtimeRef.current = runtime
    // Re-bind the SRTT getter on each effect run. The runtime captures
    // the getter once at first acquire; without this, a remount that
    // changes inputSrttRef identity would leave the predictor reading
    // the stale ref.
    runtime.setInputSrttGetter(() => inputSrttRef.current)
    runtime.setOnData((data) => sendInput(data))

    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
    let srttPoll: ReturnType<typeof setInterval> | null = null
    let focusTimers: ReturnType<typeof setTimeout>[] = []
    const containerEl = containerRef.current

    const focusTerminal = (requireActive = false): void => {
      const term = runtime.term
      const container = containerRef.current
      if (!term || !container) return
      if (requireActive && !activeRef.current) return
      requestAnimationFrame(() => {
        if (disposed) return
        if (requireActive && !activeRef.current) return
        container.focus({ preventScroll: true })
        term.textarea?.focus({ preventScroll: true })
        term.focus()
      })
    }

    // Mount into the visible container if we have layout. If not yet,
    // we still call mount() so the runtime can defer its init() to the
    // first frame with layout.
    if (containerEl) {
      runtime.mount(containerEl)
      focusTerminal(true)
      focusTimers = [0, 50, 150, 300].map((delay) =>
        setTimeout(() => focusTerminal(true), delay)
      )
    }

    // Keep the SRTT estimate warm so prediction engages promptly. Refresh
    // immediately, then on an interval; failures leave the last value intact.
    const refreshSrtt = (): void => {
      pear.broker
        .inputSrtt(projectId, agentName)
        .then((srtt) => {
          if (!disposed) inputSrttRef.current = srtt
        })
        .catch(() => {})
    }
    refreshSrtt()
    srttPoll = setInterval(refreshSrtt, 1000)

    // Trailing-debounced refit. The raw ResizeObserver fires per entry on
    // every allotment drag, including 0×0 intermediate states. Refitting
    // on a 0×0 box leaks bad metrics into xterm and forces a fix-up later
    // — gate on a real box and debounce.
    if (containerEl) {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        const { width, height } = entry.contentRect
        if (width === 0 || height === 0) return
        if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
        resizeDebounceTimer = setTimeout(() => {
          resizeDebounceTimer = null
          if (disposed) return
          const term = runtime.term
          const wasPinned = term ? isViewportPinnedToBottom(term) : false
          runtime.fitAndSync()
          if (wasPinned && term) {
            term.scrollToBottom()
          }
        }, 75)
      })
      resizeObserver.observe(containerEl)
    }

    return () => {
      disposed = true
      runtime.setOnData(null)
      for (const timer of focusTimers) clearTimeout(timer)
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
      resizeObserver?.disconnect()
      if (srttPoll) clearInterval(srttPoll)

      // Don't dispose the runtime — detach so xterm + subscription survive
      // the React unmount. The runtime is only torn down when the agent
      // itself goes away (see effect below).
      runtime.detach()
    }
  }, [containerRef, agentName, projectId, sendInput])

  // Dispose the runtime when its owning agent is no longer in the store.
  // Tab switches null-out agentName without removing the agent — we should
  // keep the runtime around in that case. But when the agent is actually
  // released (closed, removed, etc.) we should free GPU resources.
  useEffect(() => {
    return () => {
      // On unmount, check whether the agent has actually been removed
      // from the store; if so, dispose. Otherwise leave the runtime
      // parked for future remounts.
      if (!agentName) return
      const key = getAgentKey(projectId, agentName)
      const stillExists = useAgentStore
        .getState()
        .agents.some((a) => getAgentKey(a.projectId, a.name) === key)
      if (!stillExists) {
        disposeTerminalRuntime(key)
      }
    }
  }, [agentName, projectId])

  useEffect(() => {
    runtimeRef.current?.setTheme(theme)
  }, [theme])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!visible || !runtime) return
    const container = containerRef.current
    if (!container || !hasLayout(container)) return
    try {
      const wasPinned = isViewportPinnedToBottom(runtime.term)
      runtime.fitAndSync()
      // Fix #11: WebGL doesn't repaint while the host is display:none;
      // when the tab comes back, force a refresh so the canvas redraws
      // rather than showing a stale frame.
      runtime.refreshOnShow()
      if (wasPinned) runtime.term.scrollToBottom()
    } catch {
      // ignore
    }
    if (!active) return
    const timer = setTimeout(() => runtimeRef.current?.term.focus(), 50)
    return () => clearTimeout(timer)
  }, [visible, active, agentName, projectId, containerRef])

  useEffect(() => {
    if (!visible || !active) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const handleWindowFocus = (): void => {
      timer = setTimeout(() => {
        const term = runtimeRef.current?.term
        if (term) term.focus()
      }, 50)
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => {
      window.removeEventListener('focus', handleWindowFocus)
      if (timer) clearTimeout(timer)
    }
  }, [visible, active])

  useEffect(() => {
    if (!visible || !active || terminalMode === 'view' || !agentName || activeDialog) return
    const container = containerRef.current

    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      const term = runtimeRef.current?.term
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
      sendInput(data)
      setTimeout(() => term.focus(), 0)
    }

    const handleGlobalPaste = (event: ClipboardEvent): void => {
      const term = runtimeRef.current?.term
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
      sendInput(text)
      setTimeout(() => term.focus(), 0)
    }

    window.addEventListener('keydown', handleGlobalKeyDown, true)
    window.addEventListener('paste', handleGlobalPaste, true)

    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true)
      window.removeEventListener('paste', handleGlobalPaste, true)
    }
  }, [visible, active, terminalMode, agentName, projectId, activeDialog, containerRef, sendInput])

  // Keyboard handlers attached directly to the container element. These
  // were previously inside the mount effect; pulling them out keeps the
  // runtime acquisition simple and lets them piggyback on agent/projectId
  // identity without re-running the heavy effect.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !agentName) return

    const handlePointerDown = (): void => {
      const term = runtimeRef.current?.term
      if (!term) return
      requestAnimationFrame(() => {
        container.focus({ preventScroll: true })
        term.textarea?.focus({ preventScroll: true })
        term.focus()
      })
    }

    const handleBlur = (): void => {
      if (typingActiveRef.current) {
        typingActiveRef.current = false
        void onAutoHoldReleaseRef.current?.(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      const term = runtimeRef.current?.term
      if (event.isComposing || event.target === term?.textarea) {
        return
      }

      const data = getKeyboardInput(event)
      if (!data) return

      event.preventDefault()
      event.stopPropagation()
      sendInput(data)
      requestAnimationFrame(() => {
        container.focus({ preventScroll: true })
        term?.textarea?.focus({ preventScroll: true })
        term?.focus()
      })
    }

    const handlePaste = (event: ClipboardEvent): void => {
      const term = runtimeRef.current?.term
      if (document.activeElement === term?.textarea) {
        return
      }

      const text = event.clipboardData?.getData('text')
      if (!text) return

      event.preventDefault()
      event.stopPropagation()
      sendInput(text)
      requestAnimationFrame(() => {
        container.focus({ preventScroll: true })
        term?.textarea?.focus({ preventScroll: true })
        term?.focus()
      })
    }

    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('keydown', handleKeyDown)
    container.addEventListener('paste', handlePaste)
    container.addEventListener('blur', handleBlur, true)

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('blur', handleBlur, true)
    }
  }, [containerRef, agentName, sendInput])

  return runtimeRef.current?.term ?? null
}
