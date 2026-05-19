import type React from 'react'
import { useRef } from 'react'
import { useTerminal } from '@/hooks/use-terminal'

interface Props {
  agentName: string
  visible: boolean
}

export function TerminalInstance({ agentName, visible }: Props): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(containerRef, agentName, visible)

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      aria-label={`${agentName} terminal`}
      className="titlebar-nodrag h-full w-full p-1 outline-none"
    />
  )
}
