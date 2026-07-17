import type React from 'react'
import { useRef } from 'react'
import { useTerminal } from '@/hooks/use-terminal'
import type { TerminalAttachMode } from '@/lib/ipc'

interface Props {
  agentName: string
  cli?: string
  projectId?: string
  visible: boolean
  active: boolean
  mode: TerminalAttachMode
  onActivate?: () => void
}

export function TerminalInstance({ agentName, cli, projectId, visible, active, mode, onActivate }: Props): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(containerRef, agentName, projectId, visible, active, mode, cli)

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-testid="terminal-instance"
      data-agent-name={agentName}
      aria-label={`${agentName} ${mode} terminal`}
      onFocus={onActivate}
      onPointerDown={onActivate}
      className="titlebar-nodrag h-full w-full p-1 outline-none"
    />
  )
}
