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
    <div className="flex min-w-0 flex-1 items-center gap-2.5" data-testid="chat-title">
      {conversation.kind === 'channel' ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--pear-bg-surface)]">
          <Hash size={14} className="text-[var(--pear-text-faint)]" />
        </span>
      ) : (
        <AgentAvatar name={conversation.name} cli={conversation.cli} human={!!conversation.human} size={28} />
      )}
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-[var(--pear-text)]">{conversation.name}</span>
          {details && <span className="shrink-0 truncate text-[11px] text-[var(--pear-text-faint)]">{details}</span>}
        </div>
        {conversation.summary && (
          <p className="truncate text-[11px] text-[var(--pear-text-secondary)]" title={conversation.summary}>
            {conversation.summary}
          </p>
        )}
      </div>
    </div>
  )
}
