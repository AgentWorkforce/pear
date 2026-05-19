import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Send } from 'lucide-react'
import { pear, type PendingRelayMessage } from '@/lib/ipc'

interface PendingMessagesPaneProps {
  agentName: string
  refreshToken?: string
}

function formatQueuedTime(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}

export function PendingMessagesPane({
  agentName,
  refreshToken
}: PendingMessagesPaneProps): React.ReactNode {
  const [messages, setMessages] = useState<PendingRelayMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [flushing, setFlushing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPending = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setMessages(await pear.broker.getPending(agentName))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pending messages')
    } finally {
      setLoading(false)
    }
  }, [agentName])

  useEffect(() => {
    void loadPending()
    const timer = window.setInterval(() => void loadPending(), 2500)
    return () => window.clearInterval(timer)
  }, [loadPending, refreshToken])

  const handleFlush = async (): Promise<void> => {
    if (!messages.length || flushing) return
    setFlushing(true)
    setError(null)
    try {
      await pear.broker.flushPending(agentName)
      await loadPending()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inject pending messages')
    } finally {
      setFlushing(false)
    }
  }

  return (
    <aside className="titlebar-nodrag flex h-full w-[320px] min-w-[280px] max-w-[38%] shrink-0 flex-col border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--pear-border-subtle)] px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-[var(--pear-text)]">Queued</div>
          <div className="text-[11px] text-[var(--pear-text-faint)]">{messages.length} pending</div>
        </div>
        <button
          type="button"
          onClick={() => void loadPending()}
          disabled={loading}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-45"
          title="Refresh queued messages"
          aria-label="Refresh queued messages"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          onClick={handleFlush}
          disabled={!messages.length || flushing}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-45"
          title="Inject queued messages"
        >
          <Send size={13} />
          <span>Inject</span>
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!messages.length && !loading ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-[var(--pear-text-faint)]">
            No queued messages
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((message, index) => {
              const queuedAt = formatQueuedTime(message.queued_at_ms)
              return (
                <article
                  key={message.event_id || `${message.from}-${message.queued_at_ms}-${index}`}
                  className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] p-3"
                >
                  <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--pear-text-faint)]">
                    <span className="min-w-0 flex-1 truncate text-[var(--pear-text-secondary)]">
                      {message.from}
                    </span>
                    <span className="shrink-0">{message.mode}</span>
                    {queuedAt && <span className="shrink-0">{queuedAt}</span>}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-xs leading-5 text-[var(--pear-text)]">
                    {message.body}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
