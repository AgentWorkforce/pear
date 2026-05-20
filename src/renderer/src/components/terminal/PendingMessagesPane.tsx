import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Inbox, PauseCircle, Radio, Send } from 'lucide-react'
import { pear, type PendingRelayMessage } from '@/lib/ipc'

interface PendingMessagesMenuProps {
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

export function PendingMessagesMenu({
  agentName,
  deliveryMode,
  refreshToken,
  onDeliveryModeChange
}: PendingMessagesMenuProps): React.ReactNode {
  const [messages, setMessages] = useState<PendingRelayMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [flushing, setFlushing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const loadPending = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setMessages(await pear.broker.getPending(agentName))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load held messages')
    } finally {
      setLoading(false)
    }
  }, [agentName])

  useEffect(() => {
    void loadPending()
    const timer = window.setInterval(() => void loadPending(), 2500)
    return () => window.clearInterval(timer)
  }, [loadPending, refreshToken])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const handleFlush = async (): Promise<void> => {
    if (!messages.length || flushing) return
    setFlushing(true)
    setError(null)
    try {
      await pear.broker.flushPending(agentName)
      await loadPending()
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inject held messages')
    } finally {
      setFlushing(false)
    }
  }

  const handleModeChange = (mode: QueueDeliveryMode): void => {
    if (mode === deliveryMode) return
    onDeliveryModeChange(mode)
    if (mode === 'auto') {
      setOpen(false)
    }
  }

  const modeIsHeld = deliveryMode === 'drive'
  const countLabel = `${messages.length} held`

  return (
    <div
      ref={menuRef}
      className="titlebar-nodrag relative ml-auto flex shrink-0 items-center gap-1.5"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {modeIsHeld && (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors ${
            messages.length > 0
              ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]'
              : 'border-[var(--pear-border-subtle)] text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
          }`}
          title="Show held messages"
        >
          <Inbox size={12} />
          <span>{countLabel}</span>
        </button>
      )}

      <div className="flex rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] p-0.5">
        <button
          type="button"
          onClick={() => handleModeChange('drive')}
          aria-pressed={modeIsHeld}
          className={`flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${
            modeIsHeld
              ? 'bg-[var(--pear-bg-surface-hover)] text-[var(--pear-text)]'
              : 'text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]'
          }`}
          title="Hold incoming messages"
        >
          <PauseCircle size={12} />
          <span>Hold</span>
        </button>
        <button
          type="button"
          onClick={() => handleModeChange('auto')}
          aria-pressed={!modeIsHeld}
          className={`flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${
            !modeIsHeld
              ? 'bg-[var(--pear-bg-surface-hover)] text-[var(--pear-text)]'
              : 'text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]'
          }`}
          title="Live incoming messages"
        >
          <Radio size={12} />
          <span>Live</span>
        </button>
      </div>

      {error && (
        <div
          className="h-2 w-2 rounded-full bg-[var(--pear-red)]"
          title={error}
          aria-label={error}
        />
      )}

      {open && modeIsHeld && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-[340px] max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] shadow-2xl">
          <div className="flex h-10 items-center gap-2 border-b border-[var(--pear-border-subtle)] px-3">
            <div className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--pear-text)]">
              {messages.length} held message{messages.length === 1 ? '' : 's'}
            </div>
            <button
              type="button"
              onClick={() => void handleFlush()}
              disabled={!messages.length || flushing}
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2 text-[11px] text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-45"
              title="Inject held messages"
            >
              <Send size={12} />
              <span>{flushing ? 'Injecting' : 'Inject'}</span>
            </button>
          </div>

          {error && (
            <div className="m-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
              {error}
            </div>
          )}

          <div className="max-h-[320px] overflow-y-auto p-3">
            {!messages.length && !loading ? (
              <div className="flex h-24 items-center justify-center text-center text-xs text-[var(--pear-text-faint)]">
                No held messages
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
        </div>
      )}
    </div>
  )
}
