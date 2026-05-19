import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
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

interface TerminalSize {
  rows: number
  cols: number
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  agentName: string | null,
  visible: boolean,
  active: boolean = visible,
  terminalMode: TerminalAttachMode = 'passthrough'
): Terminal | null {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const writtenChunksRef = useRef<number>(0)
  const activeRef = useRef(active)
  const terminalModeRef = useRef<TerminalAttachMode>(terminalMode)
  const theme = useUIStore((s) => s.theme)
  const activeDialog = useUIStore((s) => s.activeDialog)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    terminalModeRef.current = terminalMode
  }, [terminalMode])

  useEffect(() => {
    if (!agentName) return
    pear.broker.setTerminalMode(agentName, terminalMode).catch((err) => {
      console.error('[terminal] setTerminalMode failed:', err)
    })
  }, [agentName, terminalMode])

  useEffect(() => {
    if (!containerRef.current || !agentName) return

    const container = containerRef.current
    let unsubStore: (() => void) | null = null
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let resizeObserver: ResizeObserver | null = null
    let disposed = false
    let cleanupBounce: (() => void) | null = null
    const sendInput = (data: string): void => {
      if (terminalModeRef.current === 'view') return
      pear.broker.sendInput(agentName!, data).catch((err) => {
        console.error('[terminal] sendInput failed:', err)
      })
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
        pear.broker.resizePty(agentName!, size.rows, size.cols).catch(() => {})
      }
      return size
    }

    const subscribeToBuffer = (targetTerm: Terminal): void => {
      if (unsubStore) return

      const writeNewChunks = (state = useAgentStore.getState()): void => {
        const agent = state.agents.find((a) => a.name === agentName)
        if (!agent) return
        const newChunks = agent.ptyBuffer.slice(writtenChunksRef.current)
        if (newChunks.length > 0) {
          for (const chunk of newChunks) {
            targetTerm.write(chunk)
          }
          writtenChunksRef.current = agent.ptyBuffer.length
        }
      }

      unsubStore = useAgentStore.subscribe(writeNewChunks)
      writeNewChunks()
    }

    const attachAndSeedTerminal = async (
      targetTerm: Terminal,
      initialSize: TerminalSize | null
    ): Promise<void> => {
      let shouldReplayBuffer = true

      try {
        const result = await pear.broker.attachTerminal({
          name: agentName!,
          rows: initialSize?.rows,
          cols: initialSize?.cols,
          mode: terminalModeRef.current
        })

        if (disposed) return

        if (result.snapshot?.screen) {
          targetTerm.write(result.snapshot.screen)
          writtenChunksRef.current = useAgentStore.getState().getAgentBuffer(agentName!).length
          shouldReplayBuffer = false
        }
      } catch (err) {
        console.error('[terminal] attachTerminal failed:', err)
      }

      if (disposed) return

      if (shouldReplayBuffer) {
        writtenChunksRef.current = 0
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
        lineHeight: 1.3,
        cursorBlink: true,
        allowProposedApi: true
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())

      // Forward keystrokes + terminal protocol responses to PTY
      term.onData((data) => {
        sendInput(data)
      })

      term.open(container)
      const initialSize = fitTerminal()
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
          pear.broker.resizePty(agentName!, rows - 1, cols).then(() => {
            pear.broker.resizePty(agentName!, rows, cols)
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

    const handleKeyDown = (event: KeyboardEvent): void => {
      const data = getKeyboardInput(event)
      if (!data) return

      event.preventDefault()
      event.stopPropagation()
      sendInput(data)
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
      sendInput(text)
      focusTerminal()
    }

    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('keydown', handleKeyDown)
    container.addEventListener('paste', handlePaste)

    return () => {
      disposed = true
      cleanupBounce?.()
      unsubStore?.()
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('paste', handlePaste)
      resizeObserver?.disconnect()
      term?.dispose()
      termRef.current = null
      fitAddonRef.current = null
      writtenChunksRef.current = 0
    }
  }, [containerRef, agentName])

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
        pear.broker.resizePty(agentName, rows, cols)
      }
    } catch {
      // ignore
    }
    if (!active) return
    const timer = setTimeout(() => termRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [visible, active, agentName])

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

    const sendInput = (data: string): void => {
      if (terminalModeRef.current === 'view') return
      pear.broker.sendInput(agentName, data).catch((err) => {
        console.error('[terminal] sendInput failed:', err)
      })
    }

    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      const term = termRef.current
      if (!term || event.isComposing) {
        return
      }

      const isTerminalEvent = event.target instanceof Node && !!container?.contains(event.target)
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
      const term = termRef.current
      if (!term) {
        return
      }

      const isTerminalEvent = event.target instanceof Node && !!container?.contains(event.target)
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
  }, [visible, active, terminalMode, agentName, activeDialog, containerRef])

  return termRef.current
}
