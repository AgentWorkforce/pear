import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Sun, Moon, X } from 'lucide-react'
import { useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'

const errorTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

function formatErrorTimestamp(timestamp: number): string {
  return errorTimeFormatter.format(new Date(timestamp))
}

export function StatusBar(): React.ReactNode {
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const brokerError = useAgentStore((s) => s.brokerError)
  const brokerErrors = useAgentStore((s) => s.brokerErrors)
  const agents = useAgentStore((s) => s.agents)
  const workspace = useWorkspaceStore((s) => s.getActiveWorkspace())
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const [isErrorPanelOpen, setIsErrorPanelOpen] = useState(false)
  const errorButtonRef = useRef<HTMLButtonElement>(null)
  const errorPanelRef = useRef<HTMLDivElement>(null)

  const runningAgents = agents.filter(
    (a) => a.status === 'running' && (!workspace || a.workspaceId === workspace.id)
  ).length
  const canOpenErrorPanel = brokerStatus === 'error' || brokerErrors.length > 0
  const latestError = brokerError || brokerErrors[0]?.message || null
  const historicalErrors =
    latestError && brokerErrors[0]?.message === latestError ? brokerErrors.slice(1) : brokerErrors
  const statusTitle = latestError
    ? `${latestError}${canOpenErrorPanel ? ' Click to view recent broker errors.' : ''}`
    : `Broker status: ${brokerStatus}`

  const statusColor =
    brokerStatus === 'connected'
      ? 'bg-[var(--pear-accent)]'
      : brokerStatus === 'error'
        ? 'bg-[var(--pear-red)]'
        : 'bg-[var(--pear-text-faint)]'

  useEffect(() => {
    if (!isErrorPanelOpen) return

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (errorPanelRef.current?.contains(target) || errorButtonRef.current?.contains(target)) {
        return
      }
      setIsErrorPanelOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsErrorPanelOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isErrorPanelOpen])

  useEffect(() => {
    if (!canOpenErrorPanel && isErrorPanelOpen) {
      setIsErrorPanelOpen(false)
    }
  }, [canOpenErrorPanel, isErrorPanelOpen])

  return (
    <div className="relative flex h-[38px] shrink-0 items-center gap-6 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-6 text-xs text-[var(--pear-text-dim)]">
      <div className="relative">
        {canOpenErrorPanel ? (
          <button
            ref={errorButtonRef}
            type="button"
            title={statusTitle}
            aria-haspopup="dialog"
            aria-expanded={isErrorPanelOpen}
            aria-label={`Broker status ${brokerStatus}. Open error details.`}
            onClick={() => setIsErrorPanelOpen((open) => !open)}
            className={`flex items-center gap-2 rounded-full px-2.5 py-1 transition-colors ${
              brokerStatus === 'error'
                ? 'border border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 text-[var(--pear-text)] hover:bg-[var(--pear-red)]/15'
                : 'hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]'
            }`}
          >
            <div className={`h-2 w-2 rounded-full ${statusColor}`} />
            <span>{brokerStatus}</span>
            {brokerErrors.length > 1 && (
              <span className="rounded-full bg-[var(--pear-bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--pear-text-secondary)]">
                {brokerErrors.length}
              </span>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-2" title={statusTitle}>
            <div className={`h-2 w-2 rounded-full ${statusColor}`} />
            <span>{brokerStatus}</span>
          </div>
        )}

        {isErrorPanelOpen && canOpenErrorPanel && (
          <div
            ref={errorPanelRef}
            role="dialog"
            aria-label="Broker errors"
            className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-[380px] overflow-hidden rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--pear-border-subtle)] px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-[var(--pear-text)]">Broker errors</p>
                <p className="mt-0.5 text-[11px] text-[var(--pear-text-faint)]">
                  Latest broker failures captured during this session.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsErrorPanelOpen(false)}
                aria-label="Close broker errors"
                className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
              >
                <X size={14} />
              </button>
            </div>

            <div className="max-h-[320px] overflow-y-auto p-4">
              {latestError && (
                <div className="rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--pear-red)]" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--pear-red)]">
                        {brokerStatus === 'error' ? 'Current issue' : 'Latest issue'}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--pear-text)]">{latestError}</p>
                      {brokerErrors[0] && (
                        <p className="mt-2 text-[11px] text-[var(--pear-text-faint)]">
                          {formatErrorTimestamp(brokerErrors[0].timestamp)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {historicalErrors.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">
                    Recent history
                  </p>
                  <div className="space-y-2">
                    {historicalErrors.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--pear-text-faint)]">
                          <span>Broker error</span>
                          <span>{formatErrorTimestamp(entry.timestamp)}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--pear-text-secondary)]">
                          {entry.message}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {runningAgents > 0 && (
        <span>{runningAgents} agent{runningAgents !== 1 ? 's' : ''}</span>
      )}

      {workspace && (
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--pear-text-secondary)]">{workspace.name}</span>
        </div>
      )}

      <div className="flex-1" />

      <button
        onClick={toggleTheme}
        className="ml-1 rounded-lg p-1.5 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text-dim)]"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>
    </div>
  )
}
