import { basename, join } from 'path'
import { BrowserWindow } from 'electron'
import {
  AgentRelayClient,
  type AgentRelaySpawnOptions,
  type SpawnPtyInput,
  type SendMessageInput,
  type BrokerEvent,
  type ListAgent
} from '@agent-relay/sdk'
import { RelayCast } from '@relaycast/sdk'
import { getAccessToken, getApiUrl } from './auth'

const RELAY_CHAT_BOOTSTRAP_TASK =
  'You are connected to Agent Relay inside Pear. Wait for relay messages and reply using Relaycast tools.'

const RELAY_CHAT_CONVENTIONS = [
  'When you receive `Relay message from <sender> ...`, answer using `mcp__relaycast__message_dm_send`.',
  'For channel replies, use `mcp__relaycast__message_post`.',
  'For thread replies, use `mcp__relaycast__message_reply`.',
  'When responding to relay messages, do not reply only in terminal text.'
].join('\n')

function hasRelayChatConventions(task?: string): boolean {
  const normalized = task?.toLowerCase().trim()
  if (!normalized) return false

  return (
    normalized.includes('mcp__relaycast__message_dm_send') ||
    normalized.includes('mcp__relaycast__message_post') ||
    normalized.includes('mcp__relaycast__message_reply') ||
    normalized.includes('do not reply only in terminal text')
  )
}

function buildRelayAwareTask(task?: string): string | undefined {
  const normalized = task?.trim()

  if (!normalized) {
    return `${RELAY_CHAT_BOOTSTRAP_TASK}\n\n${RELAY_CHAT_CONVENTIONS}`
  }

  if (hasRelayChatConventions(normalized)) {
    return normalized
  }

  return `${normalized}\n\n${RELAY_CHAT_BOOTSTRAP_TASK}\n\n${RELAY_CHAT_CONVENTIONS}`
}

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

export class BrokerManager {
  private client: AgentRelayClient | null = null
  private window: BrowserWindow | null = null
  private unsubEvent: (() => void) | null = null
  private _cwd: string | null = null
  private _name: string | null = null
  private ensuredHumanIdentities = new Set<string>()

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

  async start(cwd: string, name: string, win: BrowserWindow): Promise<void> {
    await this.shutdown()
    this.window = win
    this._cwd = cwd
    this._name = name

    try {
      const opts: AgentRelaySpawnOptions = {
        cwd,
        brokerName: name,
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
    await this.start(this._cwd, this._name, this.window)
  }

  private attachClient(client: AgentRelayClient): void {
    this.client = client
    this.unsubEvent = client.onEvent((event: BrokerEvent) => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('broker:event', event)
      }
    })
  }

  private async ensureHumanIdentity(name: string): Promise<void> {
    await this.ensureStarted()

    let workspaceKey = this.client?.workspaceKey
    if (!workspaceKey) {
      const session = await this.client?.getSession()
      workspaceKey = session?.workspace_key
    }
    if (!workspaceKey) return

    const cacheKey = `${workspaceKey}:${name}`
    if (this.ensuredHumanIdentities.has(cacheKey)) return

    const relay = new RelayCast({
      apiKey: workspaceKey,
      baseUrl: process.env.RELAYCAST_BASE_URL || 'https://api.relaycast.dev'
    })

    await relay.agents.registerOrRotate({
      name,
      type: 'human'
    })
    this.ensuredHumanIdentities.add(cacheKey)
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
      : {
          ...input,
          task: buildRelayAwareTask(input.task)
        }

    await this.ensureStarted()
    return this.client!.spawnPty(relayAwareInput)
  }

  async sendInput(name: string, data: string): Promise<void> {
    await this.ensureStarted()
    await this.client!.sendInput(name, data)
  }

  async resizePty(name: string, rows: number, cols: number): Promise<void> {
    await this.ensureStarted()
    await this.client!.resizePty(name, rows, cols)
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    await this.ensureStarted()
    if (input.from?.trim().toLowerCase() === 'human') {
      try {
        await this.ensureHumanIdentity('human')
      } catch (error) {
        console.warn('[broker] Failed to ensure Relaycast human identity:', error)
      }
    }
    await this.client!.sendMessage(input)
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
    this.ensuredHumanIdentities.clear()
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
