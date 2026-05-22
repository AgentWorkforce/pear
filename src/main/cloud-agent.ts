import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import {
  type ProactiveDeploymentResponse,
  type ProactiveAgentRecord
} from '@agent-relay/cloud'
import { AgentRelayClient, type BrokerEvent } from '@agent-relay/sdk'
import {
  RelayfileSetup,
  createDefaultMountLauncher,
  type MountedWorkspaceHandle,
  type MountedWorkspaceStatus,
  type MountLauncher
} from '@relayfile/sdk'
import { getAccountWorkspaceId, resolveCloudAuth } from './auth'
import { brokerManager } from './broker'
import { getRelayWorkspaceManager } from './relay-workspace'
import { loadStore, saveStore, type Project, type ProjectCloudAgent } from './store'
import type {
  CloudAgentBinding,
  CloudAgentEvent,
  CloudAgentMountStatus,
  CloudAgentRecord,
  CloudAgentSandbox,
  CloudAgentSandboxStatus,
  CloudAgentStatus,
  CloudAgentSyncMode,
  CreateCloudAgentInput
} from './cloud-agent.types'

const execFileAsync = promisify(execFile)
const WARM_POLL_MS = 2_000
const WARM_TIMEOUT_MS = 60_000
const RUN_END_PULL_DELAY_MS = 30_000
const LOCAL_PRIORITY_IDLE_MS = 5_000

type CloudAuth = {
  accessToken: string
  apiUrl: string
}

type CloudAgentBoxResponse = Partial<CloudAgentSandbox> & {
  id?: string
  httpUrl?: string
  baseUrl?: string
  url?: string
  mountPath?: string
}

type CloudAgentListResponse = ProactiveAgentRecord[] | {
  agents?: ProactiveAgentRecord[]
}

type CloudBrokerAdapter = {
  attachCloudSandbox?: (projectId: string, sandbox: CloudAgentSandbox, win?: BrowserWindow) => Promise<unknown>
  connectCloudSandbox?: (projectId: string, sandbox: CloudAgentSandbox, win?: BrowserWindow) => Promise<unknown>
  detachCloudSandbox?: (projectId: string) => Promise<void>
  onBrokerEvent?: (handler: (projectId: string, event: BrokerEvent) => void) => () => void
}

type CloudBrokerSystemMessageAdapter = {
  listAgents: (projectId?: string) => Promise<Array<{ name: string; projectId?: string }>>
  sendMessage: (projectId: string | undefined, input: {
    to: string
    text: string
    from?: string
    priority?: number
    data?: Record<string, unknown>
    mode?: 'wait' | 'steer'
  }) => Promise<void>
}

type CompatibleDeployInput = {
  entrypoint: string
  source: string
}

type ConflictPolicy = 'remote-wins' | 'local-wins'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeAgentRecord(record: ProactiveAgentRecord | Record<string, unknown>): CloudAgentRecord {
  const fallbackId = typeof record.agentId === 'string' ? record.agentId : ''
  const id = typeof record.id === 'string' ? record.id : fallbackId
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id
  const status = record.status === 'warming' || record.status === 'error' || record.status === 'stopped'
    ? record.status
    : 'ready'

  return {
    id,
    name,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    harness: typeof record.harness === 'string' ? record.harness : 'unknown',
    defaultModel: typeof record.defaultModel === 'string' ? record.defaultModel : '',
    status,
    lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : undefined,
    lastError: typeof record.lastError === 'string' ? record.lastError : undefined,
    lastAuthenticatedAt:
      typeof record.lastAuthenticatedAt === 'string' || record.lastAuthenticatedAt === null
        ? record.lastAuthenticatedAt
        : undefined
  }
}

function normalizeSandbox(payload: CloudAgentBoxResponse): CloudAgentSandbox {
  const sandboxId = payload.sandboxId || payload.id
  const execUrl = payload.execUrl || payload.httpUrl || payload.baseUrl || payload.url
  const relayfileMountPath = payload.relayfileMountPath || payload.mountPath
  const status = payload.status || 'warming'

  if (!sandboxId || !execUrl || !payload.relayfileToken || !relayfileMountPath) {
    throw new Error('Cloud agent box response is missing required sandbox or relayfile fields')
  }

  if (!['warming', 'ready', 'stopping', 'stopped'].includes(status)) {
    throw new Error(`Unsupported cloud agent sandbox status: ${status}`)
  }

  return {
    sandboxId,
    execUrl,
    filesUrl: payload.filesUrl || '',
    relayfileToken: payload.relayfileToken,
    relayfileMountPath,
    status: status as CloudAgentSandboxStatus,
    apiKey: payload.apiKey
  }
}

function normalizeCreateInput(input: CreateCloudAgentInput): CreateCloudAgentInput {
  const name = input.name.trim()
  const harness = input.harness.trim()
  const model = input.model.trim()

  if (!name) throw new Error('Cloud agent name is required')
  if (!harness) throw new Error('Cloud agent harness is required')
  if (!model) throw new Error('Cloud agent model is required')

  return { name, harness, model }
}

function toProactiveDeployInput(input: CreateCloudAgentInput): CompatibleDeployInput {
  const metadata = JSON.stringify({
    name: input.name,
    harness: input.harness,
    model: input.model
  }, null, 2)

  return {
    entrypoint: 'pear-cloud-agent.ts',
    source: [
      'export const pearCloudAgent = ' + metadata + ' as const',
      '',
      'export default async function handler(event: unknown): Promise<unknown> {',
      '  return { ok: true, event, pearCloudAgent }',
      '}',
      ''
    ].join('\n')
  }
}

function buildCloudApiUrl(auth: CloudAuth, path: string): string {
  return new URL(path.replace(/^\/+/, ''), `${auth.apiUrl}/`).toString()
}

function isUnsupportedCloudEndpoint(response: Response): boolean {
  return response.status === 404 || response.status === 405 || response.status === 501
}

function readCloudError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['error', 'message', 'detail']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  return fallback
}

async function readCloudJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

async function requestCloudApi(
  auth: CloudAuth,
  method: 'GET' | 'POST' | 'DELETE',
  endpoints: string[],
  body?: unknown
): Promise<unknown> {
  let lastUnsupported: Error | null = null

  for (const endpoint of endpoints) {
    const response = await fetch(buildCloudApiUrl(auth, endpoint), {
      method,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
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

function normalizeAgentList(payload: unknown): ProactiveAgentRecord[] {
  const response = payload as CloudAgentListResponse
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && !Array.isArray(response) && Array.isArray(response.agents)
      ? response.agents
      : null

  if (!list) {
    throw new Error('Agent list response did not include an agents array')
  }

  return list as ProactiveAgentRecord[]
}

async function cloudListProactiveAgents(auth: CloudAuth): Promise<ProactiveAgentRecord[]> {
  const payload = await requestCloudApi(auth, 'GET', ['/api/v1/cloud-agents', '/api/v1/agents'])
  return normalizeAgentList(payload)
}

async function cloudDeployProactiveAgent(
  auth: CloudAuth,
  input: CompatibleDeployInput,
  name: string
): Promise<ProactiveDeploymentResponse> {
  const payload = await requestCloudApi(
    auth,
    'POST',
    ['/api/v1/agents/deploy', '/api/v1/proactive/agents/deploy', '/api/v1/proactive-runtime/deploy'],
    {
      entrypoint: input.entrypoint,
      source: input.source,
      name
    }
  )

  if (!payload || typeof payload !== 'object') {
    throw new Error('Deployment response was not valid JSON')
  }

  return payload as ProactiveDeploymentResponse
}

async function cloudDeleteCloudAgent(auth: CloudAuth, cloudAgentId: string): Promise<void> {
  const encoded = encodeURIComponent(cloudAgentId)
  const response = await fetch(buildCloudApiUrl(auth, `/api/v1/cloud-agents/${encoded}`), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    }
  })

  // Deletion is idempotent: a 404 means the cloud agent (provider credential)
  // is already gone, so the caller can clear local state either way. We target
  // /cloud-agents/{id} only — /agents/{id} is a different resource (deployed
  // agents) and matching against it produced the misleading "Agent not found".
  if (response.ok || response.status === 404) return

  const payload = await readCloudJson(response)
  throw new Error(`Failed to delete cloud agent: ${response.status} ${readCloudError(payload, response.statusText)}`)
}

function toBinding(projectId: string, cloudAgentId: string, sandbox: CloudAgentSandbox): CloudAgentBinding {
  return {
    projectId,
    cloudAgentId,
    sandboxId: sandbox.sandboxId,
    relayfileMountPath: sandbox.relayfileMountPath,
    attachedAt: new Date().toISOString()
  }
}

function toMountStatus(status?: MountedWorkspaceStatus | null): CloudAgentMountStatus {
  return {
    ready: status?.ready ?? false,
    lastReconcileAt: status?.lastReconcileAt || status?.lastEventAt,
    pendingWrites: status?.pendingWriteback ?? 0,
    conflicts: status?.pendingConflicts ?? 0
  }
}

function normalizeMountPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean))).sort()
}

export class CloudAgentManager {
  private bindings = new Map<string, CloudAgentBinding>()
  private sandboxes = new Map<string, CloudAgentSandbox>()
  private mounts = new Map<string, MountedWorkspaceHandle>()
  private attachPromises = new Map<string, Promise<CloudAgentBinding>>()
  private inflightToolCalls = new Map<string, number>()
  private lastSettledAt = new Map<string, number>()
  private pullTimers = new Map<string, NodeJS.Timeout>()
  private syncModeTimers = new Map<string, NodeJS.Timeout>()
  private appliedConflictPolicies = new Map<string, ConflictPolicy>()
  private mountRestartPromises = new Map<string, Promise<void>>()
  private eventHandlers = new Set<(event: CloudAgentEvent) => void>()

  constructor() {
    const broker = brokerManager as unknown as CloudBrokerAdapter
    broker.onBrokerEvent?.((projectId, event) => {
      this.noteBrokerEvent(projectId, event)
    })
  }

  async list(): Promise<CloudAgentRecord[]> {
    const auth = await this.requireCloudAuth()
    const records = await cloudListProactiveAgents(auth)
    return records.map(normalizeAgentRecord)
  }

  async create(input: CreateCloudAgentInput): Promise<CloudAgentRecord> {
    const auth = await this.requireCloudAuth()
    const normalizedInput = normalizeCreateInput(input)
    const response = await cloudDeployProactiveAgent(
      auth,
      toProactiveDeployInput(normalizedInput),
      normalizedInput.name
    )
    const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
    const id = typeof record.agentId === 'string'
      ? record.agentId
      : typeof record.id === 'string'
        ? record.id
        : normalizedInput.name

    return normalizeAgentRecord({
      ...record,
      id,
      name: typeof record.name === 'string' ? record.name : normalizedInput.name,
      harness: typeof record.harness === 'string' ? record.harness : normalizedInput.harness,
      defaultModel: typeof record.defaultModel === 'string' ? record.defaultModel : normalizedInput.model,
      status: typeof record.status === 'string' ? record.status : 'ready'
    })
  }

  async delete(id: string): Promise<void> {
    const auth = await this.requireCloudAuth()
    const cloudAgentId = id.trim()
    if (!cloudAgentId) throw new Error('Cloud agent id is required')

    const data = loadStore()
    const attachedProjects = data.projects.filter((project) => project.cloudAgent?.id === cloudAgentId)
    await Promise.all(attachedProjects.map((project) => this.detach(project.id)))
    await cloudDeleteCloudAgent(auth, cloudAgentId)
  }

  async attach(projectId: string, cloudAgentId: string, win?: BrowserWindow | null): Promise<CloudAgentBinding> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) throw new Error('Project id is required')

    const existingAttach = this.attachPromises.get(normalizedProjectId)
    if (existingAttach) return existingAttach

    const attachPromise = this.attachInternal(normalizedProjectId, cloudAgentId.trim(), win ?? undefined)
      .finally(() => {
        this.attachPromises.delete(normalizedProjectId)
      })
    this.attachPromises.set(normalizedProjectId, attachPromise)
    return attachPromise
  }

  async detach(projectId: string): Promise<void> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return

    this.clearPullTimer(normalizedProjectId)
    this.clearSyncModeTimer(normalizedProjectId)
    this.mountRestartPromises.delete(normalizedProjectId)
    const binding = this.bindings.get(normalizedProjectId) || this.findPersistedBinding(normalizedProjectId)

    const mount = this.mounts.get(normalizedProjectId)
    this.mounts.delete(normalizedProjectId)
    if (mount) {
      await mount.stop().catch((error) => {
        this.emit({ type: 'error', projectId: normalizedProjectId, message: toErrorMessage(error) })
      })
    }

    if (binding) {
      await this.deleteBox(binding).catch((error) => {
        this.emit({ type: 'error', projectId: normalizedProjectId, message: toErrorMessage(error) })
      })
    }

    const broker = brokerManager as unknown as CloudBrokerAdapter
    await broker.detachCloudSandbox?.(normalizedProjectId)

    this.bindings.delete(normalizedProjectId)
    this.sandboxes.delete(normalizedProjectId)
    this.inflightToolCalls.delete(normalizedProjectId)
    this.lastSettledAt.delete(normalizedProjectId)
    this.appliedConflictPolicies.delete(normalizedProjectId)
    this.persistCloudAgent(normalizedProjectId, null)
    this.emit({ type: 'mount-status', projectId: normalizedProjectId, mount: toMountStatus(null) })
  }

  async status(projectId: string): Promise<CloudAgentStatus | null> {
    const normalizedProjectId = projectId.trim()
    const binding = this.bindings.get(normalizedProjectId) || this.findPersistedBinding(normalizedProjectId)
    if (!binding) return null

    const sandbox = this.sandboxes.get(normalizedProjectId)
    const mount = this.mounts.get(normalizedProjectId)
    const mountStatus = mount ? await mount.status().catch(() => null) : null

    return {
      binding,
      sandbox: {
        id: sandbox?.sandboxId || binding.sandboxId,
        status: sandbox?.status || 'stopped'
      },
      mount: toMountStatus(mountStatus),
      syncMode: this.syncModeFor(normalizedProjectId)
    }
  }

  async updateMountPaths(projectId: string, paths: string[]): Promise<void> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) throw new Error('Project id is required')

    const project = this.findProject(normalizedProjectId)
    const binding = this.bindings.get(normalizedProjectId) || this.findPersistedBinding(normalizedProjectId)
    if (!project || !binding) return

    const auth = await this.requireCloudAuth()
    const workspaceId = await this.requireAccountTokenWorkspaceId()
    const url = `${auth.apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/cloud-agents/${encodeURIComponent(binding.cloudAgentId)}/box`
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ relayfileMountPaths: normalizeMountPaths(paths) })
    })
    const payload = await response.json().catch(() => null) as unknown

    if (!response.ok) {
      const message = readCloudError(payload, response.statusText)
      throw new Error(`Failed to update cloud agent box mount paths: ${message}`)
    }

    if (payload && typeof payload === 'object') {
      const current = this.sandboxes.get(normalizedProjectId)
      try {
        const sandbox = normalizeSandbox({
          ...(current || {}),
          ...(payload as CloudAgentBoxResponse)
        })
        this.sandboxes.set(normalizedProjectId, sandbox)
        this.emit({ type: 'sandbox-status', projectId: normalizedProjectId, status: sandbox.status })
      } catch {
        // PATCH responses may be acknowledgements rather than full sandbox payloads.
      }
    }
  }

  async injectSystemMessage(projectId: string, message: string): Promise<void> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) throw new Error('Project id is required')
    if (!message.trim()) return
    if (!this.bindings.has(normalizedProjectId) && !this.findPersistedBinding(normalizedProjectId)) return

    const broker = brokerManager as unknown as CloudBrokerSystemMessageAdapter
    if (typeof broker.listAgents !== 'function' || typeof broker.sendMessage !== 'function') {
      throw new Error('Cloud broker does not expose the system-message injection surface')
    }

    const agents = await broker.listAgents(normalizedProjectId)
    await Promise.all(
      agents
        .filter((agent) => agent.projectId === undefined || agent.projectId === normalizedProjectId)
        .map((agent) => broker.sendMessage(normalizedProjectId, {
          to: agent.name,
          from: 'system',
          text: message,
          priority: 0,
          mode: 'steer',
          data: {
            kind: 'integrations-update',
            system: true
          }
        }))
    )
  }

  async restore(projectId: string): Promise<void> {
    const project = this.findProject(projectId)
    if (!project?.cloudAgent) return

    try {
      await this.attach(project.id, project.cloudAgent.id)
    } catch (error) {
      this.emit({ type: 'error', projectId: project.id, message: toErrorMessage(error) })
    }
  }

  async shutdownAll(): Promise<void> {
    const projectIds = Array.from(new Set([
      ...Array.from(this.mounts.keys()),
      ...Array.from(this.bindings.keys())
    ]))

    await Promise.all(projectIds.map(async (projectId) => {
      this.clearPullTimer(projectId)
      this.clearSyncModeTimer(projectId)
      const mount = this.mounts.get(projectId)
      this.mounts.delete(projectId)
      if (mount) {
        await mount.stop().catch((error) => {
          this.emit({ type: 'error', projectId, message: toErrorMessage(error) })
        })
      }
    }))
  }

  onEvent(handler: (event: CloudAgentEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  noteToolCallStart(projectId: string): void {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return

    const previousMode = this.syncModeFor(normalizedProjectId)
    this.clearSyncModeTimer(normalizedProjectId)
    this.inflightToolCalls.set(normalizedProjectId, (this.inflightToolCalls.get(normalizedProjectId) || 0) + 1)
    this.handleSyncModeChange(normalizedProjectId, previousMode)
  }

  noteToolCallEnd(projectId: string): void {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return

    const previousMode = this.syncModeFor(normalizedProjectId)
    const nextCount = Math.max(0, (this.inflightToolCalls.get(normalizedProjectId) || 0) - 1)
    if (nextCount === 0) {
      this.inflightToolCalls.delete(normalizedProjectId)
      this.lastSettledAt.set(normalizedProjectId, Date.now())
      this.scheduleLocalPriorityEvent(normalizedProjectId)
      this.schedulePullAfterRun(normalizedProjectId)
    } else {
      this.inflightToolCalls.set(normalizedProjectId, nextCount)
    }
    this.handleSyncModeChange(normalizedProjectId, previousMode)
  }

  noteBrokerEvent(projectId: string, event: BrokerEvent): void {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return
    if (!this.bindings.has(normalizedProjectId) && !this.findPersistedBinding(normalizedProjectId)) return

    if (this.isBrokerIdleEvent(event)) {
      if ((this.inflightToolCalls.get(normalizedProjectId) || 0) > 0) {
        this.noteToolCallEnd(normalizedProjectId)
      }
      return
    }

    if (this.isBrokerActivityEvent(event) && (this.inflightToolCalls.get(normalizedProjectId) || 0) === 0) {
      this.noteToolCallStart(normalizedProjectId)
    }
  }

  private async attachInternal(
    projectId: string,
    cloudAgentId: string,
    win?: BrowserWindow
  ): Promise<CloudAgentBinding> {
    if (!cloudAgentId) throw new Error('Cloud agent id is required')

    await this.requireCloudAuth()
    const project = this.requireProject(projectId)
    const sandbox = await this.warmBox(projectId, cloudAgentId)

    try {
      await this.startMount(projectId, project, sandbox)
      await this.connectBroker(projectId, sandbox, win)
    } catch (error) {
      await this.stopMount(projectId)
      await this.deleteBox(toBinding(projectId, cloudAgentId, sandbox)).catch(() => undefined)
      throw error
    }

    const binding = toBinding(projectId, cloudAgentId, sandbox)
    this.bindings.set(projectId, binding)
    this.sandboxes.set(projectId, sandbox)
    this.persistCloudAgent(projectId, {
      id: cloudAgentId,
      sandboxId: sandbox.sandboxId,
      relayfileMountPath: sandbox.relayfileMountPath,
      attachedAt: binding.attachedAt,
      autoPullAfterRun: project.cloudAgent?.autoPullAfterRun ?? true
    })
    this.emit({ type: 'sandbox-status', projectId, status: sandbox.status })
    const currentStatus = await this.status(projectId)
    if (currentStatus) this.emit({ type: 'mount-status', projectId, mount: currentStatus.mount })
    return binding
  }

  private async requireCloudAuth(): Promise<CloudAuth> {
    const auth = await resolveCloudAuth()
    if (!auth) throw new Error('cloud-auth-required')
    return auth
  }

  private async requireAccountWorkspaceId(): Promise<string> {
    const id = await getRelayWorkspaceManager().getWorkspaceId()
    if (!id) throw new Error('relay-workspace-required')
    return id
  }

  private async requireAccountTokenWorkspaceId(): Promise<string> {
    return getAccountWorkspaceId()
  }

  private async warmBox(projectId: string, cloudAgentId: string): Promise<CloudAgentSandbox> {
    const auth = await this.requireCloudAuth()
    const workspaceId = await this.requireAccountTokenWorkspaceId()
    const mountPaths = await this.integrationMountPathsFor(projectId)
    const url = `${auth.apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/cloud-agents/${encodeURIComponent(cloudAgentId)}/box`
    let sandbox = await this.fetchBox(url, auth.accessToken, 'POST', mountPaths)
    this.emit({ type: 'sandbox-status', projectId, status: sandbox.status })

    const startedAt = Date.now()
    while (sandbox.status === 'warming') {
      if (Date.now() - startedAt > WARM_TIMEOUT_MS) {
        throw new Error(`Cloud agent sandbox ${sandbox.sandboxId} did not become ready within ${WARM_TIMEOUT_MS / 1000}s`)
      }

      await delay(WARM_POLL_MS)
      sandbox = await this.fetchBox(url, auth.accessToken, 'GET')
      this.emit({ type: 'sandbox-status', projectId, status: sandbox.status })
    }

    if (sandbox.status !== 'ready') {
      throw new Error(`Cloud agent sandbox ${sandbox.sandboxId} is ${sandbox.status}`)
    }

    return sandbox
  }

  private async integrationMountPathsFor(projectId: string): Promise<string[]> {
    const { integrationsManager } = await import('./integrations')
    return integrationsManager.mountPathsFor(projectId)
  }

  private async fetchBox(
    url: string,
    accessToken: string,
    method: 'GET' | 'POST',
    mountPaths?: string[]
  ): Promise<CloudAgentSandbox> {
    const body = method === 'POST'
      ? JSON.stringify({ relayfileMountPaths: normalizeMountPaths(mountPaths || []) })
      : undefined
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      ...(body ? { body } : {})
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>
      const message = typeof body.error === 'string' ? body.error : response.statusText
      throw new Error(`Failed to ${method === 'POST' ? 'warm' : 'read'} cloud agent box: ${message}`)
    }

    return normalizeSandbox(await response.json() as CloudAgentBoxResponse)
  }

  private async deleteBox(binding: CloudAgentBinding): Promise<void> {
    const project = this.findProject(binding.projectId)
    if (!project) return

    const auth = await this.requireCloudAuth()
    const workspaceId = await this.requireAccountTokenWorkspaceId()
    const url = `${auth.apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/cloud-agents/${encodeURIComponent(binding.cloudAgentId)}/box`
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth.accessToken}` }
    })

    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>
      const message = typeof body.error === 'string' ? body.error : response.statusText
      throw new Error(`Failed to detach cloud agent box: ${message}`)
    }
  }

  private async startMount(
    projectId: string,
    project: Project,
    sandbox: CloudAgentSandbox,
    policy: ConflictPolicy = this.conflictPolicyFor(projectId)
  ): Promise<void> {
    await this.stopMount(projectId)

    const auth = await this.requireCloudAuth()
    const workspaceId = await this.requireAccountWorkspaceId()
    // RelayfileSetup's accessToken callback is invoked repeatedly across the
    // mount's lifetime so it can pick up refreshed tokens. Resolve fresh auth
    // each call — using the captured `auth.accessToken` value here would lock
    // the mount to the original token and break silently when it expires.
    const setup = new RelayfileSetup({
      cloudApiUrl: auth.apiUrl,
      accessToken: async () => {
        const fresh = await resolveCloudAuth()
        return fresh?.accessToken ?? auth.accessToken
      }
    })
    const launcher = this.createConflictPolicyLauncher(projectId, policy)
    const mountInput = {
      workspaceId,
      localDir: project.rootPath,
      remotePath: sandbox.relayfileMountPath,
      mode: 'poll' as const,
      background: true,
      agentName: `pear-${project.id}`,
      scopes: ['relayfile:fs:readwrite:/**'],
      launcher,
      readyTimeoutMs: WARM_TIMEOUT_MS
    }

    const mount = await setup.mountWorkspace(mountInput)
    this.mounts.set(projectId, mount)
    this.appliedConflictPolicies.set(projectId, policy)
    const status = await mount.status().catch(() => null)
    this.emit({ type: 'mount-status', projectId, mount: toMountStatus(status) })
  }

  private createConflictPolicyLauncher(projectId: string, policy: ConflictPolicy): MountLauncher {
    const launcher = createDefaultMountLauncher()
    return {
      start: (input) => {
        return launcher.start({
          ...input,
          env: {
            ...input.env,
            RELAYFILE_CONFLICT_POLICY: policy
          },
          onEvent: (event) => {
            input.onEvent?.(event)
            if (event.type === 'reconcile' || event.type === 'status') {
              void this.emitMountStatus(projectId)
            }
          }
        })
      }
    }
  }

  private async stopMount(projectId: string): Promise<void> {
    const mount = this.mounts.get(projectId)
    this.mounts.delete(projectId)
    this.appliedConflictPolicies.delete(projectId)
    if (mount) {
      await mount.stop()
    }
  }

  private async connectBroker(projectId: string, sandbox: CloudAgentSandbox, win?: BrowserWindow): Promise<void> {
    const broker = brokerManager as unknown as CloudBrokerAdapter
    const attach = broker.attachCloudSandbox || broker.connectCloudSandbox
    if (attach) {
      await attach.call(brokerManager, projectId, sandbox, win)
      return
    }

    const apiKey = sandbox.apiKey?.trim() || undefined
    const client = new AgentRelayClient({
      baseUrl: sandbox.execUrl,
      ...(apiKey ? { apiKey } : {})
    })
    await client.getSession()
    client.disconnect()
  }

  private isBrokerActivityEvent(event: BrokerEvent): boolean {
    return [
      'agent_spawned',
      'worker_ready',
      'worker_stream',
      'delivery_active',
      'delivery_injected',
      'delivery_queued',
      'relay_inbound'
    ].includes(event.kind)
  }

  private isBrokerIdleEvent(event: BrokerEvent): boolean {
    return [
      'agent_idle',
      'agent_exit',
      'agent_exited',
      'agent_released',
      'agent_permanently_dead'
    ].includes(event.kind)
  }

  private syncModeFor(projectId: string): CloudAgentSyncMode {
    const inflight = this.inflightToolCalls.get(projectId) || 0
    if (inflight > 0) return 'sandbox-priority'

    const settledAt = this.lastSettledAt.get(projectId)
    if (settledAt && Date.now() - settledAt < LOCAL_PRIORITY_IDLE_MS) {
      return 'sandbox-priority'
    }

    return 'local-priority'
  }

  private conflictPolicyFor(projectId: string): ConflictPolicy {
    return this.syncModeFor(projectId) === 'sandbox-priority' ? 'remote-wins' : 'local-wins'
  }

  private handleSyncModeChange(projectId: string, previousMode: CloudAgentSyncMode): void {
    const nextMode = this.syncModeFor(projectId)
    if (nextMode !== previousMode) {
      this.emit({ type: 'sync-mode-changed', projectId, syncMode: nextMode })
      void this.ensureMountConflictPolicy(projectId).catch((error) => {
        this.emit({
          type: 'error',
          projectId,
          message: `Failed to apply cloud agent sync policy: ${toErrorMessage(error)}`
        })
      })
    }
  }

  private async ensureMountConflictPolicy(projectId: string): Promise<void> {
    const desiredPolicy = this.conflictPolicyFor(projectId)
    if (this.appliedConflictPolicies.get(projectId) === desiredPolicy) return
    if (!this.mounts.has(projectId)) return

    const previousRestart = this.mountRestartPromises.get(projectId) || Promise.resolve()
    const restart = previousRestart.catch(() => undefined).then(async () => {
      const latestPolicy = this.conflictPolicyFor(projectId)
      if (this.appliedConflictPolicies.get(projectId) === latestPolicy) return

      const project = this.findProject(projectId)
      const sandbox = this.sandboxes.get(projectId)
      if (!project || !sandbox) return

      await this.startMount(projectId, project, sandbox, latestPolicy)
    })

    this.mountRestartPromises.set(projectId, restart)
    try {
      await restart
    } finally {
      if (this.mountRestartPromises.get(projectId) === restart) {
        this.mountRestartPromises.delete(projectId)
      }
    }
  }

  private schedulePullAfterRun(projectId: string): void {
    this.clearPullTimer(projectId)
    const timer = setTimeout(() => {
      void this.maybePullAfterRun(projectId)
    }, RUN_END_PULL_DELAY_MS)
    this.pullTimers.set(projectId, timer)
  }

  private clearPullTimer(projectId: string): void {
    const timer = this.pullTimers.get(projectId)
    if (timer) clearTimeout(timer)
    this.pullTimers.delete(projectId)
  }

  private scheduleLocalPriorityEvent(projectId: string): void {
    this.clearSyncModeTimer(projectId)
    const timer = setTimeout(() => {
      this.syncModeTimers.delete(projectId)
      this.handleSyncModeChange(projectId, 'sandbox-priority')
    }, LOCAL_PRIORITY_IDLE_MS)
    this.syncModeTimers.set(projectId, timer)
  }

  private clearSyncModeTimer(projectId: string): void {
    const timer = this.syncModeTimers.get(projectId)
    if (timer) clearTimeout(timer)
    this.syncModeTimers.delete(projectId)
  }

  private async maybePullAfterRun(projectId: string): Promise<void> {
    this.pullTimers.delete(projectId)
    const project = this.findProject(projectId)
    if (!project?.cloudAgent || project.cloudAgent.autoPullAfterRun === false) return

    try {
      const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: project.rootPath })
      if (status.stdout.trim()) {
        this.emit({
          type: 'error',
          projectId,
          message: 'Sandbox pushed new commits; pull when ready.'
        })
        return
      }

      await execFileAsync('git', ['fetch'], { cwd: project.rootPath })
      await execFileAsync('git', ['pull', '--ff-only'], { cwd: project.rootPath })
      await this.emitMountStatus(projectId)
    } catch (error) {
      this.emit({
        type: 'error',
        projectId,
        message: `git pull failed after cloud agent run: ${toErrorMessage(error)}`
      })
    }
  }

  private async emitMountStatus(projectId: string): Promise<void> {
    const mount = this.mounts.get(projectId)
    const status = mount ? await mount.status().catch(() => null) : null
    this.emit({ type: 'mount-status', projectId, mount: toMountStatus(status) })
  }

  private requireProject(projectId: string): Project {
    const project = this.findProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return project
  }

  private findProject(projectId: string): Project | null {
    return loadStore().projects.find((project) => project.id === projectId) || null
  }

  private findPersistedBinding(projectId: string): CloudAgentBinding | null {
    const project = this.findProject(projectId)
    if (!project?.cloudAgent) return null

    return {
      projectId: project.id,
      cloudAgentId: project.cloudAgent.id,
      sandboxId: project.cloudAgent.sandboxId,
      relayfileMountPath: project.cloudAgent.relayfileMountPath,
      attachedAt: project.cloudAgent.attachedAt
    }
  }

  private persistCloudAgent(projectId: string, cloudAgent: ProjectCloudAgent | null): void {
    const data = loadStore()
    const project = data.projects.find((entry) => entry.id === projectId)
    if (!project) return

    if (cloudAgent) {
      project.cloudAgent = cloudAgent
    } else {
      delete project.cloudAgent
    }

    saveStore(data)
  }

  private emit(event: CloudAgentEvent): void {
    for (const handler of Array.from(this.eventHandlers)) {
      handler(event)
    }

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('cloud-agent:event', event)
      }
    }
  }
}

export const cloudAgentManager = new CloudAgentManager()
