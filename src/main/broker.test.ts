import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  brokerPid?: number
  agentNames: string[]
}

const mock = vi.hoisted(() => {
  function createMockClient(agentNames: string[] = []): MockClient {
    const client: MockClient = {
      agentNames: [...agentNames],
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
      onEvent: vi.fn(() => () => undefined),
      addListener: vi.fn(() => () => undefined),
      connectEvents: vi.fn(),
      disconnectEvents: vi.fn(),
      renewLease: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      release: vi.fn(async () => undefined),
      subscribeChannels: vi.fn(async () => undefined),
      unsubscribeChannels: vi.fn(async () => undefined),
      brokerPid: 4242
    }
    return client
  }

  const state = {
    spawnedClients: [] as MockClient[],
    constructedClients: [] as MockClient[],
    nextLocalAgents: [] as string[],
    nextCloudAgents: [] as string[]
  }

  class HarnessDriverClient {
    static spawn = vi.fn(async () => {
      const client = createMockClient(state.nextLocalAgents.splice(0))
      state.spawnedClients.push(client)
      return client
    })

    static connect = vi.fn(() => {
      throw new Error('not used in tests')
    })

    constructor() {
      const client = createMockClient(state.nextCloudAgents.splice(0))
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

import { BrokerManager, resolveAgentRelayMcpCommand } from './broker'

const PROJECT_ID = 'project-1'
const originalMcpCommand = process.env.AGENT_RELAY_MCP_COMMAND
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

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

describe('resolveAgentRelayMcpCommand', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    electronMock.app.isPackaged = false
    if (originalMcpCommand === undefined) {
      delete process.env.AGENT_RELAY_MCP_COMMAND
    } else {
      process.env.AGENT_RELAY_MCP_COMMAND = originalMcpCommand
    }
    restoreProcessResourcesPath()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
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

  it('fails packaged MCP resolution when the external launcher is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-mcp-resources-'))
    electronMock.app.isPackaged = true
    delete process.env.AGENT_RELAY_MCP_COMMAND
    setProcessResourcesPath(tempDir)

    expect(() => resolveAgentRelayMcpCommand()).toThrow(/launcher is missing or not executable/)
  })
})

describe('BrokerManager local + cloud coexistence', () => {
  beforeEach(() => {
    mock.state.spawnedClients.length = 0
    mock.state.constructedClients.length = 0
    mock.state.nextLocalAgents = []
    mock.state.nextCloudAgents = []
    mock.HarnessDriverClient.spawn.mockClear()
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
