import type React from 'react'
import { User } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { useAgentStore } from '@/stores/agent-store'
import type { ChatMessage as ChatMessageType } from '@/stores/agent-store'

interface Props {
  message: ChatMessageType
  showRoute?: boolean
}

const agentColors = [
  'var(--pear-accent)',
  'var(--pear-purple)',
  'var(--pear-accent-bright)',
  'var(--pear-orange)',
  'var(--pear-teal)',
  'var(--pear-pink)',
  'var(--pear-blue)',
  'var(--pear-yellow)'
]

function getAgentColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return agentColors[Math.abs(hash) % agentColors.length]
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ChatMessage({ message, showRoute = true }: Props): React.ReactNode {
  const agent = useAgentStore((state) =>
    state.agents.find((candidate) =>
      candidate.name === message.from &&
      (!message.projectId || candidate.projectId === message.projectId)
    )
  )
  const color = message.isHuman ? 'var(--pear-accent-bright)' : getAgentColor(message.from)

  return (
    <div className="group flex gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--pear-bg-surface-hover)]/45">
      <div
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)]"
        style={{ backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)` }}
      >
        {message.isHuman ? (
          <User size={15} style={{ color }} />
        ) : (
          <AgentHarnessIcon
            cli={agent?.cli}
            className="h-5 w-5 text-[var(--pear-text)]"
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium" style={{ color }}>
            {message.isHuman ? 'You' : message.from}
          </span>
          <span className="text-[10px] text-[var(--pear-text-faint)]">
            {formatTime(message.timestamp)}
          </span>
          {showRoute && message.to && !message.isHuman && (
            <span className="text-[10px] text-[var(--pear-text-faint)]">
              &rarr; {message.to}
            </span>
          )}
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-5 text-[var(--pear-text)]">
          {message.body}
        </p>
      </div>
    </div>
  )
}
