import { join } from 'path'
import { BrowserWindow } from 'electron'
import {
  AgentRelayClient,
  type AgentRelayClientOptions,
  type SpawnPtyInput,
  type SendMessageInput,
  type BrokerEvent,
  type ListAgent
} from '@agent-relay/sdk'

// Resolve the broker binary bundled inside @agent-relay/sdk.
// The SDK normally resolves this via import.meta.url, but that breaks when
// electron-vite bundles the SDK into the main process (import.meta.url points
// to out/main/ instead of node_modules/).
function resolveBundledBrokerBinary(): string {
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
  private unsubStderr: (() => void) | null = null
  private _cwd: string | null = null
  private _name: string | null = null

  get cwd(): string | null {
    return this._cwd
  }

  get isStarted(): boolean {
    return this.client !== null
  }

  async start(cwd: string, name: string, win: BrowserWindow): Promise<void> {
    await this.shutdown()
    this.window = win
    this._cwd = cwd
    this._name = name

    try {
      const opts: AgentRelayClientOptions = {
        cwd,
        brokerName: name,
        binaryPath: resolveBundledBrokerBinary()
      }

      console.log('[broker] Starting with opts:', JSON.stringify(opts))
      this.client = await AgentRelayClient.start(opts)
      console.log('[broker] Started successfully')

      this.unsubEvent = this.client.onEvent((event: BrokerEvent) => {
        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send('broker:event', event)
        }
      })

      this.unsubStderr = this.client.onBrokerStderr((line: string) => {
        console.error('[broker stderr]', line)
      })

      this.sendStatus('connected')
    } catch (err) {
      console.error('[broker] Failed to start:', err)
      this.client = null
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

  async spawnAgent(input: SpawnPtyInput): Promise<{ name: string; runtime: string }> {
    await this.ensureStarted()
    return this.client!.spawnPty(input)
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
    if (this.unsubStderr) {
      this.unsubStderr()
      this.unsubStderr = null
    }
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
