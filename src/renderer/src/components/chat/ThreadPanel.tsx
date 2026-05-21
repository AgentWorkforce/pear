import type React from 'react'
import { useState } from 'react'
import { X } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import type { AuthUser } from '@/lib/ipc'
import { renderChatMessageBody } from '@/lib/chat-formatting'
import { useAgentStore } from '@/stores/agent-store'
import type {
  ChatMessage as ChatMessageType,
  ChatThreadReply
} from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { ChatMessage } from './ChatMessage'
import { ChatComposerInput } from './ChatComposerInput'
import { HumanAvatar } from './HumanAvatar'

interface ThreadPanelProps {
  message: ChatMessageType
  authUser?: AuthUser | null
  onClose: () => void
  onReply: (messageId: string, body: string) => void
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ReplyAvatar({
  reply,
  authUser
}: {
  reply: ChatThreadReply
  authUser?: AuthUser | null
}): React.ReactNode {
  const agent = useAgentStore((state) =>
    state.agents.find((candidate) =>
      candidate.name === reply.from &&
      (!reply.projectId || candidate.projectId === reply.projectId)
    )
  )

  if (reply.isHuman) {
    return (
      <HumanAvatar
        user={authUser}
        iconSize={14}
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)]"
      />
    )
  }

  return (
    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)]">
      <AgentHarnessIcon cli={agent?.cli} className="h-4 w-4 text-[var(--pear-text)]" />
    </div>
  )
}

function ThreadReplyRow({
  reply,
  authUser
}: {
  reply: ChatThreadReply
  authUser?: AuthUser | null
}): React.ReactNode {
  return (
    <div className="flex gap-3 rounded-md px-1 py-2 hover:bg-[var(--pear-bg-surface-hover)]/45">
      <ReplyAvatar reply={reply} authUser={authUser} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-[var(--pear-accent-bright)]">
            {reply.isHuman ? 'You' : reply.from}
          </span>
          <span className="text-[10px] text-[var(--pear-text-faint)]">{formatTime(reply.timestamp)}</span>
        </div>
        <div className="mt-0.5 space-y-1 break-words text-sm leading-5 text-[var(--pear-text)]">
          {renderChatMessageBody(reply.body)}
        </div>
      </div>
    </div>
  )
}

export function ThreadPanel({ message, authUser, onClose, onReply }: ThreadPanelProps): React.ReactNode {
  const [text, setText] = useState('')
  const agents = useAgentStore((state) => state.agents)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const replies = message.threadReplies || []
  const mentionProjectId = message.projectId || activeProjectId
  const runningAgents = agents.filter(
    (agent) => agent.status === 'running' && (!mentionProjectId || agent.projectId === mentionProjectId)
  )
  const canSend = text.trim().length > 0

  const handleSubmit = (): void => {
    if (!canSend) return

    onReply(message.id, text.trim())
    setText('')
  }

  return (
    <aside className="flex h-full w-[390px] min-w-[320px] max-w-[44vw] shrink-0 flex-col border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--pear-text)]">Thread</div>
          <div className="mt-0.5 truncate text-xs text-[var(--pear-text-faint)]">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
          title="Close thread"
          aria-label="Close thread"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ChatMessage
          message={message}
          authUser={authUser}
          showRoute={false}
          showActions={false}
          showThreadSummary={false}
        />

        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-[var(--pear-border-subtle)]" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--pear-text-faint)]">
            Replies
          </span>
          <div className="h-px flex-1 bg-[var(--pear-border-subtle)]" />
        </div>

        {replies.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--pear-border-subtle)] px-3 py-6 text-center text-sm text-[var(--pear-text-faint)]">
            No replies yet
          </div>
        ) : (
          <div className="space-y-1">
            {replies.map((reply) => (
              <ThreadReplyRow key={reply.id} reply={reply} authUser={authUser} />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-4">
        <ChatComposerInput
          value={text}
          placeholder="Reply..."
          sendLabel="Send thread reply"
          runningAgents={runningAgents}
          activeProjectId={mentionProjectId}
          canSend={canSend}
          onChange={setText}
          onSubmit={handleSubmit}
        />
      </div>
    </aside>
  )
}
