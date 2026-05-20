import { basename, join } from 'path'
import { BrowserWindow } from 'electron'
import {
  AgentRelayClient,
  type AgentRelaySpawnOptions,
  type SpawnPtyInput,
  type SendMessageInput,
  type BrokerEvent,
  type ListAgent,
  type InboundDeliveryMode,
  type PendingRelayMessage
} from '@agent-relay/sdk'
import { getAccessToken, getApiUrl } from './auth'
import { assertDirectory } from './path-utils'

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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toInboundDeliveryMode(mode?: TerminalAttachMode): InboundDeliveryMode {
  return mode === 'drive' ? 'manual_flush' : 'auto_inject'
}

function normalizeChannels(channels: string[]): string[] {
  return Array.from(new Set(channels.map((channel) => channel.trim()).filter(Boolean)))
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

export class BrokerManager {
  private sessions = new Map<string, BrokerSession>()
  private agentProjects = new Map<string, Set<string>>()
  private inputQueues = new Map<string, QueuedInput>()

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

    try {
      const opts: AgentRelaySpawnOptions = {
        cwd,
        brokerName: name,
        channels: nextChannels,
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

      this.sendStatus(normalizedProjectId, 'connected')
    } catch (err) {
      console.error(`[broker] Failed to start for project ${normalizedProjectId}:`, err)
      this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
      throw err
    }
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
      return this.sessions.values().next().value
    }

    throw new Error(`No relay workspace found for agent: ${name}`)
  }

  private attachClient(projectId: string, client: AgentRelayClient, win: BrowserWindow): () => void {
    return client.onEvent((event: BrokerEvent) => {
      if (event.kind === 'agent_spawned' && event.name) {
        this.rememberAgentProject(event.name, projectId)
      } else if ((event.kind === 'agent_exited' || event.kind === 'agent_released') && event.name) {
        this.forgetAgentProject(event.name, projectId)
      } else if (event.name) {
        this.rememberAgentProject(event.name, projectId)
      } else if (event.from) {
        this.rememberAgentProject(event.from, projectId)
      }

      if (win && !win.isDestroyed()) {
        win.webContents.send('broker:event', { ...event, projectId })
      }
    })
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
    const session = this.getSessionForAgent(name, projectId)
    return session.client.sendInput(name, data)
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
    const session = this.getSessionForAgent(name, projectId)
    await session.client.release(name)
  }

  async listAgents(projectId?: string): Promise<Array<ListAgent & { projectId: string }>> {
    const sessions = projectId ? [this.getSessionForProject(projectId)] : Array.from(this.sessions.values())
    const results = await Promise.all(
      sessions.map(async (session) => {
        const agents = await session.client.listAgents()
        for (const agent of agents) {
          this.rememberAgentProject(agent.name, session.projectId)
        }
        return agents.map((agent) => ({ ...agent, projectId: session.projectId }))
      })
    )
    return results.flat()
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
