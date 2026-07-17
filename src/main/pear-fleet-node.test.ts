import { describe, expect, it, vi } from 'vitest'
import { invokeNodeHandler, nodeInfo } from '@agent-relay/fleet'
import {
  createPearFleetNodeDefinition,
  PEAR_LOCAL_SPAWN_HARNESSES,
  resolvePearFleetConnection,
  startPearFleetSidecar
} from './pear-fleet-node'

const expectedCapabilities = Object.keys(PEAR_LOCAL_SPAWN_HARNESSES).map((cli) => `spawn:${cli}`)

describe('Pear local fleet node', () => {
  it('advertises local spawn capabilities and the project checkout', async () => {
    const definition = createPearFleetNodeDefinition({
      projectId: 'project-1',
      cwd: '/tmp/project-1',
      brokerName: 'pear-project-1'
    })

    const info = nodeInfo(definition)
    expect(info.name).toBe('pear-project-1-local-fleet')
    expect(info.capabilities).toEqual(expectedCapabilities)
    expect(expectedCapabilities.map((name) => definition.capabilities[name])).toEqual(
      expectedCapabilities.map(() =>
        expect.objectContaining({
          metadata: expect.objectContaining({
            pearLocalNode: true,
            clonePaths: { 'project-1': '/tmp/project-1' }
          })
        })
      )
    )
  })

  it('spawns non-Claude/Codex harnesses through the broker', async () => {
    const definition = createPearFleetNodeDefinition({
      projectId: 'project-1',
      cwd: '/tmp/project-1',
      brokerName: 'pear-project-1'
    })
    const spawnAgent = vi.fn(async () => ({ name: 'goose-1', runtime: 'pty' }))

    await invokeNodeHandler(definition, 'spawn:goose', {
      name: 'goose-1',
      cwd: '/tmp/project-1',
      args: ['--debug'],
      channels: ['general']
    }, {
      node: nodeInfo(definition),
      relay: {
        sendMessage: vi.fn(async () => undefined)
      },
      invocationId: 'invoke-2',
      spawnAgent
    })

    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({
        name: 'goose-1',
        cli: 'goose',
        args: ['--debug'],
        channels: ['general'],
        cwd: '/tmp/project-1'
      }),
      invocationId: 'invoke-2'
    }))
  })

  it('spawns through the broker for the advertised checkout path', async () => {
    const definition = createPearFleetNodeDefinition({
      projectId: 'project-1',
      cwd: '/tmp/project-1',
      brokerName: 'pear-project-1'
    })
    const spawnAgent = vi.fn(async () => ({ name: 'worker-1', runtime: 'pty' }))

    await invokeNodeHandler(definition, 'spawn:claude', {
      name: 'worker-1',
      cwd: '/tmp/project-1',
      task: 'check relay registration'
    }, {
      node: nodeInfo(definition),
      relay: {
        sendMessage: vi.fn(async () => undefined)
      },
      invocationId: 'invoke-1',
      spawnAgent
    })

    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({
        name: 'worker-1',
        cli: 'claude',
        cwd: '/tmp/project-1'
      }),
      initialTask: 'check relay registration',
      invocationId: 'invoke-1'
    }))
  })

  it('rejects unadvertised checkout paths', async () => {
    const definition = createPearFleetNodeDefinition({
      projectId: 'project-1',
      cwd: '/tmp/project-1',
      brokerName: 'pear-project-1'
    })

    await expect(invokeNodeHandler(definition, 'spawn:claude', {
      name: 'worker-1',
      cwd: '/tmp/other-project'
    }, {
      node: nodeInfo(definition),
      relay: {
        sendMessage: vi.fn(async () => undefined)
      },
      spawnAgent: vi.fn(async () => undefined)
    })).rejects.toThrow('checkout path is not advertised by this node')
  })
})

describe('resolvePearFleetConnection', () => {
  it('waits for the broker-minted node token and attaches to the same v10 node', async () => {
    let now = 0
    let reads = 0
    const connection = await resolvePearFleetConnection(async () => {
      reads += 1
      if (reads === 1) {
        return { node_id: 'node-1', node_name: 'pear-project-1' }
      }
      return {
        node_id: 'node-1',
        node_name: 'pear-project-1',
        node_token: 'nt_live_test',
        relay_base_url: 'https://cast.example'
      }
    }, new AbortController().signal, {
      timeoutMs: 1_000,
      pollIntervalMs: 250,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      }
    })

    expect(reads).toBe(2)
    expect(connection).toEqual({
      connection: {
        nodeId: 'node-1',
        nodeToken: 'nt_live_test',
        baseUrl: 'https://cast.example'
      },
      nodeName: 'pear-project-1'
    })
  })

  it('fails clearly instead of silently disabling the provider when the token never arrives', async () => {
    let now = 0
    await expect(resolvePearFleetConnection(
      async () => ({ node_id: 'node-1', node_name: 'pear-project-1' }),
      new AbortController().signal,
      {
        timeoutMs: 500,
        pollIntervalMs: 250,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        }
      }
    )).rejects.toThrow('timed out waiting for a node token for node-1')
  })

  it('bounds a broker session read that never settles', async () => {
    let now = 0
    await expect(resolvePearFleetConnection(
      () => new Promise(() => {}),
      new AbortController().signal,
      {
        timeoutMs: 500,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        }
      }
    )).rejects.toThrow('timed out waiting for the broker node id')
    expect(now).toBe(500)
  })

  it('stops promptly while a broker session read is hung', async () => {
    const sidecar = startPearFleetSidecar({
      projectId: 'project-1',
      cwd: '/tmp/project-1',
      brokerName: 'pear-project-1',
      readBrokerSession: () => new Promise(() => {})
    })
    const registered = sidecar.registered.catch((error: unknown) => error)

    await sidecar.stop()

    await expect(registered).resolves.toMatchObject({ name: 'AbortError' })
  })
})
