import type React from 'react'
import { useRef } from 'react'
import { useTerminal } from '@/hooks/use-terminal'
import type { TerminalAttachMode } from '@/lib/ipc'

interface Props {
  agentName: string
  visible: boolean
  active: boolean
  mode: TerminalAttachMode
  onActivate?: () => void
}

export function TerminalInstance({ agentName, visible, active, mode, onActivate }: Props): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(containerRef, agentName, visible, active, mode)

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      aria-label={`${agentName} ${mode} terminal`}
      onFocus={onActivate}
      onPointerDown={onActivate}
      className="titlebar-nodrag h-full w-full p-1 outline-none"
    />
  )
}
