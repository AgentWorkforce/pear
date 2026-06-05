import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Cloud, Loader2, Plus, Trash2 } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { pear, type CloudAgentRecord } from '@/lib/ipc'
import {
  useCloudAgentStore,
  type CloudAgentAttachProgress
} from '@/stores/cloud-agent-store'
import { getAgentKey, useAgentStore } from '@/stores/agent-store'
import { useProjectStore, type CloudAgentWorkspaceMode } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

function phaseLabel(progress: CloudAgentAttachProgress | undefined, elapsedSec: number): string {
  if (!progress) return elapsedSec > 1 ? `Starting attach… (${elapsedSec}s)` : 'Starting attach…'
  const elapsed = `(${elapsedSec}s)`
  if (progress.sandboxPhase) {
    switch (progress.sandboxPhase) {
      case 'queued':
        return `Queued for sandbox ${elapsed}`
      case 'pulling-image':
        return `Preparing sandbox image ${elapsed}`
      case 'starting':
        return `Starting sandbox ${elapsed}`
      case 'cloning':
        return `Cloning workspace ${elapsed}`
      case 'mounting':
        return `Mounting workspace ${elapsed}`
      case 'ready':
        return 'Ready'
    }
  }
  switch (progress.phase) {
    case 'warming-sandbox':
      return `Warming sandbox ${elapsed}`
    case 'mounting':
      return `Mounting workspace ${elapsed}`
    case 'connecting-broker':
      return `Connecting to broker ${elapsed}`
    case 'done':
      return 'Ready'
    case 'error':
      return progress.message || 'Attach failed'
    case 'idle':
    default:
      return `Working… ${elapsed}`
  }
}

export type CloudAgentPickerProps = {
  projectId?: string
  onAttach: (cloudAgentId: string) => void | Promise<void>
  onCancel: () => void
  onAuthRequired?: () => void
}

const HARNESS_OPTIONS = [
  { value: 'claude', label: 'Claude', defaultModel: 'claude-opus-4-7' },
  { value: 'codex', label: 'Codex', defaultModel: 'gpt-5.2' },
  { value: 'opencode', label: 'OpenCode', defaultModel: 'claude-sonnet-4-6' }
]

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isAuthRequiredError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (code === 'AUTH_REQUIRED') return true
  // Match only explicit auth-required signals — not the generic "required" /
  // "auth*" substrings, which also occur in "Cloud agent name is required",
  // "authorization scope insufficient", etc., and would misroute the user to
  // the sign-in flow instead of showing the real error.
  return /cloud-auth-required|sign in to|login required|not logged in/i.test(getErrorMessage(error))
}

function formatRelativeTime(value: string | undefined): string {
  if (!value) return 'never used'

  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 'last used recently'

  const diffMs = Date.now() - timestamp
  if (diffMs < 60_000) return 'last used just now'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `last used ${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `last used ${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `last used ${days}d ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `last used ${months}mo ago`

  const years = Math.floor(months / 12)
  return `last used ${years}y ago`
}

function getAgentTitle(agent: CloudAgentRecord): string {
  return agent.displayName || agent.name
}

function getAgentSubtitle(agent: CloudAgentRecord): string {
  return `${agent.harness} · ${agent.defaultModel} · ${formatRelativeTime(agent.lastUsedAt)}`
}

function getStatusClass(status: CloudAgentRecord['status']): string {
  if (status === 'ready') return 'border-[var(--pear-green)]/25 bg-[var(--pear-green)]/10 text-[var(--pear-green)]'
  if (status === 'warming') return 'border-[var(--pear-yellow)]/25 bg-[var(--pear-yellow)]/10 text-[var(--pear-yellow)]'
  if (status === 'error') return 'border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 text-[var(--pear-red)]'
  return 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)]'
}

function StatusPill({ status }: { status: CloudAgentRecord['status'] }): React.ReactNode {
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${getStatusClass(status)}`}>
      {status}
    </span>
  )
}

function cloudWorkerName(agent: CloudAgentRecord): string {
  const base = (agent.name || agent.displayName || agent.id)
    .trim()
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return base || 'cloud-agent'
}

function cloudWorkerCli(agent: CloudAgentRecord): string {
  const harness = agent.harness.trim().toLowerCase()
  if (harness === 'claude' || harness === 'codex' || harness === 'opencode') return harness
  if (harness === 'anthropic') return 'claude'
  if (harness === 'openai' || harness === 'gpt' || harness === 'chatgpt') return 'codex'
  return 'claude'
}

function cloudAgentWorkspaceMode(project: unknown): CloudAgentWorkspaceMode {
  const mode = project && typeof project === 'object'
    ? (project as { cloudAgentWorkspaceMode?: unknown }).cloudAgentWorkspaceMode
    : undefined
  return mode === 'git' || mode === 'relayfile'
    ? mode
    : 'git-overlay'
}

function modeLabel(mode: CloudAgentWorkspaceMode): string {
  if (mode === 'git') return 'Git - pull after run'
  if (mode === 'relayfile') return 'Relayfile - live sync'
  return 'Git + live sync'
}

export default function CloudAgentPicker({
  projectId,
  onAttach,
  onCancel,
  onAuthRequired
}: CloudAgentPickerProps): React.ReactNode {
  const [agents, setAgents] = useState<CloudAgentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createHarness, setCreateHarness] = useState('claude')
  const [createModel, setCreateModel] = useState('claude-opus-4-7')
  const [busy, setBusy] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const prewarmTargetRef = useRef<string | null>(null)
  const attachStartedRef = useRef(false)
  const mountedRef = useRef(true)
  const projectIdRef = useRef(projectId)

  const attachProgress = useCloudAgentStore(
    (state) => projectId ? state.attachProgress[projectId] : undefined
  )
  const setAttachProgress = useCloudAgentStore((s) => s.setAttachProgress)
  const project = useProjectStore(
    (state) => state.projects.find((candidate) => candidate.id === projectId)
  )
  const workspaceMode = cloudAgentWorkspaceMode(project)

  useEffect(() => {
    projectIdRef.current = projectId
  }, [projectId])

  // Tick once a second while attaching so the elapsed timer counts up.
  useEffect(() => {
    if (!busy) return
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [busy])

  const attachElapsedSec = attachProgress
    ? Math.max(1, Math.round((nowMs - attachProgress.startedAt) / 1000))
    : 0
  const showingAttachProgress = Boolean(
    attachProgress &&
    attachProgress.phase !== 'idle' &&
    attachProgress.phase !== 'done' &&
    (attachProgress.cloudAgentId === undefined || attachProgress.cloudAgentId === selectedId)
  )

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedId) || null,
    [agents, selectedId]
  )

  useEffect(() => {
    let cancelled = false

    async function loadAgents(): Promise<void> {
      setLoading(true)
      setError(null)

      try {
        const cloudAgents = await pear.cloudAgent.list()
        if (cancelled) return

        setAgents(cloudAgents)
        setSelectedId((current) => {
          if (current && cloudAgents.some((agent) => agent.id === current)) return current
          return cloudAgents[0]?.id || null
        })
      } catch (err) {
        if (cancelled) return
        if (isAuthRequiredError(err)) {
          onAuthRequired?.()
          return
        }
        setError(getErrorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadAgents()

    return () => {
      cancelled = true
    }
  }, [onAuthRequired])

  function seedWarmProgress(agentId: string): void {
    if (!projectId) return
    const agent = agents.find((candidate) => candidate.id === agentId)
    setAttachProgress(projectId, {
      phase: 'warming-sandbox',
      cloudAgentId: agentId,
      cloudAgentName: agent ? getAgentTitle(agent) : agentId,
      message: 'Requesting cloud sandbox',
      startedAt: Date.now(),
      updatedAt: Date.now()
    })
  }

  function beginPrewarm(agentId: string): void {
    if (!projectId || !agentId || attachStartedRef.current) return

    const previous = prewarmTargetRef.current
    if (previous === agentId) return
    if (previous) {
      void pear.cloudAgent.cancelPrewarm(projectId, previous).catch(() => undefined)
    }
    prewarmTargetRef.current = agentId
    seedWarmProgress(agentId)
    void pear.cloudAgent.prewarm(projectId, agentId).catch((err) => {
      if (prewarmTargetRef.current !== agentId || attachStartedRef.current) return
      if (isAuthRequiredError(err)) {
        if (mountedRef.current) onAuthRequired?.()
        return
      }
      if (mountedRef.current) setError(getErrorMessage(err))
      if (mountedRef.current && projectId) {
        const agent = agents.find((candidate) => candidate.id === agentId)
        setAttachProgress(projectId, {
          phase: 'error',
          cloudAgentId: agentId,
          cloudAgentName: agent ? getAgentTitle(agent) : agentId,
          message: getErrorMessage(err),
          startedAt: attachProgress?.startedAt ?? Date.now(),
          updatedAt: Date.now()
        })
      }
    })
  }

  function cancelCurrentPrewarm(): void {
    const currentProjectId = projectIdRef.current
    if (!currentProjectId || !prewarmTargetRef.current) return
    const target = prewarmTargetRef.current
    prewarmTargetRef.current = null
    void pear.cloudAgent.cancelPrewarm(currentProjectId, target).catch(() => undefined)
    setAttachProgress(currentProjectId, null)
  }

  useEffect(() => {
    if (!projectId || !selectedId || loading || creating || attachStartedRef.current) return
    beginPrewarm(selectedId)
  }, [projectId, selectedId, loading, creating])

  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (!attachStartedRef.current) {
        cancelCurrentPrewarm()
      }
    }
  }, [])

  async function handleCreate(): Promise<void> {
    const name = createName.trim()
    if (!name) return

    setBusy(true)
    setError(null)
    try {
      const created = await pear.cloudAgent.create({
        name,
        harness: createHarness,
        model: createModel.trim()
      })
      setAgents((current) => [created, ...current.filter((agent) => agent.id !== created.id)])
      setSelectedId(created.id)
      setCreating(false)
      setCreateName('')
    } catch (err) {
      if (isAuthRequiredError(err)) {
        onAuthRequired?.()
        return
      }
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    const agent = agents.find((candidate) => candidate.id === id)
    const label = agent ? getAgentTitle(agent) : 'this cloud agent'
    if (!window.confirm(`Delete "${label}"? This removes the cloud agent from your account.`)) return

    setBusy(true)
    setError(null)
    try {
      await pear.cloudAgent.delete(id)
      setAgents((current) => {
        const next = current.filter((candidate) => candidate.id !== id)
        setSelectedId((currentSelected) => {
          if (currentSelected !== id) return currentSelected
          return next[0]?.id || null
        })
        return next
      })
    } catch (err) {
      if (isAuthRequiredError(err)) {
        onAuthRequired?.()
        return
      }
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleAttachClick(): Promise<void> {
    if (!selectedId || !projectId) return

    const attachingAgentId = selectedId
    const attachingAgent = selectedAgent
    attachStartedRef.current = true
    prewarmTargetRef.current = null
    setBusy(true)
    setError(null)
    // Seed an immediate progress row so the UI doesn't show a blank "busy"
    // state for the few hundred ms before the first sandbox-status event
    // arrives. The main process overwrites this once events flow.
    if (projectId) {
      setAttachProgress(projectId, {
        phase: 'warming-sandbox',
        cloudAgentId: attachingAgentId,
        cloudAgentName: attachingAgent ? getAgentTitle(attachingAgent) : attachingAgentId,
        message: 'Requesting cloud sandbox',
        startedAt: attachProgress?.startedAt ?? Date.now(),
        updatedAt: Date.now()
      })
    }
    pear.cloudAgent.attach(projectId, attachingAgentId).then(async () => {
      const cli = attachingAgent ? cloudWorkerCli(attachingAgent) : 'claude'
      const requestedName = attachingAgent ? cloudWorkerName(attachingAgent) : 'cloud-agent'
      const spawned = await pear.broker.spawnAgent(projectId, {
        name: requestedName,
        cli,
        cwd: '/workspace',
        // The cloud worker must land on the sandbox broker — a local broker
        // may be running side by side for this project.
        broker: 'cloud',
        ...(attachingAgent?.defaultModel ? { model: attachingAgent.defaultModel } : {})
      })
      const name = spawned.name || requestedName
      await pear.broker.attachTerminal({
        projectId,
        name,
        mode: 'passthrough'
      })
      useAgentStore.getState().trackSpawnedAgent(name, projectId, undefined, cli, '/workspace')
      useAgentStore.getState().setActiveAgentKey(getAgentKey(projectId, name))
      useUIStore.getState().openTab({ kind: 'agents', projectId })
      await onAttach(attachingAgentId)
      if (projectId) {
        setAttachProgress(projectId, null)
      }
    }).catch((err) => {
      if (/cloud agent attach canceled/i.test(getErrorMessage(err))) {
        if (projectId) setAttachProgress(projectId, null)
        return
      }
      if (isAuthRequiredError(err)) {
        if (mountedRef.current) onAuthRequired?.()
        return
      }
      if (mountedRef.current) setError(getErrorMessage(err))
      if (projectId) {
        setAttachProgress(projectId, {
          phase: 'error',
          cloudAgentId: attachingAgentId,
          cloudAgentName: attachingAgent ? getAgentTitle(attachingAgent) : attachingAgentId,
          message: getErrorMessage(err),
          startedAt: attachProgress?.startedAt ?? Date.now(),
          updatedAt: Date.now()
        })
      }
    }).finally(() => {
      attachStartedRef.current = false
      if (mountedRef.current) setBusy(false)
    })
  }

  function handleHarnessChange(value: string): void {
    const option = HARNESS_OPTIONS.find((candidate) => candidate.value === value)
    setCreateHarness(value)
    if (option) setCreateModel(option.defaultModel)
  }

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--pear-border-subtle)] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-accent)]">
            <Cloud size={17} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[var(--pear-text)]">Your cloud agents</h2>
            <p className="mt-0.5 truncate text-xs text-[var(--pear-text-faint)]">
              Attach a persistent Agent Relay Cloud agent to this project.
            </p>
          </div>
        </div>
        {busy && <Loader2 size={16} className="shrink-0 animate-spin text-[var(--pear-text-faint)]" />}
      </header>

      {error && (
        <div className="mx-5 mt-4 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
          {error}
        </div>
      )}

      <div className="min-h-[260px] flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-[var(--pear-text-faint)]">
            <Loader2 size={15} className="animate-spin" />
            Loading cloud agents
          </div>
        ) : (
          <ul className="space-y-2" role="radiogroup" aria-label="Cloud agents">
            {agents.map((agent) => {
              const selected = agent.id === selectedId

              return (
                <li
                  key={agent.id}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={busy ? -1 : 0}
                  onClick={() => {
                    if (busy) return
                    setSelectedId(agent.id)
                    beginPrewarm(agent.id)
                  }}
                  onKeyDown={(event) => {
                    if (busy) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedId(agent.id)
                      beginPrewarm(agent.id)
                    }
                  }}
                  className={`group cursor-pointer rounded-md border px-3 py-3 outline-none transition-colors ${
                    selected
                      ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] ring-1 ring-[var(--pear-accent-dim)]'
                      : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)]'
                  } ${busy ? 'pointer-events-none opacity-60' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        selected
                          ? 'border-[var(--pear-accent-bright)]'
                          : 'border-[var(--pear-border)]'
                      }`}
                      aria-hidden="true"
                    >
                      {selected && <span className="h-2 w-2 rounded-full bg-[var(--pear-accent-bright)]" />}
                    </span>
                    <AgentHarnessIcon cli={agent.harness} className="mt-0.5 h-5 w-5 shrink-0 text-[var(--pear-text-secondary)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-[var(--pear-text)]">{getAgentTitle(agent)}</span>
                        <StatusPill status={agent.status} />
                      </div>
                      <div className="mt-0.5 truncate text-xs text-[var(--pear-text-faint)]">
                        {getAgentSubtitle(agent)}
                      </div>
                      {agent.lastAuthenticatedAt == null && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--pear-yellow)]/20 bg-[var(--pear-yellow)]/10 px-2 py-1.5 text-[11px] leading-4 text-[var(--pear-yellow)]">
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                          <span>
                            This cloud agent has no provider credentials yet. Run agent-relay cloud connect &lt;provider&gt; in a terminal.
                          </span>
                        </div>
                      )}
                      {agent.lastError && (
                        <div className="mt-2 truncate text-[11px] text-[var(--pear-red)]">{agent.lastError}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleDelete(agent.id)
                      }}
                      disabled={busy}
                      className="shrink-0 rounded-md p-1.5 text-[var(--pear-text-faint)] opacity-0 transition-opacity hover:bg-[var(--pear-red)]/10 hover:text-[var(--pear-red)] disabled:opacity-30 group-hover:opacity-100 group-focus-within:opacity-100"
                      title={`Delete ${getAgentTitle(agent)}`}
                      aria-label={`Delete ${getAgentTitle(agent)}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              )
            })}

            <li
              tabIndex={busy ? -1 : 0}
              onClick={() => !busy && setCreating(true)}
              onKeyDown={(event) => {
                if (busy) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setCreating(true)
                }
              }}
              className={`flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-[var(--pear-border)] px-3 py-3 text-sm text-[var(--pear-text-dim)] outline-none transition-colors hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] ${
                busy ? 'pointer-events-none opacity-60' : ''
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)]">
                <Plus size={15} />
              </span>
              <span> Create new cloud agent</span>
            </li>
          </ul>
        )}

        {!loading && agents.length === 0 && !creating && (
          <div className="mt-3 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-6 text-center text-sm text-[var(--pear-text-faint)]">
            No cloud agents yet.
          </div>
        )}

        {creating && (
          <form
            className="mt-4 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-4"
            onSubmit={(event) => {
              event.preventDefault()
              void handleCreate()
            }}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[var(--pear-text)]">Create cloud agent</h3>
              <button
                type="button"
                onClick={() => setCreating(false)}
                disabled={busy}
                className="text-xs text-[var(--pear-text-faint)] hover:text-[var(--pear-text)] disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_150px]">
              <label className="min-w-0">
                <span className="mb-1.5 block text-xs text-[var(--pear-text-faint)]">Name</span>
                <input
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  disabled={busy}
                  placeholder="release-bot"
                  className="h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-xs text-[var(--pear-text-faint)]">Harness</span>
                <select
                  value={createHarness}
                  onChange={(event) => handleHarnessChange(event.target.value)}
                  disabled={busy}
                  className="h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                >
                  {HARNESS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 md:col-span-2">
                <span className="mb-1.5 block text-xs text-[var(--pear-text-faint)]">Model</span>
                <input
                  value={createModel}
                  onChange={(event) => setCreateModel(event.target.value)}
                  disabled={busy}
                  className="h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={busy || !createName.trim() || !createModel.trim()}
                className="flex h-9 items-center gap-2 rounded-md bg-[var(--pear-accent)] px-3 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:opacity-40"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                Create agent
              </button>
            </div>
          </form>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-[var(--pear-border-subtle)] px-5 py-4">
        <div className="min-w-0 flex items-center gap-2 text-xs text-[var(--pear-text-faint)]">
          {showingAttachProgress ? (
            <>
              <Loader2 size={13} className="shrink-0 animate-spin text-[var(--pear-accent)]" />
              <span className="truncate text-[var(--pear-text-dim)]">
                {phaseLabel(attachProgress, attachElapsedSec)}
              </span>
            </>
          ) : selectedAgent ? (
            <>
              <span className="truncate">Selected: {getAgentTitle(selectedAgent)}</span>
              <span className="hidden shrink-0 rounded-full border border-[var(--pear-border-subtle)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-text-faint)] sm:inline">
                {modeLabel(workspaceMode)}
              </span>
            </>
          ) : (
            <span>Select an agent to attach</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (!attachStartedRef.current) cancelCurrentPrewarm()
              onCancel()
            }}
            disabled={creating}
            className="h-9 rounded-md px-3 text-sm text-[var(--pear-text-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleAttachClick()}
            disabled={busy || !selectedId}
            className="flex h-9 items-center gap-2 rounded-md bg-[var(--pear-accent)] px-3 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:opacity-40"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? 'Attaching…' : 'Attach to project'}
          </button>
        </div>
      </footer>
    </div>
  )
}
