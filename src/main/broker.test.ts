import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

// Covers the multi-session BrokerManager: a project's local broker and cloud
// sandbox broker coexist instead of clobbering each other in the sessions map.

type MockClient = {
  getSession: ReturnType<typeof vi.fn>
  listAgents: ReturnType<typeof vi.fn>
  getInboundDeliveryMode: ReturnType<typeof vi.fn>
  setInboundDeliveryMode: ReturnType<typeof vi.fn>
  snapshot: ReturnType<typeof vi.fn>
  resizePty: ReturnType<typeof vi.fn>
  getPending: ReturnType<typeof vi.fn>
  spawnPty: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  addListener: ReturnType<typeof vi.fn>
  connectEvents: ReturnType<typeof vi.fn>
  disconnectEvents: ReturnType<typeof vi.fn>
  renewLease: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  subscribeChannels: ReturnType<typeof vi.fn>
  unsubscribeChannels: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  queryEvents: ReturnType<typeof vi.fn>
  brokerPid?: number
  baseUrl?: string
  agentNames: string[]
  eventHistory: unknown[]
  eventListeners: Set<(event: unknown) => void>
  emitEvent: (event: unknown) => void
}

const mock = vi.hoisted(() => {
  function createMockClient(agentNames: string[] = []): MockClient {
    const client: MockClient = {
      agentNames: [...agentNames],
      eventHistory: [],
      eventListeners: new Set(),
      emitEvent: (event: unknown) => {
        client.eventHistory.push(event)
        for (const listener of client.eventListeners) listener(event)
      },
      getSession: vi.fn(async () => ({})),
      listAgents: vi.fn(async () => client.agentNames.map((name) => ({ name, runtime: 'pty', channels: [] }))),
      getInboundDeliveryMode: vi.fn(async () => 'passthrough'),
      spawnPty: vi.fn(async (input: { name: string }) => {
        client.agentNames.push(input.name)
        return { name: input.name, runtime: 'pty' }
      }),
      setInboundDeliveryMode: vi.fn(async (_name: string, mode: string) => ({ mode, flushed: 0 })),
      snapshot: vi.fn(async () => ({ rows: 24, cols: 80, cursor: { x: 0, y: 0 }, screen: 'aGVsbG8=' })),
      resizePty: vi.fn(async () => undefined),
      getPending: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({
        agents: client.agentNames.map((name) => ({ name, runtime: 'pty', channels: [] })),
        pending_delivery_count: 0
      })),
      queryEvents: vi.fn((filter: { kind?: string; name?: string; limit?: number }) => {
        const events = client.eventHistory.filter((event) => {
          if (!event || typeof event !== 'object') return false
          const record = event as Record<string, unknown>
          if (filter.kind && record.kind !== filter.kind) return false
          if (filter.name && record.name !== filter.name) return false
          return true
        })
        return events.slice(-(filter.limit ?? events.length))
      }),
      onEvent: vi.fn((listener: (event: unknown) => void) => {
        client.eventListeners.add(listener)
        return () => {
          client.eventListeners.delete(listener)
        }
      }),
      addListener: vi.fn(() => () => undefined),
      connectEvents: vi.fn(),
      disconnectEvents: vi.fn(),
      renewLease: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      release: vi.fn(async () => undefined),
      subscribeChannels: vi.fn(async () => undefined),
      unsubscribeChannels: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (input: { to?: string }) => {
        const target = input.to || ''
        const eventId = `evt-${Math.random().toString(16).slice(2)}`
        if (target && !target.startsWith('#')) {
          setImmediate(() => {
            client.emitEvent({
              kind: 'delivery_injected',
              event_id: eventId,
              name: target
            })
          })
        }
        return { event_id: eventId, targets: target && !target.startsWith('#') ? [target] : [] }
      }),
      brokerPid: 4242
    }
    return client
  }

  const state = {
    spawnedClients: [] as MockClient[],
    constructedClients: [] as MockClient[],
    connectedClients: [] as MockClient[],
    nextLocalAgents: [] as string[],
    nextCloudAgents: [] as string[],
    nextCloudSessionMetadata: [] as Array<Record<string, unknown>>,
    nextConnectedAgents: [] as string[],
    nextConnectedSessionMetadata: [] as Array<Record<string, unknown>>,
    nextConnectedSessionErrors: [] as Error[]
  }

  class HarnessDriverClient {
    static spawn = vi.fn(async () => {
      const client = createMockClient(state.nextLocalAgents.splice(0))
      state.spawnedClients.push(client)
      return client
    })

    static connect = vi.fn(() => {
      const client = createMockClient(state.nextConnectedAgents.splice(0))
      const metadata = state.nextConnectedSessionMetadata.shift()
      if (metadata) {
        client.getSession.mockResolvedValueOnce(metadata)
      }
      const sessionError = state.nextConnectedSessionErrors.shift()
      if (sessionError) {
        client.getSession.mockRejectedValueOnce(sessionError)
      }
      state.connectedClients.push(client)
      return client
    })

    constructor() {
      const client = createMockClient(state.nextCloudAgents.splice(0))
      const metadata = state.nextCloudSessionMetadata.shift()
      if (metadata) {
        client.getSession.mockResolvedValueOnce(metadata)
      }
      state.constructedClients.push(client)
      // Re-key `this` as the mock client.
      return client as unknown as HarnessDriverClient
    }
  }

  return { state, createMockClient, HarnessDriverClient }
})

const electronMock = vi.hoisted(() => ({
  app: {
    getAppPath: () => '/tmp/pear-app',
    isPackaged: false,
    getPath: () => '/tmp/pear-user-data'
  }
}))

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: class {}
}))

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: mock.HarnessDriverClient
}))

vi.mock('./auth', () => ({
  getAccessToken: vi.fn(async () => 'token'),
  getApiUrl: vi.fn(() => 'https://cloud.example')
}))

vi.mock('./path-utils', () => ({
  assertDirectory: vi.fn()
}))

vi.mock('./burn-spawn-hook', () => ({
  createPearBurnSpawnListener: vi.fn(() => () => undefined),
  stampPearBurnSpawnedAgent: vi.fn(async () => undefined)
}))

vi.mock('./burn', () => ({
  getBurnLedgerHome: vi.fn(() => '/tmp/burn'),
  getPearBurnAgentKey: vi.fn((projectId: string, name: string) => `${projectId}:${name}`)
}))

import { BrokerManager, parseBrokerInitCliFlags, resolveAgentRelayMcpCommand } from './broker'

const PROJECT_ID = 'project-1'
const originalMcpCommand = process.env.AGENT_RELAY_MCP_COMMAND
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const originalPublicEnv = process.env.PUBLIC
const originalProgramDataEnv = process.env.ProgramData
const originalPersonaHarnessReadyTimeoutEnv = process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function setProcessResourcesPath(resourcesPath: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath
  })
}

function restoreProcessResourcesPath(): void {
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor)
  } else {
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  }
}

function lastSpawned(): MockClient {
  const client = mock.state.spawnedClients[mock.state.spawnedClients.length - 1]
  if (!client) throw new Error('no local broker spawned')
  return client
}

function lastConstructed(): MockClient {
  const client = mock.state.constructedClients[mock.state.constructedClients.length - 1]
  if (!client) throw new Error('no cloud client constructed')
  return client
}

async function startLocal(manager: BrokerManager, agents: string[] = []): Promise<MockClient> {
  mock.state.nextLocalAgents = agents
  await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])
  return lastSpawned()
}

function createMockWindow(destroyed = false): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: {
      send: vi.fn()
    }
  } as unknown as BrowserWindow
}

async function startLocalWithWindow(
  manager: BrokerManager,
  win: BrowserWindow,
  agents: string[] = [],
  projectId = PROJECT_ID
): Promise<MockClient> {
  mock.state.nextLocalAgents = agents
  await manager.start(projectId, `/tmp/${projectId}`, `pear-${projectId}`, win, [])
  return lastSpawned()
}

async function attachCloud(manager: BrokerManager, agents: string[] = []): Promise<MockClient> {
  mock.state.nextCloudAgents = agents
  await manager.attachCloudSandbox(PROJECT_ID, {
    sandboxId: 'sandbox-1',
    execUrl: 'https://sandbox.example'
  } as never)
  return lastConstructed()
}

async function writeAgentWorkforceFixture(projectDir: string): Promise<void> {
  const binDir = join(projectDir, 'node_modules', '.bin')
  const posixBin = join(binDir, 'agentworkforce')
  const winBin = join(binDir, 'agentworkforce.cmd')
  const jsBin = join(binDir, 'agentworkforce.js')
  const script = [
    'const command = process.argv[2]',
    "if (command === 'show') {",
    "  console.log(JSON.stringify({ spec: { id: 'autonomous-actor', harness: 'claude' } }))",
    '} else {',
    "  console.log(JSON.stringify({ personas: [{ persona: 'autonomous-actor', harness: 'claude' }] }))",
    '}'
  ].join('\n')

  await mkdir(binDir, { recursive: true })
  await writeFile(jsBin, script)
  await writeFile(posixBin, `#!/usr/bin/env node\n${script}\n`)
  await writeFile(winBin, `@echo off\r\nnode "%~dp0agentworkforce.js" %*\r\n`)
  await chmod(jsBin, 0o755)
  await chmod(posixBin, 0o755)
  await chmod(winBin, 0o755)
}

function emitPersonaHarnessReady(client: MockClient, name: string): void {
  client.emitEvent({
    kind: 'worker_stream',
    name,
    chunk: 'Sandbox mount ready -> /tmp/agentworkforce-session\n'
  })
}

describe('resolveAgentRelayMcpCommand', () => {
  let tempDir: string | null = null
  let extraTempDir: string | null = null

  afterEach(async () => {
    electronMock.app.isPackaged = false
    if (originalMcpCommand === undefined) {
      delete process.env.AGENT_RELAY_MCP_COMMAND
    } else {
      process.env.AGENT_RELAY_MCP_COMMAND = originalMcpCommand
    }
    restoreProcessResourcesPath()
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
    if (originalPublicEnv === undefined) {
      delete process.env.PUBLIC
    } else {
      process.env.PUBLIC = originalPublicEnv
    }
    if (originalProgramDataEnv === undefined) {
      delete process.env.ProgramData
    } else {
      process.env.ProgramData = originalProgramDataEnv
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
    if (extraTempDir) await rm(extraTempDir, { recursive: true, force: true })
    extraTempDir = null
  })

  it('rejects asar-internal MCP command overrides in packaged mode', () => {
    electronMock.app.isPackaged = true
    process.env.AGENT_RELAY_MCP_COMMAND =
      '/Applications/Pear by Agent Relay.app/Contents/Resources/app.asar/node_modules/agent-relay/dist/cli/index.js mcp'

    expect(() => resolveAgentRelayMcpCommand()).toThrow(/must not reference app\.asar/)
  })

  it('resolves the packaged MCP launcher from external resources', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-mcp-resources-'))
    const launcherPath = join(tempDir, 'agent-relay-mcp', process.platform === 'win32' ? 'launch.cmd' : 'launch.sh')
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
    await chmod(launcherPath, 0o755)
    electronMock.app.isPackaged = true
    delete process.env.AGENT_RELAY_MCP_COMMAND
    setProcessResourcesPath(tempDir)

    const command = resolveAgentRelayMcpCommand()

    expect(command).toBe(launcherPath)
    expect(command).not.toContain('app.asar')
  })

  it('uses a no-space shim for packaged MCP launcher paths containing spaces', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear mcp resources-'))
    const launcherPath = join(tempDir, 'agent-relay-mcp', process.platform === 'win32' ? 'launch.cmd' : 'launch.sh')
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
    await chmod(launcherPath, 0o755)
    electronMock.app.isPackaged = true
    delete process.env.AGENT_RELAY_MCP_COMMAND
    setProcessResourcesPath(tempDir)

    const command = resolveAgentRelayMcpCommand()

    expect(command).toMatch(/pear-agent-relay-mcp/)
    expect(command).not.toContain('app.asar')
    expect(command).not.toMatch(/\s/)
    expect(await readFile(command!, 'utf8')).toContain(launcherPath)
  })

  it('escapes percent signs in packaged Windows MCP shims', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear mcp %USER% resources-'))
    extraTempDir = await mkdtemp(join(tmpdir(), 'pear-public-'))
    const publicDir = extraTempDir
    const launcherPath = join(tempDir, 'agent-relay-mcp', 'launch.cmd')
    await mkdir(dirname(launcherPath), { recursive: true })
    await mkdir(publicDir, { recursive: true })
    await writeFile(launcherPath, '@echo off\r\n')
    setProcessPlatform('win32')
    process.env.PUBLIC = publicDir
    process.env.ProgramData = ''
    electronMock.app.isPackaged = true
    delete process.env.AGENT_RELAY_MCP_COMMAND
    setProcessResourcesPath(tempDir)

    const command = resolveAgentRelayMcpCommand()

    expect(command).toContain('pear-agent-relay-mcp')
    expect(command).not.toMatch(/\s/)
    const content = await readFile(command!, 'utf8')
    expect(content).toContain('%USER%'.replace(/%/g, '%%'))
    expect(content).not.toContain('%USER% resources')
  })

  it('fails packaged MCP resolution when the external launcher is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-mcp-resources-'))
    electronMock.app.isPackaged = true
    delete process.env.AGENT_RELAY_MCP_COMMAND
    setProcessResourcesPath(tempDir)

    expect(() => resolveAgentRelayMcpCommand()).toThrow(/launcher is missing or not executable/)
  })
})

describe('parseBrokerInitCliFlags', () => {
  it('detects current broker init flags', () => {
    const flags = parseBrokerInitCliFlags(`
Usage: agent-relay-broker init [OPTIONS]

Options:
      --name <NAME>                    Legacy broker instance name flag. Prefer --instance-name [default: ]
      --instance-name <INSTANCE_NAME>  Stable broker instance name within the Relay workspace
      --workspace-key <WORKSPACE_KEY>  Join an existing Relay workspace instead of creating a fresh one
      --channels <CHANNELS>            [default: general]
`)

    expect(flags).toEqual({
      supportsInstanceName: true,
      supportsName: true,
      supportsWorkspaceKey: true
    })
  })

  it('detects legacy broker init flags', () => {
    const flags = parseBrokerInitCliFlags(`
Usage: agent-relay-broker init [OPTIONS]

Options:
      --name <NAME>            [default: ]
      --channels <CHANNELS>    [default: general]
      --persist                Enable persistence
`)

    expect(flags).toEqual({
      supportsInstanceName: false,
      supportsName: true,
      supportsWorkspaceKey: false
    })
  })
})

describe('electron-builder broker packaging', () => {
  it('unpacks bundled broker binaries outside app.asar', async () => {
    const config = await readFile('electron-builder.yml', 'utf8')

    expect(config).toContain('node_modules/@agent-relay/broker-*/bin/**')
    expect(config).toContain('node_modules/agent-relay/node_modules/@agent-relay/broker-*/bin/**')
  })
})

describe('BrokerManager local + cloud coexistence', () => {
  let personaTempDir: string | null = null
  const inheritedWorkspaceKey = process.env.AGENT_RELAY_WORKSPACE_KEY

  beforeEach(() => {
    delete process.env.AGENT_RELAY_WORKSPACE_KEY
    mock.state.spawnedClients.length = 0
    mock.state.constructedClients.length = 0
    mock.state.connectedClients.length = 0
    mock.state.nextLocalAgents = []
    mock.state.nextCloudAgents = []
    mock.state.nextCloudSessionMetadata = []
    mock.state.nextConnectedAgents = []
    mock.state.nextConnectedSessionMetadata = []
    mock.state.nextConnectedSessionErrors = []
    mock.HarnessDriverClient.spawn.mockClear()
    mock.HarnessDriverClient.connect.mockClear()
  })

  afterEach(async () => {
    if (originalPersonaHarnessReadyTimeoutEnv === undefined) {
      delete process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS
    } else {
      process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS = originalPersonaHarnessReadyTimeoutEnv
    }
    if (personaTempDir) await rm(personaTempDir, { recursive: true, force: true })
    personaTempDir = null
    if (inheritedWorkspaceKey === undefined) {
      delete process.env.AGENT_RELAY_WORKSPACE_KEY
    } else {
      process.env.AGENT_RELAY_WORKSPACE_KEY = inheritedWorkspaceKey
    }
  })

  it('keeps the local session alive when a cloud sandbox attaches', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['local-agent'])
    const cloud = await attachCloud(manager, ['cloud-agent'])

    expect(local.shutdown).not.toHaveBeenCalled()

    const agents = await manager.listAgents(PROJECT_ID)
    expect(agents.map((agent) => [agent.name, agent.brokerKind])).toEqual([
      ['local-agent', 'local'],
      ['cloud-agent', 'cloud']
    ])
    expect(agents.every((agent) => agent.projectId === PROJECT_ID)).toBe(true)

    await manager.shutdown()
    expect(local.shutdown).toHaveBeenCalled()
    expect(cloud.shutdown).toHaveBeenCalled()
  })

  it('reports an existing local broker start as reused', async () => {
    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []

    const firstStart = await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    const secondStart = await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

    expect(firstStart).toBe(true)
    expect(secondStart).toBe(false)
    expect(mock.HarnessDriverClient.spawn).toHaveBeenCalledTimes(1)
    expect(local.shutdown).not.toHaveBeenCalled()

    await manager.shutdown()
  })

  it('passes an explicit workspace key env pin to local broker spawn options', async () => {
    const previousWorkspaceKey = process.env.AGENT_RELAY_WORKSPACE_KEY
    process.env.AGENT_RELAY_WORKSPACE_KEY = 'rk_live_pinned'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const manager = new BrokerManager()

    try {
      await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

      expect(mock.HarnessDriverClient.spawn).toHaveBeenCalledWith(expect.objectContaining({
        brokerName: 'pear-project-1',
        workspaceKey: 'rk_live_pinned'
      }))
      const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(logged).toContain('rk_live_…')
      expect(logged).not.toContain('rk_live_pinned')
    } finally {
      logSpy.mockRestore()
      if (previousWorkspaceKey === undefined) {
        delete process.env.AGENT_RELAY_WORKSPACE_KEY
      } else {
        process.env.AGENT_RELAY_WORKSPACE_KEY = previousWorkspaceKey
      }
      await manager.shutdown()
    }
  })

  it('reads the local broker workspace key for cloud provisioning', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager)
    local.getSession.mockResolvedValueOnce({ workspace_key: 'rk_live_project' })

    await expect(manager.workspaceKeyForProject(PROJECT_ID)).resolves.toBe('rk_live_project')

    await manager.shutdown()
  })

  it('omits the project workspace key when no local broker exposes one', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    await expect(manager.workspaceKeyForProject(PROJECT_ID)).resolves.toBeUndefined()
    await expect(manager.workspaceKeyForProject('missing-project')).resolves.toBeUndefined()

    await manager.shutdown()
  })

  it('emits a cloud workspace mismatch event when the sandbox ignores the sent key', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    mock.state.nextCloudSessionMetadata.push({ workspace_key: 'rk_sand_456' })

    await manager.attachCloudSandbox(PROJECT_ID, {
      sandboxId: 'sandbox-1',
      execUrl: 'https://sandbox.example',
      sentWorkspaceKey: 'rk_sent_123'
    }, win)

    expect(win.webContents.send).toHaveBeenCalledWith(
      'broker:event',
      expect.objectContaining({
        kind: 'cloud_workspace_key_mismatch',
        projectId: PROJECT_ID,
        cloudSandboxId: 'sandbox-1',
        sentWorkspaceKeyPrefix: 'rk_sent_',
        sandboxWorkspaceKeyPrefix: 'rk_sand_',
        detail: expect.stringContaining('stale broker binary')
      })
    )

    await manager.shutdown()
  })

  it('does not emit a cloud workspace mismatch event when the sandbox joins the sent key', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    mock.state.nextCloudSessionMetadata.push({ workspace_key: 'rk_live_same' })

    await manager.attachCloudSandbox(PROJECT_ID, {
      sandboxId: 'sandbox-1',
      execUrl: 'https://sandbox.example',
      sentWorkspaceKey: 'rk_live_same'
    }, win)

    const mismatchEvents = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel, payload]) =>
        channel === 'broker:event' &&
        (payload as { kind?: string }).kind === 'cloud_workspace_key_mismatch'
      )
    expect(mismatchEvents).toHaveLength(0)

    await manager.shutdown()
  })

  it('does not emit a cloud workspace mismatch event on keyless legacy attaches', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    mock.state.nextCloudSessionMetadata.push({ workspace_key: 'rk_live_sandbox' })

    await manager.attachCloudSandbox(PROJECT_ID, {
      sandboxId: 'sandbox-1',
      execUrl: 'https://sandbox.example'
    }, win)

    const mismatchEvents = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel, payload]) =>
        channel === 'broker:event' &&
        (payload as { kind?: string }).kind === 'cloud_workspace_key_mismatch'
      )
    expect(mismatchEvents).toHaveLength(0)

    await manager.shutdown()
  })

  it('reuses current harness-driver connection files instead of spawning another broker', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pear-current-connection-'))
    const connectionPath = join(tempDir, '.agentworkforce', 'relay', 'connection.json')
    await mkdir(dirname(connectionPath), { recursive: true })
    await writeFile(connectionPath, JSON.stringify({
      url: 'http://127.0.0.1:43210',
      apiKey: 'test-key',
      pid: 4242
    }))

    try {
      const manager = new BrokerManager()
      mock.state.nextConnectedAgents = ['codex-1']

      const started = await manager.start(PROJECT_ID, tempDir, 'pear-project-1', undefined as never, [])

      expect(started).toBe(true)
      expect(mock.HarnessDriverClient.connect).toHaveBeenCalledWith({ cwd: tempDir, connectionPath })
      expect(mock.HarnessDriverClient.spawn).not.toHaveBeenCalled()
      expect(mock.state.connectedClients).toHaveLength(1)

      await manager.shutdown()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('does not reuse an existing connection with a mismatched explicit workspace key', async () => {
    const previousWorkspaceKey = process.env.AGENT_RELAY_WORKSPACE_KEY
    process.env.AGENT_RELAY_WORKSPACE_KEY = 'rk_live_pinned'
    const tempDir = await mkdtemp(join(tmpdir(), 'pear-pinned-connection-'))
    const connectionPath = join(tempDir, '.agentworkforce', 'relay', 'connection.json')
    await mkdir(dirname(connectionPath), { recursive: true })
    await writeFile(connectionPath, JSON.stringify({
      url: 'http://127.0.0.1:43210',
      apiKey: 'test-key',
      pid: 4242
    }))

    try {
      const manager = new BrokerManager()
      mock.state.nextConnectedSessionMetadata.push({ workspace_key: 'rk_live_other' })

      const started = await manager.start(PROJECT_ID, tempDir, 'pear-project-1', undefined as never, [])

      expect(started).toBe(true)
      expect(mock.HarnessDriverClient.connect).toHaveBeenCalledWith({ cwd: tempDir, connectionPath })
      expect(mock.state.connectedClients[0]?.disconnect).toHaveBeenCalled()
      expect(mock.HarnessDriverClient.spawn).toHaveBeenCalledWith(expect.objectContaining({
        brokerName: 'pear-project-1',
        workspaceKey: 'rk_live_pinned'
      }))

      await manager.shutdown()
    } finally {
      if (previousWorkspaceKey === undefined) {
        delete process.env.AGENT_RELAY_WORKSPACE_KEY
      } else {
        process.env.AGENT_RELAY_WORKSPACE_KEY = previousWorkspaceKey
      }
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('reports the matching connection file when a stale current file and matching legacy file coexist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pear-connection-status-'))
    const currentConnectionPath = join(tempDir, '.agentworkforce', 'relay', 'connection.json')
    const legacyConnectionPath = join(tempDir, '.agent-relay', 'connection.json')
    await mkdir(dirname(currentConnectionPath), { recursive: true })
    await mkdir(dirname(legacyConnectionPath), { recursive: true })

    try {
      const manager = new BrokerManager()
      mock.state.nextLocalAgents = []
      await manager.start(PROJECT_ID, tempDir, 'pear-project-1', undefined as never, [])
      const local = lastSpawned()
      local.baseUrl = 'http://127.0.0.1:43210'
      local.brokerPid = 4242

      await writeFile(currentConnectionPath, JSON.stringify({
        url: 'http://127.0.0.1:1',
        api_key: 'stale-key',
        pid: 1
      }))
      await writeFile(legacyConnectionPath, JSON.stringify({
        url: 'http://127.0.0.1:43210/',
        api_key: 'legacy-key',
        pid: 4242
      }))

      const [details] = await manager.listBrokerDetails()

      expect(details.connectionPath).toBe(legacyConnectionPath)
      expect(details.connectionFileStatus).toBe('matches')
      expect(details.apiKey).toBe('legacy-key')

      await manager.shutdown()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('disconnects failed broker connection probes before trying the next candidate', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pear-connection-fallback-'))
    const currentConnectionPath = join(tempDir, '.agentworkforce', 'relay', 'connection.json')
    const legacyConnectionPath = join(tempDir, '.agent-relay', 'connection.json')
    await mkdir(dirname(currentConnectionPath), { recursive: true })
    await mkdir(dirname(legacyConnectionPath), { recursive: true })
    await writeFile(currentConnectionPath, JSON.stringify({
      url: 'http://127.0.0.1:1',
      api_key: 'stale-key',
      pid: 1
    }))
    await writeFile(legacyConnectionPath, JSON.stringify({
      url: 'http://127.0.0.1:43210',
      api_key: 'legacy-key',
      pid: 4242
    }))

    try {
      const manager = new BrokerManager()
      mock.state.nextConnectedSessionErrors = [new Error('stale broker')]

      const started = await manager.start(PROJECT_ID, tempDir, 'pear-project-1', undefined as never, [])

      expect(started).toBe(true)
      expect(mock.HarnessDriverClient.connect).toHaveBeenCalledTimes(2)
      expect(mock.HarnessDriverClient.connect).toHaveBeenNthCalledWith(1, { cwd: tempDir, connectionPath: currentConnectionPath })
      expect(mock.HarnessDriverClient.connect).toHaveBeenNthCalledWith(2, { cwd: tempDir, connectionPath: legacyConnectionPath })
      expect(mock.state.connectedClients[0].disconnect).toHaveBeenCalledTimes(1)
      expect(mock.HarnessDriverClient.spawn).not.toHaveBeenCalled()

      await manager.shutdown()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps the cloud session alive when a local broker starts afterwards', async () => {
    const manager = new BrokerManager()
    const cloud = await attachCloud(manager, ['cloud-agent'])
    const local = await startLocal(manager, [])

    expect(cloud.shutdown).not.toHaveBeenCalled()
    expect(local).not.toBe(cloud)

    const agents = await manager.listAgents(PROJECT_ID)
    expect(agents.map((agent) => agent.name)).toContain('cloud-agent')

    await manager.shutdown()
  })

  it('routes spawns by broker target and defaults to the local session', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager)
    const cloud = await attachCloud(manager)

    await manager.spawnAgent(PROJECT_ID, { name: 'worker', cli: 'fake-cli' })
    expect(local.spawnPty).toHaveBeenCalledTimes(1)
    expect(cloud.spawnPty).not.toHaveBeenCalled()

    await manager.spawnAgent(PROJECT_ID, { name: 'cloud-worker', cli: 'fake-cli', broker: 'cloud' })
    expect(cloud.spawnPty).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it('dedupes agent names across both sessions when spawning', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, [])
    await attachCloud(manager, ['worker'])

    const spawned = await manager.spawnAgent(PROJECT_ID, { name: 'worker', cli: 'fake-cli' })
    expect(spawned.name).not.toBe('worker')
    expect(local.spawnPty).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it('coalesces concurrent duplicate spawn requests', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, [])
    let releaseSpawn!: () => void
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      await new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      local.agentNames.push(input.name)
      return { name: input.name, runtime: 'pty' }
    })

    const first = manager.spawnAgent(PROJECT_ID, { name: 'worker', cli: 'fake-cli', cwd: '/tmp/project' })
    const second = manager.spawnAgent(PROJECT_ID, { name: 'worker', cli: 'fake-cli', cwd: '/tmp/project' })
    await Promise.resolve()
    await Promise.resolve()

    expect(local.spawnPty).toHaveBeenCalledTimes(1)
    releaseSpawn()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { name: 'worker', runtime: 'pty' },
      { name: 'worker', runtime: 'pty' }
    ])
    expect(local.agentNames).toEqual(['worker'])

    await manager.shutdown()
  })

  it('returns a clone-safe payload when spawning a workforce persona', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)

    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []
    await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      local.agentNames.push(input.name)
      setImmediate(() => emitPersonaHarnessReady(local, input.name))
      return {
        name: input.name,
        runtime: 'pty',
        cli: 'agentworkforce',
        nonCloneable: () => undefined
      }
    })

    const result = await manager.spawnPersona(PROJECT_ID, 'autonomous-actor')

    expect(local.spawnPty).toHaveBeenCalledWith(expect.objectContaining({
      args: ['agent', 'autonomous-actor']
    }))
    expect(local.spawnPty).not.toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['--install-in-repo'])
    }))
    expect(result).toEqual({
      name: 'autonomous-actor',
      runtime: 'pty',
      cli: 'claude'
    })
    expect(() => structuredClone(result)).not.toThrow()

    await manager.shutdown()
  })

  it('lists workforce personas from a project root before the relay workspace starts', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-list-'))
    await writeAgentWorkforceFixture(personaTempDir)

    const manager = new BrokerManager()

    await expect(manager.listPersonas(PROJECT_ID, personaTempDir)).resolves.toEqual([
      { id: 'autonomous-actor', harness: 'claude' }
    ])
    expect(mock.HarnessDriverClient.spawn).not.toHaveBeenCalled()

    await manager.shutdown()
  })

  it('returns an empty persona list instead of throwing when no session or root is available', async () => {
    const manager = new BrokerManager()

    await expect(manager.listPersonas(PROJECT_ID)).resolves.toEqual([])

    await manager.shutdown()
  })

  it('coalesces concurrent duplicate workforce persona spawn requests', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)

    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []
    await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    let releaseSpawn!: () => void
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      await new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      local.agentNames.push(input.name)
      setImmediate(() => emitPersonaHarnessReady(local, input.name))
      return {
        name: input.name,
        runtime: 'pty',
        cli: 'agentworkforce',
        nonCloneable: () => undefined
      }
    })

    const first = manager.spawnPersona(PROJECT_ID, 'autonomous-actor')
    const second = manager.spawnPersona(PROJECT_ID, 'autonomous-actor')
    await Promise.resolve()
    await Promise.resolve()

    expect(local.spawnPty).toHaveBeenCalledTimes(1)
    releaseSpawn()
    const results = await Promise.all([first, second])

    expect(results).toEqual([
      { name: 'autonomous-actor', runtime: 'pty', cli: 'claude' },
      { name: 'autonomous-actor', runtime: 'pty', cli: 'claude' }
    ])
    expect(() => structuredClone(results[0])).not.toThrow()
    expect(() => structuredClone(results[1])).not.toThrow()
    expect(local.agentNames).toEqual(['autonomous-actor'])

    await manager.shutdown()
  })

  it('releases a workforce persona wrapper that never reaches harness readiness', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)
    process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS = '20'

    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []
    await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      local.agentNames.push(input.name)
      return {
        name: input.name,
        runtime: 'pty',
        cli: 'agentworkforce'
      }
    })

    await expect(manager.spawnPersona(PROJECT_ID, 'autonomous-actor')).rejects.toThrow(
      /Timed out waiting for Workforce persona autonomous-actor to prepare its harness/
    )
    expect(local.release).toHaveBeenCalledWith(
      'autonomous-actor',
      'persona harness readiness verification failed'
    )

    delete process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS
    await manager.shutdown()
  })

  it('does not expose a workforce persona to listAgents until harness readiness passes', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)

    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []
    await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    let releaseSpawn!: () => void
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      local.agentNames.push(input.name)
      await new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      setImmediate(() => emitPersonaHarnessReady(local, input.name))
      return {
        name: input.name,
        runtime: 'pty',
        cli: 'agentworkforce'
      }
    })

    const spawned = manager.spawnPersona(PROJECT_ID, 'autonomous-actor')
    await Promise.resolve()
    await Promise.resolve()

    await expect(manager.listAgents(PROJECT_ID)).resolves.toEqual([])
    releaseSpawn()
    await expect(spawned).resolves.toEqual({
      name: 'autonomous-actor',
      runtime: 'pty',
      cli: 'claude'
    })
    expect((await manager.listAgents(PROJECT_ID)).map((agent) => agent.name)).toEqual(['autonomous-actor'])

    await manager.shutdown()
  })

  it('does not expose a workforce persona to broker details until harness readiness passes', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)

    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []
    await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    let releaseSpawn!: () => void
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      local.agentNames.push(input.name)
      await new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      setImmediate(() => emitPersonaHarnessReady(local, input.name))
      return {
        name: input.name,
        runtime: 'pty',
        cli: 'agentworkforce'
      }
    })

    const spawned = manager.spawnPersona(PROJECT_ID, 'autonomous-actor')
    await Promise.resolve()
    await Promise.resolve()

    const [pendingDetails] = await manager.listBrokerDetails()
    expect(pendingDetails.agentCount).toBe(0)
    expect(pendingDetails.agents).toEqual([])

    releaseSpawn()
    await expect(spawned).resolves.toEqual({
      name: 'autonomous-actor',
      runtime: 'pty',
      cli: 'claude'
    })

    const [readyDetails] = await manager.listBrokerDetails()
    expect(readyDetails.agentCount).toBe(1)
    expect(readyDetails.agents.map((agent) => agent.name)).toEqual(['autonomous-actor'])

    await manager.shutdown()
  })

  it('releases a workforce persona when broker delivery readiness is not confirmed', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)
    process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS = '50'

    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []
    await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      local.agentNames.push(input.name)
      setImmediate(() => emitPersonaHarnessReady(local, input.name))
      return {
        name: input.name,
        runtime: 'pty',
        cli: 'agentworkforce'
      }
    })
    local.sendMessage.mockResolvedValueOnce({
      event_id: 'evt-readiness-never-injected',
      targets: ['autonomous-actor']
    })

    await expect(manager.spawnPersona(PROJECT_ID, 'autonomous-actor')).rejects.toThrow(
      /did not become ready for broker delivery/
    )
    expect(local.release).toHaveBeenCalledWith(
      'autonomous-actor',
      'persona harness readiness verification failed'
    )

    await manager.shutdown()
  })

  it('does not reuse old sandbox-ready output for a new workforce persona launch', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)
    process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS = '20'

    const manager = new BrokerManager()
    mock.state.nextLocalAgents = []
    await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    emitPersonaHarnessReady(local, 'autonomous-actor')
    local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
      local.agentNames.push(input.name)
      return {
        name: input.name,
        runtime: 'pty',
        cli: 'agentworkforce'
      }
    })

    await expect(manager.spawnPersona(PROJECT_ID, 'autonomous-actor')).rejects.toThrow(
      /Timed out waiting for Workforce persona autonomous-actor to prepare its harness/
    )

    await manager.shutdown()
  })

  it('spawning with broker: cloud fails clearly when no sandbox is attached', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    await expect(
      manager.spawnAgent(PROJECT_ID, { name: 'worker', cli: 'fake-cli', broker: 'cloud' })
    ).rejects.toThrowError(/Cloud sandbox is not attached/)

    await manager.shutdown()
  })

  it('attaches terminals to the session that owns the agent', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, [])
    const cloud = await attachCloud(manager, ['cloud-agent'])

    const result = await manager.attachTerminal(PROJECT_ID, { name: 'cloud-agent', mode: 'passthrough' })
    expect(result.name).toBe('cloud-agent')
    expect(cloud.snapshot).toHaveBeenCalled()
    expect(local.snapshot).not.toHaveBeenCalled()
    expect(local.setInboundDeliveryMode).not.toHaveBeenCalled()

    await manager.shutdown()
  })

  it('detachCloudSandbox drops only the cloud session', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['local-agent'])
    const cloud = await attachCloud(manager, ['cloud-agent'])

    await manager.detachCloudSandbox(PROJECT_ID)
    expect(cloud.shutdown).toHaveBeenCalled()
    expect(local.shutdown).not.toHaveBeenCalled()

    const agents = await manager.listAgents(PROJECT_ID)
    expect(agents.map((agent) => agent.name)).toEqual(['local-agent'])

    await manager.shutdown()
  })

  it('re-attaching a cloud sandbox replaces only the previous cloud session', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager)
    const firstCloud = await attachCloud(manager)
    const secondCloud = await attachCloud(manager)

    expect(firstCloud.shutdown).toHaveBeenCalled()
    expect(secondCloud).not.toBe(firstCloud)
    expect(local.shutdown).not.toHaveBeenCalled()

    await manager.shutdown()
  })

  it('routes broker events to the current window after an existing session swaps windows', async () => {
    const manager = new BrokerManager()
    const firstWindow = createMockWindow()
    const secondWindow = createMockWindow()
    const local = await startLocalWithWindow(manager, firstWindow)

    await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', secondWindow, [])

    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')
    listener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      body: 'window swap proof',
      event_id: 'evt-window-swap',
      seq: 12
    })

    expect((firstWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .some(([channel, payload]) =>
        channel === 'broker:event' &&
        (payload as { body?: string }).body === 'window swap proof'
      )).toBe(false)
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      'broker:event',
      expect.objectContaining({
        kind: 'relay_inbound',
        body: 'window swap proof',
        projectId: PROJECT_ID
      })
    )

    await manager.shutdown()
  })

  it('does not publish broker events to a destroyed captured window', async () => {
    const manager = new BrokerManager()
    const destroyedWindow = createMockWindow(true)
    const local = await startLocalWithWindow(manager, destroyedWindow)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      body: 'destroyed window proof',
      event_id: 'evt-destroyed-window',
      seq: 13
    })

    expect(destroyedWindow.webContents.send).not.toHaveBeenCalledWith(
      'broker:event',
      expect.objectContaining({
        body: 'destroyed window proof'
      })
    )

    await manager.shutdown()
  })

  it('dedupes repeated PTY chunks from overlapping event streams', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    const chunkEvent = {
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'pong\n',
      seq: 22
    }
    listener?.(chunkEvent)
    listener?.(chunkEvent)

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([['broker:pty-chunk', PROJECT_ID, 'claude-1', 'pong\n']])

    await manager.shutdown()
  })

  it('keeps legitimate repeated PTY chunks with different broker sequences', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'pong\n',
      seq: 23
    })
    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'pong\n',
      seq: 24
    })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toHaveLength(2)

    await manager.shutdown()
  })

  it('dedupes repeated PTY chunks when broker events have no identity', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'pong\n'
    })
    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'pong\n'
    })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([['broker:pty-chunk', PROJECT_ID, 'claude-1', 'pong\n']])

    await manager.shutdown()
  })

  it('keeps distinct PTY chunks when broker events have no identity', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'po'
    })
    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'ng\n'
    })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'po'],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'ng\n']
    ])

    await manager.shutdown()
  })

  it('refreshEventStream rebinds the harness stream from the last seen sequence', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      body: 'seq proof',
      event_id: 'evt-seq-proof',
      seq: 477
    })

    await manager.refreshEventStream(PROJECT_ID, 'test-rebind')

    expect(local.disconnectEvents).toHaveBeenCalledTimes(1)
    expect(local.onEvent).toHaveBeenCalledTimes(2)
    expect(local.connectEvents).toHaveBeenLastCalledWith(477)

    await manager.shutdown()
  })

  it('ignores stale PTY callbacks from superseded event streams', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const staleListener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(staleListener).toBeTypeOf('function')

    await manager.refreshEventStream(PROJECT_ID, 'test-stale-listener')

    const currentListener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(currentListener).toBeTypeOf('function')
    staleListener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'Background command "Poll hn-monitor logs waiting for new run after 21:00Z" completed (exit code 0)\n'
    })
    currentListener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'fresh output\n'
    })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([['broker:pty-chunk', PROJECT_ID, 'claude-1', 'fresh output\n']])

    await manager.shutdown()
  })

  it('ignores stale PTY callbacks from a previous broker session', async () => {
    const manager = new BrokerManager()
    const firstWindow = createMockWindow()
    const firstClient = await startLocalWithWindow(manager, firstWindow)
    const staleListener = firstClient.onEvent.mock.calls.at(-1)?.[0]
    expect(staleListener).toBeTypeOf('function')

    await manager.shutdown(PROJECT_ID)

    const secondWindow = createMockWindow()
    const secondClient = await startLocalWithWindow(manager, secondWindow)
    const currentListener = secondClient.onEvent.mock.calls.at(-1)?.[0]
    expect(currentListener).toBeTypeOf('function')

    staleListener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'old session output\n'
    })
    currentListener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: 'new session output\n'
    })

    const firstPtyCalls = (firstWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    const secondPtyCalls = (secondWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(firstPtyCalls).toEqual([])
    expect(secondPtyCalls).toEqual([['broker:pty-chunk', PROJECT_ID, 'claude-1', 'new session output\n']])

    await manager.shutdown()
  })

  it('keeps a replacement event listener when reconnect throws during refreshEventStream', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)

    local.connectEvents.mockImplementationOnce(() => {
      throw new Error('connect failed')
    })

    await manager.refreshEventStream(PROJECT_ID, 'test-rebind-failure')

    expect(local.disconnectEvents).toHaveBeenCalledTimes(1)
    expect(local.onEvent).toHaveBeenCalledTimes(2)
    expect(local.connectEvents).toHaveBeenLastCalledWith(undefined)

    const replacementListener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(replacementListener).toBeTypeOf('function')
    replacementListener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      body: 'rebind failure still subscribed',
      event_id: 'evt-rebind-failure',
      seq: 478
    })

    expect(win.webContents.send).toHaveBeenCalledWith(
      'broker:event',
      expect.objectContaining({
        kind: 'relay_inbound',
        body: 'rebind failure still subscribed',
        projectId: PROJECT_ID
      })
    )

    await manager.shutdown()
  })

  it('treats project-scoped refreshEventStream as a no-op before a broker session starts', async () => {
    const manager = new BrokerManager()

    await expect(manager.refreshEventStream(PROJECT_ID, 'startup-refresh')).resolves.toBeUndefined()

    await manager.shutdown()
  })

  it('does not let a global event-stream refresh overwrite session windows', async () => {
    const manager = new BrokerManager()
    const firstWindow = createMockWindow()
    const secondWindow = createMockWindow()
    const intruderWindow = createMockWindow()
    await startLocalWithWindow(manager, firstWindow, [], PROJECT_ID)
    const secondClient = await startLocalWithWindow(manager, secondWindow, [], 'project-2')

    await manager.refreshEventStream(undefined, 'global-refresh', intruderWindow)

    const secondListener = secondClient.onEvent.mock.calls.at(-1)?.[0]
    expect(secondListener).toBeTypeOf('function')
    secondListener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      body: 'global refresh proof',
      event_id: 'evt-global-refresh',
      seq: 479
    })

    expect(intruderWindow.webContents.send).not.toHaveBeenCalledWith(
      'broker:event',
      expect.objectContaining({
        body: 'global refresh proof'
      })
    )
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      'broker:event',
      expect.objectContaining({
        kind: 'relay_inbound',
        body: 'global refresh proof',
        projectId: 'project-2'
      })
    )

    await manager.shutdown()
  })

  it('waits for delivery using the addressed agent when broker send result omits targets', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['claude-1'])
    local.sendMessage.mockResolvedValueOnce({ event_id: 'evt-integration' })
    local.onEvent.mockImplementationOnce((listener) => {
      setImmediate(() => {
        listener({
          kind: 'delivery_ack',
          event_id: 'evt-integration',
          name: 'claude-1'
        })
      })
      return () => undefined
    })

    await expect(manager.sendMessageAndWaitForDelivery(PROJECT_ID, {
      to: 'claude-1',
      text: '<integration-event>ping</integration-event>'
    })).resolves.toEqual({
      eventId: 'evt-integration',
      targets: ['claude-1']
    })

    await manager.shutdown()
  })

  it('waits for injection using the addressed agent when broker send result omits targets', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['claude-1'])
    local.sendMessage.mockResolvedValueOnce({ event_id: 'evt-injected' })
    local.onEvent.mockImplementationOnce((listener) => {
      setImmediate(() => {
        listener({
          kind: 'delivery_injected',
          event_id: 'evt-injected',
          name: 'claude-1'
        })
      })
      return () => undefined
    })

    await expect(manager.sendMessageAndWaitForInjected(PROJECT_ID, {
      to: 'claude-1',
      text: '<integration-event>ping</integration-event>'
    })).resolves.toEqual({
      eventId: 'evt-injected',
      targets: ['claude-1']
    })

    await manager.shutdown()
  })

  it('does not treat delivery ack or verification as an injection confirmation', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['claude-1'])
    local.sendMessage.mockResolvedValueOnce({ event_id: 'evt-not-injected' })
    local.onEvent.mockImplementationOnce((listener) => {
      setImmediate(() => {
        listener({
          kind: 'delivery_ack',
          event_id: 'evt-not-injected',
          name: 'claude-1'
        })
        listener({
          kind: 'delivery_verified',
          event_id: 'evt-not-injected',
          name: 'claude-1'
        })
      })
      return () => undefined
    })

    await expect(manager.sendMessageAndWaitForInjected(PROJECT_ID, {
      to: 'claude-1',
      text: '<integration-event>ping</integration-event>'
    }, { timeoutMs: 10 })).rejects.toThrow(
      'Timed out waiting for delivery injection for evt-not-injected (claude-1)'
    )

    await manager.shutdown()
  })

  it.each([
    ['delivery_failed', 'PTY write failed'],
    ['message_delivery_failed', 'broker send failed']
  ] as const)('rejects injection wait on %s', async (kind, reason) => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['claude-1'])
    local.sendMessage.mockResolvedValueOnce({ event_id: `evt-${kind}` })
    local.onEvent.mockImplementationOnce((listener) => {
      setImmediate(() => {
        listener({
          kind,
          event_id: `evt-${kind}`,
          name: 'claude-1',
          reason
        })
      })
      return () => undefined
    })

    await expect(manager.sendMessageAndWaitForInjected(PROJECT_ID, {
      to: 'claude-1',
      text: '<integration-event>ping</integration-event>'
    })).rejects.toThrow(reason)

    await manager.shutdown()
  })

  it('waits for every reported target before confirming injection', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['claude-1', 'codex-1'])
    local.sendMessage.mockResolvedValueOnce({
      event_id: 'evt-multi-injected',
      targets: ['claude-1', 'codex-1']
    })
    local.onEvent.mockImplementationOnce((listener) => {
      setImmediate(() => {
        listener({
          kind: 'delivery_injected',
          event_id: 'evt-multi-injected',
          name: 'claude-1'
        })
        listener({
          kind: 'delivery_injected',
          event_id: 'evt-multi-injected',
          name: 'codex-1'
        })
      })
      return () => undefined
    })

    await expect(manager.sendMessageAndWaitForInjected(PROJECT_ID, {
      to: 'claude-1',
      text: '<integration-event>ping</integration-event>'
    })).resolves.toEqual({
      eventId: 'evt-multi-injected',
      targets: ['claude-1', 'codex-1']
    })

    await manager.shutdown()
  })

  it('returns without waiting for injection when a channel send has no concrete targets', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['claude-1'])
    local.sendMessage.mockResolvedValueOnce({ event_id: 'evt-channel', targets: [] })

    await expect(manager.sendMessageAndWaitForInjected(PROJECT_ID, {
      to: '#general',
      text: '<integration-event>ping</integration-event>'
    }, { timeoutMs: 1 })).resolves.toEqual({
      eventId: 'evt-channel',
      targets: []
    })

    await manager.shutdown()
  })

  it('replays injection events observed before sendMessage resolves', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['claude-1'])
    let eventListener: ((event: unknown) => void) | undefined
    local.onEvent.mockImplementationOnce((listener) => {
      eventListener = listener
      return () => undefined
    })
    local.sendMessage.mockImplementationOnce(async () => {
      eventListener?.({
        kind: 'delivery_injected',
        event_id: 'evt-early-injected',
        name: 'claude-1'
      })
      return { event_id: 'evt-early-injected' }
    })

    await expect(manager.sendMessageAndWaitForInjected(PROJECT_ID, {
      to: 'claude-1',
      text: '<integration-event>ping</integration-event>'
    })).resolves.toEqual({
      eventId: 'evt-early-injected',
      targets: ['claude-1']
    })

    await manager.shutdown()
  })

  it('keeps repeated no-identity PTY chunks after intervening output', async () => {
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: '>'
    })
    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: ' '
    })
    listener?.({
      kind: 'worker_stream',
      name: 'claude-1',
      chunk: '>'
    })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', '>'],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', ' '],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', '>']
    ])

    await manager.shutdown()
  })
})

describe('BrokerManager spawnAgent CLI preflight', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    mock.state.spawnedClients.length = 0
    mock.state.constructedClients.length = 0
    mock.state.nextLocalAgents = []
    mock.state.nextCloudAgents = []
  })

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('validates relative executable paths from the agent cwd', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-broker-'))
    const toolPath = join(tempDir, 'bin', 'tool')
    await mkdir(join(tempDir, 'bin'), { recursive: true })
    await writeFile(toolPath, '#!/bin/sh\nexit 0\n')
    await chmod(toolPath, 0o755)

    const manager = new BrokerManager()
    const local = await startLocal(manager)

    await expect(manager.spawnAgent(PROJECT_ID, {
      name: 'local-tool',
      cli: './bin/tool',
      cwd: tempDir
    })).resolves.toEqual({ name: 'local-tool', runtime: 'pty' })

    expect(local.spawnPty).toHaveBeenCalledWith(expect.objectContaining({
      name: 'local-tool',
      cli: './bin/tool',
      cwd: tempDir
    }))

    await manager.shutdown()
  })
})
