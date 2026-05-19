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

function toInboundDeliveryMode(mode?: TerminalAttachMode): InboundDeliveryMode {
  return mode === 'drive' ? 'manual_flush' : 'auto_inject'
}

export class BrokerManager {
  private client: AgentRelayClient | null = null
  private window: BrowserWindow | null = null
  private unsubEvent: (() => void) | null = null
  private _cwd: string | null = null
  private _name: string | null = null
  private _channels: string[] = []

  // Cloud connection state
  private cloudSandboxId: string | null = null

  get cwd(): string | null {
    return this._cwd
  }

  get isStarted(): boolean {
    return this.client !== null
  }

  get isCloud(): boolean {
    return this.cloudSandboxId !== null
  }

  async start(cwd: string, name: string, win: BrowserWindow, channels: string[] = []): Promise<void> {
    assertDirectory(cwd, 'Workspace path')
    await this.shutdown()
    this.window = win
    this._cwd = cwd
    this._name = name
    this._channels = Array.from(new Set(channels.map((channel) => channel.trim()).filter(Boolean)))

    try {
      const opts: AgentRelaySpawnOptions = {
        cwd,
        brokerName: name,
        channels: this._channels,
        binaryPath: resolveBundledBrokerBinary(),
        onStderr: (line: string) => {
          console.error('[broker stderr]', line)
        }
      }

      console.log('[broker] Starting with opts:', JSON.stringify(opts))
      const client = await AgentRelayClient.spawn(opts)
      console.log('[broker] Started successfully')
      this.attachClient(client)

      this.sendStatus('connected')
    } catch (err) {
      console.error('[broker] Failed to start:', err)
      this.client = null
      this.sendStatus('error', String(err))
      throw err
    }
  }

  /**
   * Connect to a broker running in a remote Daytona sandbox.
   * Creates the sandbox via the cloud API, then connects through the SDK.
   */
  async connectCloud(win: BrowserWindow): Promise<string> {
    await this.shutdown()
    this.window = win

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

      this.cloudSandboxId = sandboxId
      this.attachClient(client)
      client.connectEvents()

      this.sendStatus('connected')
      return sandboxId
    } catch (err) {
      console.error('[broker] Failed to connect cloud broker:', err)
      this.client = null
      this.cloudSandboxId = null
      this.sendStatus('error', String(err))
      throw err
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) return
    console.log('[broker] ensureStarted: client is null, cwd=', this._cwd, 'name=', this._name, 'window=', !!this.window)
    if (!this._cwd || !this._name || !this.window) {
      throw new Error('Broker not started — select a workspace first')
    }
    // Try to auto-start
    await this.start(this._cwd, this._name, this.window, this._channels)
  }

  private attachClient(client: AgentRelayClient): void {
    this.client = client
    this.unsubEvent = client.onEvent((event: BrokerEvent) => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('broker:event', event)
      }
    })
  }

  async spawnAgent(input: SpawnPtyInput): Promise<{ name: string; runtime: string }> {
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

    await this.ensureStarted()
    return this.client!.spawnPty(relayAwareInput)
  }

  async attachTerminal(input: AttachTerminalInput): Promise<AttachTerminalResult> {
    const name = input.name.trim()
    if (!name) {
      throw new Error('Agent name is required')
    }

    await this.ensureStarted()
    const client = this.client!
    const mode = toInboundDeliveryMode(input.mode)
    let previousMode: InboundDeliveryMode | undefined

    try {
      previousMode = await client.getInboundDeliveryMode(name)
    } catch (err) {
      console.warn(`[broker] Failed to read delivery mode for ${name}:`, err)
    }

    // Pear's terminal behaves like Relay CLI passthrough by default: the human
    // can type while broker-managed inbound messages continue to auto-inject.
    await client.setInboundDeliveryMode(name, mode)

    if (isPositiveInteger(input.rows) && isPositiveInteger(input.cols)) {
      try {
        await client.resizePty(name, input.rows, input.cols)
      } catch (err) {
        console.warn(`[broker] Failed to sync PTY size for ${name}:`, err)
      }
    }

    const pending = mode === 'manual_flush'
      ? await client.getPending(name).then((messages) => messages.length).catch(() => 0)
      : 0

    try {
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

  async sendInput(name: string, data: string): Promise<{ name: string; bytes_written: number }> {
    await this.ensureStarted()
    return this.client!.sendInput(name, data)
  }

  async setTerminalMode(
    name: string,
    mode: TerminalAttachMode
  ): Promise<{ name: string; mode: InboundDeliveryMode; flushed: number; pending: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    await this.ensureStarted()
    const result = await this.client!.setInboundDeliveryMode(trimmedName, toInboundDeliveryMode(mode))
    const pending = result.mode === 'manual_flush'
      ? await this.client!.getPending(trimmedName).then((messages) => messages.length).catch(() => 0)
      : 0

    return {
      name: trimmedName,
      mode: result.mode,
      flushed: result.flushed,
      pending
    }
  }

  async getPendingMessages(name: string): Promise<PendingRelayMessage[]> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    await this.ensureStarted()
    return this.client!.getPending(trimmedName)
  }

  async flushPending(name: string): Promise<{ flushed: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    await this.ensureStarted()
    return this.client!.flushPending(trimmedName)
  }

  async resizePty(name: string, rows: number, cols: number): Promise<void> {
    await this.ensureStarted()
    await this.client!.resizePty(name, rows, cols)
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    await this.ensureStarted()
    await this.client!.sendMessage(input)
  }

  async syncChannels(channels: string[]): Promise<void> {
    const nextChannels = Array.from(
      new Set(channels.map((channel) => channel.trim()).filter(Boolean))
    )
    const previousChannels = this._channels
    this._channels = nextChannels

    if (!this.client) {
      return
    }

    const added = nextChannels.filter((channel) => !previousChannels.includes(channel))
    const removed = previousChannels.filter((channel) => !nextChannels.includes(channel))

    if (!added.length && !removed.length) {
      return
    }

    const agents = await this.client.listAgents()
    if (!agents.length) {
      if (!this.isCloud && this._cwd && this._name && this.window) {
        await this.start(this._cwd, this._name, this.window, nextChannels)
      }
      return
    }

    await Promise.all(
      agents.map(async (agent) => {
        if (added.length) {
          await this.client!.subscribeChannels(agent.name, added)
        }
        if (removed.length) {
          await this.client!.unsubscribeChannels(agent.name, removed)
        }
      })
    )
  }

  async releaseAgent(name: string): Promise<void> {
    await this.ensureStarted()
    await this.client!.release(name)
  }

  async listAgents(): Promise<ListAgent[]> {
    if (!this.client) return []
    return this.client.listAgents()
  }

  async shutdown(): Promise<void> {
    if (this.unsubEvent) {
      this.unsubEvent()
      this.unsubEvent = null
    }
    this.cloudSandboxId = null
    if (this.client) {
      try {
        await this.client.shutdown()
      } catch {
        // Ignore shutdown errors
      }
      this.client = null
    }
  }

  private sendStatus(status: string, error?: string): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('broker:status', { status, error })
    }
  }
}

export const brokerManager = new BrokerManager()
