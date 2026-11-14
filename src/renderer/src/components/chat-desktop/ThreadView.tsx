import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Download, FileText, Loader2, Pencil } from 'lucide-react'
import { formatChatDateDivider, isSameChatDay } from '@/components/chat/ChatView'
import { AgentAvatar } from '@/components/common/AgentAvatar'
import { HumanAvatar } from '@/components/chat/HumanAvatar'
import { useAuthUser } from '@/lib/auth-user'
import { useChatStore, type ChatPendingMessage } from '@/stores/chat-store'
import type { RelayChatAttachment, RelayChatMessage, SessionTranscriptTurn } from '@/lib/ipc'

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

function formatRowTime(createdAt: string): string {
  const at = Date.parse(createdAt)
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
}

const AVATAR_SIZE = 32

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
const EMPTY_TURNS: SessionTranscriptTurn[] = []

export function ThreadView({ conversationId }: { conversationId: string }): React.ReactNode {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId))
  const messages = useChatStore((s) => s.history[conversationId] ?? EMPTY_MESSAGES)
  const sessionTurns = useChatStore((s) => s.sessionTurns[conversationId] ?? EMPTY_TURNS)
  const authUser = useAuthUser()
  const error = useChatStore((s) => s.historyError[conversationId])
  const loading = useChatStore((s) =>
    Boolean(s.historyLoading[conversationId]) || (!s.history[conversationId] && !s.historyError[conversationId])
  )
  const pending = useChatStore((s) => s.pending[conversationId] ?? EMPTY_PENDING)
  const delivery = useChatStore((s) => s.delivery)
  const editFailedPending = useChatStore((s) => s.editFailedPending)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, sessionTurns.length, pending.length, conversationId])

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--pear-text-faint)]">
        Conversation not found
      </div>
    )
  }

  const spoken = [
    ...sessionTurns.map((turn) => ({
      key: `session:${turn.id}`,
      message: undefined,
      mine: turn.role === 'user',
      from: turn.role === 'user' ? 'you' : conversation.name,
      text: turn.text,
      createdAt: turn.timestampMs ? new Date(turn.timestampMs).toISOString() : '',
      attachments: [] as RelayChatAttachment[]
    })),
    ...messages.map((message) => ({
      key: message.id,
      message,
      mine: message.mine,
      from: message.from,
      text: message.text,
      createdAt: message.createdAt,
      attachments: message.attachments || []
    }))
  ].sort((left, right) => {
    const leftAt = Date.parse(left.createdAt)
    const rightAt = Date.parse(right.createdAt)
    const leftOk = Number.isFinite(leftAt)
    const rightOk = Number.isFinite(rightAt)
    if (leftOk && rightOk && leftAt !== rightAt) return leftAt - rightAt
    if (leftOk !== rightOk) return leftOk ? 1 : -1
    return 0
  })

  const rows: ThreadRow[] = []
  let previousAt = 0
  let previousFrom = ''
  spoken.forEach((message, index) => {
    const at = Date.parse(message.createdAt)
    const speaker = message.mine ? '\u0000you' : message.from
    const dayChanged = index === 0 || !isSameChatDay(previousAt, Number.isFinite(at) ? at : previousAt)
    const grouped =
      index > 0 &&
      speaker === previousFrom &&
      Number.isFinite(at) &&
      at - previousAt <= CHAT_GROUP_WINDOW_MS
    rows.push({
      key: message.key,
      message: message.message,
      mine: message.mine,
      from: message.from,
      text: message.text,
      createdAt: message.createdAt,
      attachments: message.attachments,
      showDayDivider: dayChanged && Number.isFinite(at),
      dayDividerAt: Number.isFinite(at) ? at : Date.now(),
      showSender: !grouped
    })
    if (Number.isFinite(at)) previousAt = at
    previousFrom = speaker
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
      <div className="mx-auto w-full max-w-3xl">
      {loading && rows.length === 0 && (
        <div aria-busy="true" className="flex flex-col gap-3 py-4">
          <p className="flex items-center justify-center gap-2 text-sm text-[var(--pear-text-faint)]">
            <Loader2 size={14} className="animate-spin" />
            {conversation.sessionId ? 'Loading conversation and session…' : 'Loading conversation…'}
          </p>
          {['w-2/3', 'ml-auto w-1/2', 'w-3/5'].map((width) => (
            <div key={width} className={`h-10 animate-pulse rounded-lg bg-[var(--pear-bg-overlay)] ${width}`} />
          ))}
        </div>
      )}
      {loading && rows.length > 0 && (
        <p className="sticky top-0 z-10 mx-auto mb-2 flex w-fit items-center gap-1.5 rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-1 text-[11px] text-[var(--pear-text-faint)]">
          <Loader2 size={11} className="animate-spin" />
          Updating…
        </p>
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
              className={`flex gap-2.5 ${row.mine ? 'justify-end' : 'justify-start'} ${row.showSender ? 'mt-4' : 'mt-1'}`}
            >
              {!row.mine && (
                <span className="shrink-0" style={{ width: AVATAR_SIZE }}>
                  {row.showSender && (
                    <AgentAvatar
                      name={row.from}
                      cli={row.from === conversation.name ? conversation.cli : undefined}
                      human={row.from === conversation.name && !!conversation.human}
                      size={AVATAR_SIZE}
                    />
                  )}
                </span>
              )}
              <div className={`flex max-w-[78%] flex-col ${row.mine ? 'items-end' : 'items-start'}`}>
                {row.showSender && (
                  <span className={`mb-1 flex items-baseline gap-2 text-[11px] ${row.mine ? 'flex-row-reverse' : ''}`}>
                    <span className="font-semibold text-[var(--pear-text-secondary)]">
                      {row.mine ? 'You' : row.from}
                    </span>
                    <span className="text-[var(--pear-text-faint)]">{formatRowTime(row.createdAt)}</span>
                  </span>
                )}
                <div
                  data-testid="message-body"
                  {...(failed
                    ? {
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => editFailedPending(row.pending?.localId || ''),
                      onKeyDown: (event: KeyboardEvent) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          editFailedPending(row.pending?.localId || '')
                        }
                      }
                    }
                    : {})}
                  title={failed ? 'Tap to edit and retry' : undefined}
                  className={`select-text whitespace-pre-wrap break-words px-3.5 py-2 text-left text-sm leading-relaxed ${
                    row.mine
                      ? 'rounded-2xl rounded-tr-md bg-[var(--pear-accent-dim)] text-[var(--pear-text)]'
                      : 'rounded-2xl rounded-tl-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text)]'
                  } ${failed ? 'cursor-pointer border border-dashed border-[var(--pear-red)]' : 'cursor-default'}`}
                >
                  {linkifyText(row.text)}
                  {row.attachments.map((attachment) => (
                    <AttachmentRow key={attachment.file_id} attachment={attachment} />
                  ))}
                </div>
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
              {row.mine && (
                <span className="shrink-0" style={{ width: AVATAR_SIZE }}>
                  {row.showSender && (
                    <HumanAvatar
                      user={authUser}
                      iconSize={Math.round(AVATAR_SIZE * 0.55)}
                      className="flex items-center justify-center overflow-hidden rounded-lg bg-[var(--pear-bg)]/60"
                      style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
                    />
                  )}
                </span>
              )}
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}
