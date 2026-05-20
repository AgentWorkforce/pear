import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Inbox, PauseCircle, Radio, Send } from 'lucide-react'
import { pear, type PendingRelayMessage } from '@/lib/ipc'
import { useAgentStore, type ChatMessage } from '@/stores/agent-store'

interface PendingMessagesMenuProps {
  projectId?: string
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

function isIncomingAgentMessage(message: ChatMessage, agentName: string): boolean {
  return message.to === agentName || (message.to === '*' && message.from !== agentName)
}

function formatMessageRoute(message: ChatMessage): string {
  if (message.to === '*') return 'broadcast'
  return `to ${message.to}`
}

export function PendingMessagesMenu({
  projectId,
  agentName,
  deliveryMode,
  refreshToken,
  onDeliveryModeChange
}: PendingMessagesMenuProps): React.ReactNode {
  const allMessages = useAgentStore((s) => s.messages)
  const [heldMessages, setHeldMessages] = useState<PendingRelayMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [flushing, setFlushing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const agentMessages = useMemo(
    () => allMessages.filter((message) => isIncomingAgentMessage(message, agentName)),
    [agentName, allMessages]
  )
  const recentMessages = useMemo(
    () => agentMessages.slice(-8).reverse(),
    [agentMessages]
  )

  const loadPending = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setHeldMessages(await pear.broker.getPending(projectId, agentName))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load held messages')
    } finally {
      setLoading(false)
    }
  }, [agentName, projectId])

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
    if (!heldMessages.length || flushing) return
    setFlushing(true)
    setError(null)
    try {
      await pear.broker.flushPending(projectId, agentName)
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
  }

  const modeIsHeld = deliveryMode === 'drive'
  const totalMessageCount = agentMessages.length + heldMessages.length
  const countActive = modeIsHeld ? heldMessages.length > 0 : totalMessageCount > 0
  const emptyHeldCount = modeIsHeld && totalMessageCount === 0
  const emptyLiveCount = !modeIsHeld && totalMessageCount === 0
  const primaryCountLabel = modeIsHeld
    ? emptyHeldCount
      ? '0'
      : `${heldMessages.length} held`
    : emptyLiveCount
      ? '0'
      : `${totalMessageCount} total`
  const secondaryCountLabel = modeIsHeld && !emptyHeldCount ? `${totalMessageCount} total` : null
  const dropdownCountLabel = modeIsHeld
    ? emptyHeldCount
      ? '0 messages'
      : `${heldMessages.length} held / ${totalMessageCount} total message${totalMessageCount === 1 ? '' : 's'}`
    : `${totalMessageCount} message${totalMessageCount === 1 ? '' : 's'}`
  const hasHeldMessages = heldMessages.length > 0
  const hasRecentMessages = recentMessages.length > 0
  const showEmptyState = !loading && !hasHeldMessages && !hasRecentMessages
  const showLoadingState = loading && !hasHeldMessages && !hasRecentMessages
  const showHeldSection = hasHeldMessages
  const showRecentSection = hasRecentMessages

  return (
    <div
      ref={menuRef}
      className="titlebar-nodrag relative ml-auto flex shrink-0 items-center gap-1.5"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors ${
          countActive
            ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]'
            : 'border-[var(--pear-border-subtle)] text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
        }`}
        title="Show messages"
      >
        <Inbox size={12} />
        <span>{primaryCountLabel}</span>
        {secondaryCountLabel && (
          <span className="text-[var(--pear-text-faint)]">{secondaryCountLabel}</span>
        )}
      </button>

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

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-[340px] max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] shadow-2xl">
          <div className="flex h-10 items-center gap-2 border-b border-[var(--pear-border-subtle)] px-3">
            <div className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--pear-text)]">
              {dropdownCountLabel}
            </div>
            {hasHeldMessages && (
              <button
                type="button"
                onClick={() => void handleFlush()}
                disabled={!heldMessages.length || flushing}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2 text-[11px] text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-45"
                title="Inject held messages"
              >
                <Send size={12} />
                <span>{flushing ? 'Injecting' : 'Inject'}</span>
              </button>
            )}
          </div>

          {error && (
            <div className="m-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
              {error}
            </div>
          )}

          <div className="max-h-[320px] overflow-y-auto p-3">
            {showEmptyState ? (
              <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-6 text-center text-xs text-[var(--pear-text-faint)]">
                No messages
              </div>
            ) : showLoadingState ? (
              <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-6 text-center text-xs text-[var(--pear-text-faint)]">
                Loading messages
              </div>
            ) : (
              <>
                {showHeldSection && (
                  <section>
                    <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-[var(--pear-text-faint)]">
                      <span>Held</span>
                      <span>{heldMessages.length}</span>
                    </div>
                    <div className="space-y-2">
                      {heldMessages.map((message, index) => {
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
                  </section>
                )}

                {showRecentSection && (
                  <section
                    className={showHeldSection ? 'mt-3 border-t border-[var(--pear-border-subtle)] pt-3' : ''}
                  >
                    <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-[var(--pear-text-faint)]">
                      <span>Recent</span>
                      <span>{agentMessages.length}</span>
                    </div>
                    <div className="space-y-2">
                      {recentMessages.map((message) => {
                        const sentAt = formatQueuedTime(message.timestamp)
                        return (
                          <article
                            key={message.id}
                            className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] p-3"
                          >
                            <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--pear-text-faint)]">
                              <span className="min-w-0 flex-1 truncate text-[var(--pear-text-secondary)]">
                                {message.isHuman ? 'You' : message.from}
                              </span>
                              <span className="shrink-0">{formatMessageRoute(message)}</span>
                              {sentAt && <span className="shrink-0">{sentAt}</span>}
                            </div>
                            <div className="whitespace-pre-wrap break-words text-xs leading-5 text-[var(--pear-text)]">
                              {message.body}
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
