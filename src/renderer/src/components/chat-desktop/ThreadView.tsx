import { useEffect, useRef } from 'react'
import { Download, FileText, Pencil } from 'lucide-react'
import { formatChatDateDivider, isSameChatDay } from '@/components/chat/ChatView'
import { useChatStore, type ChatPendingMessage } from '@/stores/chat-store'
import type { RelayChatAttachment, RelayChatMessage } from '@/lib/ipc'

/** Consecutive same-sender rows within 15 minutes render as one group. */
export const CHAT_GROUP_WINDOW_MS = 15 * 60 * 1_000

const URL_PATTERN = /(https?:\/\/[^\s<>"')]+)/g

export function linkifyText(text: string): React.ReactNode[] {
  const parts = text.split(URL_PATTERN)
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--pear-accent-bright)] underline"
        >
          {part}
        </a>
      )
    }
    return <span key={index}>{part}</span>
  })
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function AttachmentRow({ attachment }: { attachment: RelayChatAttachment }): React.ReactNode {
  const label = `${attachment.filename}${formatBytes(attachment.size_bytes) ? ` · ${formatBytes(attachment.size_bytes)}` : ''}`
  const body = (
    <>
      <FileText size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {attachment.downloadUrl && <Download size={13} className="shrink-0" />}
    </>
  )
  const classes =
    'mt-1.5 flex max-w-xs items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/50 px-2 py-1.5 text-xs text-[var(--pear-text-secondary)] hover:border-[var(--pear-accent-dim)]'
  if (attachment.downloadUrl) {
    return (
      <a href={attachment.downloadUrl} download={attachment.filename} className={classes}>
        {body}
      </a>
    )
  }
  return <span className={classes}>{body}</span>
}

function SenderChip({ name }: { name: string }): React.ReactNode {
  return (
    <span className="mb-1 flex items-center gap-1.5">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-[var(--pear-bg-overlay)] text-[10px] font-bold text-[var(--pear-text-secondary)]">
        {(name || '?').slice(0, 1).toUpperCase()}
      </span>
      <span className="text-[11px] font-semibold text-[var(--pear-text-secondary)]">{name}</span>
    </span>
  )
}

interface ThreadRow {
  key: string
  message?: RelayChatMessage
  pending?: ChatPendingMessage
  mine: boolean
  from: string
  text: string
  createdAt: string
  attachments: RelayChatAttachment[]
  showDayDivider: boolean
  dayDividerAt: number
  showSender: boolean
}

const EMPTY_MESSAGES: RelayChatMessage[] = []
const EMPTY_PENDING: ChatPendingMessage[] = []

export function ThreadView({ conversationId }: { conversationId: string }): React.ReactNode {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId))
  const messages = useChatStore((s) => s.history[conversationId] ?? EMPTY_MESSAGES)
  const loading = useChatStore((s) => s.historyLoading[conversationId] || false)
  const error = useChatStore((s) => s.historyError[conversationId])
  const pending = useChatStore((s) => s.pending[conversationId] ?? EMPTY_PENDING)
  const delivery = useChatStore((s) => s.delivery)
  const editFailedPending = useChatStore((s) => s.editFailedPending)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, pending.length, conversationId])

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--pear-text-faint)]">
        Conversation not found
      </div>
    )
  }

  const rows: ThreadRow[] = []
  let previousAt = 0
  let previousFrom = ''
  messages.forEach((message, index) => {
    const at = Date.parse(message.createdAt)
    const dayChanged = index === 0 || !isSameChatDay(previousAt, Number.isFinite(at) ? at : previousAt)
    const grouped =
      index > 0 &&
      message.from === previousFrom &&
      Number.isFinite(at) &&
      at - previousAt <= CHAT_GROUP_WINDOW_MS
    rows.push({
      key: message.id,
      message,
      mine: message.mine,
      from: message.from,
      text: message.text,
      createdAt: message.createdAt,
      attachments: message.attachments || [],
      showDayDivider: dayChanged,
      dayDividerAt: Number.isFinite(at) ? at : Date.now(),
      showSender: !grouped
    })
    if (Number.isFinite(at)) previousAt = at
    previousFrom = message.from
  })
  for (const item of pending) {
    rows.push({
      key: item.localId,
      pending: item,
      mine: true,
      from: 'you',
      text: item.text,
      createdAt: item.createdAt,
      attachments: [],
      showDayDivider: false,
      dayDividerAt: 0,
      showSender: false
    })
  }

  // Delivery label goes under the last message the companion sent.
  let lastOwnServerId: string | null = null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.mine && row.message && !row.pending) {
      lastOwnServerId = row.message.id
      break
    }
  }

  return (
    <div ref={scrollRef} data-testid="thread-scroll" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {loading && rows.length === 0 && (
        <p className="py-10 text-center text-sm text-[var(--pear-text-faint)]">Loading history…</p>
      )}
      {error && (
        <p className="py-10 text-center text-sm text-[var(--pear-red)]">{error}</p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p className="py-10 text-center text-sm text-[var(--pear-text-faint)]">
          No messages yet. Say hello inside this thread.
        </p>
      )}
      {rows.map((row) => {
        const failed = row.pending?.status === 'failed'
        return (
          <div key={row.key}>
            {row.showDayDivider && (
              <div className="relative my-4 flex items-center justify-center">
                <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--pear-border-subtle)]" />
                <span className="relative rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-1 text-xs font-medium text-[var(--pear-text-secondary)]">
                  {formatChatDateDivider(row.dayDividerAt)}
                </span>
              </div>
            )}
            <div
              data-testid="thread-row"
              data-mine={row.mine ? 'true' : 'false'}
              className={`mb-1.5 flex ${row.mine ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[75%] ${row.mine ? 'items-end' : 'items-start'} flex flex-col`}>
                {!row.mine && row.showSender && <SenderChip name={row.from} />}
                <button
                  type="button"
                  disabled={!failed}
                  onClick={failed ? () => editFailedPending(row.pending?.localId || '') : undefined}
                  title={failed ? 'Tap to edit and retry' : undefined}
                  className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-left text-sm ${
                    row.mine
                      ? 'bg-[var(--pear-accent-dim)] text-[var(--pear-text)]'
                      : 'border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text)]'
                  } ${failed ? 'cursor-pointer border border-dashed border-[var(--pear-red)]' : 'cursor-default'}`}
                >
                  {linkifyText(row.text)}
                  {row.attachments.map((attachment) => (
                    <AttachmentRow key={attachment.file_id} attachment={attachment} />
                  ))}
                </button>
                {row.pending && (
                  <span className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--pear-text-faint)]">
                    {failed ? (
                      <>
                        <Pencil size={11} />
                        <span>
                          Failed{row.pending.error ? `: ${row.pending.error}` : ''} — tap to edit
                        </span>
                      </>
                    ) : (
                      <span>Sending…</span>
                    )}
                  </span>
                )}
                {!row.pending &&
                  row.mine &&
                  row.message?.id === lastOwnServerId &&
                  delivery[row.message.id] !== undefined && (
                    <span className="mt-0.5 text-[11px] text-[var(--pear-text-faint)]">
                      {delivery[row.message.id] ? 'Delivered' : 'Sent'}
                    </span>
                  )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
