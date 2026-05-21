import type React from 'react'
import { useState } from 'react'
import { MessageCircle, SmilePlus } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import type { AuthUser } from '@/lib/ipc'
import { renderChatMessageBody } from '@/lib/chat-formatting'
import { useAgentStore } from '@/stores/agent-store'
import type {
  ChatMessage as ChatMessageType,
  ChatThreadReply
} from '@/stores/agent-store'
import { HumanAvatar } from './HumanAvatar'

interface Props {
  message: ChatMessageType
  showRoute?: boolean
  showActions?: boolean
  showThreadSummary?: boolean
  activeThread?: boolean
  authUser?: AuthUser | null
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

function participantKey(participant: Pick<ChatThreadReply, 'from' | 'isHuman' | 'projectId'>): string {
  return `${participant.projectId || 'unknown'}:${participant.isHuman ? 'human' : participant.from}`
}

function threadParticipants(replies: ChatThreadReply[]): ChatThreadReply[] {
  const participants: ChatThreadReply[] = []
  const seen = new Set<string>()

  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const reply = replies[index]
    const key = participantKey(reply)
    if (seen.has(key)) continue

    seen.add(key)
    participants.unshift(reply)
    if (participants.length === 2) break
  }

  return participants
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

function InlineReactionButton({
  messageId,
  onReact
}: {
  messageId: string
  onReact: (messageId: string, emoji: string) => void
}): React.ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setPickerOpen((open) => !open)}
        className="flex h-7 w-9 items-center justify-center rounded-full border border-transparent bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
        title="Add reaction"
        aria-label="Add reaction"
      >
        <SmilePlus size={16} />
      </button>
      {pickerOpen && (
        <div className="absolute left-0 top-8 z-20 flex gap-1 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-1 shadow-2xl">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onReact(messageId, emoji)
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
  )
}

function ThreadParticipantAvatar({
  participant,
  authUser
}: {
  participant: ChatThreadReply
  authUser?: AuthUser | null
}): React.ReactNode {
  const agent = useAgentStore((state) =>
    state.agents.find((candidate) =>
      candidate.name === participant.from &&
      (!participant.projectId || candidate.projectId === participant.projectId)
    )
  )

  if (participant.isHuman) {
    return (
      <HumanAvatar
        user={authUser}
        iconSize={11}
        className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-[var(--pear-bg)] bg-[var(--pear-bg-overlay)]"
      />
    )
  }

  const color = getAgentColor(participant.from)

  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 border-[var(--pear-bg)]"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 22%, var(--pear-bg))` }}
      title={participant.from}
      aria-label={participant.from}
    >
      <AgentHarnessIcon cli={agent?.cli} className="h-3.5 w-3.5 text-[var(--pear-text)]" />
    </span>
  )
}

function ThreadSummary({
  message,
  replies,
  authUser,
  onReply
}: {
  message: ChatMessageType
  replies: ChatThreadReply[]
  authUser?: AuthUser | null
  onReply?: (message: ChatMessageType) => void
}): React.ReactNode {
  const lastReply = replies[replies.length - 1]
  const participants = threadParticipants(replies)

  return (
    <button
      type="button"
      onClick={() => onReply?.(message)}
      className="flex min-h-7 max-w-full items-center gap-2 rounded-md pr-2 text-left text-xs font-medium hover:bg-[var(--pear-bg-overlay)]"
    >
      <span className="flex shrink-0 -space-x-1">
        {participants.map((participant) => (
          <ThreadParticipantAvatar
            key={participantKey(participant)}
            participant={participant}
            authUser={authUser}
          />
        ))}
      </span>
      <span className="shrink-0 text-[var(--pear-accent-bright)]">
        {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
      </span>
      {lastReply && (
        <span className="min-w-0 truncate font-normal text-[var(--pear-text-faint)]">
          {formatReplyTime(lastReply.timestamp)}
        </span>
      )}
    </button>
  )
}

export function ChatMessage({
  message,
  showRoute = true,
  showActions = true,
  showThreadSummary = true,
  activeThread = false,
  authUser,
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

  if (message.kind === 'notice') {
    return (
      <div className="flex justify-center px-2 py-2">
        <div className="flex max-w-full items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/45 px-2.5 py-1 text-xs text-[var(--pear-text-faint)]">
          <span className="truncate">{message.body}</span>
          <span className="shrink-0 text-[10px]">{formatTime(message.timestamp)}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`group relative flex gap-3 rounded-md px-2 py-1.5 ${
        activeThread ? 'bg-[var(--pear-bg-overlay)]/70' : 'hover:bg-[var(--pear-bg-surface-hover)]/45'
      }`}
    >
      {showActions && <MessageActions message={message} onReply={onReply} onReact={onReact} />}

      {message.isHuman ? (
        <HumanAvatar
          user={authUser}
          color={color}
          iconSize={15}
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--pear-border-subtle)]"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)` }}
        />
      ) : (
        <div
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)]"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)` }}
        >
          <AgentHarnessIcon
            cli={agent?.cli}
            className="h-5 w-5 text-[var(--pear-text)]"
          />
        </div>
      )}

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
        <div className="mt-0.5 space-y-1 break-words text-sm leading-5 text-[var(--pear-text)]">
          {renderChatMessageBody(message.body)}
        </div>

        {(reactions.length > 0 || (showThreadSummary && replies.length > 0)) && (
          <div className="mt-2 space-y-2">
            {reactions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {reactions.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    type="button"
                    onClick={() => onReact?.(message.id, reaction.emoji)}
                    className={`flex h-7 items-center gap-1 rounded-full border px-2 text-xs font-semibold ${
                      reaction.reactedByHuman
                        ? 'border-transparent bg-[var(--pear-accent-dim)] text-white hover:brightness-110'
                        : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text-secondary)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]'
                    }`}
                    aria-label={`Toggle ${reaction.emoji} reaction`}
                  >
                    <span>{reaction.emoji}</span>
                    <span>{reaction.count}</span>
                  </button>
                ))}

                {onReact && (
                  <InlineReactionButton messageId={message.id} onReact={onReact} />
                )}
              </div>
            )}

            {showThreadSummary && replies.length > 0 && (
              <ThreadSummary
                message={message}
                replies={replies}
                authUser={authUser}
                onReply={onReply}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
