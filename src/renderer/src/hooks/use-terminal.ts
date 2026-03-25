import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore, type Theme } from '@/stores/ui-store'

const DARK_THEME = {
  background: '#161a12',
  foreground: '#d4d4c8',
  cursor: '#8cb369',
  selectionBackground: '#3a3e32',
  black: '#2a2e22',
  red: '#c45c5c',
  green: '#8cb369',
  yellow: '#d4a843',
  blue: '#6b9fc4',
  magenta: '#9b85b5',
  cyan: '#6bab9a',
  white: '#d4d4c8',
  brightBlack: '#5c5c52',
  brightRed: '#d47070',
  brightGreen: '#a3c585',
  brightYellow: '#e0bc5e',
  brightBlue: '#85b5d4',
  brightMagenta: '#b09fc9',
  brightCyan: '#85c4b3',
  brightWhite: '#e8e8dc'
}

const LIGHT_THEME = {
  background: '#f5f4f0',
  foreground: '#2a2e22',
  cursor: '#5a8a3c',
  selectionBackground: '#d0e8c0',
  black: '#2a2e22',
  red: '#c04040',
  green: '#5a8a3c',
  yellow: '#b08920',
  blue: '#3a7fa8',
  magenta: '#7a60a0',
  cyan: '#3a8a78',
  white: '#f5f4f0',
  brightBlack: '#6a7060',
  brightRed: '#d05050',
  brightGreen: '#6ea04a',
  brightYellow: '#c09830',
  brightBlue: '#4a90b8',
  brightMagenta: '#8a70b0',
  brightCyan: '#4a9a88',
  brightWhite: '#ffffff'
}

function getXtermTheme(theme: Theme): typeof DARK_THEME {
  return theme === 'light' ? LIGHT_THEME : DARK_THEME
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

    const term = new Terminal({
      theme: getXtermTheme(theme),
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      allowProposedApi: true
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)

    try {
      fitAddon.fit()
    } catch {
      // Container may not have dimensions yet
    }

    const buffer = useAgentStore.getState().getAgentBuffer(agentName)
    for (const chunk of buffer) {
      term.write(chunk)
    }
    writtenChunksRef.current = buffer.length

    term.onData((data) => {
      if (agentName) pear.broker.sendInput(agentName, data)
    })

    // Focus the terminal after the browser has finished layout so the
    // xterm textarea is reachable (Allotment may still be sizing panes
    // when this effect first runs).
    requestAnimationFrame(() => term.focus())

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Sync local xterm size with the broker-side PTY on every resize
    const syncSize = (): void => {
      try {
        fitAddon.fit()
        const { rows, cols } = term
        if (rows > 0 && cols > 0) {
          pear.broker.resizePty(agentName!, rows, cols)
        }
      } catch {
        // ignore — container may not have dimensions yet
      }
    }

    // Send initial size to the broker
    syncSize()

    const resizeObserver = new ResizeObserver(syncSize)
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      writtenChunksRef.current = 0
    }
  }, [containerRef, agentName])

  // Update xterm theme when app theme changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getXtermTheme(theme)
    }
  }, [theme])

  // Subscribe to new PTY output
  useEffect(() => {
    if (!agentName || !termRef.current) return

    const unsub = useAgentStore.subscribe((state) => {
      const agent = state.agents.find((a) => a.name === agentName)
      if (!agent) return
      const newChunks = agent.ptyBuffer.slice(writtenChunksRef.current)
      for (const chunk of newChunks) {
        termRef.current?.write(chunk)
      }
      writtenChunksRef.current = agent.ptyBuffer.length
    })

    return unsub
  }, [agentName])

  // Refit, resize PTY, and refocus when visibility changes
  useEffect(() => {
    if (visible && termRef.current && fitAddonRef.current) {
      try {
        fitAddonRef.current.fit()
        const { rows, cols } = termRef.current
        if (rows > 0 && cols > 0 && agentName) {
          pear.broker.resizePty(agentName, rows, cols)
        }
      } catch {
        // ignore
      }
      requestAnimationFrame(() => termRef.current?.focus())
    }
  }, [visible, agentName])

  return termRef.current
}
