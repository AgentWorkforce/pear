import type React from 'react'
import { useRef } from 'react'
import { useTerminal } from '@/hooks/use-terminal'
import type { TerminalAttachMode } from '@/lib/ipc'

interface Props {
  agentName: string
  projectId?: string
  visible: boolean
  active: boolean
  mode: TerminalAttachMode
  onActivate?: () => void
  autoHold?: boolean
  onAutoHoldStart?: () => Promise<void> | void
  onAutoHoldRelease?: (flush: boolean) => Promise<void> | void
}

export function TerminalInstance({ agentName, projectId, visible, active, mode, onActivate, autoHold, onAutoHoldStart, onAutoHoldRelease }: Props): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(containerRef, agentName, projectId, visible, active, mode, autoHold, onAutoHoldStart, onAutoHoldRelease)

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
