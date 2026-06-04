import { beforeEach, describe, expect, it, vi } from 'vitest'

// Covers the multi-session BrokerManager: a project's local broker and cloud
// sandbox broker coexist instead of clobbering each other in the sessions map.

type MockClient = {
  getSession: ReturnType<typeof vi.fn>
  listAgents: ReturnType<typeof vi.fn>
  getInboundDeliveryMode: ReturnType<typeof vi.fn>
  spawnPty: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  addListener: ReturnType<typeof vi.fn>
  connectEvents: ReturnType<typeof vi.fn>
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
      onEvent: vi.fn(() => () => undefined),
      addListener: vi.fn(() => () => undefined),
      connectEvents: vi.fn(),
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

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/pear-app',
    isPackaged: false,
    getPath: () => '/tmp/pear-user-data'
  },
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

import { BrokerManager } from './broker'

const PROJECT_ID = 'project-1'

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

async function attachCloud(manager: BrokerManager, agents: string[] = []): Promise<MockClient> {
  mock.state.nextCloudAgents = agents
  await manager.attachCloudSandbox(PROJECT_ID, {
    sandboxId: 'sandbox-1',
    execUrl: 'https://sandbox.example'
  } as never)
  return lastConstructed()
}

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
})
