import type React from 'react'
import { Bot, User } from 'lucide-react'
import type { ChatMessage as ChatMessageType } from '@/stores/agent-store'

interface Props {
  message: ChatMessageType
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

export function ChatMessage({ message }: Props): React.ReactNode {
  const color = message.isHuman ? 'var(--pear-accent-bright)' : getAgentColor(message.from)

  return (
    <div className="group flex gap-3">
      {/* Avatar */}
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded"
        style={{ backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)` }}
      >
        {message.isHuman ? (
          <User size={12} style={{ color }} />
        ) : (
          <Bot size={12} style={{ color }} />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-medium" style={{ color }}>
            {message.isHuman ? 'You' : message.from}
          </span>
          <span className="text-[10px] text-[var(--pear-text-faint)]">
            {formatTime(message.timestamp)}
          </span>
          {message.to && !message.isHuman && (
            <span className="text-[10px] text-[var(--pear-text-faint)]">
              &rarr; {message.to}
            </span>
          )}
        </div>
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--pear-text)]">{message.body}</p>
      </div>
    </div>
  )
}
