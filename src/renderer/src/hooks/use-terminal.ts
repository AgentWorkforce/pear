import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { pear } from '@/lib/ipc'
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

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  agentName: string | null,
  visible: boolean
): Terminal | null {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const writtenChunksRef = useRef<number>(0)
  const theme = useUIStore((s) => s.theme)

  useEffect(() => {
    if (!containerRef.current || !agentName) return

    const container = containerRef.current
    let unsubStore: (() => void) | null = null
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let resizeObserver: ResizeObserver | null = null
    let disposed = false
    let cleanupBounce: (() => void) | null = null

    const focusTerminal = (): void => {
      if (!term) return
      requestAnimationFrame(() => {
        if (!disposed) {
          term?.focus()
        }
      })
    }

    const safeFitAndSync = (): void => {
      if (!term || !fitAddon || !hasLayout(container)) return
      try {
        fitAddon.fit()
      } catch {
        return
      }
      const { rows, cols } = term
      if (rows > 0 && cols > 0) {
        pear.broker.resizePty(agentName!, rows, cols)
      }
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
        pear.broker.sendInput(agentName!, data).catch((err) => {
          console.error('[terminal] sendInput failed:', err)
        })
      })

      term.open(container)
      safeFitAndSync()

      // Replay buffered output then subscribe for new chunks
      const buffer = useAgentStore.getState().getAgentBuffer(agentName!)
      for (const chunk of buffer) {
        term.write(chunk)
      }
      writtenChunksRef.current = buffer.length

      const t = term
      unsubStore = useAgentStore.subscribe((state) => {
        const agent = state.agents.find((a) => a.name === agentName)
        if (!agent) return
        const newChunks = agent.ptyBuffer.slice(writtenChunksRef.current)
        if (newChunks.length > 0) {
          for (const chunk of newChunks) {
            t.write(chunk)
          }
          writtenChunksRef.current = agent.ptyBuffer.length
        }
      })

      termRef.current = term
      fitAddonRef.current = fitAddon

      focusTerminal()

      // Spawn dialogs and pane layout updates can steal focus immediately after
      // mount. Retry a few times so the xterm textarea reliably becomes active.
      const focusTimers = [0, 50, 150, 300].map((delay) =>
        setTimeout(() => focusTerminal(), delay)
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
    const handleMouseDown = (): void => {
      focusTerminal()
    }
    container.addEventListener('mousedown', handleMouseDown)

    return () => {
      disposed = true
      cleanupBounce?.()
      unsubStore?.()
      container.removeEventListener('mousedown', handleMouseDown)
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
    const timer = setTimeout(() => termRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [visible, agentName])

  useEffect(() => {
    if (!visible) return
    const handleWindowFocus = (): void => {
      setTimeout(() => termRef.current?.focus(), 50)
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [visible])

  return termRef.current
}
