import React, { Suspense, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Code2,
  Database,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Plus,
  RadioTower,
  Save,
  Send,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { pear, type CloudAgentRecord, type ConnectedIntegration, type ProactiveAgentBinding, type ProactiveAgentDraft } from '@/lib/ipc'
import { useCloudAgentCatalog } from '@/hooks/use-cloud-agent'
import { useProactiveAgents } from '@/hooks/use-proactive-agent'
import { useProjectStore, type ProjectIntegration } from '@/stores/project-store'

export type ProactiveAgentEditorProps = {
  projectId: string
  personaId?: string
  onClose: () => void
}

type Harness = ProactiveAgentDraft['harness']
type WatchRule = ProactiveAgentDraft['watch'][number]
type MemoryScope = NonNullable<NonNullable<ProactiveAgentDraft['memory']>['scopes']>[number]
type DeployPhaseId = 'validate' | 'bundle' | 'upload' | 'warm' | 'register'
type DeployPhaseStatus = 'pending' | 'active' | 'done' | 'error'

type DeployPhase = {
  id: DeployPhaseId
  label: string
  status: DeployPhaseStatus
  startedAt?: number
  finishedAt?: number
}

type ProactiveAgentDeployResult = {
  status: 'active' | 'warming' | 'error'
  error?: string
}

type ProactiveAgentEvent = {
  projectId?: string
  personaId?: string
  phase?: DeployPhaseId | 'warm-box' | 'register-triggers'
  status?: string
  error?: string
  message?: string
}

type ProactiveAgentIPC = {
  list?: (projectId: string) => Promise<ProactiveAgentBinding[]>
  create?: (projectId: string, draft: ProactiveAgentDraft) => Promise<ProactiveAgentBinding>
  update?: (projectId: string, personaId: string, draft: ProactiveAgentDraft) => Promise<ProactiveAgentBinding>
  deploy?: (projectId: string, personaId: string) => Promise<ProactiveAgentDeployResult>
  onEvent?: (callback: (event: ProactiveAgentEvent) => void) => () => void
}

type PearWithProactiveAgent = typeof pear & {
  proactiveAgent?: ProactiveAgentIPC
}

type ValidationErrors = Partial<Record<
  | 'id'
  | 'name'
  | 'cloudAgentId'
  | 'harness'
  | 'model'
  | 'systemPrompt'
  | 'watch'
  | 'handlerCode'
  | 'deploy',
  string
>>

type KeyValueRow = {
  id: string
  key: string
  value: string
}

const MODEL_OPTIONS: Record<Harness, string[]> = {
  claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex: ['gpt-5.2', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'],
  opencode: ['claude-sonnet-4-6', 'gpt-5.2', 'qwen3-coder'],
  grok: ['grok-build-0.1', 'grok-code-fast-1', 'grok-code-fast']
}

const DEPLOY_PHASES: DeployPhase[] = [
  { id: 'validate', label: 'Validate', status: 'pending' },
  { id: 'bundle', label: 'Bundle', status: 'pending' },
  { id: 'upload', label: 'Upload', status: 'pending' },
  { id: 'warm', label: 'Warm box', status: 'pending' },
  { id: 'register', label: 'Register triggers', status: 'pending' }
]

const DEFAULT_HANDLER_CODE = `import { handler } from '@agentworkforce/runtime';

export default handler(async (ctx, event) => {
  if (event.type !== 'relayfile.changed') return;
  const file = await ctx.fs.read(event.path);
  // your logic here
  await ctx.notify({ channel: 'pear', text: \`Reacted to \${event.path}\` });
});`

const DEFAULT_WATCH_RULE: WatchRule = {
  paths: [''],
  events: ['created', 'updated', 'deleted'],
  debounceMs: 5000,
  match: ''
}

function createDefaultDraft(): ProactiveAgentDraft {
  return {
    id: '',
    name: '',
    description: '',
    cloudAgentId: '',
    harness: 'claude',
    model: MODEL_OPTIONS.claude[0],
    systemPrompt: 'You are a proactive agent. Use $VAR inputs when needed and act only when a trigger is relevant.',
    integrations: {},
    mount: { enabled: false },
    watch: [{ ...DEFAULT_WATCH_RULE, paths: [...DEFAULT_WATCH_RULE.paths], events: [...DEFAULT_WATCH_RULE.events] }],
    handlerCode: DEFAULT_HANDLER_CODE,
    inputs: {},
    memory: { enabled: false, scopes: [], ttlDays: 30 },
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    runMode: 'cloud'
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function kebabCase(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function cloneWatch(rule: WatchRule): WatchRule {
  return {
    paths: [...rule.paths],
    events: [...rule.events],
    debounceMs: rule.debounceMs,
    match: rule.match || ''
  }
}

function normalizeDraft(draft: ProactiveAgentDraft): ProactiveAgentDraft {
  return {
    ...draft,
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description?.trim() || undefined,
    cloudAgentId: draft.cloudAgentId.trim(),
    model: draft.model.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    integrations: draft.integrations || {},
    mount: { enabled: draft.mount?.enabled === true },
    watch: draft.watch.map((rule) => ({
      paths: rule.paths.map((path) => path.trim()).filter(Boolean),
      events: rule.events.length > 0 ? rule.events : ['created', 'updated', 'deleted'],
      debounceMs: Number.isFinite(rule.debounceMs) ? rule.debounceMs : 5000,
      match: rule.match?.trim() || undefined
    })),
    handlerCode: draft.handlerCode,
    inputs: Object.fromEntries(
      Object.entries(draft.inputs || {})
        .map(([key, value]) => [key.trim(), value])
        .filter(([key]) => key.length > 0)
    ),
    memory: draft.memory?.enabled
      ? {
          enabled: true,
          scopes: draft.memory.scopes || [],
          ttlDays: draft.memory.ttlDays
        }
      : { enabled: false },
    harnessSettings: draft.harnessSettings,
    runMode: 'cloud'
  }
}

function validateDraft(draft: ProactiveAgentDraft): ValidationErrors {
  const normalized = normalizeDraft(draft)
  const errors: ValidationErrors = {}

  if (!normalized.id) errors.id = 'Agent id is required.'
  if (normalized.id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized.id)) {
    errors.id = 'Use kebab-case: lowercase letters, numbers, and single dashes.'
  }
  if (!normalized.name) errors.name = 'Name is required.'
  if (!normalized.cloudAgentId) errors.cloudAgentId = 'Choose a cloud agent.'
  if (!normalized.harness) errors.harness = 'Choose a harness.'
  if (!normalized.model) errors.model = 'Choose a model.'
  if (!normalized.systemPrompt) errors.systemPrompt = 'System prompt is required.'
  if (!normalized.handlerCode.trim()) errors.handlerCode = 'Handler code is required.'
  if (normalized.watch.length === 0 || normalized.watch.every((rule) => rule.paths.length === 0)) {
    errors.watch = 'Add at least one trigger path.'
  }

  return errors
}

function hasErrors(errors: ValidationErrors): boolean {
  return Object.values(errors).some(Boolean)
}

function phaseElapsed(phase: DeployPhase): string {
  if (!phase.startedAt) return '--'

  const end = phase.finishedAt || Date.now()
  return `${Math.max(0, Math.round((end - phase.startedAt) / 100) / 10).toFixed(1)}s`
}

function createKeyValueRows(values: Record<string, string> | undefined): KeyValueRow[] {
  const entries = Object.entries(values || {})
  if (entries.length === 0) return [{ id: crypto.randomUUID(), key: '', value: '' }]
  return entries.map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))
}

function keyValueRowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(
    rows
      .map((row) => [row.key.trim(), row.value] as const)
      .filter(([key]) => key.length > 0)
  )
}

function normalizePhaseId(phase: unknown): DeployPhaseId | null {
  if (phase === 'warm-box') return 'warm'
  if (phase === 'register-triggers') return 'register'
  if (phase === 'validate' || phase === 'bundle' || phase === 'upload' || phase === 'warm' || phase === 'register') {
    return phase
  }
  return null
}

function extractFieldErrors(error: unknown): ValidationErrors {
  if (!error || typeof error !== 'object') return {}

  const record = error as { fieldErrors?: unknown; errors?: unknown }
  const source = record.fieldErrors || record.errors
  if (!source || typeof source !== 'object') return {}

  const next: ValidationErrors = {}
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string') {
      next[key as keyof ValidationErrors] = value
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      next[key as keyof ValidationErrors] = value[0]
    }
  }
  return next
}

function FieldError({ message }: { message?: string }): React.ReactNode {
  if (!message) return null
  return <div className="mt-1 text-xs text-[var(--pear-red)]">{message}</div>
}

function Section({
  children,
  icon,
  subtitle,
  title
}: {
  children: React.ReactNode
  icon: React.ReactNode
  subtitle?: string
  title: string
}): React.ReactNode {
  return (
    <details open className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)]">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/40 text-[var(--pear-accent)]">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[var(--pear-text)]">{title}</span>
          {subtitle && <span className="mt-0.5 block text-xs text-[var(--pear-text-faint)]">{subtitle}</span>}
        </span>
      </summary>
      <div className="border-t border-[var(--pear-border-subtle)] px-4 py-4">
        {children}
      </div>
    </details>
  )
}

function InlineHandlerCodeEditor({
  onChange,
  value
}: {
  value: string
  onChange: (value: string) => void
}): React.ReactNode {
  return (
    <textarea
      value={value}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className="min-h-[360px] w-full resize-y rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-3 font-mono text-xs leading-5 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
    />
  )
}

const HandlerCodeEditor = React.lazy(async () => ({ default: InlineHandlerCodeEditor }))

function WatchRuleEditor({
  onChange,
  onRemove,
  removable,
  rule
}: {
  onChange: (rule: WatchRule) => void
  onRemove: () => void
  removable: boolean
  rule: WatchRule
}): React.ReactNode {
  const pathText = rule.paths.join('\n')

  function toggleEvent(eventName: WatchRule['events'][number]): void {
    const hasEvent = rule.events.includes(eventName)
    const events = hasEvent
      ? rule.events.filter((entry) => entry !== eventName)
      : [...rule.events, eventName]
    onChange({ ...rule, events })
  }

  return (
    <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[var(--pear-text)]">When a file changes</div>
          <div className="mt-0.5 text-xs text-[var(--pear-text-faint)]">Relayfile paths, one glob per line.</div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={!removable}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] text-[var(--pear-text-dim)] hover:border-[var(--pear-red)]/40 hover:text-[var(--pear-red)] disabled:pointer-events-none disabled:opacity-40"
          title="Remove trigger"
          aria-label="Remove trigger"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-[var(--pear-text-dim)]">Paths</span>
        <textarea
          value={pathText}
          placeholder="/integrations/github/repos/acme/web/issues/**/*.json"
          onChange={(event) => onChange({ ...rule, paths: event.target.value.split('\n') })}
          className="mt-1 min-h-[78px] w-full resize-y rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 font-mono text-xs leading-5 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
        />
      </label>

      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_160px]">
        <div>
          <div className="text-xs font-medium text-[var(--pear-text-dim)]">Events</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(['created', 'updated', 'deleted'] as const).map((eventName) => (
              <label key={eventName} className="flex h-8 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2.5 text-xs text-[var(--pear-text-dim)]">
                <input
                  type="checkbox"
                  checked={rule.events.includes(eventName)}
                  onChange={() => toggleEvent(eventName)}
                />
                {eventName}
              </label>
            ))}
          </div>
        </div>

        <label>
          <span className="text-xs font-medium text-[var(--pear-text-dim)]">Debounce ms</span>
          <input
            type="number"
            min={0}
            step={250}
            value={rule.debounceMs ?? 5000}
            onChange={(event) => onChange({ ...rule, debounceMs: Number(event.target.value) })}
            className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
          />
        </label>
      </div>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-[var(--pear-text-dim)]">Match expression</span>
        <input
          type="text"
          value={rule.match || ''}
          placeholder="optional jq-like expression"
          onChange={(event) => onChange({ ...rule, match: event.target.value })}
          className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
        />
      </label>
    </div>
  )
}

function KeyValueEditor({
  onChange,
  rows
}: {
  onChange: (rows: KeyValueRow[]) => void
  rows: KeyValueRow[]
}): React.ReactNode {
  function updateRow(id: string, patch: Partial<KeyValueRow>): void {
    onChange(rows.map((row) => row.id === id ? { ...row, ...patch } : row))
  }

  function removeRow(id: string): void {
    const next = rows.filter((row) => row.id !== id)
    onChange(next.length > 0 ? next : [{ id: crypto.randomUUID(), key: '', value: '' }])
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_36px]">
          <input
            type="text"
            value={row.key}
            placeholder="KEY"
            onChange={(event) => updateRow(row.id, { key: event.target.value })}
            className="h-9 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 font-mono text-xs text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
          />
          <input
            type="text"
            value={row.value}
            placeholder="value"
            onChange={(event) => updateRow(row.id, { value: event.target.value })}
            className="h-9 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
          />
          <button
            type="button"
            onClick={() => removeRow(row.id)}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] text-[var(--pear-text-dim)] hover:border-[var(--pear-red)]/40 hover:text-[var(--pear-red)]"
            title="Remove input"
            aria-label="Remove input"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { id: crypto.randomUUID(), key: '', value: '' }])}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] px-2.5 text-xs font-medium text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
      >
        <Plus size={13} />
        Add input
      </button>
    </div>
  )
}

function DeployProgress({ phases }: { phases: DeployPhase[] }): React.ReactNode {
  return (
    <div className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] p-4">
      <div className="mb-3 text-sm font-semibold text-[var(--pear-text)]">Deploy progress</div>
      <div className="grid gap-2 md:grid-cols-5">
        {phases.map((phase) => (
          <div key={phase.id} className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-3">
            <div className="flex items-center gap-2">
              {phase.status === 'done' ? (
                <CheckCircle2 size={14} className="text-[var(--pear-green)]" />
              ) : phase.status === 'active' ? (
                <Loader2 size={14} className="animate-spin text-[var(--pear-accent)]" />
              ) : phase.status === 'error' ? (
                <AlertTriangle size={14} className="text-[var(--pear-red)]" />
              ) : (
                <span className="h-3.5 w-3.5 rounded-full border border-[var(--pear-border-subtle)]" />
              )}
              <span className="text-xs font-medium text-[var(--pear-text)]">{phase.label}</span>
            </div>
            <div className="mt-2 text-xs text-[var(--pear-text-faint)]">{phaseElapsed(phase)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProactiveAgentEditor({
  projectId,
  personaId,
  onClose
}: ProactiveAgentEditorProps): React.ReactNode {
  const pearApi = pear as unknown as PearWithProactiveAgent
  const project = useProjectStore((state) => state.projects.find((entry) => entry.id === projectId))
  const { bindings } = useProactiveAgents(projectId)
  const { catalog: cloudAgents, refresh: refreshCloudAgents } = useCloudAgentCatalog()
  const existingBinding = useMemo(
    () => bindings.find((binding) => binding.personaId === personaId) || null,
    [bindings, personaId]
  )

  const [draft, setDraft] = useState<ProactiveAgentDraft>(() => existingBinding?.draft || createDefaultDraft())
  const [inputs, setInputs] = useState<KeyValueRow[]>(() => createKeyValueRows(existingBinding?.draft.inputs))
  const [connectedIntegrations, setConnectedIntegrations] = useState<ConnectedIntegration[]>([])
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)
  const [idTouched, setIdTouched] = useState(Boolean(existingBinding?.draft.id))
  const [viewJson, setViewJson] = useState(false)
  const [errors, setErrors] = useState<ValidationErrors>({})
  const [busy, setBusy] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [deployMessage, setDeployMessage] = useState<string | null>(null)
  const [deployPhases, setDeployPhases] = useState<DeployPhase[]>(DEPLOY_PHASES)

  useEffect(() => {
    if (!existingBinding) return
    setDraft(existingBinding.draft)
    setInputs(createKeyValueRows(existingBinding.draft.inputs))
    setIdTouched(Boolean(existingBinding.draft.id))
  }, [existingBinding])

  useEffect(() => {
    void refreshCloudAgents()
  }, [refreshCloudAgents])

  useEffect(() => {
    let cancelled = false

    async function loadIntegrations(): Promise<void> {
      setLoadingIntegrations(true)
      try {
        const next = await pear.integrations.list(projectId)
        if (!cancelled) setConnectedIntegrations(next)
      } catch {
        if (!cancelled) setConnectedIntegrations([])
      } finally {
        if (!cancelled) setLoadingIntegrations(false)
      }
    }

    void loadIntegrations()
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    const unsubscribe = pearApi.proactiveAgent?.onEvent?.((event) => {
      if (event.projectId && event.projectId !== projectId) return
      if (event.personaId && personaId && event.personaId !== personaId) return

      const eventRecord = event as Record<string, unknown>
      const phaseId = normalizePhaseId(eventRecord.phase)
      if (phaseId) {
        markPhase(phaseId, eventRecord.status === 'error' ? 'error' : 'done')
      }
      const eventError = typeof eventRecord.error === 'string' ? eventRecord.error : null
      const eventMessage = typeof eventRecord.message === 'string' ? eventRecord.message : null
      if (eventError || eventMessage) {
        setDeployMessage(eventError || eventMessage)
      }
    })

    return () => {
      unsubscribe?.()
    }
  }, [pearApi.proactiveAgent, personaId, projectId])

  const selectedDraft = useMemo(
    () => normalizeDraft({ ...draft, inputs: keyValueRowsToRecord(inputs) }),
    [draft, inputs]
  )

  const availableIntegrations = useMemo(() => {
    if (connectedIntegrations.length > 0) return connectedIntegrations

    return (project?.integrations || []).map((integration: ProjectIntegration): ConnectedIntegration => ({
      provider: integration.type,
      integrationId: integration.id,
      scope: { name: integration.name },
      mountPaths: [],
      connectedAt: '',
      notifyAgent: true
    }))
  }, [connectedIntegrations, project?.integrations])

  const selectedIntegrationKeys = useMemo(
    () => new Set(Object.keys(draft.integrations || {})),
    [draft.integrations]
  )

  function patchDraft(patch: Partial<ProactiveAgentDraft>): void {
    setDraft((current) => ({ ...current, ...patch }))
  }

  function markPhase(phaseId: DeployPhaseId, status: DeployPhaseStatus): void {
    setDeployPhases((current) => current.map((phase) => {
      if (phase.id !== phaseId) return phase

      const now = Date.now()
      return {
        ...phase,
        status,
        startedAt: status === 'active' ? now : phase.startedAt || now,
        finishedAt: status === 'done' || status === 'error' ? now : undefined
      }
    }))
  }

  function resetDeployPhases(): void {
    setDeployPhases(DEPLOY_PHASES.map((phase) => ({ ...phase })))
  }

  function updateWatchRule(index: number, rule: WatchRule): void {
    patchDraft({
      watch: draft.watch.map((entry, entryIndex) => entryIndex === index ? rule : entry)
    })
  }

  function removeWatchRule(index: number): void {
    const next = draft.watch.filter((_entry, entryIndex) => entryIndex !== index)
    patchDraft({ watch: next.length > 0 ? next : [cloneWatch(DEFAULT_WATCH_RULE)] })
  }

  function toggleIntegration(integration: ConnectedIntegration): void {
    const key = integration.provider
    const next = { ...(draft.integrations || {}) }
    if (selectedIntegrationKeys.has(key)) {
      delete next[key]
    } else {
      next[key] = integration.scope || {}
    }
    patchDraft({ integrations: next })
  }

  function toggleMemoryScope(scope: MemoryScope): void {
    const memory = draft.memory || { enabled: false, scopes: [], ttlDays: 30 }
    const scopes = new Set<MemoryScope>(memory.scopes || [])
    if (scopes.has(scope)) {
      scopes.delete(scope)
    } else {
      scopes.add(scope)
    }
    patchDraft({ memory: { ...memory, scopes: Array.from(scopes) } })
  }

  function handleNameBlur(): void {
    if (idTouched || draft.id.trim()) return
    const nextId = kebabCase(draft.name)
    if (nextId) patchDraft({ id: nextId })
  }

  async function saveDraft(): Promise<ProactiveAgentBinding | null> {
    const validation = validateDraft(selectedDraft)
    setErrors(validation)
    if (hasErrors(validation)) return null

    const proactiveAgent = pearApi.proactiveAgent
    if (!proactiveAgent?.create || !proactiveAgent.update) {
      setErrors({ deploy: 'Proactive agent IPC is not available yet.' })
      return null
    }

    const saved = personaId
      ? await proactiveAgent.update(projectId, personaId, selectedDraft)
      : await proactiveAgent.create(projectId, selectedDraft)
    return saved
  }

  async function handleSaveDraft(): Promise<void> {
    setBusy(true)
    setDeployMessage(null)
    try {
      await saveDraft()
    } catch (err) {
      setErrors({ ...extractFieldErrors(err), deploy: getErrorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleDeploy(): Promise<void> {
    setBusy(true)
    setDeploying(true)
    setDeployMessage(null)
    resetDeployPhases()

    try {
      markPhase('validate', 'active')
      const validation = validateDraft(selectedDraft)
      if (hasErrors(validation)) {
        setErrors(validation)
        markPhase('validate', 'error')
        return
      }
      markPhase('validate', 'done')

      markPhase('bundle', 'active')
      const saved = await saveDraft()
      if (!saved) {
        markPhase('bundle', 'error')
        return
      }
      markPhase('bundle', 'done')

      const proactiveAgent = pearApi.proactiveAgent
      if (!proactiveAgent?.deploy) {
        markPhase('upload', 'error')
        setErrors({ deploy: 'Proactive agent deploy IPC is not available yet.' })
        return
      }

      markPhase('upload', 'active')
      const deployPersonaId = personaId || saved.personaId || selectedDraft.id
      const result = await proactiveAgent.deploy(projectId, deployPersonaId)
      markPhase('upload', result.status === 'error' ? 'error' : 'done')

      markPhase('warm', 'active')
      markPhase('warm', result.status === 'error' ? 'error' : 'done')
      markPhase('register', result.status === 'error' ? 'error' : 'active')
      markPhase('register', result.status === 'error' ? 'error' : 'done')

      if (result.status === 'error') {
        setErrors({ deploy: result.error || 'Deploy failed.' })
        setDeployMessage(result.error || 'Deploy failed.')
      } else {
        setErrors({})
        setDeployMessage(result.status === 'warming' ? 'Agent saved and warming.' : 'Agent deployed.')
      }
    } catch (err) {
      const fieldErrors = extractFieldErrors(err)
      setErrors({ ...fieldErrors, deploy: getErrorMessage(err) })
      setDeployMessage(getErrorMessage(err))
      setDeployPhases((current) => current.map((phase) => phase.status === 'active' ? { ...phase, status: 'error', finishedAt: Date.now() } : phase))
    } finally {
      setBusy(false)
      setDeploying(false)
    }
  }

  function handleHarnessChange(harness: Harness): void {
    patchDraft({ harness, model: MODEL_OPTIONS[harness][0] })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
      <header className="border-b border-[var(--pear-border)] bg-[var(--pear-bg-surface)] px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-[var(--pear-text-faint)]">
              <RadioTower size={13} />
              Agents
            </div>
            <h1 className="truncate text-2xl font-semibold text-[var(--pear-text)]">
              {personaId ? 'Edit agent' : 'New agent'}
            </h1>
            <p className="mt-1 text-sm text-[var(--pear-text-dim)]">
              {project ? project.name : projectId} - cloud mode
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setViewJson((current) => !current)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] px-3 text-sm font-medium text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
            >
              {viewJson ? <EyeOff size={14} /> : <Eye size={14} />}
              View as JSON
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
              title="Close editor"
              aria-label="Close editor"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-5 px-6 py-6">
          {errors.deploy && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              {errors.deploy}
            </div>
          )}

          {deployMessage && (
            <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2 text-sm text-[var(--pear-text-dim)]">
              {deployMessage}
            </div>
          )}

          {deploying || deployPhases.some((phase) => phase.status !== 'pending') ? (
            <DeployProgress phases={deployPhases} />
          ) : null}

          {viewJson ? (
            <pre className="overflow-auto rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] p-4 font-mono text-xs leading-5 text-[var(--pear-text-dim)]">
              {JSON.stringify(selectedDraft, null, 2)}
            </pre>
          ) : (
            <>
              <Section
                title="Identity"
                subtitle="Name the agent and keep the internal id stable."
                icon={<Settings size={15} />}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-medium text-[var(--pear-text-dim)]">Name</span>
                    <input
                      type="text"
                      value={draft.name}
                      placeholder="Release Notes Bot"
                      onBlur={handleNameBlur}
                      onChange={(event) => patchDraft({ name: event.target.value })}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
                    />
                    <FieldError message={errors.name} />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-[var(--pear-text-dim)]">Agent id</span>
                    <input
                      type="text"
                      value={draft.id}
                      placeholder="release-notes-bot"
                      onChange={(event) => {
                        setIdTouched(true)
                        patchDraft({ id: event.target.value })
                      }}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 font-mono text-xs text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
                    />
                    <FieldError message={errors.id} />
                  </label>
                </div>

                <label className="mt-4 block">
                  <span className="text-xs font-medium text-[var(--pear-text-dim)]">Description</span>
                  <textarea
                    value={draft.description || ''}
                    placeholder="What this agent watches and what it does."
                    onChange={(event) => patchDraft({ description: event.target.value })}
                    className="mt-1 min-h-[78px] w-full resize-y rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-sm leading-5 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
                  />
                </label>
              </Section>

              <Section
                title="Runtime"
                subtitle="Runs in cloud mode for v1."
                icon={<Cloud size={15} />}
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <label className="block">
                    <span className="text-xs font-medium text-[var(--pear-text-dim)]">Cloud agent</span>
                    <select
                      value={draft.cloudAgentId}
                      onChange={(event) => patchDraft({ cloudAgentId: event.target.value })}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
                    >
                      <option value="">Choose agent</option>
                      {cloudAgents.map((agent: CloudAgentRecord) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.displayName || agent.name} ({agent.harness})
                        </option>
                      ))}
                    </select>
                    <FieldError message={errors.cloudAgentId} />
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-[var(--pear-text-dim)]">Harness</span>
                    <select
                      value={draft.harness}
                      onChange={(event) => handleHarnessChange(event.target.value as Harness)}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
                    >
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="opencode">OpenCode</option>
                      <option value="grok">Grok</option>
                    </select>
                    <FieldError message={errors.harness} />
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-[var(--pear-text-dim)]">Model</span>
                    <select
                      value={draft.model}
                      onChange={(event) => patchDraft({ model: event.target.value })}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
                    >
                      {MODEL_OPTIONS[draft.harness].map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                    <FieldError message={errors.model} />
                  </label>
                </div>

                <label className="mt-4 block">
                  <span className="text-xs font-medium text-[var(--pear-text-dim)]">System prompt</span>
                  <textarea
                    value={draft.systemPrompt}
                    placeholder="Use $VAR inputs such as $REPO or $CHANNEL inside this prompt."
                    onChange={(event) => patchDraft({ systemPrompt: event.target.value })}
                    className="mt-1 min-h-[128px] w-full resize-y rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-sm leading-5 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
                  />
                  <div className="mt-1 text-xs text-[var(--pear-text-faint)]">$VAR values are substituted from Inputs / env.</div>
                  <FieldError message={errors.systemPrompt} />
                </label>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-medium text-[var(--pear-text-dim)]">Reasoning</span>
                    <select
                      value={draft.harnessSettings?.reasoning || 'medium'}
                      onChange={(event) => patchDraft({ harnessSettings: { ...draft.harnessSettings, reasoning: event.target.value as 'low' | 'medium' | 'high' } })}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-[var(--pear-text-dim)]">Timeout seconds</span>
                    <input
                      type="number"
                      min={30}
                      value={draft.harnessSettings?.timeoutSeconds || 300}
                      onChange={(event) => patchDraft({ harnessSettings: { ...draft.harnessSettings, timeoutSeconds: Number(event.target.value) } })}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
                    />
                  </label>
                </div>
              </Section>

              <Section
                title="Integrations"
                subtitle="Project-visible integrations are inherited by the agent."
                icon={<Database size={15} />}
              >
                <div className="flex flex-wrap gap-2">
                  {loadingIntegrations && (
                    <div className="flex items-center gap-2 text-sm text-[var(--pear-text-faint)]">
                      <Loader2 size={14} className="animate-spin" />
                      Loading integrations
                    </div>
                  )}
                  {!loadingIntegrations && availableIntegrations.length === 0 && (
                    <div className="rounded-md border border-dashed border-[var(--pear-border-subtle)] px-3 py-2 text-sm text-[var(--pear-text-faint)]">
                      No project integrations are visible yet.
                    </div>
                  )}
                  {availableIntegrations.map((integration) => {
                    const selected = selectedIntegrationKeys.has(integration.provider)
                    return (
                      <button
                        key={`${integration.provider}:${integration.integrationId}`}
                        type="button"
                        onClick={() => toggleIntegration(integration)}
                        className={`rounded-md border px-3 py-2 text-left text-sm ${
                          selected
                            ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-accent)]/10 text-[var(--pear-text)]'
                            : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)]'
                        }`}
                      >
                        <span className="block font-medium">{integration.provider}</span>
                        <span className="mt-0.5 block max-w-[260px] truncate text-xs text-[var(--pear-text-faint)]">
                          {integration.mountPaths.length > 0 ? integration.mountPaths.join(', ') : 'Scope inherited'}
                        </span>
                      </button>
                    )
                  })}
                </div>

                <div className="mt-4 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-3">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={draft.mount?.enabled === true}
                      onChange={(event) => patchDraft({ mount: { enabled: event.target.checked } })}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-medium text-[var(--pear-text)]">Use relayfile mount</span>
                      <span className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-[var(--pear-text-faint)]" title="Mount is slower to spin up but lets your handler read integration data as files. Most handlers don't need it.">
                        <Info size={13} className="mt-0.5 shrink-0" />
                        Mount is slower to spin up but lets your handler read integration data as files. Most handlers don't need it.
                      </span>
                      <a href="LINK_TO_RELAYFILE_PERF_ISSUE" className="mt-1 inline-block text-xs text-[var(--pear-accent)] hover:underline">
                        LINK_TO_RELAYFILE_PERF_ISSUE
                      </a>
                    </span>
                  </label>
                </div>
              </Section>

              <Section
                title="Triggers"
                subtitle="Fire the agent when matching relayfile paths change."
                icon={<RadioTower size={15} />}
              >
                <div className="space-y-3">
                  {draft.watch.map((rule, index) => (
                    <WatchRuleEditor
                      key={index}
                      rule={rule}
                      removable={draft.watch.length > 1}
                      onChange={(nextRule) => updateWatchRule(index, nextRule)}
                      onRemove={() => removeWatchRule(index)}
                    />
                  ))}
                  <FieldError message={errors.watch} />
                  <button
                    type="button"
                    onClick={() => patchDraft({ watch: [...draft.watch, cloneWatch(DEFAULT_WATCH_RULE)] })}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] px-2.5 text-xs font-medium text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
                  >
                    <Plus size={13} />
                    Add trigger
                  </button>
                </div>
              </Section>

              <Section
                title="Handler code"
                subtitle="The handler runs when a trigger fires."
                icon={<Code2 size={15} />}
              >
                <Suspense fallback={<div className="flex h-40 items-center justify-center gap-2 text-sm text-[var(--pear-text-faint)]"><Loader2 size={14} className="animate-spin" />Loading handler editor</div>}>
                  <HandlerCodeEditor
                    value={draft.handlerCode}
                    onChange={(handlerCode) => patchDraft({ handlerCode })}
                  />
                </Suspense>
                <FieldError message={errors.handlerCode} />
              </Section>

              <Section
                title="Inputs / env"
                subtitle="Non-secret values available to prompts and handlers."
                icon={<Settings size={15} />}
              >
                <KeyValueEditor rows={inputs} onChange={setInputs} />
              </Section>

              <Section
                title="Memory"
                subtitle="Optional long-lived context for this agent."
                icon={<Database size={15} />}
              >
                <label className="flex items-center gap-2 text-sm text-[var(--pear-text)]">
                  <input
                    type="checkbox"
                    checked={draft.memory?.enabled === true}
                    onChange={(event) => patchDraft({ memory: { ...(draft.memory || {}), enabled: event.target.checked, scopes: draft.memory?.scopes || [], ttlDays: draft.memory?.ttlDays || 30 } })}
                  />
                  Enable memory
                </label>

                {draft.memory?.enabled && (
                  <div className="mt-4 grid gap-4 md:grid-cols-[1fr_160px]">
                    <div>
                      <div className="text-xs font-medium text-[var(--pear-text-dim)]">Scopes</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(['workspace', 'project', 'persona'] as const).map((scope) => (
                          <label key={scope} className="flex h-8 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2.5 text-xs text-[var(--pear-text-dim)]">
                            <input
                              type="checkbox"
                              checked={(draft.memory?.scopes || []).includes(scope)}
                              onChange={() => toggleMemoryScope(scope)}
                            />
                            {scope}
                          </label>
                        ))}
                      </div>
                    </div>
                    <label>
                      <span className="text-xs font-medium text-[var(--pear-text-dim)]">TTL days</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.memory.ttlDays || 30}
                        onChange={(event) => patchDraft({ memory: { ...draft.memory, enabled: true, ttlDays: Number(event.target.value) } })}
                        className="mt-1 h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
                      />
                    </label>
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-[var(--pear-border)] bg-[var(--pear-bg-surface)] px-6 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-md border border-[var(--pear-border-subtle)] px-3 text-sm font-medium text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:pointer-events-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSaveDraft()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] px-3 text-sm font-medium text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:pointer-events-none disabled:opacity-50"
          >
            {busy && !deploying ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save draft
          </button>
          <button
            type="button"
            onClick={() => void handleDeploy()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--pear-accent)] px-3 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:pointer-events-none disabled:opacity-50"
          >
            {deploying ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Deploy
          </button>
        </div>
      </footer>
    </div>
  )
}

export default ProactiveAgentEditor
