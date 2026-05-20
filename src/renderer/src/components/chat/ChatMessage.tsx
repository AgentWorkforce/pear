import type React from 'react'
import { useState } from 'react'
import { MessageCircle, SmilePlus, User } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { useAgentStore } from '@/stores/agent-store'
import type { ChatMessage as ChatMessageType } from '@/stores/agent-store'

interface Props {
  message: ChatMessageType
  showRoute?: boolean
  showActions?: boolean
  showThreadSummary?: boolean
  activeThread?: boolean
  onReply?: (message: ChatMessageType) => void
  onReact?: (messageId: string, emoji: string) => void
}

const QUICK_REACTIONS = ['✅', '👀', '👍', '🎉', '❤️', '😂']

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

function formatReplyTime(timestamp: number): string {
  const now = Date.now()
  const ageMs = now - timestamp
  if (ageMs >= 0 && ageMs < 60_000) return 'just now'
  if (ageMs >= 0 && ageMs < 3_600_000) {
    const minutes = Math.max(1, Math.floor(ageMs / 60_000))
    return `${minutes}m ago`
  }
  if (ageMs >= 0 && ageMs < 86_400_000) {
    const hours = Math.max(1, Math.floor(ageMs / 3_600_000))
    return `${hours}h ago`
  }
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

interface MessageActionsProps {
  message: ChatMessageType
  onReply?: (message: ChatMessageType) => void
  onReact?: (messageId: string, emoji: string) => void
}

function MessageActions({ message, onReply, onReact }: MessageActionsProps): React.ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false)

  if (!onReply && !onReact) return null

  return (
    <div className="absolute right-2 top-1.5 z-10 flex items-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <div className="relative flex">
        {onReact && (
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            className="flex h-8 w-8 items-center justify-center text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
            title="Add reaction"
            aria-label="Add reaction"
          >
            <SmilePlus size={15} />
          </button>
        )}
        {pickerOpen && onReact && (
          <div className="absolute right-0 top-9 z-20 flex gap-1 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-1 shadow-2xl">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  onReact(message.id, emoji)
                  setPickerOpen(false)
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-[var(--pear-bg-overlay)]"
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      {onReply && (
        <button
          type="button"
          onClick={() => onReply(message)}
          className="flex h-8 w-8 items-center justify-center border-l border-[var(--pear-border-subtle)] text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
          title="Reply in thread"
          aria-label="Reply in thread"
        >
          <MessageCircle size={15} />
        </button>
      )}
    </div>
  )
}

export function ChatMessage({
  message,
  showRoute = true,
  showActions = true,
  showThreadSummary = true,
  activeThread = false,
  onReply,
  onReact
}: Props): React.ReactNode {
  const agent = useAgentStore((state) =>
    state.agents.find((candidate) =>
      candidate.name === message.from &&
      (!message.projectId || candidate.projectId === message.projectId)
    )
  )
  const color = message.isHuman ? 'var(--pear-accent-bright)' : getAgentColor(message.from)
  const reactions = message.reactions || []
  const replies = message.threadReplies || []
  const lastReply = replies[replies.length - 1]

  return (
    <div
      className={`group relative flex gap-3 rounded-md px-2 py-1.5 ${
        activeThread ? 'bg-[var(--pear-bg-overlay)]/70' : 'hover:bg-[var(--pear-bg-surface-hover)]/45'
      }`}
    >
      {showActions && <MessageActions message={message} onReply={onReply} onReact={onReact} />}

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

      <div className={`min-w-0 flex-1 ${showActions ? 'pr-16' : ''}`}>
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

        {(reactions.length > 0 || (showThreadSummary && replies.length > 0)) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                onClick={() => onReact?.(message.id, reaction.emoji)}
                className={`flex h-7 items-center gap-1 rounded-full border px-2 text-xs ${
                  reaction.reactedByHuman
                    ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                    : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-text-secondary)] hover:border-[var(--pear-accent-dim)]'
                }`}
                aria-label={`Toggle ${reaction.emoji} reaction`}
              >
                <span>{reaction.emoji}</span>
                <span>{reaction.count}</span>
              </button>
            ))}

            {showThreadSummary && replies.length > 0 && (
              <button
                type="button"
                onClick={() => onReply?.(message)}
                className="flex h-7 items-center gap-2 rounded-full px-2 text-xs font-medium text-[var(--pear-accent-bright)] hover:bg-[var(--pear-bg-overlay)]"
              >
                <MessageCircle size={13} />
                <span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
                {lastReply && (
                  <span className="font-normal text-[var(--pear-text-faint)]">
                    Last reply {formatReplyTime(lastReply.timestamp)}
                  </span>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
