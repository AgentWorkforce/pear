import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Circle, Save, Square, Play, RefreshCw } from 'lucide-react'
import { pear, type FactoryStatus } from '@/lib/ipc'
import { useProjectStore } from '@/stores/project-store'

type FactoryConfigDraft = Record<string, any>

const emptyConfig = (): FactoryConfigDraft => ({
  workspaceId: '',
  subscription: { teams: [], labels: [], projects: [], assignees: [] },
  repos: { byLabel: {}, clonePaths: {}, keywordRules: [], default: '' },
  triage: { maxImplementers: 2 },
  batchSize: 1,
  mergePolicy: 'never',
  models: {},
  slack: { channel: '', style: 'threaded-summarized' },
  safety: { requireTitlePrefix: '[factory-e2e]', requireLabel: 'factory', requireTeamKey: 'AR' }
})

function csv(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : ''
}

function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2)
}

function parseJsonField(label: string, value: string): unknown {
  try {
    return value.trim() ? JSON.parse(value) : {}
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function fieldClass(): string {
  return 'h-9 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent)]'
}

function textAreaClass(): string {
  return 'min-h-[104px] rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 font-mono text-xs text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent)]'
}

function Label({ children }: { children: React.ReactNode }): React.ReactNode {
  return <label className="grid gap-1.5 text-xs font-medium text-[var(--pear-text-faint)]">{children}</label>
}

export function FactoryPage(): React.ReactNode {
  const activeProject = useProjectStore((s) => s.projects.find((project) => project.id === s.activeProjectId))
  const projectRoot = activeProject?.rootPath
  const [status, setStatus] = useState<FactoryStatus | null>(null)
  const [configPath, setConfigPath] = useState('')
  const [draft, setDraft] = useState<FactoryConfigDraft>(emptyConfig)
  const [byLabelJson, setByLabelJson] = useState('{}')
  const [clonePathsJson, setClonePathsJson] = useState('{}')
  const [keywordRulesJson, setKeywordRulesJson] = useState('[]')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const statusLabel = status?.running ? 'Running' : 'Stopped'
  const statusColor = status?.running ? 'text-[var(--pear-teal)]' : 'text-[var(--pear-text-faint)]'

  const logs = useMemo(() => status?.logs.slice(-160).reverse() ?? [], [status])

  async function refresh(): Promise<void> {
    const nextStatus = await pear.factory.status()
    setStatus(nextStatus)
    const loaded = await pear.factory.readConfig(configPath || undefined, projectRoot)
    setConfigPath(loaded.configPath)
    setErrors(loaded.errors)
    if (loaded.config && typeof loaded.config === 'object') {
      const next = loaded.config as FactoryConfigDraft
      setDraft(next)
      setByLabelJson(prettyJson(next.repos?.byLabel))
      setClonePathsJson(prettyJson(next.repos?.clonePaths))
      setKeywordRulesJson(prettyJson(next.repos?.keywordRules ?? []))
    }
  }

  useEffect(() => {
    void refresh()
    return pear.factory.onEvent((event) => {
      setStatus(event.status)
    })
    // configPath is intentionally excluded; refresh owns initial path discovery.
  }, [projectRoot])

  function update(section: string, key: string, value: unknown): void {
    setDraft((current) => ({
      ...current,
      [section]: {
        ...(current[section] ?? {}),
        [key]: value
      }
    }))
  }

  async function save(): Promise<void> {
    setBusy(true)
    setMessage(null)
    setErrors([])
    try {
      const next = {
        ...draft,
        repos: {
          ...(draft.repos ?? {}),
          byLabel: parseJsonField('repos.byLabel', byLabelJson),
          clonePaths: parseJsonField('repos.clonePaths', clonePathsJson),
          keywordRules: parseJsonField('repos.keywordRules', keywordRulesJson)
        }
      }
      const result = await pear.factory.saveConfig(next, configPath || undefined, projectRoot)
      setConfigPath(result.configPath)
      setErrors(result.errors)
      setMessage(result.warning || (result.errors.length ? null : 'Saved'))
      if (result.config && typeof result.config === 'object') setDraft(result.config as FactoryConfigDraft)
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)])
    } finally {
      setBusy(false)
    }
  }

  async function start(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      setStatus(await pear.factory.start(configPath || undefined, projectRoot))
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)])
    } finally {
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      setStatus(await pear.factory.stop())
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
            <Circle size={10} className={statusColor} fill="currentColor" />
            <h1 className="truncate text-lg font-semibold">Factory</h1>
            <span className={`text-sm ${statusColor}`}>{statusLabel}</span>
          </div>
          <div className="mt-1 truncate text-xs text-[var(--pear-text-faint)]">{configPath || status?.configPath || 'factory.config.json'}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => void refresh()} className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)]" title="Refresh" aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
          <button type="button" onClick={() => void save()} disabled={busy} className="flex h-9 items-center gap-2 rounded-md bg-[var(--pear-bg-surface)] px-3 text-sm hover:bg-[var(--pear-bg-surface-hover)] disabled:opacity-50">
            <Save size={15} /> Save
          </button>
          {status?.running ? (
            <button type="button" onClick={() => void stop()} disabled={busy} className="flex h-9 items-center gap-2 rounded-md bg-[var(--pear-red)] px-3 text-sm text-white disabled:opacity-50">
              <Square size={14} /> Stop
            </button>
          ) : (
            <button type="button" onClick={() => void start()} disabled={busy} className="flex h-9 items-center gap-2 rounded-md bg-[var(--pear-accent)] px-3 text-sm font-medium text-[var(--pear-bg)] disabled:opacity-50">
              <Play size={15} /> Start
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {(errors.length > 0 || message) && (
          <div className="mb-4 rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] px-3 py-2 text-sm">
            {errors.map((error) => <div key={error} className="text-[var(--pear-red)]">{error}</div>)}
            {message && <div className="text-[var(--pear-text-dim)]">{message}</div>}
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <section className="grid gap-5">
            <div className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Subscription</h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Label>Teams<input className={fieldClass()} value={csv(draft.subscription?.teams)} onChange={(event) => update('subscription', 'teams', parseCsv(event.target.value))} /></Label>
                <Label>Labels<input className={fieldClass()} value={csv(draft.subscription?.labels)} onChange={(event) => update('subscription', 'labels', parseCsv(event.target.value))} /></Label>
                <Label>Projects<input className={fieldClass()} value={csv(draft.subscription?.projects)} onChange={(event) => update('subscription', 'projects', parseCsv(event.target.value))} /></Label>
                <Label>Assignees<input className={fieldClass()} value={csv(draft.subscription?.assignees)} onChange={(event) => update('subscription', 'assignees', parseCsv(event.target.value))} /></Label>
              </div>
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Repos</h2>
              <Label>Default<input className={fieldClass()} value={draft.repos?.default ?? ''} onChange={(event) => update('repos', 'default', event.target.value)} /></Label>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Label>byLabel<textarea className={textAreaClass()} value={byLabelJson} onChange={(event) => setByLabelJson(event.target.value)} /></Label>
                <Label>clonePaths<textarea className={textAreaClass()} value={clonePathsJson} onChange={(event) => setClonePathsJson(event.target.value)} /></Label>
              </div>
              <Label>keywordRules<textarea className={textAreaClass()} value={keywordRulesJson} onChange={(event) => setKeywordRulesJson(event.target.value)} /></Label>
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Execution</h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Label>Max implementers<input className={fieldClass()} type="number" min={1} max={6} value={draft.triage?.maxImplementers ?? 2} onChange={(event) => update('triage', 'maxImplementers', Number(event.target.value))} /></Label>
                <Label>Batch size<input className={fieldClass()} type="number" min={1} max={5} value={draft.batchSize ?? 1} onChange={(event) => setDraft((current) => ({ ...current, batchSize: Number(event.target.value) }))} /></Label>
                <Label>Merge policy<select className={fieldClass()} value={draft.mergePolicy ?? 'never'} onChange={(event) => setDraft((current) => ({ ...current, mergePolicy: event.target.value }))}><option value="never">never</option><option value="on-green-with-review">on-green-with-review</option></select></Label>
              </div>
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Models And Safety</h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Label>Implementer<input className={fieldClass()} value={draft.models?.implementer ?? ''} onChange={(event) => update('models', 'implementer', event.target.value)} /></Label>
                <Label>Reviewer<input className={fieldClass()} value={draft.models?.reviewer ?? ''} onChange={(event) => update('models', 'reviewer', event.target.value)} /></Label>
                <Label>Triage<input className={fieldClass()} value={draft.models?.triage ?? ''} onChange={(event) => update('models', 'triage', event.target.value)} /></Label>
                <Label>Slack channel<input className={fieldClass()} value={draft.slack?.channel ?? ''} onChange={(event) => update('slack', 'channel', event.target.value)} /></Label>
                <Label>Title prefix<input className={fieldClass()} value={draft.safety?.requireTitlePrefix ?? ''} onChange={(event) => update('safety', 'requireTitlePrefix', event.target.value)} /></Label>
                <Label>Required label<input className={fieldClass()} value={draft.safety?.requireLabel ?? ''} onChange={(event) => update('safety', 'requireLabel', event.target.value)} /></Label>
                <Label>Required team key<input className={fieldClass()} value={draft.safety?.requireTeamKey ?? ''} onChange={(event) => update('safety', 'requireTeamKey', event.target.value)} /></Label>
              </div>
            </div>
          </section>

          <aside className="grid content-start gap-5">
            <section className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Running Agents</h2>
              <div className="overflow-hidden rounded-md border border-[var(--pear-border-subtle)]">
                {(status?.agents.length ?? 0) === 0 ? (
                  <div className="px-3 py-6 text-sm text-[var(--pear-text-faint)]">No factory agents</div>
                ) : (
                  status?.agents.map((agent) => (
                    <div key={agent.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-[var(--pear-border-subtle)] px-3 py-2 last:border-b-0">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{agent.name}</div>
                        <div className="truncate text-xs text-[var(--pear-text-faint)]">{agent.issue?.key ?? agent.role ?? 'factory'}</div>
                      </div>
                      <div className="text-xs text-[var(--pear-text-faint)]">{agent.pids.length ? agent.pids.join(', ') : ''}</div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Heartbeat</h2>
              <div className="rounded-md border border-[var(--pear-border-subtle)] px-3 py-2 text-sm text-[var(--pear-text-dim)]">
                {status?.heartbeat ? (
                  <div className="grid gap-1">
                    <div>{status.heartbeat.status} {status.heartbeat.iteration}/{status.heartbeat.maxIterations}</div>
                    <div className="text-xs text-[var(--pear-text-faint)]">{status.heartbeat.updatedAt}</div>
                    {status.heartbeat.reason && <div className="text-xs text-[var(--pear-text-faint)]">{status.heartbeat.reason}</div>}
                  </div>
                ) : 'No heartbeat'}
              </div>
            </section>

            <section className="grid gap-3">
              <h2 className="text-sm font-semibold text-[var(--pear-text-dim)]">Logs</h2>
              <div className="max-h-[420px] overflow-y-auto rounded-md border border-[var(--pear-border-subtle)] bg-black/20 p-3 font-mono text-xs">
                {logs.length === 0 ? (
                  <div className="text-[var(--pear-text-faint)]">No logs</div>
                ) : logs.map((line, index) => (
                  <div key={`${line.ts}-${index}`} className={line.stream === 'stderr' ? 'text-[var(--pear-red)]' : 'text-[var(--pear-text-dim)]'}>
                    {line.text}
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
