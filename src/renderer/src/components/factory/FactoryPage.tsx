import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Cloud, RefreshCw, Save, WifiOff } from 'lucide-react'
import { pear, type FactoryNodeConfig, type FactoryStatus } from '@/lib/ipc'
import { useProjectStore } from '@/stores/project-store'

const emptyNodeConfig = (): FactoryNodeConfig => ({
  capabilities: [],
  clonePaths: {},
  dryRun: false
})

function fieldClass(): string {
  return 'h-9 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent)]'
}

function textAreaClass(): string {
  return 'min-h-[116px] rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 font-mono text-xs text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent)]'
}

function Label({ children }: { children: React.ReactNode }): React.ReactNode {
  return <label className="grid gap-1.5 text-xs font-medium text-[var(--pear-text-faint)]">{children}</label>
}

function csv(value: string[]): string {
  return value.join(', ')
}

function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseClonePaths(value: string): Record<string, string> {
  const parsed = value.trim() ? JSON.parse(value) as unknown : {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('clonePaths must be a JSON object')
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'string') throw new Error(`clonePaths.${key} must be a string`)
    out[key] = entry
  }
  return out
}

function statusPresentation(status: FactoryStatus | null): {
  label: string
  Icon: typeof CheckCircle2
  color: string
} {
  if (!status) return { label: 'Loading', Icon: Cloud, color: 'text-[var(--pear-text-faint)]' }
  if (status.state === 'online') return { label: 'Cloud online', Icon: CheckCircle2, color: 'text-[var(--pear-teal)]' }
  if (status.state === 'empty') return { label: 'Cloud empty', Icon: Cloud, color: 'text-[var(--pear-text-dim)]' }
  if (status.state === 'unauthenticated') return { label: 'Sign in required', Icon: WifiOff, color: 'text-[var(--pear-yellow)]' }
  return { label: 'Cloud unavailable', Icon: AlertTriangle, color: 'text-[var(--pear-red)]' }
}

export function FactoryPage(): React.ReactNode {
  const activeProject = useProjectStore((s) => s.projects.find((project) => project.id === s.activeProjectId))
  const projectRoot = activeProject?.rootPath
  const [status, setStatus] = useState<FactoryStatus | null>(null)
  const [configPath, setConfigPath] = useState('')
  const [draft, setDraft] = useState<FactoryNodeConfig>(emptyNodeConfig)
  const [clonePathsJson, setClonePathsJson] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const presentation = statusPresentation(status)
  const counters = useMemo(() => Object.entries(status?.counters ?? {}), [status])

  async function refresh(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const [nextStatus, loaded] = await Promise.all([
        pear.factory.status(),
        pear.factory.readConfig(configPath || undefined, projectRoot)
      ])
      setStatus(nextStatus)
      setConfigPath(loaded.configPath)
      setErrors(loaded.errors)
      if (loaded.config) {
        setDraft(loaded.config)
        setClonePathsJson(JSON.stringify(loaded.config.clonePaths ?? {}, null, 2))
      }
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // Read-only cloud snapshot: status is fetched on mount and on the manual
    // Refresh button. Main no longer pushes `factory:event` (the in-Pear daemon
    // was removed in the p5 teardown), so there is no live subscription here.
    void refresh()
    // configPath is intentionally excluded; refresh owns initial path discovery.
  }, [projectRoot])

  async function save(): Promise<void> {
    setBusy(true)
    setMessage(null)
    setErrors([])
    try {
      const next: FactoryNodeConfig = {
        ...draft,
        capabilities: draft.capabilities ?? [],
        clonePaths: parseClonePaths(clonePathsJson),
        dryRun: !!draft.dryRun
      }
      const result = await pear.factory.saveConfig(next, configPath || undefined, projectRoot)
      setConfigPath(result.configPath)
      setErrors(result.errors)
      if (result.config) {
        setDraft(result.config)
        setClonePathsJson(JSON.stringify(result.config.clonePaths ?? {}, null, 2))
      }
      if (result.errors.length === 0) setMessage('NodeConfig saved')
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)] text-[var(--pear-text)]">
      <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <presentation.Icon size={17} className={presentation.color} />
            <h1 className="truncate text-lg font-semibold">Factory</h1>
            <span className={`text-sm ${presentation.color}`}>{presentation.label}</span>
          </div>
          <div className="mt-1 truncate text-xs text-[var(--pear-text-faint)]">
            {status?.workspaceId || 'No cloud workspace'}{status?.cloudUrl ? ` | ${status.cloudUrl}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => void refresh()} disabled={busy} className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] disabled:opacity-50" title="Refresh" aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
          <button type="button" onClick={() => void save()} disabled={busy} className="flex h-9 items-center gap-2 rounded-md bg-[var(--pear-bg-surface)] px-3 text-sm hover:bg-[var(--pear-bg-surface-hover)] disabled:opacity-50">
            <Save size={15} /> Save NodeConfig
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {(errors.length > 0 || message || status?.message) && (
          <div className="mb-4 rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] px-3 py-2 text-sm">
            {errors.map((error) => <div key={error} className="text-[var(--pear-red)]">{error}</div>)}
            {message && <div className="text-[var(--pear-text-dim)]">{message}</div>}
            {status?.message && <div className="text-[var(--pear-text-faint)]">{status.message}</div>}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
          <section className="grid content-start gap-5">
            <div className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Cloud Status</h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded-md border border-[var(--pear-border-subtle)] px-3 py-2">
                  <div className="text-xs text-[var(--pear-text-faint)]">Issues</div>
                  <div className="text-xl font-semibold">{status?.issues.length ?? 0}</div>
                </div>
                <div className="rounded-md border border-[var(--pear-border-subtle)] px-3 py-2">
                  <div className="text-xs text-[var(--pear-text-faint)]">Agents</div>
                  <div className="text-xl font-semibold">{status?.agents.length ?? 0}</div>
                </div>
                <div className="rounded-md border border-[var(--pear-border-subtle)] px-3 py-2">
                  <div className="text-xs text-[var(--pear-text-faint)]">Updated</div>
                  <div className="truncate text-sm">{status?.updatedAt ?? 'Not available'}</div>
                </div>
              </div>
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Active Issues</h2>
              <div className="overflow-hidden rounded-md border border-[var(--pear-border-subtle)]">
                {(status?.issues.length ?? 0) === 0 ? (
                  <div className="px-3 py-6 text-sm text-[var(--pear-text-faint)]">No cloud factory issues</div>
                ) : (
                  status?.issues.map((issue) => (
                    <div key={issue.key} className="grid grid-cols-[minmax(90px,0.25fr)_minmax(0,1fr)_minmax(90px,0.25fr)] gap-3 border-b border-[var(--pear-border-subtle)] px-3 py-2 text-sm last:border-b-0">
                      <div className="font-medium">{issue.key}</div>
                      <div className="min-w-0 truncate text-[var(--pear-text-dim)]">{issue.title || issue.repo || 'Untitled'}</div>
                      <div className="truncate text-right text-xs text-[var(--pear-text-faint)]">{issue.state || issue.assignee || ''}</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Cloud Agents</h2>
              <div className="overflow-hidden rounded-md border border-[var(--pear-border-subtle)]">
                {(status?.agents.length ?? 0) === 0 ? (
                  <div className="px-3 py-6 text-sm text-[var(--pear-text-faint)]">No cloud factory agents</div>
                ) : (
                  status?.agents.map((agent) => (
                    <div key={agent.id ?? agent.name} className="grid grid-cols-[minmax(0,1fr)_minmax(90px,0.3fr)] gap-3 border-b border-[var(--pear-border-subtle)] px-3 py-2 text-sm last:border-b-0">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{agent.name}</div>
                        <div className="truncate text-xs text-[var(--pear-text-faint)]">{agent.issue?.key ?? agent.role ?? ''}</div>
                      </div>
                      <div className="truncate text-right text-xs text-[var(--pear-text-faint)]">{agent.status ?? ''}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          <aside className="grid content-start gap-5">
            <section className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">NodeConfig</h2>
              <div className="truncate text-xs text-[var(--pear-text-faint)]">{configPath || 'factory.config.json'}</div>
              <div className="grid gap-3">
                <Label>Workspace ID<input className={fieldClass()} value={draft.workspaceId ?? ''} onChange={(event) => setDraft((current) => ({ ...current, workspaceId: event.target.value || undefined }))} /></Label>
                <Label>Capabilities<input className={fieldClass()} value={csv(draft.capabilities ?? [])} onChange={(event) => setDraft((current) => ({ ...current, capabilities: parseCsv(event.target.value) }))} /></Label>
                <Label>Clone root<input className={fieldClass()} value={draft.cloneRoot ?? ''} onChange={(event) => setDraft((current) => ({ ...current, cloneRoot: event.target.value || undefined }))} /></Label>
                <Label>Clone paths<textarea className={textAreaClass()} value={clonePathsJson} onChange={(event) => setClonePathsJson(event.target.value)} /></Label>
                <label className="flex items-center gap-2 text-sm text-[var(--pear-text-dim)]">
                  <input type="checkbox" checked={!!draft.dryRun} onChange={(event) => setDraft((current) => ({ ...current, dryRun: event.target.checked }))} />
                  Dry run
                </label>
              </div>
            </section>

            {counters.length > 0 && (
              <section className="grid gap-3">
                <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Counters</h2>
                <div className="overflow-hidden rounded-md border border-[var(--pear-border-subtle)]">
                  {counters.map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-3 border-b border-[var(--pear-border-subtle)] px-3 py-2 text-sm last:border-b-0">
                      <div className="truncate text-[var(--pear-text-dim)]">{key}</div>
                      <div className="font-medium">{value}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}
