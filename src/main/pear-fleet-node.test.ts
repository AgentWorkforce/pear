import { describe, expect, it, vi } from 'vitest'
import { invokeNodeHandler, nodeInfo, nodeManifest } from '@agent-relay/fleet'
import { createPearFleetNodeDefinition, PEAR_LOCAL_SPAWN_HARNESSES, reconnectDelayMs } from './pear-fleet-node'

const expectedCapabilities = Object.keys(PEAR_LOCAL_SPAWN_HARNESSES).map((cli) => `spawn:${cli}`)

describe('Pear local fleet node', () => {
  it('advertises local spawn capabilities and the project checkout', async () => {
    const definition = createPearFleetNodeDefinition({
      projectId: 'project-1',
      cwd: '/tmp/project-1',
      brokerName: 'pear-project-1'
    })

    const manifest = nodeManifest(definition)
    expect(manifest.name).toBe('pear-project-1-local-fleet')
    expect(manifest.capabilities.map((capability) => capability.name)).toEqual(expectedCapabilities)
    expect(manifest.capabilities).toEqual(expectedCapabilities.map((name) => expect.objectContaining({
      name,
      metadata: expect.objectContaining({
        pearLocalNode: true,
        clonePaths: { 'project-1': '/tmp/project-1' }
      })
    })))
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

describe('reconnectDelayMs', () => {
  it('caps transient reconnects (already registered) at the fast ceiling', () => {
    expect(reconnectDelayMs(1, true)).toBe(500)
    expect(reconnectDelayMs(2, true)).toBe(1_000)
    expect(reconnectDelayMs(4, true)).toBe(4_000)
    // 500 * 2**4 = 8000 -> clamped to the 5s ceiling
    expect(reconnectDelayMs(5, true)).toBe(5_000)
    expect(reconnectDelayMs(50, true)).toBe(5_000)
  })

  it('backs off much harder while the node has never registered', () => {
    // Grows past the registered ceiling so a wedged broker is not stormed.
    expect(reconnectDelayMs(5, false)).toBe(8_000)
    expect(reconnectDelayMs(6, false)).toBe(16_000)
    expect(reconnectDelayMs(8, false)).toBe(60_000)
    expect(reconnectDelayMs(50, false)).toBe(60_000)
  })

  it('never returns a negative or sub-base delay for the first attempt', () => {
    expect(reconnectDelayMs(0, false)).toBe(500)
    expect(reconnectDelayMs(1, false)).toBe(500)
  })
})
