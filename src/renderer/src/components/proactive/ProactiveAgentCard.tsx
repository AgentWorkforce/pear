import type React from 'react'
import { useState } from 'react'
import {
  Edit3,
  Loader2,
  Megaphone,
  MoreHorizontal,
  Pause,
  Play,
  RadioTower,
  Trash2
} from 'lucide-react'

// TODO(sibling): import ProactiveAgentBinding from '@/lib/ipc' once the IPC slice exports it.
export type ProactiveAgentDraft = {
  id: string
  name: string
  description?: string
  cloudAgentId: string
  harness: 'claude' | 'codex' | 'opencode'
  model: string
  systemPrompt: string
  integrations: Record<string, Record<string, unknown>>
  watch: Array<{
    paths: string[]
    events: Array<'created' | 'updated' | 'deleted'>
    debounceMs?: number
    match?: string
  }>
  handlerCode: string
  inputs?: Record<string, string>
  memory?: { enabled: boolean; scopes?: string[]; ttlDays?: number }
  harnessSettings?: { reasoning?: 'low' | 'medium' | 'high'; timeoutSeconds?: number }
  mount?: { enabled: boolean }
  runMode?: 'cloud' | 'local'
}

export type ProactiveAgentBinding = {
  projectId: string
  personaId: string
  cloudAgentId: string
  status: 'draft' | 'warming' | 'active' | 'paused' | 'error'
  lastError?: string
  lastFiredAt?: string
  createdAt: string
  updatedAt: string
  draft: ProactiveAgentDraft
}

export type ProactiveAgentCardProps = {
  binding: ProactiveAgentBinding
  onEdit: (personaId: string) => void
  onViewRuns: (personaId: string) => void
  onPause: (personaId: string) => void | Promise<void>
  onResume: (personaId: string) => void | Promise<void>
  onUndeploy: (personaId: string) => void | Promise<void>
}

type StatusMeta = {
  label: string
  dotClassName: string
  pillClassName: string
}

const STATUS_META: Record<ProactiveAgentBinding['status'], StatusMeta> = {
  active: {
    label: 'Active',
    dotClassName: 'bg-[var(--pear-green)]',
    pillClassName: 'border-[var(--pear-green)]/25 bg-[var(--pear-green)]/10 text-[var(--pear-green)]'
  },
  warming: {
    label: 'Warming',
    dotClassName: 'animate-pulse bg-[var(--pear-yellow)]',
    pillClassName: 'border-[var(--pear-yellow)]/25 bg-[var(--pear-yellow)]/10 text-[var(--pear-yellow)]'
  },
  paused: {
    label: 'Paused',
    dotClassName: 'bg-[var(--pear-text-faint)]',
    pillClassName: 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)]'
  },
  error: {
    label: 'Error',
    dotClassName: 'bg-[var(--pear-red)]',
    pillClassName: 'border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 text-[var(--pear-red)]'
  },
  draft: {
    label: 'Draft',
    dotClassName: 'bg-[var(--pear-text-dim)]',
    pillClassName: 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text-dim)]'
  }
}

function formatRelativeTime(value: string | undefined): string {
  if (!value) return 'never'

  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 'recently'

  const diffMs = Date.now() - timestamp
  if (diffMs < 60_000) return 'just now'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(months / 12)
  return `${years}y ago`
}

function truncateMiddle(value: string, maxLength = 72): string {
  if (value.length <= maxLength) return value

  const edgeLength = Math.floor((maxLength - 3) / 2)
  return `${value.slice(0, edgeLength)}...${value.slice(value.length - edgeLength)}`
}

function getWatchPaths(binding: ProactiveAgentBinding): string[] {
  return binding.draft.watch.flatMap((rule) => rule.paths).filter((path) => path.trim().length > 0)
}

function getAgentName(binding: ProactiveAgentBinding): string {
  return binding.draft.name.trim() || binding.draft.id || binding.personaId
}

function ActionButton({
  children,
  disabled,
  onClick,
  title
}: {
  children: React.ReactNode
  disabled: boolean
  onClick: () => void
  title: string
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-2.5 text-xs font-medium text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function ProactiveAgentCard({
  binding,
  onEdit,
  onViewRuns,
  onPause,
  onResume,
  onUndeploy
}: ProactiveAgentCardProps): React.ReactNode {
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const status = STATUS_META[binding.status]
  const agentName = getAgentName(binding)
  const watchPaths = getWatchPaths(binding)
  const firstWatchPath = watchPaths[0]
  const remainingWatchCount = Math.max(0, watchPaths.length - 1)
  const shouldResume = binding.status === 'paused'

  async function runAction(action: () => void | Promise<void>): Promise<void> {
    if (busy) return

    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    setMenuOpen(false)
    if (!window.confirm(`Delete agent "${agentName}"?`)) return
    await runAction(() => onUndeploy(binding.personaId))
  }

  return (
    <article className="group rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-4 py-3 transition-colors hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)]">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-3">
            <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-accent)]">
              <Megaphone size={17} />
              <span
                className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--pear-bg-raised)] ${status.dotClassName}`}
                aria-hidden="true"
              />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="min-w-0 truncate text-sm font-semibold text-[var(--pear-text)]">{agentName}</h3>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${status.pillClassName}`}>
                  {status.label}
                </span>
                <span className="shrink-0 rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-text-faint)]">
                  {binding.draft.runMode || 'cloud'}
                </span>
              </div>

              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--pear-text-faint)]">
                <RadioTower size={12} className="shrink-0" />
                {firstWatchPath ? (
                  <span className="min-w-0 truncate">
                    Trigger: {truncateMiddle(firstWatchPath)}
                    {remainingWatchCount > 0 && (
                      <span className="ml-1 text-[var(--pear-text-dim)]">+{remainingWatchCount} more</span>
                    )}
                  </span>
                ) : (
                  <span>No triggers configured</span>
                )}
              </div>

              <div className="mt-1 text-xs text-[var(--pear-text-faint)]">
                Last fired: {formatRelativeTime(binding.lastFiredAt)}
              </div>

              {binding.lastError && (
                <div className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--pear-red)]">
                  {binding.lastError}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="relative flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
          {busy && <Loader2 size={14} className="animate-spin text-[var(--pear-text-faint)]" />}

          <ActionButton
            disabled={busy}
            onClick={() => void runAction(() => onViewRuns(binding.personaId))}
            title={`View runs for ${agentName}`}
          >
            <RadioTower size={13} />
            View runs
          </ActionButton>

          <ActionButton
            disabled={busy}
            onClick={() => void runAction(() => onEdit(binding.personaId))}
            title={`Edit ${agentName}`}
          >
            <Edit3 size={13} />
            Edit
          </ActionButton>

          <ActionButton
            disabled={busy}
            onClick={() => void runAction(() => shouldResume ? onResume(binding.personaId) : onPause(binding.personaId))}
            title={`${shouldResume ? 'Resume' : 'Pause'} ${agentName}`}
          >
            {shouldResume ? <Play size={13} /> : <Pause size={13} />}
            {shouldResume ? 'Resume' : 'Pause'}
          </ActionButton>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            disabled={busy}
            title={`More actions for ${agentName}`}
            aria-label={`More actions for ${agentName}`}
            aria-expanded={menuOpen}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:pointer-events-none disabled:opacity-50"
          >
            <MoreHorizontal size={15} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-9 z-10 min-w-[150px] rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] p-1 shadow-xl">
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs font-medium text-[var(--pear-red)] hover:bg-[var(--pear-red)]/10"
              >
                <Trash2 size={13} />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

export default ProactiveAgentCard
