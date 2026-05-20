import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, PauseCircle, Radio, Send } from 'lucide-react'
import { pear, type PendingRelayMessage } from '@/lib/ipc'

interface PendingMessagesPaneProps {
  agentName: string
  deliveryMode: QueueDeliveryMode
  refreshToken?: string
  onDeliveryModeChange: (mode: QueueDeliveryMode) => void
}

export type QueueDeliveryMode = 'drive' | 'auto'

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
  deliveryMode,
  refreshToken,
  onDeliveryModeChange
}: PendingMessagesPaneProps): React.ReactNode {
  const [messages, setMessages] = useState<PendingRelayMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [flushing, setFlushing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

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

  const toggleDeliveryMode = (): void => {
    onDeliveryModeChange(deliveryMode === 'drive' ? 'auto' : 'drive')
  }

  if (!expanded) {
    return (
      <aside className="titlebar-nodrag flex h-full w-14 shrink-0 flex-col items-center gap-2 border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] py-2">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title="Show queued messages"
          aria-label="Show queued messages"
        >
          <ChevronLeft size={15} />
        </button>

        <button
          type="button"
          onClick={toggleDeliveryMode}
          className={`flex h-8 w-8 items-center justify-center rounded-md ${
            deliveryMode === 'drive'
              ? 'text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]'
              : 'text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
          }`}
          title={`Switch incoming to ${deliveryMode === 'drive' ? 'Live' : 'Hold'}`}
          aria-label={`Switch incoming to ${deliveryMode === 'drive' ? 'Live' : 'Hold'}`}
        >
          {deliveryMode === 'drive' ? <PauseCircle size={15} /> : <Radio size={15} />}
        </button>

        {deliveryMode === 'drive' ? (
          <div
            className={`flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs font-semibold ${
              messages.length > 0
                ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                : 'border-[var(--pear-border-subtle)] text-[var(--pear-text-faint)]'
            }`}
            title={`${messages.length} held messages`}
            aria-label={`${messages.length} held messages`}
          >
            {messages.length}
          </div>
        ) : (
          <div
            className="flex h-8 min-w-8 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] px-1.5 text-[10px] font-semibold uppercase text-[var(--pear-text-faint)]"
            title="Incoming messages are delivered as they arrive"
            aria-label="Incoming messages are delivered as they arrive"
          >
            Live
          </div>
        )}

        {deliveryMode === 'drive' && (
          <button
            type="button"
            onClick={handleFlush}
            disabled={!messages.length || flushing}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-45"
            title="Inject held messages"
            aria-label="Inject held messages"
          >
            <Send size={14} />
          </button>
        )}

        {error && (
          <div
            className="mt-auto h-2 w-2 rounded-full bg-[var(--pear-red)]"
            title={error}
            aria-label={error}
          />
        )}
      </aside>
    )
  }

  return (
    <aside className="titlebar-nodrag flex h-full w-[320px] min-w-[280px] max-w-[38%] shrink-0 flex-col border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--pear-border-subtle)] px-3">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title="Hide queued messages"
          aria-label="Hide queued messages"
        >
          <ChevronRight size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-[var(--pear-text)]">
            {deliveryMode === 'drive'
              ? `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`
              : ''}
          </div>
        </div>
        <div className="flex rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] p-0.5">
          <button
            type="button"
            onClick={() => onDeliveryModeChange('drive')}
            aria-pressed={deliveryMode === 'drive'}
            className={`flex h-7 items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${
              deliveryMode === 'drive'
                ? 'bg-[var(--pear-bg-surface-hover)] text-[var(--pear-text)]'
                : 'text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]'
            }`}
            title="Hold incoming relay messages"
          >
            <PauseCircle size={12} />
            Hold
          </button>
          <button
            type="button"
            onClick={() => onDeliveryModeChange('auto')}
            aria-pressed={deliveryMode === 'auto'}
            className={`flex h-7 items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${
              deliveryMode === 'auto'
                ? 'bg-[var(--pear-bg-surface-hover)] text-[var(--pear-text)]'
                : 'text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]'
            }`}
            title="Inject incoming relay messages as they arrive"
          >
            <Radio size={12} />
            Live
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!messages.length && !loading ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-[var(--pear-text-faint)]">
            {deliveryMode === 'drive'
              ? 'No held messages'
              : 'Incoming messages are delivered as they arrive'}
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
        {deliveryMode === 'drive' && (
          <button
            type="button"
            onClick={handleFlush}
            disabled={!messages.length || flushing}
            className="mt-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-3 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-45"
            title="Inject held messages"
          >
            <Send size={13} />
            <span>Inject held messages</span>
          </button>
        )}
      </div>
    </aside>
  )
}
