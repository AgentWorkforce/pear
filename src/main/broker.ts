import { existsSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, join } from 'path'
import { BrowserWindow } from 'electron'
import {
  AgentRelayClient,
  type AgentRelaySpawnOptions,
  type SpawnPtyInput,
  type SendMessageInput,
  type BrokerEvent,
  type BrokerStatus,
  type ListAgent,
  type InboundDeliveryMode,
  type PendingRelayMessage,
  type PtyInputStream
} from '@agent-relay/sdk'
import { getAccessToken, getApiUrl } from './auth'
import { assertDirectory } from './path-utils'
import {
  BrokerConnectionFileSchema,
  GeneratedCommitDraftSchema,
  type GeneratedCommitDraft
} from './schemas'
import { compactBrokerEvent, normalizeEventTimestamp } from '../shared/lib/broker-events'

function isShellLikeCommand(cli: string): boolean {
  const normalized = basename(cli).toLowerCase()
  return ['shell', 'sh', 'bash', 'zsh', 'fish', 'nu', 'nushell', 'pwsh', 'powershell'].includes(normalized)
}

function resolveShellCommand(): string {
  const configuredShell = process.env.SHELL?.trim()
  if (configuredShell) {
    return configuredShell
  }

  if (process.platform === 'win32') {
    return 'powershell.exe'
  }

  return '/bin/zsh'
}

// Resolve the broker binary bundled inside @agent-relay/sdk.
// The SDK normally resolves this via import.meta.url, but that breaks when
// electron-vite bundles the SDK into the main process (import.meta.url points
// to out/main/ instead of node_modules/).
function resolveBundledBrokerBinary(): string {
  // Use local relay build if available (for development)
  const localBinary = join(__dirname, '..', '..', '..', 'relay', 'target', 'debug', 'agent-relay-broker')
  try {
    require('fs').accessSync(localBinary, require('fs').constants.X_OK)
    console.log('[broker] Using local relay binary:', localBinary)
    return localBinary
  } catch {
    // Fall back to SDK-bundled binary
  }

  const suffix = `${process.platform}-${process.arch}`
  return join(
    __dirname, '..', '..', 'node_modules', '@agent-relay', 'sdk', 'bin',
    `agent-relay-broker-${suffix}`
  )
}

type TerminalAttachMode = 'view' | 'drive' | 'passthrough'

interface QueuedInput {
  projectId: string
  name: string
  data: string
  timer: NodeJS.Timeout | null
  flushing: boolean
}

export interface AttachTerminalInput {
  name: string
  rows?: number
  cols?: number
  mode?: TerminalAttachMode
}

export interface AttachTerminalResult {
  name: string
  mode: InboundDeliveryMode
  previousMode?: InboundDeliveryMode
  pending: number
  snapshot?: {
    rows: number
    cols: number
    cursor: [number, number]
    screen: string
  }
}

export type { GeneratedCommitDraft }

export interface BrokerRuntimeAutoFixResult {
  removed: string[]
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const BROKER_DETAILS_TIMEOUT_MS = 3_000
const COMMIT_DRAFT_MAX_DIFF_CHARS = 80_000
const COMMIT_DRAFT_TIMEOUT_MS = 180_000
const MAX_BROKER_EVENT_HISTORY = 3_000
const BROKER_EVENT_HISTORY_TTL_MS = 12 * 60 * 60 * 1_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type BrokerEventRecordPayload = Record<string, unknown> & { kind: string }

function getErrorStatus(err: unknown): unknown {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined
  return (err as { status?: unknown }).status
}

function isUnsupportedInputStreamError(err: unknown): boolean {
  return getErrorStatus(err) === 404 || /\b404\b|not found|unsupported/i.test(toErrorMessage(err))
}

function isMissingAgentError(err: unknown): boolean {
  return getErrorStatus(err) === 404 || /agent_not_found|no worker named|not found/i.test(toErrorMessage(err))
}

function withBrokerDetailsTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${BROKER_DETAILS_TIMEOUT_MS}ms`))
    }, BROKER_DETAILS_TIMEOUT_MS)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  return url?.trim().replace(/\/+$/, '') || undefined
}

function parsePortFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.port) {
      return Number.parseInt(parsed.port, 10)
    }
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined
  } catch {
    return undefined
  }
}

function getClientBaseUrl(client: AgentRelayClient): string | undefined {
  return normalizeBaseUrl((client as unknown as BrokerClientInternals).transport?.baseUrl)
}

function getClientApiKey(client: AgentRelayClient): string | undefined {
  return (client as unknown as BrokerClientInternals).transport?.apiKey
}

function getBrokerConnectionFileInfo(
  cwd: string,
  baseUrl: string | undefined,
  brokerPid: number | undefined
): BrokerConnectionFileInfo {
  if (!cwd) {
    return { hasApiKey: false }
  }

  const connectionPath = join(cwd, '.agent-relay', 'connection.json')
  if (!existsSync(connectionPath)) {
    return { path: connectionPath, status: 'missing', hasApiKey: false }
  }

  try {
    const parsed = BrokerConnectionFileSchema.safeParse(
      JSON.parse(readFileSync(connectionPath, 'utf-8'))
    )
    if (!parsed.success) {
      return { path: connectionPath, status: 'invalid', hasApiKey: false }
    }
    const connectionUrl = normalizeBaseUrl(parsed.data.url)
    const sameUrl = !!baseUrl && connectionUrl === baseUrl
    const samePid = !brokerPid || !parsed.data.pid || parsed.data.pid === brokerPid

    return {
      path: connectionPath,
      status: sameUrl && samePid ? 'matches' : 'different',
      hasApiKey: !!parsed.data.apiKey,
      apiKey: parsed.data.apiKey
    }
  } catch {
    return { path: connectionPath, status: 'invalid', hasApiKey: false }
  }
}

function toInboundDeliveryMode(mode?: TerminalAttachMode): InboundDeliveryMode {
  return mode === 'drive' ? 'manual_flush' : 'auto_inject'
}

function normalizeChannels(channels: string[]): string[] {
  return Array.from(new Set(channels.map((channel) => channel.trim()).filter(Boolean)))
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function compactCommitDiff(diff: string): string {
  if (diff.length <= COMMIT_DRAFT_MAX_DIFF_CHARS) return diff
  return `${diff.slice(0, COMMIT_DRAFT_MAX_DIFF_CHARS)}\n\n[diff truncated at ${COMMIT_DRAFT_MAX_DIFF_CHARS} characters]`
}

function buildCommitDraftTask(diff: string): string {
  return [
    'Generate a commit message for the selected git diff below.',
    'Use only the diff. Do not inspect files, edit files, run commands, or create commits.',
    'Return exactly one JSON object and no markdown, code fence, commentary, or surrounding text.',
    'The JSON schema is: {"title":"string","body":"string"}',
    'Rules:',
    '- title: imperative Git commit summary, under 72 characters, no trailing period.',
    '- body: concise commit body, or an empty string if the title is enough.',
    '',
    'Selected diff:',
    '--- DIFF START ---',
    compactCommitDiff(diff),
    '--- DIFF END ---'
  ].join('\n')
}

function getJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = []

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < text.length; index += 1) {
      const char = text[index]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1))
          break
        }
      }
    }
  }

  return candidates
}

function parseGeneratedCommitDraft(text: string): GeneratedCommitDraft {
  const candidates = getJsonObjectCandidates(text)
  for (const candidate of candidates.reverse()) {
    try {
      const draft = GeneratedCommitDraftSchema.safeParse(JSON.parse(candidate))
      if (draft.success) return draft.data
    } catch {
      // Keep scanning terminal output; diffs can contain unrelated braces.
    }
  }
  throw new Error('Commit message agent did not return a usable JSON draft')
}

function getBrokerRuntimeSafeName(name: string): string {
  return name
    .split('')
    .map((char) => /[a-z0-9-]/i.test(char) ? char : '-')
    .join('')
}

function getBrokerRuntimeCleanupPaths(cwd: string, brokerName: string): string[] {
  const root = join(cwd, '.agent-relay')
  const safeName = getBrokerRuntimeSafeName(brokerName)

  return [
    join(root, 'connection.json'),
    join(root, `broker-${safeName}.lock`),
    join(root, `state-${safeName}.json`),
    join(root, `pending-${safeName}.json`)
  ]
}

function isRecoverableBrokerRuntimeError(
  err: unknown,
  options: { allowLivePidConflict?: boolean } = {}
): boolean {
  const message = toErrorMessage(err)
  const hasBrokerLockConflict = /another broker instance is already running in this directory/i.test(message)
  const hasLivePidConflict = /another broker instance is already running in this directory \(pid:\s*\d+/i.test(message)
  const hasStaleLockSignal =
    /stale broker lock detected/i.test(message) ||
    /broker lock held but no valid PID file found/i.test(message)

  return (options.allowLivePidConflict || !hasLivePidConflict) &&
    (hasStaleLockSignal || hasBrokerLockConflict)
}

async function clearBrokerRuntimeFiles(cwd: string, brokerName: string): Promise<string[]> {
  const removed: string[] = []

  for (const filePath of getBrokerRuntimeCleanupPaths(cwd, brokerName)) {
    if (!existsSync(filePath)) continue
    await rm(filePath, { force: true })
    removed.push(filePath)
  }

  return removed
}

function getAvailableAgentName(requestedName: string, existingNames: Set<string>): string {
  const trimmedName = requestedName.trim()
  if (!existingNames.has(trimmedName)) {
    return trimmedName
  }

  const match = trimmedName.match(/^(.*?)-(\d+)$/)
  const baseName = match ? match[1] : trimmedName
  let index = match ? Number(match[2]) + 1 : 2

  while (existingNames.has(`${baseName}-${index}`)) {
    index += 1
  }

  return `${baseName}-${index}`
}

function isAgentNameConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /agent ['"].+['"] already exists/i.test(message) || message.includes('already exists')
}

interface BrokerSession {
  projectId: string
  client: AgentRelayClient
  window: BrowserWindow
  unsubEvent: () => void
  cwd: string
  name: string
  channels: string[]
  cloudSandboxId: string | null
}

export interface BrokerAgentDetails {
  name: string
  runtime: string
  cli?: string
  model?: string
  channels: string[]
  parent?: string
  pid?: number
  currentState?: string
}

export interface BrokerDetails {
  projectId: string
  name: string
  cwd: string
  channels: string[]
  kind: 'local' | 'cloud'
  url?: string
  port?: number
  apiKey?: string
  brokerPid?: number
  cloudSandboxId?: string | null
  connectionPath?: string
  connectionFileStatus?: 'matches' | 'missing' | 'different' | 'invalid'
  apiKeyAvailable: boolean
  health: 'connected' | 'unreachable'
  session?: {
    brokerVersion: string
    protocolVersion: number
    workspaceKey?: string
    defaultWorkspaceId?: string
    mode: string
    uptimeSecs: number
  }
  relaycast?: {
    workspaceKey?: string
    defaultWorkspaceId?: string
    authenticated?: boolean
    workspaceCount?: number
    workspaces: Array<{
      workspaceId: string
      workspaceAlias?: string | null
      selfName: string
      selfAgentId: string
      authenticated: boolean
      default: boolean
    }>
  }
  agentCount: number
  pendingDeliveryCount: number
  agents: BrokerAgentDetails[]
  error?: string
}

export interface BrokerEventRecord {
  id: string
  projectId: string
  timestamp: number
  event: BrokerEventRecordPayload
}

interface BrokerStateSnapshot {
  agents: ListAgent[]
  pendingDeliveryCount: number
  auth?: BrokerStatus['auth']
}

interface BrokerConnectionFileInfo {
  path?: string
  status?: BrokerDetails['connectionFileStatus']
  hasApiKey: boolean
  apiKey?: string
}

interface BrokerClientInternals {
  transport?: {
    baseUrl?: string
    apiKey?: string
  }
}

export class BrokerManager {
  private sessions = new Map<string, BrokerSession>()
  private agentProjects = new Map<string, Set<string>>()
  private inputQueues = new Map<string, QueuedInput>()
  private inputStreams = new Map<string, PtyInputStream>()
  private inputStreamFallbacks = new Set<string>()
  private eventHistory: BrokerEventRecord[] = []
  private eventSerial = 0

  get cwd(): string | null {
    return this.sessions.values().next().value?.cwd || null
  }

  get isStarted(): boolean {
    return this.sessions.size > 0
  }

  get isCloud(): boolean {
    return Array.from(this.sessions.values()).some((session) => session.cloudSandboxId !== null)
  }

  async start(
    projectId: string,
    cwd: string,
    name: string,
    win: BrowserWindow,
    channels: string[] = []
  ): Promise<void> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) {
      throw new Error('Project id is required')
    }
    assertDirectory(cwd, 'Project path')
    const nextChannels = normalizeChannels(channels)
    const existing = this.sessions.get(normalizedProjectId)

    if (existing) {
      existing.window = win
      existing.cwd = cwd
      existing.name = name
      await this.syncChannels(normalizedProjectId, nextChannels)
      this.sendStatus(normalizedProjectId, 'connected')
      return
    }

    const startBroker = async (): Promise<void> => {
      const opts: AgentRelaySpawnOptions = {
        cwd,
        brokerName: name,
        channels: nextChannels,
        binaryArgs: { persist: true },
        binaryPath: resolveBundledBrokerBinary(),
        onStderr: (line: string) => {
          console.error(`[broker stderr:${normalizedProjectId}]`, line)
        }
      }

      console.log('[broker] Starting with opts:', JSON.stringify({ ...opts, projectId: normalizedProjectId }))
      const client = await AgentRelayClient.spawn(opts)
      console.log('[broker] Started successfully for project:', normalizedProjectId)
      const unsubEvent = this.attachClient(normalizedProjectId, client, win)
      this.sessions.set(normalizedProjectId, {
        projectId: normalizedProjectId,
        client,
        window: win,
        unsubEvent,
        cwd,
        name,
        channels: nextChannels,
        cloudSandboxId: null
      })

      this.publishBrokerEvent(normalizedProjectId, win, {
        kind: 'broker_initialized',
        name,
        cwd,
        url: getClientBaseUrl(client),
        brokerPid: client.brokerPid,
        channels: nextChannels,
        source: 'local'
      })
      this.sendStatus(normalizedProjectId, 'connected')
    }

    try {
      await startBroker()
    } catch (err) {
      console.error(`[broker] Failed to start for project ${normalizedProjectId}:`, err)
      this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
      throw err
    }
  }

  async autoFixRuntime(
    projectId: string,
    cwd: string,
    name: string,
    win: BrowserWindow,
    channels: string[] = [],
    errorMessage?: string
  ): Promise<BrokerRuntimeAutoFixResult> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) {
      throw new Error('Project id is required')
    }
    const hasManagedSession = this.sessions.has(normalizedProjectId)
    if (errorMessage && !isRecoverableBrokerRuntimeError(errorMessage, {
      allowLivePidConflict: hasManagedSession
    })) {
      throw new Error('This broker error does not look like stale Agent Relay runtime state.')
    }

    assertDirectory(cwd, 'Project path')
    await this.shutdown(normalizedProjectId)
    const removed = await clearBrokerRuntimeFiles(cwd, name)
    console.warn(
      `[broker] Auto-fixed runtime files for project ${normalizedProjectId}:`,
      removed.length > 0 ? removed : '(no files existed)'
    )
    await delay(250)
    await this.start(normalizedProjectId, cwd, name, win, channels)
    return { removed }
  }

  /**
   * Connect to a broker running in a remote Daytona sandbox.
   * Creates the sandbox via the cloud API, then connects through the SDK.
   */
  async connectCloud(projectId: string, win: BrowserWindow): Promise<string> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) {
      throw new Error('Project id is required')
    }
    await this.shutdown(normalizedProjectId)

    try {
      const token = await getAccessToken()
      if (!token) throw new Error('Not logged in — sign in first')

      const apiUrl = getApiUrl()

      // 1. Create sandbox with broker
      console.log('[broker] Creating cloud sandbox...')
      const createRes = await fetch(`${apiUrl}/api/v1/sandboxes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({ error: createRes.statusText }))
        throw new Error(`Failed to create sandbox: ${(err as { error: string }).error}`)
      }
      const { sandboxId } = await createRes.json() as { sandboxId: string }
      console.log('[broker] Sandbox created:', sandboxId)

      // 2. Get terminal connection info
      const termRes = await fetch(`${apiUrl}/api/v1/sandboxes/${sandboxId}/terminal`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!termRes.ok) {
        throw new Error('Failed to get terminal connection info')
      }
      const { httpUrl, apiKey } = await termRes.json() as { httpUrl: string; apiKey: string }

      console.log('[broker] Connecting to cloud broker via SDK:', httpUrl)
      const client = new AgentRelayClient({ baseUrl: httpUrl, apiKey })
      await client.getSession()

      const unsubEvent = this.attachClient(normalizedProjectId, client, win)
      this.sessions.set(normalizedProjectId, {
        projectId: normalizedProjectId,
        client,
        window: win,
        unsubEvent,
        cwd: '',
        name: `cloud-${normalizedProjectId}`,
        channels: [],
        cloudSandboxId: sandboxId
      })
      client.connectEvents()

      this.publishBrokerEvent(normalizedProjectId, win, {
        kind: 'broker_initialized',
        name: `cloud-${normalizedProjectId}`,
        url: getClientBaseUrl(client),
        cloudSandboxId: sandboxId,
        source: 'cloud'
      })
      this.sendStatus(normalizedProjectId, 'connected')
      return sandboxId
    } catch (err) {
      console.error(`[broker] Failed to connect cloud broker for project ${normalizedProjectId}:`, err)
      this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
      throw err
    }
  }

  private getSessionForProject(projectId: string): BrokerSession {
    const normalizedProjectId = projectId.trim()
    const session = this.sessions.get(normalizedProjectId)
    if (!session) {
      throw new Error('Relay workspace not started — select the project first')
    }
    return session
  }

  private getSessionForAgent(name: string, projectId?: string): BrokerSession {
    if (projectId?.trim()) {
      return this.getSessionForProject(projectId)
    }

    const mappedProjectIds = this.agentProjects.get(name)
    if (mappedProjectIds?.size === 1) {
      return this.getSessionForProject(Array.from(mappedProjectIds)[0])
    }
    if (mappedProjectIds && mappedProjectIds.size > 1) {
      throw new Error(`Agent name exists in multiple projects; project id is required: ${name}`)
    }

    if (this.sessions.size === 1) {
      const onlySession = this.sessions.values().next().value
      if (onlySession) return onlySession
    }

    throw new Error(`No relay workspace found for agent: ${name}`)
  }

  private attachClient(projectId: string, client: AgentRelayClient, win: BrowserWindow): () => void {
    return client.onEvent((event: BrokerEvent) => {
      this.publishBrokerEvent(projectId, win, event as unknown as BrokerEventRecordPayload)

      if (event.kind === 'agent_spawned' && event.name) {
        this.rememberAgentProject(event.name, projectId)
      } else if (event.kind === 'agent_exit' && event.name) {
        this.closeInputStream(this.getInputStreamKey(projectId, event.name), 1000, 'agent closed')
        this.forgetAgentProject(event.name, projectId)
        void client.release(event.name, 'agent exit').catch((err) => {
          if (!isMissingAgentError(err)) {
            console.warn(`[broker] Failed to release exited agent ${event.name}:`, err)
          }
        })
      } else if ((event.kind === 'agent_exited' || event.kind === 'agent_released') && event.name) {
        this.closeInputStream(this.getInputStreamKey(projectId, event.name), 1000, 'agent closed')
        this.forgetAgentProject(event.name, projectId)
      } else if ('name' in event && typeof event.name === 'string') {
        this.rememberAgentProject(event.name, projectId)
      } else if ('from' in event && typeof event.from === 'string') {
        this.rememberAgentProject(event.from, projectId)
      }
    })
  }

  private publishBrokerEvent(
    projectId: string,
    win: BrowserWindow | undefined,
    event: BrokerEventRecordPayload
  ): BrokerEventRecord {
    const record = this.recordBrokerEvent(projectId, event)
    if (win && !win.isDestroyed()) {
      win.webContents.send('broker:event', {
        ...event,
        projectId,
        observedAt: record.timestamp,
        historyId: record.id
      })
    }
    return record
  }

  private recordBrokerEvent(projectId: string, event: BrokerEventRecordPayload): BrokerEventRecord {
    const eventRecord = event as Record<string, unknown>
    const timestamp = normalizeEventTimestamp(eventRecord.timestamp) ?? Date.now()
    const record: BrokerEventRecord = {
      id: `${projectId}:${++this.eventSerial}`,
      projectId,
      timestamp,
      event: compactBrokerEvent(event)
    }

    this.eventHistory.push(record)
    this.pruneBrokerEventHistory()
    return record
  }

  private pruneBrokerEventHistory(now = Date.now()): void {
    const cutoff = now - BROKER_EVENT_HISTORY_TTL_MS
    if (this.eventHistory.length <= MAX_BROKER_EVENT_HISTORY) {
      const firstFreshIndex = this.eventHistory.findIndex((entry) => entry.timestamp >= cutoff)
      if (firstFreshIndex > 0) {
        this.eventHistory.splice(0, firstFreshIndex)
      } else if (firstFreshIndex === -1 && this.eventHistory.length > 0) {
        this.eventHistory = []
      }
      return
    }

    this.eventHistory = this.eventHistory
      .filter((entry) => entry.timestamp >= cutoff)
      .slice(-MAX_BROKER_EVENT_HISTORY)
  }

  private rememberAgentProject(name: string, projectId: string): void {
    const projects = this.agentProjects.get(name) || new Set<string>()
    projects.add(projectId)
    this.agentProjects.set(name, projects)
  }

  private forgetAgentProject(name: string, projectId: string): void {
    const projects = this.agentProjects.get(name)
    if (!projects) return
    projects.delete(projectId)
    if (projects.size === 0) {
      this.agentProjects.delete(name)
    }
  }

  private getInputStreamKey(projectId: string, name: string): string {
    return `${projectId}:${name}`
  }

  private getOrOpenInputStream(session: BrokerSession, name: string): PtyInputStream {
    const key = this.getInputStreamKey(session.projectId, name)
    const existing = this.inputStreams.get(key)
    if (existing && !existing.closed) {
      return existing
    }

    const stream = session.client.openInputStream(name)
    this.inputStreams.set(key, stream)
    stream.waitUntilOpen().catch(() => {
      if (this.inputStreams.get(key) === stream) {
        this.inputStreams.delete(key)
      }
    })
    return stream
  }

  private closeInputStream(key: string, code = 1000, reason = 'closed'): void {
    const stream = this.inputStreams.get(key)
    this.inputStreams.delete(key)
    this.inputStreamFallbacks.delete(key)
    if (stream) {
      stream.close(code, reason)
    }
  }

  private closeInputStreamsForProject(projectId: string): void {
    for (const key of Array.from(this.inputStreams.keys())) {
      if (key.startsWith(`${projectId}:`)) {
        this.closeInputStream(key, 1000, 'project closed')
      }
    }
    for (const key of Array.from(this.inputStreamFallbacks.keys())) {
      if (key.startsWith(`${projectId}:`)) {
        this.inputStreamFallbacks.delete(key)
      }
    }
  }

  async spawnAgent(projectId: string, input: SpawnPtyInput): Promise<{ name: string; runtime: string }> {
    const session = this.getSessionForProject(projectId)
    const shellSession = isShellLikeCommand(input.cli)
    const relayAwareInput: SpawnPtyInput = shellSession
      ? {
          ...input,
          cli: input.cli === 'shell' ? resolveShellCommand() : input.cli,
          args: input.args ?? (process.platform === 'win32' ? [] : ['-l']),
          task: input.task?.trim() || undefined,
          model: undefined,
          skipRelayPrompt: true
        }
      : input

    const existingNames = new Set(
      (await session.client.listAgents()).map((agent) => agent.name)
    )
    let nextInput = {
      ...relayAwareInput,
      name: getAvailableAgentName(relayAwareInput.name, existingNames)
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const spawned = await session.client.spawnPty(nextInput)
        this.rememberAgentProject(spawned.name || nextInput.name, session.projectId)
        return spawned
      } catch (err) {
        if (!isAgentNameConflict(err)) {
          throw err
        }
        existingNames.add(nextInput.name)
        nextInput = {
          ...nextInput,
          name: getAvailableAgentName(nextInput.name, existingNames)
        }
      }
    }

    throw new Error(`Unable to allocate an agent name for ${relayAwareInput.name}`)
  }

  async generateCommitDraft(projectId: string, diff: string): Promise<GeneratedCommitDraft> {
    const session = this.getSessionForProject(projectId)
    const selectedDiff = diff.trim()
    if (!selectedDiff) {
      throw new Error('Select changes before generating a message')
    }

    const task = buildCommitDraftTask(selectedDiff)
    const cli = process.env.PEAR_COMMIT_AGENT_CLI?.trim() || 'codex'
    const model = process.env.PEAR_COMMIT_AGENT_MODEL?.trim()
    const timeoutMs = parsePositiveIntegerEnv('PEAR_COMMIT_AGENT_TIMEOUT_MS', COMMIT_DRAFT_TIMEOUT_MS)
    const spawned = await this.spawnAgent(projectId, {
      name: 'commit-draft',
      cli,
      cwd: session.cwd || undefined,
      channels: session.channels,
      task,
      idleThresholdSecs: 1,
      ...(model ? { model } : {})
    })

    const chunks: string[] = []
    const unsubscribe = session.client.onEvent((event) => {
      if (event.kind === 'worker_stream' && event.name === spawned.name) {
        chunks.push(event.chunk)
      }
    })

    try {
      await this.waitForAgentIdle(session, spawned.name, timeoutMs)
      const output = await this.readAgentOutput(session, spawned.name, chunks)
      return parseGeneratedCommitDraft(output)
    } finally {
      unsubscribe()
      try {
        await session.client.release(spawned.name, 'commit draft generated')
      } catch (err) {
        console.warn(`[broker] Failed to release commit draft agent ${spawned.name}:`, err)
      }
      this.forgetAgentProject(spawned.name, session.projectId)
    }
  }

  private async waitForAgentIdle(session: BrokerSession, name: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    let idleSince: number | null = null

    while (Date.now() - startedAt < timeoutMs) {
      const agent = await session.client.getStatus()
        .then((status) => status.agents.find((entry) => entry.name === name))
        .catch(() => undefined)

      if (!agent) {
        return
      }

      if (agent.current_state === 'idle') {
        idleSince ??= Date.now()
        if (Date.now() - startedAt >= 5_000 && Date.now() - idleSince >= 1_000) {
          return
        }
      } else {
        idleSince = null
      }

      await delay(1_000)
    }

    throw new Error(`Commit message agent timed out after ${Math.round(timeoutMs / 1000)} seconds`)
  }

  private async readAgentOutput(session: BrokerSession, name: string, chunks: string[]): Promise<string> {
    const eventText = session.client.queryEvents({ kind: 'worker_stream', name, limit: 5000 })
      .flatMap((event) => event.kind === 'worker_stream' ? [event.chunk] : [])
      .join('')

    let snapshotText = ''
    try {
      snapshotText = (await session.client.snapshot(name, 'plain')).screen
    } catch (err) {
      console.warn(`[broker] Failed to snapshot commit draft agent ${name}:`, err)
    }

    return [eventText, chunks.join(''), snapshotText].filter(Boolean).join('\n')
  }

  async attachTerminal(projectId: string | undefined, input: AttachTerminalInput): Promise<AttachTerminalResult> {
    const name = input.name.trim()
    if (!name) {
      throw new Error('Agent name is required')
    }

    const session = this.getSessionForAgent(name, projectId)
    const client = session.client
    const mode = toInboundDeliveryMode(input.mode)
    let previousMode: InboundDeliveryMode | undefined

    try {
      previousMode = await client.getInboundDeliveryMode(name)
    } catch (err) {
      console.warn(`[broker] Failed to read delivery mode for ${name}:`, err)
    }

    // Keep the broker's inbound delivery policy aligned with the renderer's
    // queue mode while human terminal input continues to go through sendInput.
    await client.setInboundDeliveryMode(name, mode)

    let resizedBeforeSnapshot = false
    if (isPositiveInteger(input.rows) && isPositiveInteger(input.cols)) {
      try {
        await client.resizePty(name, input.rows, input.cols)
        resizedBeforeSnapshot = true
      } catch (err) {
        console.warn(`[broker] Failed to sync PTY size for ${name}:`, err)
      }
    }

    const pending = mode === 'manual_flush'
      ? await client.getPending(name).then((messages) => messages.length).catch(() => 0)
      : 0

    try {
      if (resizedBeforeSnapshot) {
        await delay(80)
      }
      const snapshot = await client.snapshot(name, 'ansi')
      return {
        name,
        mode,
        previousMode,
        pending,
        snapshot: {
          rows: snapshot.rows,
          cols: snapshot.cols,
          cursor: snapshot.cursor,
          screen: Buffer.from(snapshot.screen, 'base64').toString('utf-8')
        }
      }
    } catch (err) {
      console.warn(`[broker] Failed to capture terminal snapshot for ${name}:`, err)
      return {
        name,
        mode,
        previousMode,
        pending
      }
    }
  }

  async sendInput(
    projectId: string | undefined,
    name: string,
    data: string
  ): Promise<{ name: string; bytes_written: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    if (!data) {
      return { name: trimmedName, bytes_written: 0 }
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    const key = this.getInputStreamKey(session.projectId, trimmedName)
    if (!this.inputStreamFallbacks.has(key)) {
      const stream = this.getOrOpenInputStream(session, trimmedName)
      try {
        return await stream.send(data)
      } catch (err) {
        if (this.inputStreams.get(key) === stream) {
          this.closeInputStream(key, 1011, 'stream send failed')
        }
        if (isUnsupportedInputStreamError(err)) {
          this.inputStreamFallbacks.add(key)
        }
        console.warn(`[broker] PTY input stream failed for ${trimmedName}; falling back to HTTP input:`, err)
      }
    }
    return session.client.sendInput(trimmedName, data)
  }

  queueInput(projectId: string | undefined, name: string, data: string): void {
    const trimmedName = typeof name === 'string' ? name.trim() : ''
    if (!trimmedName || typeof data !== 'string' || data.length === 0) {
      return
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    const key = `${session.projectId}:${trimmedName}`
    let queue = this.inputQueues.get(key)
    if (!queue) {
      queue = { projectId: session.projectId, name: trimmedName, data: '', timer: null, flushing: false }
      this.inputQueues.set(key, queue)
    }

    queue.data += data
    this.scheduleInputFlush(key)
  }

  private scheduleInputFlush(key: string): void {
    const queue = this.inputQueues.get(key)
    if (!queue || queue.timer || queue.flushing) {
      return
    }

    queue.timer = setTimeout(() => {
      const currentQueue = this.inputQueues.get(key)
      if (currentQueue) {
        currentQueue.timer = null
      }
      void this.flushQueuedInput(key)
    }, 4)
  }

  private async flushQueuedInput(key: string): Promise<void> {
    const queue = this.inputQueues.get(key)
    if (!queue || queue.flushing) {
      return
    }

    queue.flushing = true
    try {
      while (queue.data.length > 0) {
        const data = queue.data
        queue.data = ''
        await this.sendInput(queue.projectId, queue.name, data)
      }
    } catch (err) {
      console.error(`[broker] Failed to send queued input for ${queue.name}:`, err)
    } finally {
      queue.flushing = false
      if (queue.data.length > 0) {
        this.scheduleInputFlush(key)
      } else if (!queue.timer) {
        this.inputQueues.delete(key)
      }
    }
  }

  async setTerminalMode(
    projectId: string | undefined,
    name: string,
    mode: TerminalAttachMode
  ): Promise<{ name: string; mode: InboundDeliveryMode; flushed: number; pending: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    const result = await session.client.setInboundDeliveryMode(trimmedName, toInboundDeliveryMode(mode))
    const pending = result.mode === 'manual_flush'
      ? await session.client.getPending(trimmedName).then((messages) => messages.length).catch(() => 0)
      : 0

    return {
      name: trimmedName,
      mode: result.mode,
      flushed: result.flushed,
      pending
    }
  }

  async getPendingMessages(projectId: string | undefined, name: string): Promise<PendingRelayMessage[]> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    return session.client.getPending(trimmedName)
  }

  async flushPending(projectId: string | undefined, name: string): Promise<{ flushed: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    return session.client.flushPending(trimmedName)
  }

  async resizePty(projectId: string | undefined, name: string, rows: number, cols: number): Promise<void> {
    const session = this.getSessionForAgent(name, projectId)
    await session.client.resizePty(name, rows, cols)
  }

  async sendMessage(projectId: string | undefined, input: SendMessageInput): Promise<void> {
    const session = input.to.startsWith('#')
      ? this.getSessionForProject(projectId || '')
      : this.getSessionForAgent(input.to, projectId)
    await session.client.sendMessage(input)
  }

  async subscribeAgentChannel(projectId: string | undefined, name: string, channel: string): Promise<void> {
    const trimmedName = name.trim()
    const [channelName] = normalizeChannels([channel])
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    if (!channelName) {
      throw new Error('Channel name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    await session.client.subscribeChannels(trimmedName, [channelName])
  }

  async unsubscribeAgentChannel(projectId: string | undefined, name: string, channel: string): Promise<void> {
    const trimmedName = name.trim()
    const [channelName] = normalizeChannels([channel])
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    if (!channelName) {
      throw new Error('Channel name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    await session.client.unsubscribeChannels(trimmedName, [channelName])
  }

  async syncChannels(projectId: string, channels: string[]): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) return
    const nextChannels = normalizeChannels(channels)
    const previousChannels = session.channels
    session.channels = nextChannels

    const added = nextChannels.filter((channel) => !previousChannels.includes(channel))
    const removed = previousChannels.filter((channel) => !nextChannels.includes(channel))

    if (!added.length && !removed.length) {
      return
    }

    const agents = await session.client.listAgents()
    if (!agents.length) {
      return
    }

    await Promise.all(
      agents.map(async (agent) => {
        if (added.length) {
          await session.client.subscribeChannels(agent.name, added)
        }
        if (removed.length) {
          await session.client.unsubscribeChannels(agent.name, removed)
        }
      })
    )
  }

  async releaseAgent(projectId: string | undefined, name: string): Promise<void> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    const session = this.getSessionForAgent(trimmedName, projectId)
    await session.client.release(trimmedName)
    this.closeInputStream(this.getInputStreamKey(session.projectId, trimmedName), 1000, 'agent released')
  }

  async listAgents(projectId?: string): Promise<Array<ListAgent & {
    projectId: string
    inboundDeliveryMode?: InboundDeliveryMode
  }>> {
    const sessions = projectId ? [this.getSessionForProject(projectId)] : Array.from(this.sessions.values())
    const results = await Promise.all(
      sessions.map(async (session) => {
        const agents = await session.client.listAgents()
        for (const agent of agents) {
          this.rememberAgentProject(agent.name, session.projectId)
        }
        return Promise.all(
          agents.map(async (agent) => {
            const inboundDeliveryMode = await session.client.getInboundDeliveryMode(agent.name).catch(() => undefined)
            return { ...agent, projectId: session.projectId, inboundDeliveryMode }
          })
        )
      })
    )
    return results.flat()
  }

  async listBrokerDetails(): Promise<BrokerDetails[]> {
    const sessions = Array.from(this.sessions.values())

    const details = await Promise.all(
      sessions.map(async (session) => {
        const baseUrl = getClientBaseUrl(session.client)
        const apiKey = getClientApiKey(session.client)
        const brokerPid = session.client.brokerPid
        const connectionFile = getBrokerConnectionFileInfo(session.cwd, baseUrl, brokerPid)
        const sessionResult = await Promise.allSettled([
          withBrokerDetailsTimeout(session.client.getSession(), 'Broker metadata'),
          this.getBrokerStateSnapshot(session)
        ])
        const [metadata, state] = sessionResult
        const agents = state.status === 'fulfilled' ? state.value.agents : []
        const auth = state.status === 'fulfilled' ? state.value.auth : undefined
        const workspaceKey = metadata.status === 'fulfilled' ? metadata.value.workspace_key : undefined
        const defaultWorkspaceId = metadata.status === 'fulfilled' ? metadata.value.default_workspace_id : undefined
        const relaycast = workspaceKey || defaultWorkspaceId || auth
          ? {
              workspaceKey,
              defaultWorkspaceId,
              authenticated: auth?.authenticated,
              workspaceCount: auth?.workspace_count,
              workspaces: (auth?.workspaces || []).map((workspace) => ({
                workspaceId: workspace.workspace_id,
                workspaceAlias: workspace.workspace_alias,
                selfName: workspace.self_name,
                selfAgentId: workspace.self_agent_id,
                authenticated: workspace.authenticated,
                default: workspace.default
              }))
            }
          : undefined
        const errors = sessionResult
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => toErrorMessage(result.reason))

        return {
          projectId: session.projectId,
          name: session.name,
          cwd: session.cwd,
          channels: session.channels,
          kind: session.cloudSandboxId ? 'cloud' : 'local',
          url: baseUrl,
          port: parsePortFromUrl(baseUrl),
          apiKey: apiKey || connectionFile.apiKey,
          brokerPid,
          cloudSandboxId: session.cloudSandboxId,
          connectionPath: connectionFile.path,
          connectionFileStatus: connectionFile.status,
          apiKeyAvailable: !!apiKey || connectionFile.hasApiKey,
          health: errors.length === 0 ? 'connected' : 'unreachable',
          session: metadata.status === 'fulfilled'
            ? {
                brokerVersion: metadata.value.broker_version,
                protocolVersion: metadata.value.protocol_version,
                workspaceKey: metadata.value.workspace_key,
                defaultWorkspaceId: metadata.value.default_workspace_id,
                mode: metadata.value.mode,
                uptimeSecs: metadata.value.uptime_secs
              }
            : undefined,
          relaycast,
          agentCount: agents.length,
          pendingDeliveryCount: state.status === 'fulfilled' ? state.value.pendingDeliveryCount : 0,
          agents: agents.map((agent) => ({
            name: agent.name,
            runtime: agent.runtime,
            cli: agent.cli,
            model: agent.model,
            channels: agent.channels,
            parent: agent.parent,
            pid: agent.pid,
            currentState: agent.current_state
          })),
          error: errors.length > 0 ? errors.join('\n') : undefined
        } satisfies BrokerDetails
      })
    )

    return details
  }

  listBrokerEvents(): BrokerEventRecord[] {
    this.pruneBrokerEventHistory()
    return this.eventHistory.map((entry) => ({
      ...entry,
      event: { ...(entry.event as Record<string, unknown>) } as BrokerEventRecordPayload
    }))
  }

  private async getBrokerStateSnapshot(session: BrokerSession): Promise<BrokerStateSnapshot> {
    try {
      const status: BrokerStatus = await withBrokerDetailsTimeout(
        session.client.getStatus(),
        'Broker status'
      )
      return {
        agents: status.agents,
        pendingDeliveryCount: status.pending_delivery_count,
        auth: status.auth
      }
    } catch (statusErr) {
      try {
        return {
          agents: await withBrokerDetailsTimeout(session.client.listAgents(), 'Agent list'),
          pendingDeliveryCount: 0
        }
      } catch (listErr) {
        throw new Error(
          `Failed to read broker state: ${toErrorMessage(statusErr)}; ${toErrorMessage(listErr)}`
        )
      }
    }
  }

  async shutdown(projectId?: string): Promise<void> {
    const targetProjectIds = projectId ? [projectId] : Array.from(this.sessions.keys())
    for (const targetProjectId of targetProjectIds) {
      for (const [key, queue] of this.inputQueues.entries()) {
        if (queue.projectId !== targetProjectId) continue
        if (queue.timer) {
          clearTimeout(queue.timer)
        }
        this.inputQueues.delete(key)
      }
      this.closeInputStreamsForProject(targetProjectId)

      const session = this.sessions.get(targetProjectId)
      if (!session) continue
      session.unsubEvent()
      try {
        await session.client.shutdown()
      } catch {
        // Ignore shutdown errors.
      }
      this.sessions.delete(targetProjectId)
      for (const [agentName, mappedProjectIds] of this.agentProjects.entries()) {
        mappedProjectIds.delete(targetProjectId)
        if (mappedProjectIds.size === 0) {
          this.agentProjects.delete(agentName)
        }
      }
    }
  }

  private sendStatus(projectId: string, status: string, error?: string): void {
    const session = this.sessions.get(projectId)
    this.sendStatusToWindow(session?.window, projectId, status, error)
  }

  private sendStatusToWindow(
    win: BrowserWindow | undefined,
    projectId: string,
    status: string,
    error?: string
  ): void {
    if (win && !win.isDestroyed()) {
      win.webContents.send('broker:status', { projectId, status, error })
    }
  }
}

export const brokerManager = new BrokerManager()
