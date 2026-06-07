import { rm } from 'node:fs/promises'
import {
  buildPersonaSpec,
  deployBundle,
  proactiveAgentBundleDir,
  stageBundle
} from './proactive-agent.bundle'
import { resolveCloudAuth } from './auth'
import { loadStore, saveStore, type Project } from './store'
import type {
  ProactiveAgentBinding,
  ProactiveAgentDeployPhase,
  ProactiveAgentDeployResult,
  ProactiveAgentDraft,
  ProactiveAgentEvent,
  ProactiveAgentRun,
  ProactiveAgentRunsPage,
  ProactiveAgentStatus,
  ProactiveAgentTranscript,
  ProactiveAgentWatchEventKind
} from './proactive-agent.types'

type Listener = (event: ProactiveAgentEvent) => void
type CloudMethod = 'GET' | 'PATCH' | 'DELETE'

type CloudAuth = {
  accessToken: string
  apiUrl: string
}

type CloudPersonaRecord = {
  id?: unknown
  personaId?: unknown
  status?: unknown
  lastError?: unknown
  lastFiredAt?: unknown
  updatedAt?: unknown
}

type PersonaKitModule = {
  parsePersonaSpec?: (spec: unknown) => unknown
}

const PERSONA_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WATCH_EVENTS = new Set<ProactiveAgentWatchEventKind>(['created', 'updated', 'deleted'])
const HARNESSES = new Set(['claude', 'codex', 'opencode', 'grok'])
const RUN_MODES = new Set(['cloud', 'local'])
const MEMORY_SCOPES = new Set(['workspace', 'project', 'persona'])
const REASONING_LEVELS = new Set(['low', 'medium', 'high'])

let personaKitMissingWarned = false

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeId(value: string, label: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error(`${label} is required`)
  return id
}

function cloneBinding(binding: ProactiveAgentBinding): ProactiveAgentBinding {
  return JSON.parse(JSON.stringify(binding)) as ProactiveAgentBinding
}

function cloneRun(run: ProactiveAgentRun): ProactiveAgentRun {
  return JSON.parse(JSON.stringify(run)) as ProactiveAgentRun
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloudPath(path: string, query?: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query || {})) {
    if (value) params.set(key, value)
  }
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

function buildCloudApiUrl(auth: CloudAuth, path: string): string {
  return new URL(path.replace(/^\/+/, ''), `${auth.apiUrl}/`).toString()
}

function isUnsupportedCloudEndpoint(response: Response): boolean {
  return response.status === 404 || response.status === 405 || response.status === 501
}

function readCloudError(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    for (const key of ['error', 'message', 'detail']) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  return fallback
}

async function readCloudJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingModuleError(error: unknown): boolean {
  if (!isRecord(error)) return false
  const code = error.code
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return true
  const message = typeof error.message === 'string' ? error.message : ''
  return message.includes('Cannot find package') || message.includes('Cannot find module')
}

async function loadPersonaKit(): Promise<PersonaKitModule | null> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>

  try {
    return await dynamicImport('@agentworkforce/persona-kit') as PersonaKitModule
  } catch (error) {
    if (isMissingModuleError(error)) return null
    throw error
  }
}

function normalizeCloudStatus(value: unknown): ProactiveAgentStatus | null {
  if (value === 'draft' || value === 'warming' || value === 'active' || value === 'paused' || value === 'error') {
    return value
  }
  if (value === 'ready') return 'active'
  if (value === 'failed') return 'error'
  return null
}

function normalizeRunsPage(payload: unknown): ProactiveAgentRunsPage {
  if (Array.isArray(payload)) {
    return { runs: payload as ProactiveAgentRun[] }
  }

  if (isRecord(payload)) {
    return {
      runs: Array.isArray(payload.runs) ? payload.runs as ProactiveAgentRun[] : [],
      ...(typeof payload.nextCursor === 'string' ? { nextCursor: payload.nextCursor } : {})
    }
  }

  return { runs: [] }
}

function normalizeTranscript(runId: string, payload: unknown): ProactiveAgentTranscript {
  if (!isRecord(payload)) return { runId, messages: [] }
  const messages = Array.isArray(payload.messages)
    ? payload.messages as ProactiveAgentTranscript['messages']
    : []

  return {
    runId: typeof payload.runId === 'string' ? payload.runId : runId,
    ...(typeof payload.projectId === 'string' ? { projectId: payload.projectId } : {}),
    ...(typeof payload.personaId === 'string' ? { personaId: payload.personaId } : {}),
    messages
  }
}

function normalizeCloudPersonaList(payload: unknown): CloudPersonaRecord[] {
  if (Array.isArray(payload)) return payload as CloudPersonaRecord[]
  if (isRecord(payload)) {
    for (const key of ['personas', 'agents', 'items']) {
      const value = payload[key]
      if (Array.isArray(value)) return value as CloudPersonaRecord[]
    }
  }
  return []
}

export class ProactiveAgentManager {
  private readonly listeners = new Set<Listener>()
  private readonly runCache = new Map<string, ProactiveAgentRun[]>()

  async restore(projectId: string): Promise<void> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const project = this.requireProject(normalizedProjectId)
    let bindings = (project.proactiveAgents || []).map(cloneBinding)

    try {
      const cloudRecords = await this.listCloudPersonas(project)
      bindings = this.reconcileCloudBindings(normalizedProjectId, bindings, cloudRecords)
      this.replaceProjectBindings(normalizedProjectId, bindings)
    } catch (error) {
      console.warn(`[proactive-agent] Failed to reconcile cloud status for ${normalizedProjectId}: ${toErrorMessage(error)}`)
    }

    for (const binding of bindings) {
      this.emit({ type: 'binding-updated', projectId: normalizedProjectId, personaId: binding.personaId, binding })
    }
  }

  async list(projectId: string): Promise<ProactiveAgentBinding[]> {
    const project = this.requireProject(projectId)
    return (project.proactiveAgents || []).map(cloneBinding)
  }

  async create(projectId: string, draft: ProactiveAgentDraft): Promise<ProactiveAgentBinding> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    this.requireProject(normalizedProjectId)
    const normalizedDraft = this.normalizeDraft(draft)
    await this.validateDraft(normalizedDraft)
    await stageBundle({ projectId: normalizedProjectId, draft: normalizedDraft })

    const timestamp = nowIso()
    const binding: ProactiveAgentBinding = {
      projectId: normalizedProjectId,
      personaId: normalizedDraft.id,
      cloudAgentId: normalizedDraft.cloudAgentId,
      status: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
      draft: normalizedDraft
    }

    this.upsertBinding(normalizedProjectId, binding)
    this.emit({ type: 'binding-updated', projectId: normalizedProjectId, personaId: binding.personaId, binding })
    return cloneBinding(binding)
  }

  async update(projectId: string, personaId: string, draft: ProactiveAgentDraft): Promise<ProactiveAgentBinding> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const normalizedPersonaId = normalizeId(personaId, 'Persona id')
    const current = this.requireBinding(normalizedProjectId, normalizedPersonaId)
    const normalizedDraft = this.normalizeDraft({ ...draft, id: normalizedPersonaId })
    await this.validateDraft(normalizedDraft)
    await stageBundle({ projectId: normalizedProjectId, draft: normalizedDraft })

    const binding: ProactiveAgentBinding = {
      ...current,
      cloudAgentId: normalizedDraft.cloudAgentId,
      status: current.status === 'error' ? 'draft' : current.status,
      lastError: undefined,
      updatedAt: nowIso(),
      draft: normalizedDraft
    }

    this.upsertBinding(normalizedProjectId, binding)
    this.emit({ type: 'binding-updated', projectId: normalizedProjectId, personaId: binding.personaId, binding })
    return cloneBinding(binding)
  }

  async deploy(projectId: string, personaId: string): Promise<ProactiveAgentDeployResult> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const normalizedPersonaId = normalizeId(personaId, 'Persona id')
    const binding = this.requireBinding(normalizedProjectId, normalizedPersonaId)
    const project = this.requireProject(normalizedProjectId)

    if (binding.draft.runMode === 'local') {
      throw new Error('Local run mode is v2 — coming soon')
    }

    await this.validateDraft(binding.draft)
    this.updateBindingStatus(normalizedProjectId, normalizedPersonaId, 'warming')
    const result = await deployBundle({
      projectId: normalizedProjectId,
      draft: binding.draft,
      workspace: project.relayWorkspaceId || normalizedProjectId,
      onPhase: (phase) => {
        this.emitDeployPhase(normalizedProjectId, normalizedPersonaId, phase)
      }
    })

    this.updateBindingStatus(
      normalizedProjectId,
      normalizedPersonaId,
      result.status,
      result.error
    )

    return result.error
      ? { status: result.status, error: result.error }
      : { status: result.status }
  }

  async pause(projectId: string, personaId: string): Promise<void> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const normalizedPersonaId = normalizeId(personaId, 'Persona id')
    const binding = this.requireBinding(normalizedProjectId, normalizedPersonaId)
    const project = this.requireProject(normalizedProjectId)

    await this.patchCloudPersonaStatus(project, binding, 'paused')
    this.updateBindingStatus(normalizedProjectId, normalizedPersonaId, 'paused')
  }

  async resume(projectId: string, personaId: string): Promise<void> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const normalizedPersonaId = normalizeId(personaId, 'Persona id')
    const binding = this.requireBinding(normalizedProjectId, normalizedPersonaId)
    const project = this.requireProject(normalizedProjectId)

    await this.patchCloudPersonaStatus(project, binding, 'active')
    this.updateBindingStatus(normalizedProjectId, normalizedPersonaId, 'active')
  }

  async undeploy(projectId: string, personaId: string): Promise<void> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const normalizedPersonaId = normalizeId(personaId, 'Persona id')
    const binding = this.requireBinding(normalizedProjectId, normalizedPersonaId)
    const project = this.requireProject(normalizedProjectId)

    await this.deleteCloudPersona(project, binding)
    await rm(proactiveAgentBundleDir(normalizedProjectId, normalizedPersonaId), { recursive: true, force: true })

    const data = loadStore()
    const storedProject = this.findProject(data.projects, normalizedProjectId)
    if (!storedProject) return

    storedProject.proactiveAgents = (storedProject.proactiveAgents || []).filter((entry) => entry.personaId !== normalizedPersonaId)
    saveStore(data)
    this.runCache.delete(this.runCacheKey(normalizedProjectId, normalizedPersonaId))
    this.emit({ type: 'binding-removed', projectId: normalizedProjectId, personaId: normalizedPersonaId })
  }

  async runs(projectId: string, personaId: string, opts: { limit?: number; cursor?: string } = {}): Promise<ProactiveAgentRunsPage> {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const normalizedPersonaId = normalizeId(personaId, 'Persona id')
    const binding = this.requireBinding(normalizedProjectId, normalizedPersonaId)
    const project = this.requireProject(normalizedProjectId)
    const page = await this.fetchCloudRuns(project, binding, opts)

    this.runCache.set(this.runCacheKey(normalizedProjectId, normalizedPersonaId), page.runs.map(cloneRun))
    return {
      runs: page.runs.map(cloneRun),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }
  }

  async runTranscript(runId: string): Promise<ProactiveAgentTranscript> {
    const normalizedRunId = normalizeId(runId, 'Run id')
    return this.fetchCloudTranscript(normalizedRunId)
  }

  onEvent(handler: Listener): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  private emit(event: ProactiveAgentEvent): void {
    this.listeners.forEach((listener) => {
      listener(event)
    })
  }

  private emitDeployPhase(projectId: string, personaId: string, phase: ProactiveAgentDeployPhase, error?: string): void {
    this.emit({
      type: 'deploy-phase',
      projectId,
      personaId,
      phase,
      status: error ? 'error' : 'done',
      ...(error ? { error } : {})
    } as unknown as ProactiveAgentEvent)
  }

  private normalizeDraft(draft: ProactiveAgentDraft): ProactiveAgentDraft {
    if (!isRecord(draft)) throw new Error('Draft is required')
    const id = normalizeId(draft.id, 'Agent id')
    const name = normalizeId(draft.name, 'Agent name')
    const cloudAgentId = normalizeId(draft.cloudAgentId, 'Cloud agent id')
    const model = normalizeId(draft.model, 'Model')
    const systemPrompt = normalizeId(draft.systemPrompt, 'System prompt')
    const handlerCode = normalizeId(draft.handlerCode, 'Handler code')

    return {
      ...draft,
      id,
      name,
      cloudAgentId,
      model,
      systemPrompt,
      handlerCode,
      integrations: isRecord(draft.integrations) ? draft.integrations : {},
      watch: Array.isArray(draft.watch) ? draft.watch : [],
      mount: { enabled: draft.mount?.enabled ?? false },
      runMode: draft.runMode || 'cloud'
    }
  }

  private async validateDraft(draft: ProactiveAgentDraft): Promise<void> {
    if (!PERSONA_ID_RE.test(draft.id)) {
      throw new Error('Agent id must be kebab-case')
    }
    if (!HARNESSES.has(draft.harness)) {
      throw new Error('Harness must be one of claude, codex, opencode, or grok')
    }
    if (!RUN_MODES.has(draft.runMode || 'cloud')) {
      throw new Error('Run mode must be cloud or local')
    }
    if (!isRecord(draft.integrations)) {
      throw new Error('Integrations must be an object')
    }
    for (const [key, value] of Object.entries(draft.integrations)) {
      if (!key.trim() || !isRecord(value)) throw new Error('Each integration must be an object')
    }
    if (!Array.isArray(draft.watch) || draft.watch.length === 0) {
      throw new Error('At least one watch rule is required')
    }
    draft.watch.forEach((rule, index) => {
      if (!isRecord(rule)) throw new Error(`Watch rule ${index + 1} must be an object`)
      if (!Array.isArray(rule.paths) || rule.paths.length === 0) {
        throw new Error(`Watch rule ${index + 1} requires at least one path`)
      }
      for (const path of rule.paths) {
        if (typeof path !== 'string' || !path.trim()) throw new Error(`Watch rule ${index + 1} includes an empty path`)
      }
      if (!Array.isArray(rule.events) || rule.events.length === 0) {
        throw new Error(`Watch rule ${index + 1} requires at least one event`)
      }
      for (const event of rule.events) {
        if (!WATCH_EVENTS.has(event)) throw new Error(`Watch rule ${index + 1} has an unsupported event`)
      }
      if (rule.debounceMs !== undefined && (!Number.isFinite(rule.debounceMs) || rule.debounceMs < 0)) {
        throw new Error(`Watch rule ${index + 1} debounce must be a non-negative number`)
      }
      if (rule.match !== undefined && typeof rule.match !== 'string') {
        throw new Error(`Watch rule ${index + 1} match must be a string`)
      }
    })
    if (draft.inputs !== undefined) {
      if (!isRecord(draft.inputs)) throw new Error('Inputs must be an object')
      for (const [key, value] of Object.entries(draft.inputs)) {
        if (!key.trim() || typeof value !== 'string') throw new Error('Inputs must be string key/value pairs')
      }
    }
    if (draft.memory !== undefined) {
      if (!isRecord(draft.memory) || typeof draft.memory.enabled !== 'boolean') {
        throw new Error('Memory enabled must be a boolean')
      }
      if (draft.memory.scopes !== undefined) {
        if (!Array.isArray(draft.memory.scopes)) throw new Error('Memory scopes must be an array')
        for (const scope of draft.memory.scopes) {
          if (!MEMORY_SCOPES.has(scope)) throw new Error('Memory scope is unsupported')
        }
      }
      if (draft.memory.ttlDays !== undefined && (!Number.isFinite(draft.memory.ttlDays) || draft.memory.ttlDays <= 0)) {
        throw new Error('Memory TTL must be a positive number')
      }
    }
    if (draft.harnessSettings !== undefined) {
      if (!isRecord(draft.harnessSettings)) throw new Error('Harness settings must be an object')
      if (draft.harnessSettings.reasoning !== undefined && !REASONING_LEVELS.has(draft.harnessSettings.reasoning)) {
        throw new Error('Harness reasoning level is unsupported')
      }
      if (
        draft.harnessSettings.timeoutSeconds !== undefined &&
        (!Number.isFinite(draft.harnessSettings.timeoutSeconds) || draft.harnessSettings.timeoutSeconds <= 0)
      ) {
        throw new Error('Harness timeout must be a positive number')
      }
    }
    if (draft.mount !== undefined && (!isRecord(draft.mount) || typeof draft.mount.enabled !== 'boolean')) {
      throw new Error('Mount enabled must be a boolean')
    }

    const personaKit = await loadPersonaKit()
    if (!personaKit?.parsePersonaSpec) {
      if (!personaKitMissingWarned) {
        console.warn('[proactive-agent] @agentworkforce/persona-kit is unavailable; using Pear runtime validation only.')
        personaKitMissingWarned = true
      }
      return
    }

    try {
      personaKit.parsePersonaSpec(buildPersonaSpec(draft, { handlerEntry: './agent.ts' }))
    } catch (error) {
      throw new Error(`Persona validation failed: ${toErrorMessage(error)}`)
    }
  }

  private updateBindingStatus(
    projectId: string,
    personaId: string,
    status: ProactiveAgentBinding['status'],
    lastError?: string
  ): ProactiveAgentBinding {
    const normalizedProjectId = normalizeId(projectId, 'Project id')
    const normalizedPersonaId = normalizeId(personaId, 'Persona id')
    const current = this.requireBinding(normalizedProjectId, normalizedPersonaId)
    const binding: ProactiveAgentBinding = {
      ...current,
      status,
      ...(lastError ? { lastError } : { lastError: undefined }),
      updatedAt: nowIso()
    }
    this.upsertBinding(normalizedProjectId, binding)
    this.emit({ type: 'binding-updated', projectId: normalizedProjectId, personaId: normalizedPersonaId, binding })
    return binding
  }

  private upsertBinding(projectId: string, binding: ProactiveAgentBinding): void {
    const data = loadStore()
    const project = this.findProject(data.projects, projectId)
    if (!project) throw new Error('Project not found')

    const bindings = project.proactiveAgents || []
    const index = bindings.findIndex((candidate) => candidate.personaId === binding.personaId)
    if (index === -1) {
      bindings.push(binding)
    } else {
      bindings[index] = binding
    }
    project.proactiveAgents = bindings
    saveStore(data)
  }

  private replaceProjectBindings(projectId: string, bindings: ProactiveAgentBinding[]): void {
    const data = loadStore()
    const project = this.findProject(data.projects, projectId)
    if (!project) throw new Error('Project not found')
    project.proactiveAgents = bindings.map(cloneBinding)
    saveStore(data)
  }

  private requireBinding(projectId: string, personaId: string): ProactiveAgentBinding {
    const project = this.requireProject(projectId)
    const binding = (project.proactiveAgents || []).find((candidate) => candidate.personaId === personaId)
    if (!binding) throw new Error('Proactive agent binding not found')
    return cloneBinding(binding)
  }

  private requireProject(projectId: string): Project {
    const project = this.findProject(loadStore().projects, normalizeId(projectId, 'Project id'))
    if (!project) throw new Error('Project not found')
    return project
  }

  private findProject(projects: Project[], projectId: string): Project | undefined {
    return projects.find((project) => project.id === projectId)
  }

  private runCacheKey(projectId: string, personaId: string): string {
    return `${projectId}:${personaId}`
  }

  private async requireCloudAuth(): Promise<CloudAuth> {
    const auth = await resolveCloudAuth()
    if (!auth) throw new Error('Cloud login is required')
    return auth
  }

  private async requestCloudApi(method: CloudMethod, endpoints: string[], body?: unknown): Promise<unknown> {
    const auth = await this.requireCloudAuth()
    let lastUnsupported: Error | null = null

    for (const endpoint of endpoints) {
      const response = await fetch(buildCloudApiUrl(auth, endpoint), {
        method,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'Content-Type': 'application/json'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const payload = await readCloudJson(response)

      if (isUnsupportedCloudEndpoint(response)) {
        lastUnsupported = new Error(`${method} ${endpoint} is not supported: ${response.status} ${readCloudError(payload, response.statusText)}`)
        continue
      }

      if (!response.ok) {
        throw new Error(`${method} ${endpoint} failed: ${response.status} ${readCloudError(payload, response.statusText)}`)
      }

      return payload
    }

    throw lastUnsupported || new Error(`${method} cloud request is not supported by the configured cloud API`)
  }

  private workspaceId(project: Project): string {
    return project.relayWorkspaceId || project.id
  }

  private personaEndpoints(project: Project, personaId: string): string[] {
    const workspace = encodeURIComponent(this.workspaceId(project))
    const persona = encodeURIComponent(personaId)
    return [
      `/api/v1/workspaces/${workspace}/proactive-personas/${persona}`,
      cloudPath(`/api/v1/proactive-personas/${persona}`, {
        workspace: this.workspaceId(project),
        projectId: project.id
      })
    ]
  }

  private async listCloudPersonas(project: Project): Promise<CloudPersonaRecord[]> {
    const workspace = encodeURIComponent(this.workspaceId(project))
    const payload = await this.requestCloudApi('GET', [
      cloudPath(`/api/v1/workspaces/${workspace}/proactive-personas`, { projectId: project.id }),
      cloudPath('/api/v1/proactive-personas', {
        workspace: this.workspaceId(project),
        projectId: project.id
      })
    ])
    return normalizeCloudPersonaList(payload)
  }

  private reconcileCloudBindings(
    projectId: string,
    bindings: ProactiveAgentBinding[],
    records: CloudPersonaRecord[]
  ): ProactiveAgentBinding[] {
    const byId = new Map<string, CloudPersonaRecord>()
    for (const record of records) {
      const id = typeof record.personaId === 'string'
        ? record.personaId
        : typeof record.id === 'string'
          ? record.id
          : ''
      if (id) byId.set(id, record)
    }

    return bindings.map((binding) => {
      const record = byId.get(binding.personaId)
      if (!record) return cloneBinding(binding)

      const status = normalizeCloudStatus(record.status)
      return {
        ...binding,
        projectId,
        ...(status ? { status } : {}),
        ...(typeof record.lastError === 'string' && record.lastError.trim()
          ? { lastError: record.lastError }
          : { lastError: undefined }),
        ...(typeof record.lastFiredAt === 'string' && record.lastFiredAt.trim()
          ? { lastFiredAt: record.lastFiredAt }
          : {}),
        ...(typeof record.updatedAt === 'string' && record.updatedAt.trim()
          ? { updatedAt: record.updatedAt }
          : { updatedAt: nowIso() })
      }
    })
  }

  private async patchCloudPersonaStatus(
    project: Project,
    binding: ProactiveAgentBinding,
    status: 'active' | 'paused'
  ): Promise<void> {
    await this.requestCloudApi('PATCH', this.personaEndpoints(project, binding.personaId), {
      status,
      projectId: project.id,
      workspace: this.workspaceId(project)
    })
  }

  private async deleteCloudPersona(project: Project, binding: ProactiveAgentBinding): Promise<void> {
    await this.requestCloudApi('DELETE', this.personaEndpoints(project, binding.personaId))
  }

  private async fetchCloudRuns(
    project: Project,
    binding: ProactiveAgentBinding,
    opts: { limit?: number; cursor?: string }
  ): Promise<ProactiveAgentRunsPage> {
    const workspace = encodeURIComponent(this.workspaceId(project))
    const persona = encodeURIComponent(binding.personaId)
    const query = {
      projectId: project.id,
      workspace: this.workspaceId(project),
      limit: opts.limit && opts.limit > 0 ? String(opts.limit) : undefined,
      cursor: opts.cursor
    }
    const payload = await this.requestCloudApi('GET', [
      cloudPath(`/api/v1/workspaces/${workspace}/proactive-personas/${persona}/runs`, query),
      cloudPath(`/api/v1/proactive-personas/${persona}/runs`, query)
    ])
    return normalizeRunsPage(payload)
  }

  private async fetchCloudTranscript(runId: string): Promise<ProactiveAgentTranscript> {
    const run = encodeURIComponent(runId)
    const payload = await this.requestCloudApi('GET', [
      `/api/v1/proactive-runs/${run}/transcript`,
      `/api/v1/proactive/runs/${run}/transcript`
    ])
    return normalizeTranscript(runId, payload)
  }
}

export const proactiveAgentManager = new ProactiveAgentManager()
