import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Send, User, X } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { useAgentStore } from '@/stores/agent-store'
import type {
  ChatMessage as ChatMessageType,
  ChatThreadReply
} from '@/stores/agent-store'
import { ChatMessage } from './ChatMessage'

interface ThreadPanelProps {
  message: ChatMessageType
  onClose: () => void
  onReply: (messageId: string, body: string) => void
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ReplyAvatar({ reply }: { reply: ChatThreadReply }): React.ReactNode {
  const agent = useAgentStore((state) =>
    state.agents.find((candidate) =>
      candidate.name === reply.from &&
      (!reply.projectId || candidate.projectId === reply.projectId)
    )
  )

  return (
    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)]">
      {reply.isHuman ? (
        <User size={14} className="text-[var(--pear-accent-bright)]" />
      ) : (
        <AgentHarnessIcon cli={agent?.cli} className="h-4 w-4 text-[var(--pear-text)]" />
      )}
    </div>
  )
}

function ThreadReplyRow({ reply }: { reply: ChatThreadReply }): React.ReactNode {
  return (
    <div className="flex gap-3 rounded-md px-1 py-2 hover:bg-[var(--pear-bg-surface-hover)]/45">
      <ReplyAvatar reply={reply} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-[var(--pear-accent-bright)]">
            {reply.isHuman ? 'You' : reply.from}
          </span>
          <span className="text-[10px] text-[var(--pear-text-faint)]">{formatTime(reply.timestamp)}</span>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-5 text-[var(--pear-text)]">
          {reply.body}
        </p>
      </div>
    </div>
  )
}

export function ThreadPanel({ message, onClose, onReply }: ThreadPanelProps): React.ReactNode {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const replies = message.threadReplies || []
  const canSend = text.trim().length > 0

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = '0px'
    const nextHeight = Math.min(textarea.scrollHeight, 180)
    textarea.style.height = `${Math.max(nextHeight, 72)}px`
  }, [text])

  const handleSubmit = (event?: React.FormEvent): void => {
    event?.preventDefault()
    if (!canSend) return

    onReply(message.id, text)
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
              <ThreadReplyRow key={reply.id} reply={reply} />
            ))}
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-4"
        onSubmit={handleSubmit}
      >
        <div className="rounded-md border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] p-3">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="Reply..."
            rows={3}
            className="block w-full resize-none bg-transparent text-sm leading-5 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={!canSend}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                canSend
                  ? 'bg-[var(--pear-accent)] text-[var(--pear-bg)] hover:opacity-90'
                  : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)]'
              }`}
              aria-label="Send thread reply"
            >
              <Send size={14} className="translate-x-[1px]" />
            </button>
          </div>
        </div>
      </form>
    </aside>
  )
}
