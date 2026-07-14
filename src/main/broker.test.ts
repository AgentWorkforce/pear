import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
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
      brokerPid: 4242,
      baseUrl: 'http://127.0.0.1:4242'
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
    static spawn = vi.fn(async (_options: unknown) => {
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

const fleetNodeMock = vi.hoisted(() => {
  type SidecarMock = { registered: Promise<unknown>; done: Promise<void>; stop: ReturnType<typeof vi.fn> }
  const sidecars: SidecarMock[] = []
  const startPearFleetSidecar = vi.fn((_options: unknown): SidecarMock => {
    const sidecar: SidecarMock = {
      registered: Promise.resolve({
        name: 'pear-project-1-local-fleet',
        capabilities: [
          'claude',
          'codex',
          'gemini',
          'opencode',
          'grok',
          'aider',
          'goose',
          'cursor',
          'droid'
        ].map((cli) => ({ name: `spawn:${cli}`, kind: 'action' }))
      }),
      done: new Promise<void>(() => undefined),
      stop: vi.fn(async () => undefined)
    }
    sidecars.push(sidecar)
    return sidecar
  })

  return { sidecars, startPearFleetSidecar }
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

vi.mock('./pear-fleet-node', () => ({
  startPearFleetSidecar: fleetNodeMock.startPearFleetSidecar
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

import {
  BrokerManager,
  isCommandAvailableWithAugmentedPath,
  resolveAgentRelayMcpCommand
} from './broker'
import {
  parseBrokerInitCliFlags,
  resolveBundledBrokerBinary
} from './broker-binary'
import { resolvePackageBin } from './mcp-command'
import {
  classifyBrokerEvent,
  KNOWN_BROKER_EVENT_KINDS
} from '../shared/schemas/broker-events'

const PROJECT_ID = 'project-1'
const originalMcpCommand = process.env.AGENT_RELAY_MCP_COMMAND
const originalAgentRelayBin = process.env.AGENT_RELAY_BIN
const originalBrokerBinaryPath = process.env.BROKER_BINARY_PATH
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const originalPublicEnv = process.env.PUBLIC
const originalProgramDataEnv = process.env.ProgramData
const originalPersonaHarnessReadyTimeoutEnv = process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS
const originalPathEnv = process.env.PATH

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
    delete (process as { resourcesPath?: string }).resourcesPath
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

describe('resolveBundledBrokerBinary', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    electronMock.app.isPackaged = false
    delete process.env.BROKER_BINARY_PATH
    if (originalAgentRelayBin === undefined) {
      delete process.env.AGENT_RELAY_BIN
    } else {
      process.env.AGENT_RELAY_BIN = originalAgentRelayBin
    }
  })

  afterEach(async () => {
    electronMock.app.isPackaged = false
    if (originalBrokerBinaryPath === undefined) {
      delete process.env.BROKER_BINARY_PATH
    } else {
      process.env.BROKER_BINARY_PATH = originalBrokerBinaryPath
    }
    if (originalAgentRelayBin === undefined) {
      delete process.env.AGENT_RELAY_BIN
    } else {
      process.env.AGENT_RELAY_BIN = originalAgentRelayBin
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('uses a valid AGENT_RELAY_BIN override', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-broker-bin-'))
    const brokerPath = join(tempDir, 'agent-relay-broker')
    await writeFile(brokerPath, '#!/bin/sh\nexit 0\n')
    await chmod(brokerPath, 0o755)
    process.env.AGENT_RELAY_BIN = brokerPath

    expect(resolveBundledBrokerBinary()).toBe(brokerPath)
  })

  it('ignores an invalid AGENT_RELAY_BIN override and falls back to a bundled broker', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-broker-bin-'))
    const missingBrokerPath = join(tempDir, 'missing-broker')
    process.env.AGENT_RELAY_BIN = missingBrokerPath
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const resolved = resolveBundledBrokerBinary()

      expect(resolved).not.toBe(missingBrokerPath)
      expect(resolved).toContain(join('node_modules', '@agent-relay'))
      expect(warnSpy).toHaveBeenCalledWith(
        '[broker] Ignoring AGENT_RELAY_BIN because it is not executable:',
        missingBrokerPath
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('checks the packaged optional broker binary in app.asar.unpacked', async () => {
    delete process.env.AGENT_RELAY_BIN
    tempDir = await mkdtemp(join(tmpdir(), 'pear-broker-asar-'))
    const baseDir = join(tempDir, 'Resources', 'app.asar', 'out', 'main')
    const brokerPath = join(
      tempDir,
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      '@agent-relay',
      `broker-${process.platform}-${process.arch}`,
      'bin',
      process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker'
    )
    await mkdir(dirname(brokerPath), { recursive: true })
    await writeFile(brokerPath, '#!/bin/sh\nexit 0\n')
    await chmod(brokerPath, 0o755)
    electronMock.app.isPackaged = true

    expect(resolveBundledBrokerBinary(baseDir)).toBe(brokerPath)
  })

  it('uses an .exe broker name on win32 fallback paths', () => {
    delete process.env.AGENT_RELAY_BIN
    setProcessPlatform('win32')

    const resolved = resolveBundledBrokerBinary('/tmp/pear-no-broker')

    expect(resolved).toContain('win32')
    expect(resolved).toMatch(/\.exe$/)
  })
})

describe('BrokerManager local + cloud coexistence', () => {
  let personaTempDir: string | null = null
  const inheritedWorkspaceKey = process.env.AGENT_RELAY_WORKSPACE_KEY

  beforeEach(() => {
    electronMock.app.isPackaged = false
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
    delete process.env.AGENT_RELAY_WORKSPACE_KEY
    delete process.env.BROKER_BINARY_PATH
    if (originalAgentRelayBin === undefined) {
      delete process.env.AGENT_RELAY_BIN
    } else {
      process.env.AGENT_RELAY_BIN = originalAgentRelayBin
    }
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
    fleetNodeMock.sidecars.length = 0
    fleetNodeMock.startPearFleetSidecar.mockClear()
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
    if (originalAgentRelayBin === undefined) {
      delete process.env.AGENT_RELAY_BIN
    } else {
      process.env.AGENT_RELAY_BIN = originalAgentRelayBin
    }
    if (originalBrokerBinaryPath === undefined) {
      delete process.env.BROKER_BINARY_PATH
    } else {
      process.env.BROKER_BINARY_PATH = originalBrokerBinaryPath
    }
    electronMock.app.isPackaged = false
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
    // Guaranteed cleanup for tests that stub global fetch (mintObserverToken
    // specs below) — relying on a `vi.unstubAllGlobals()` call at the end of
    // each test body would leak the stub into later tests if an earlier
    // assertion in that test throws first.
    vi.unstubAllGlobals()
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

  it('dedupes replayed agent_exit releases in the background', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['exited-agent'])

    local.emitEvent({ kind: 'agent_exit', name: 'exited-agent', reason: 'done', event_id: 'exit-1' })
    local.emitEvent({ kind: 'agent_exit', name: 'exited-agent', reason: 'done', event_id: 'exit-1' })

    await vi.waitFor(() => expect(local.release).toHaveBeenCalledTimes(1))
    expect(local.release).toHaveBeenCalledWith('exited-agent', 'agent exit')

    await manager.shutdown()
  })

  it('keeps live terminal attach serving while an exited-agent release hangs', async () => {
    const manager = new BrokerManager()
    const local = await startLocal(manager, ['exited-agent', 'live-agent'])
    local.release.mockImplementationOnce(() => new Promise(() => undefined))

    local.emitEvent({ kind: 'agent_exit', name: 'exited-agent', reason: 'done', event_id: 'exit-1' })
    await vi.waitFor(() => expect(local.release).toHaveBeenCalledTimes(1))

    const attached = await manager.attachTerminal(PROJECT_ID, { name: 'live-agent', rows: 24, cols: 80 })

    expect(attached.name).toBe('live-agent')
    expect(attached.snapshot?.screen).toBe('hello')
    expect(local.snapshot).toHaveBeenCalledWith('live-agent', 'ansi')

    await manager.shutdown()
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

  it('registers a local fleet node for spawned brokers', async () => {
    const manager = new BrokerManager()

    await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

    expect(fleetNodeMock.startPearFleetSidecar).toHaveBeenCalledTimes(1)
    expect(fleetNodeMock.startPearFleetSidecar).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      cwd: '/tmp/project-1',
      brokerName: 'pear-project-1',
      connection: {
        url: 'http://127.0.0.1:4242'
      }
    }))

    await manager.shutdown()
    expect(fleetNodeMock.sidecars[0]?.stop).toHaveBeenCalledTimes(1)
  })

  it('keeps one local fleet node when reusing the same broker session', async () => {
    const manager = new BrokerManager()

    await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])
    await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

    expect(fleetNodeMock.startPearFleetSidecar).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it('does not register a local fleet node for cloud sandbox sessions', async () => {
    const manager = new BrokerManager()

    await attachCloud(manager, ['cloud-agent'])

    expect(fleetNodeMock.startPearFleetSidecar).not.toHaveBeenCalled()

    await manager.shutdown()
  })

  it('does not block local broker start when fleet registration hangs', async () => {
    const sidecar = {
      registered: new Promise<unknown>(() => undefined),
      done: Promise.resolve(),
      stop: vi.fn(async () => undefined)
    }
    fleetNodeMock.startPearFleetSidecar.mockImplementationOnce(() => {
      fleetNodeMock.sidecars.push(sidecar)
      return sidecar
    })
    const manager = new BrokerManager()

    try {
      const started = manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

      await expect(started).resolves.toBe(true)
      expect(mock.HarnessDriverClient.spawn).toHaveBeenCalledTimes(1)
    } finally {
      await manager.shutdown()
    }
  }, 5_000)

  it('does not block local broker shutdown when fleet stop hangs', async () => {
    const sidecar = {
      registered: Promise.resolve({ name: 'pear-project-1-local-fleet', capabilities: [] }),
      done: new Promise<void>(() => undefined),
      stop: vi.fn(() => new Promise<void>(() => undefined))
    }
    fleetNodeMock.startPearFleetSidecar.mockImplementationOnce(() => {
      fleetNodeMock.sidecars.push(sidecar)
      return sidecar
    })
    const manager = new BrokerManager()

    await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])
    const local = lastSpawned()
    const shutdown = manager.shutdown()

    await expect(shutdown).resolves.toBeUndefined()
    expect(local.shutdown).toHaveBeenCalled()
  }, 5_000)

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

  it('does not expose the native broker as the spawned worker Agent Relay CLI', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pear-worker-broker-env-'))
    const brokerPath = join(tempDir, 'agent-relay-broker')
    await writeFile(brokerPath, `#!/bin/sh
if [ "$*" = "init --help" ]; then
  echo "--instance-name --workspace-key"
fi
exit 0
`)
    await chmod(brokerPath, 0o755)
    process.env.AGENT_RELAY_BIN = brokerPath
    delete process.env.BROKER_BINARY_PATH
    const manager = new BrokerManager()

    try {
      await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

      const spawnOptions = mock.HarnessDriverClient.spawn.mock.calls[0]?.[0] as {
        env?: NodeJS.ProcessEnv
      } | undefined
      expect(spawnOptions?.env?.BROKER_BINARY_PATH).toBe(brokerPath)
      expect(spawnOptions?.env?.AGENT_RELAY_BIN).toBe('')
    } finally {
      await manager.shutdown()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves an intentional Agent Relay CLI override separately from the broker', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pear-worker-cli-env-'))
    const brokerPath = join(tempDir, 'agent-relay-broker')
    const cliPath = join(tempDir, 'agent-relay')
    await writeFile(brokerPath, `#!/bin/sh
if [ "$*" = "init --help" ]; then
  echo "--instance-name --workspace-key"
fi
exit 0
`)
    await writeFile(cliPath, `#!/bin/sh
if [ "$*" = "cloud session --help" ]; then
  echo "Usage: agent-relay cloud session [options]" >&2
  exit 2
fi
exit 2
`)
    await chmod(brokerPath, 0o755)
    await chmod(cliPath, 0o755)
    process.env.BROKER_BINARY_PATH = brokerPath
    process.env.AGENT_RELAY_BIN = cliPath
    const manager = new BrokerManager()

    try {
      await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

      const spawnOptions = mock.HarnessDriverClient.spawn.mock.calls[0]?.[0] as {
        env?: NodeJS.ProcessEnv
      } | undefined
      expect(spawnOptions?.env?.BROKER_BINARY_PATH).toBe(brokerPath)
      expect(spawnOptions?.env?.AGENT_RELAY_BIN).toBe(cliPath)
    } finally {
      await manager.shutdown()
      await rm(tempDir, { recursive: true, force: true })
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

  it('mints an observer token via a direct POST to the broker\'s local HTTP API, then caches it', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ot_live_abc', id: 'obs-1' }),
      text: async () => ''
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await manager.mintObserverToken(PROJECT_ID)
    expect(result).toEqual({ token: 'ot_live_abc', id: 'obs-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4242/api/observer-token',
      expect.objectContaining({ method: 'POST' })
    )

    // A second mint for the same project reuses the cached token instead of
    // spamming the broker with fresh unrevoked tokens.
    const second = await manager.mintObserverToken(PROJECT_ID)
    expect(second).toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it('coalesces concurrent mints for the same project onto a single in-flight request', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    let resolveFetch: ((value: unknown) => void) | undefined
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)

    // Two "clicks" before the first POST has resolved — without coalescing,
    // each would race past the (still-empty) cache-miss check and mint a
    // separate, unrevoked token.
    const first = manager.mintObserverToken(PROJECT_ID)
    const second = manager.mintObserverToken(PROJECT_ID)

    // mintObserverTokenUncached awaits session.client.getSession() before
    // calling fetch, so give that microtask a turn before asserting.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    resolveFetch?.({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ot_live_abc', id: 'obs-1' })
    })

    await expect(first).resolves.toEqual({ token: 'ot_live_abc', id: 'obs-1' })
    await expect(second).resolves.toEqual({ token: 'ot_live_abc', id: 'obs-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Once settled, a later mint reuses the now-populated cache rather than
    // the (already-cleared) in-flight entry.
    await expect(manager.mintObserverToken(PROJECT_ID)).resolves.toEqual({ token: 'ot_live_abc', id: 'obs-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it('allows a fresh mint after a coalesced in-flight request fails', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    let rejectFetch: ((reason: unknown) => void) | undefined
    const failingFetchMock = vi.fn(() => new Promise((_resolve, reject) => {
      rejectFetch = reject
    }))
    vi.stubGlobal('fetch', failingFetchMock)

    const first = manager.mintObserverToken(PROJECT_ID)
    const second = manager.mintObserverToken(PROJECT_ID)
    await vi.waitFor(() => expect(failingFetchMock).toHaveBeenCalledTimes(1))

    rejectFetch?.(new Error('network down'))
    await expect(first).rejects.toThrow(/network down/)
    await expect(second).rejects.toThrow(/network down/)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ot_live_retry', id: 'obs-retry' })
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(manager.mintObserverToken(PROJECT_ID)).resolves.toEqual({ token: 'ot_live_retry', id: 'obs-retry' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it('surfaces a distinct, honest error when the broker predates the observer-token route (404) instead of falling back to the insecure workspace-key link', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'not found'
    })))

    await expect(manager.mintObserverToken(PROJECT_ID)).rejects.toThrow(
      /Observer links require a newer broker version/
    )

    await manager.shutdown()
  })

  it('throws a readable error when the broker rejects the observer-token request', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom'
    })))

    await expect(manager.mintObserverToken(PROJECT_ID)).rejects.toThrow(/HTTP 500/)

    await manager.shutdown()
  })

  it('mints a fresh observer token after the project session is torn down and restarted', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ot_live_abc', id: 'obs-1' })
    })))
    await manager.mintObserverToken(PROJECT_ID)

    await manager.shutdown(PROJECT_ID)
    await startLocal(manager)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ot_live_def', id: 'obs-2' })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await manager.mintObserverToken(PROJECT_ID)
    expect(result).toEqual({ token: 'ot_live_def', id: 'obs-2' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it('does not let a mint left in flight by a dropped session poison the cache for a restarted session', async () => {
    const manager = new BrokerManager()
    await startLocal(manager)

    let resolveStaleFetch: ((value: unknown) => void) | undefined
    const staleFetchMock = vi.fn(() => new Promise((resolve) => {
      resolveStaleFetch = resolve
    }))
    vi.stubGlobal('fetch', staleFetchMock)

    // Mint starts against the first session but its POST never resolves yet.
    const stalePromise = manager.mintObserverToken(PROJECT_ID)
    await vi.waitFor(() => expect(staleFetchMock).toHaveBeenCalledTimes(1))

    // The session is torn down mid-mint (e.g. joinWorkspace's shutdown path)
    // and a new one starts for the same project id — a workspace switch
    // while the old mint is still in flight.
    await manager.shutdown(PROJECT_ID)
    await startLocal(manager)

    const freshFetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ot_live_fresh', id: 'obs-fresh' })
    }))
    vi.stubGlobal('fetch', freshFetchMock)

    // Without clearing observerTokenMints (and bumping the generation) in
    // dropSession, this would reuse the stale in-flight promise from the
    // dropped session instead of minting fresh against the new one.
    const freshResult = await manager.mintObserverToken(PROJECT_ID)
    expect(freshResult).toEqual({ token: 'ot_live_fresh', id: 'obs-fresh' })
    expect(freshFetchMock).toHaveBeenCalledTimes(1)

    // Now let the stale mint (against the already-dropped session) resolve
    // late, simulating the race the fix guards against.
    resolveStaleFetch?.({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ot_live_stale', id: 'obs-stale' })
    })
    await expect(stalePromise).resolves.toEqual({ token: 'ot_live_stale', id: 'obs-stale' })

    // The late resolution must not have overwritten the cache with the
    // previous workspace's token — a later mint still returns the fresh,
    // current-session token from cache (no additional fetch).
    const cachedResult = await manager.mintObserverToken(PROJECT_ID)
    expect(cachedResult).toEqual({ token: 'ot_live_fresh', id: 'obs-fresh' })
    expect(freshFetchMock).toHaveBeenCalledTimes(1)

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
      expect(fleetNodeMock.startPearFleetSidecar).toHaveBeenCalledWith(expect.objectContaining({
        projectId: PROJECT_ID,
        cwd: tempDir,
        brokerName: 'pear-project-1'
      }))

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

  it('uses the packaged Agent Relay broker binary instead of an adjacent local relay build by default', async () => {
    const manager = new BrokerManager()

    await manager.start(PROJECT_ID, '/tmp/project-1', 'pear-project-1', undefined as never, [])

    const spawnOptions = mock.HarnessDriverClient.spawn.mock.calls[0]?.[0] as { binaryPath?: string } | undefined
    expect(spawnOptions?.binaryPath).toContain(join('node_modules', '@agent-relay', `broker-${process.platform}-${process.arch}`, 'bin'))
    expect(spawnOptions?.binaryPath).not.toContain(join('relay', 'target', 'debug'))

    await manager.shutdown()
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
    const binaryName = process.platform === 'win32' ? 'agentworkforce.cmd' : 'agentworkforce'

    expect(local.spawnPty).toHaveBeenCalledWith(expect.objectContaining({
      cli: join(personaTempDir, 'node_modules', '.bin', binaryName),
      args: ['agent', 'autonomous-actor']
    }))
    expect(local.spawnPty).not.toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['--install-in-repo'])
    }))
    // The workforce CLI only injects the agent-relay MCP into the inner
    // harness when the broker stamps RELAY_AGENT_NAME into the worker env,
    // and the broker suppresses that stamp when skipRelayPrompt is set.
    expect(local.spawnPty).not.toHaveBeenCalledWith(expect.objectContaining({
      skipRelayPrompt: true
    }))
    expect(result).toEqual({
      name: 'autonomous-actor',
      runtime: 'pty',
      cli: 'claude'
    })
    expect(() => structuredClone(result)).not.toThrow()

    await manager.shutdown()
  })

  it('uses Pear pinned Workforce 4.1.16 when the project has no local CLI', async () => {
    if (process.platform === 'win32') return
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-clean-persona-spawn-'))
    const packageCommand = resolvePackageBin('agentworkforce', 'agentworkforce')
    expect(packageCommand).toBeTruthy()
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(personaTempDir)
    const manager = new BrokerManager()

    try {
      mock.state.nextLocalAgents = []
      await manager.start(PROJECT_ID, personaTempDir, 'pear-project-1', undefined as never, [])
      const local = lastSpawned()
      local.spawnPty.mockImplementationOnce(async (input: { name: string }) => {
        local.agentNames.push(input.name)
        setImmediate(() => emitPersonaHarnessReady(local, input.name))
        return { name: input.name, runtime: 'pty', cli: 'agentworkforce' }
      })

      await manager.spawnPersona(PROJECT_ID, 'persona-maker')

      expect(local.spawnPty).toHaveBeenCalledWith(expect.objectContaining({
        cli: packageCommand,
        args: ['agent', 'persona-maker']
      }))
      expect(execFileSync(packageCommand!, ['--version'], { encoding: 'utf8' }).trim()).toBe('4.1.16')
    } finally {
      cwdSpy.mockRestore()
      await manager.shutdown()
    }
  })

  it('executes Pear packaged Workforce runtime with broker-first MCP precedence', () => {
    if (process.platform === 'win32') return
    const probe = execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `
        import { createRequire } from 'node:module';
        import { pathToFileURL } from 'node:url';
        const rootRequire = createRequire(import.meta.url);
        const cliPackagePath = rootRequire.resolve('@agentworkforce/cli/package.json');
        const cliRequire = createRequire(cliPackagePath);
        const runtime = await import(pathToFileURL(cliRequire.resolve('@agentworkforce/runtime')).href);
        const logs = [];
        await runtime.resolveAgentRelayBrokerMcpArgs({
          cli: 'codex',
          env: {
            BROKER_BINARY_PATH: '/usr/bin/true',
            AGENT_RELAY_BIN: '/usr/bin/false'
          },
          relayMcp: { agentName: 'pear-consumption-smoke', apiKey: 'redacted' },
          cwd: process.cwd(),
          existingArgs: [],
          log: (level, message, attrs) => logs.push({ level, message, attrs })
        });
        process.stdout.write(JSON.stringify({
          runtimeVersion: cliRequire('@agentworkforce/runtime/package.json').version,
          log: logs.at(-1)
        }));
      `
    ], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })
    const result = JSON.parse(probe) as {
      runtimeVersion: string
      log: { message: string; attrs?: { broker?: string } }
    }

    expect(result.log.message).toBe('harness.relay_mcp.broker_args_invalid_json')
    expect(result.log.attrs?.broker).toBe('/usr/bin/true')
    expect(result.runtimeVersion).toBe('4.1.16')
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

    await vi.waitFor(() => expect(local.spawnPty).toHaveBeenCalledTimes(1))
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
    await vi.waitFor(() => expect(local.spawnPty).toHaveBeenCalledTimes(1))

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
    await vi.waitFor(() => expect(local.spawnPty).toHaveBeenCalledTimes(1))

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

  it('retries the delivery readiness probe until the inner harness becomes injectable', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)
    // Generous overall budget, but a tight per-probe window + retry gap so the
    // first probe times out fast and a retry can land within the same test.
    process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS = '2000'
    process.env.PEAR_PERSONA_READY_PROBE_TIMEOUT_MS = '40'
    process.env.PEAR_PERSONA_READY_PROBE_RETRY_DELAY_MS = '10'

    const manager = new BrokerManager()
    try {
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
      // First probe: broker accepts the send but the inner harness never injects
      // (no delivery_injected event) — it isn't steerable yet. Subsequent probes
      // fall through to the default mock, which auto-emits delivery_injected.
      local.sendMessage.mockResolvedValueOnce({
        event_id: 'evt-readiness-not-yet-injected',
        targets: ['autonomous-actor']
      })

      await expect(manager.spawnPersona(PROJECT_ID, 'autonomous-actor')).resolves.toEqual({
        name: 'autonomous-actor',
        runtime: 'pty',
        cli: 'claude'
      })
      expect(local.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(local.release).not.toHaveBeenCalled()
    } finally {
      delete process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS
      delete process.env.PEAR_PERSONA_READY_PROBE_TIMEOUT_MS
      delete process.env.PEAR_PERSONA_READY_PROBE_RETRY_DELAY_MS
      await manager.shutdown()
    }
  })

  it('fails fast on an unsupported delivery readiness confirmation instead of retrying', async () => {
    personaTempDir = await mkdtemp(join(tmpdir(), 'pear-persona-spawn-'))
    await writeAgentWorkforceFixture(personaTempDir)
    // Large budget + tight retry gap: if an unsupported confirmation were
    // (wrongly) retried it would resend many probes before the deadline. A
    // fail-fast path sends exactly one.
    process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS = '5000'
    process.env.PEAR_PERSONA_READY_PROBE_RETRY_DELAY_MS = '5'

    const manager = new BrokerManager()
    try {
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
      // Broker resolves without an event_id -> unsupported_operation. This is
      // deterministic; waiting cannot fix it, so the spawn should fail at once.
      local.sendMessage.mockResolvedValueOnce({})

      await expect(manager.spawnPersona(PROJECT_ID, 'autonomous-actor')).rejects.toThrow(
        /did not become ready for broker delivery/
      )
      expect(local.sendMessage).toHaveBeenCalledTimes(1)
      expect(local.release).toHaveBeenCalledWith(
        'autonomous-actor',
        'persona harness readiness verification failed'
      )
    } finally {
      delete process.env.PEAR_PERSONA_HARNESS_READY_TIMEOUT_MS
      delete process.env.PEAR_PERSONA_READY_PROBE_RETRY_DELAY_MS
      await manager.shutdown()
    }
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

  it('treats terminal attach for a missing worker as a stale terminal', async () => {
    const previousTimeout = process.env.PEAR_ATTACH_REGISTRATION_TIMEOUT_MS
    process.env.PEAR_ATTACH_REGISTRATION_TIMEOUT_MS = '1'
    const manager = new BrokerManager()
    const local = await startLocal(manager, [])

    try {
      await expect(manager.attachTerminal(PROJECT_ID, {
        name: 'codex-1',
        mode: 'passthrough'
      })).resolves.toEqual({
        name: 'codex-1',
        mode: 'auto_inject',
        pending: 0
      })

      expect(local.getInboundDeliveryMode).not.toHaveBeenCalled()
      expect(local.setInboundDeliveryMode).not.toHaveBeenCalled()
      expect(local.snapshot).not.toHaveBeenCalled()
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.PEAR_ATTACH_REGISTRATION_TIMEOUT_MS
      } else {
        process.env.PEAR_ATTACH_REGISTRATION_TIMEOUT_MS = previousTimeout
      }
      await manager.shutdown()
    }
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

  it('delivers identical PTY chunks when broker events have no identity', async () => {
    // Identical consecutive chunks are NORMAL terminal traffic (the same
    // keystroke echoed twice, byte-identical TUI repaint frames). Without an
    // identity there is no way to tell a transport replay from real output,
    // and dropping real bytes mangles escape sequences — the stacked
    // "duplicate line" rendering corruption. Never drop on content alone.
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
    expect(ptyCalls).toEqual([
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'pong\n'],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'pong\n']
    ])

    await manager.shutdown()
  })

  it('logs the identity-less PTY stream blind spot once per stream while delivering', async () => {
    // AGENTS.md: low-noise telemetry for missing event identity. One line per
    // stream, not per chunk — an identity-less stream hits the branch on
    // every chunk and per-chunk logging would flood.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const manager = new BrokerManager()
      const win = createMockWindow()
      const local = await startLocalWithWindow(manager, win)
      const listener = local.onEvent.mock.calls.at(-1)?.[0]
      expect(listener).toBeTypeOf('function')

      listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'one\n' })
      listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'two\n' })
      listener?.({ kind: 'worker_stream', name: 'codex-1', chunk: 'three\n' })

      const blindSpotLogs = infoSpy.mock.calls.filter(([first]) =>
        typeof first === 'string' && first.includes('no seq/event_id')
      )
      expect(blindSpotLogs).toHaveLength(2) // once for claude-1, once for codex-1
      expect(blindSpotLogs[0][0]).toContain('claude-1')
      expect(blindSpotLogs[1][0]).toContain('codex-1')

      // Telemetry never suppresses delivery.
      const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
        .filter(([channel]) => channel === 'broker:pty-chunk')
      expect(ptyCalls).toHaveLength(3)

      await manager.shutdown()
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('delivers chunks whose seq repeats with different bytes (daemon seq reset)', async () => {
    // A daemon restart resets its event seq counter. The replacement stream
    // reuses seq numbers we have already seen — but the bytes are new output
    // and must render. Only an (identity AND content) match is a replay.
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'before restart\n', seq: 90 })
    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'after restart\n', seq: 90 })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'before restart\n'],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'after restart\n']
    ])

    await manager.shutdown()
  })

  it('delivers low-seq chunks after a watermark reset instead of dropping a window', async () => {
    // After the daemon restarts, fresh chunks arrive with seqs far below the
    // old watermark. They must all be delivered immediately — the previous
    // TTL-based dedup dropped them for up to 60s, losing repaint bytes.
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'old-high\n', seq: 5_000 })
    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'fresh-1\n', seq: 1 })
    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'fresh-2\n', seq: 2 })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'old-high\n'],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'fresh-1\n'],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'fresh-2\n']
    ])

    await manager.shutdown()
  })

  it('drops a delayed replay of an older seq with identical bytes', async () => {
    // Rebind replay re-delivers recent events: same seq, same bytes, possibly
    // long after first delivery. These are the one provable-duplicate case.
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'a\n', seq: 10 })
    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'b\n', seq: 11 })
    // Rebind replays the tail of the stream.
    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'a\n', seq: 10 })
    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'b\n', seq: 11 })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'a\n'],
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'b\n']
    ])

    await manager.shutdown()
  })

  it('tracks PTY dedup watermarks per agent stream', async () => {
    // Two agents share the session event-stream seq space; one agent's
    // watermark must not swallow the other's chunks.
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    listener?.({ kind: 'worker_stream', name: 'claude-1', chunk: 'one\n', seq: 100 })
    listener?.({ kind: 'worker_stream', name: 'codex-1', chunk: 'one\n', seq: 100 })
    listener?.({ kind: 'worker_stream', name: 'codex-1', chunk: 'two\n', seq: 101 })

    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([
      ['broker:pty-chunk', PROJECT_ID, 'claude-1', 'one\n'],
      ['broker:pty-chunk', PROJECT_ID, 'codex-1', 'one\n'],
      ['broker:pty-chunk', PROJECT_ID, 'codex-1', 'two\n']
    ])

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

function brokerEventSends(win: BrowserWindow): unknown[] {
  return (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
    .filter(([channel]) => channel === 'broker:event')
    .map(([, payload]) => payload)
}

describe('BrokerManager broker event ingress validation', () => {
  it('drops a malformed known event, logs once, and keeps the stream alive', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]
    expect(listener).toBeTypeOf('function')

    // relay_inbound is a known kind, but `body` is required by the schema.
    listener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      event_id: 'evt-malformed'
    })

    // The malformed event must not be forwarded to the renderer.
    expect(
      brokerEventSends(win).some(
        (payload) => (payload as { event_id?: string }).event_id === 'evt-malformed'
      )
    ).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      '[broker] Dropped malformed broker event:',
      expect.objectContaining({ kind: 'relay_inbound' })
    )

    // A subsequent valid event still flows — the stream is not torn down.
    listener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      body: 'still alive',
      event_id: 'evt-valid'
    })
    expect(win.webContents.send).toHaveBeenCalledWith(
      'broker:event',
      expect.objectContaining({ kind: 'relay_inbound', body: 'still alive' })
    )

    warnSpy.mockRestore()
    await manager.shutdown()
  })

  it('throttles repeated malformed warnings for the same kind', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]

    for (let i = 0; i < 3; i += 1) {
      listener?.({ kind: 'agent_idle', name: 'claude-1' }) // missing idle_secs
    }

    const idleWarnings = warnSpy.mock.calls.filter(
      ([message, detail]) =>
        message === '[broker] Dropped malformed broker event:' &&
        (detail as { kind?: string }).kind === 'agent_idle'
    )
    expect(idleWarnings).toHaveLength(1)

    warnSpy.mockRestore()
    await manager.shutdown()
  })

  it('forwards unknown event kinds unchanged and logs once per kind', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]

    listener?.({ kind: 'future_event_kind', name: 'claude-1', detail: 'one' })
    listener?.({ kind: 'future_event_kind', name: 'claude-1', detail: 'two' })

    // Both unknown events are forwarded (not dropped) — forward-compat.
    const forwarded = brokerEventSends(win).filter(
      (payload) => (payload as { kind?: string }).kind === 'future_event_kind'
    )
    expect(forwarded).toHaveLength(2)
    expect(forwarded[0]).toMatchObject({ detail: 'one' })

    // But the unknown-kind telemetry warning fires only once for the kind.
    const unknownWarnings = warnSpy.mock.calls.filter(
      ([message, detail]) =>
        message === '[broker] Forwarding unrecognized broker event kind (forward-compat):' &&
        (detail as { kind?: string }).kind === 'future_event_kind'
    )
    expect(unknownWarnings).toHaveLength(1)

    warnSpy.mockRestore()
    await manager.shutdown()
  })

  it('parses and forwards valid events of each major shape', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]

    listener?.({ kind: 'agent_spawned', name: 'claude-2', runtime: 'pty', cli: 'claude' })
    listener?.({
      kind: 'relay_inbound',
      from: 'codex-2',
      target: '#general',
      body: 'hello',
      event_id: 'evt-shape'
    })
    listener?.({ kind: 'agent_idle', name: 'claude-2', idle_secs: 5 })
    listener?.({ kind: 'delivery_queued', name: 'claude-2', delivery_id: 'd1', event_id: 'e1' })
    // worker_stream is delivered out-of-band on broker:pty-chunk, not broker:event.
    listener?.({ kind: 'worker_stream', name: 'claude-2', stream: 'stdout', chunk: 'tick\n' })

    const kinds = brokerEventSends(win).map((payload) => (payload as { kind?: string }).kind)
    expect(kinds).toEqual(
      expect.arrayContaining(['agent_spawned', 'relay_inbound', 'agent_idle', 'delivery_queued'])
    )
    const ptyCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'broker:pty-chunk')
    expect(ptyCalls).toEqual([['broker:pty-chunk', PROJECT_ID, 'claude-2', 'tick\n']])

    // None of the valid shapes should have warned.
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[broker] Dropped malformed broker event:',
      expect.anything()
    )

    warnSpy.mockRestore()
    await manager.shutdown()
  })

  it('forwards replay_gap events to the renderer and logs a distinct warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new BrokerManager()
    const win = createMockWindow()
    const local = await startLocalWithWindow(manager, win)
    const listener = local.onEvent.mock.calls.at(-1)?.[0]

    listener?.({ kind: 'replay_gap', requestedSinceSeq: 10, oldestAvailable: 42, seq: 100 })

    // Forwarded like any other event — the renderer's reconciliation
    // pipeline (agent-store.ts / use-message-reconciliation.ts) is what
    // actually reacts to it.
    expect(
      brokerEventSends(win).some((payload) => (payload as { kind?: string }).kind === 'replay_gap')
    ).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Replay gap on project')
    )

    warnSpy.mockRestore()
    await manager.shutdown()
  })
})

describe('classifyBrokerEvent', () => {
  it('classifies a valid known event and preserves passthrough fields', () => {
    const result = classifyBrokerEvent({
      kind: 'worker_stream',
      name: 'claude-1',
      stream: 'stdout',
      chunk: 'hi',
      // Extra fields the SDK may add / dedupe reads dynamically must survive.
      seq: 42,
      event_id: 'evt-1'
    })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.kind).toBe('worker_stream')
      expect(result.event).toMatchObject({ chunk: 'hi', seq: 42, event_id: 'evt-1' })
    }
  })

  it('flags a known event with a wrong field type as malformed', () => {
    const result = classifyBrokerEvent({ kind: 'worker_stream', name: 'claude-1', stream: 'stdout', chunk: 123 })
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.kind).toBe('worker_stream')
      expect(result.reason).toContain('chunk')
    }
  })

  it('accepts delivery events without delivery_id', () => {
    // The app's delivery logic keys on event_id + name only
    // (isDeliveryEventForMessage); requiring delivery_id would silently drop
    // confirmations from brokers that omit it and leave pending-delivery UI
    // state stuck.
    for (const kind of ['delivery_injected', 'delivery_verified', 'delivery_ack', 'delivery_active']) {
      const result = classifyBrokerEvent({ kind, name: 'claude-1', event_id: 'evt-9' })
      expect(result.status).toBe('valid')
    }
    expect(classifyBrokerEvent({
      kind: 'delivery_failed', name: 'claude-1', event_id: 'evt-9', reason: 'timeout'
    }).status).toBe('valid')
    expect(classifyBrokerEvent({
      kind: 'message_delivery_confirmed', name: 'claude-1', event_id: 'evt-9', from: 'a', to: 'b'
    }).status).toBe('valid')
  })

  it('accepts null for absent optional fields (broker serializes None as null)', () => {
    // Regression: the live broker emits `null` for unset optional fields, not
    // omitted keys. `.optional()` rejected null, so real agent_spawned /
    // worker_ready / relay_inbound events were dropped at ingress (observed in
    // production logs 2026-06-11). Payloads below are the exact dropped shapes.
    expect(classifyBrokerEvent({
      kind: 'agent_spawned',
      name: 'codex-1',
      runtime: 'pty',
      provider: null,
      model: null,
      pid: null
    }).status).toBe('valid')
    expect(classifyBrokerEvent({
      kind: 'worker_ready',
      name: 'codex-1',
      runtime: 'pty',
      provider: null,
      model: null
    }).status).toBe('valid')
    expect(classifyBrokerEvent({
      kind: 'relay_inbound',
      event_id: 'evt-null-1',
      from: 'will',
      target: 'codex-1',
      body: 'hello',
      thread_id: null
    }).status).toBe('valid')
    // Wrong non-null types must still be rejected.
    expect(classifyBrokerEvent({
      kind: 'agent_spawned', name: 'codex-1', runtime: 'pty', pid: 'not-a-number'
    }).status).toBe('malformed')
  })

  it('treats an unknown kind as forwardable, not malformed', () => {
    const result = classifyBrokerEvent({ kind: 'brand_new_kind', name: 'x' })
    expect(result.status).toBe('unknown')
    if (result.status === 'unknown') {
      expect(result.event).toMatchObject({ kind: 'brand_new_kind', name: 'x' })
    }
  })

  it('treats a payload with no usable kind as malformed', () => {
    expect(classifyBrokerEvent({ name: 'x' }).status).toBe('malformed')
    expect(classifyBrokerEvent(null).status).toBe('malformed')
    expect(classifyBrokerEvent({ kind: 42 }).status).toBe('malformed')
  })

  it('recognizes the broker event kinds the app consumes', () => {
    for (const kind of [
      'agent_spawned',
      'agent_exited',
      'relay_inbound',
      'worker_stream',
      'delivery_queued',
      'channel_subscribed',
      'agent_idle',
      'agent_blocked_on_send',
      'replay_gap'
    ]) {
      expect(KNOWN_BROKER_EVENT_KINDS.has(kind)).toBe(true)
    }
  })

  it('classifies a replay_gap event as valid and preserves its fields', () => {
    const result = classifyBrokerEvent({
      kind: 'replay_gap',
      requestedSinceSeq: 10,
      oldestAvailable: 42,
      seq: 100
    })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.event).toMatchObject({ requestedSinceSeq: 10, oldestAvailable: 42, seq: 100 })
    }
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

describe('isCommandAvailableWithAugmentedPath', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    process.env.PATH = originalPathEnv
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('resolves commands without mutating PATH', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-cli-path-'))
    const toolPath = join(tempDir, 'opencode')
    await writeFile(toolPath, '#!/bin/sh\nexit 0\n')
    await chmod(toolPath, 0o755)
    process.env.PATH = tempDir

    expect(isCommandAvailableWithAugmentedPath('opencode')).toBe(true)
    expect(process.env.PATH).toBe(tempDir)
  })

  it('returns false for blank commands', () => {
    expect(isCommandAvailableWithAugmentedPath('   ')).toBe(false)
  })
})
