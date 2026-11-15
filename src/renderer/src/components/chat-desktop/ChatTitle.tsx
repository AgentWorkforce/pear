import type React from 'react'
import { Hash } from 'lucide-react'
import { AgentAvatar } from '@/components/common/AgentAvatar'
import { useChatStore } from '@/stores/chat-store'
import type { RelayChatConversation } from '@/lib/ipc'

/** "claude · online · relay-app · Finn-Mac-Mini" */
export function conversationDetails(conversation: RelayChatConversation): string {
  if (conversation.kind === 'channel') return 'Channel'
  return [
    conversation.human ? 'person' : conversation.cli,
    conversation.status,
    conversation.project,
    conversation.machine
  ].filter(Boolean).join(' · ')
}

/** The open conversation, shown in the title bar: who it is, where it runs, and what it's working on. */
export function ChatTitle(): React.ReactNode {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.selectedId))
  if (!conversation) return null
  const details = conversationDetails(conversation)
  return (
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-3.5 border-l border-[var(--pear-border-subtle)] pl-5 pr-4"
      data-testid="chat-title"
    >
      {conversation.kind === 'channel' ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--pear-bg-surface)]">
          <Hash size={16} className="text-[var(--pear-text-faint)]" />
        </span>
      ) : (
        <span className="shrink-0">
          <AgentAvatar name={conversation.name} cli={conversation.cli} human={!!conversation.human} size={32} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[5px] py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-[13px] font-semibold leading-[18px] text-[var(--pear-text)]">{conversation.name}</span>
          {details && (
            <span className="min-w-0 truncate text-[11px] leading-[18px] text-[var(--pear-text-faint)]">{details}</span>
          )}
        </div>
        {conversation.summary && (
          <p className="truncate text-[11.5px] leading-[15px] text-[var(--pear-text-secondary)]" title={conversation.summary}>
            {conversation.summary}
          </p>
        )}
      </div>
    </div>
  )
}
