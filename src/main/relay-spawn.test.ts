import { describe, expect, it, vi } from 'vitest'
import {
  RelaySpawner,
  nodeHasLiveAgent,
  nodeNamesById,
  parseSpawnNodes,
  spawnFailureMessage,
  spawnInputProblem,
  type SpawnRequest
} from './relay-spawn'
import type { ChatSpawnInput } from '../shared/types/ipc'

function node(name: string, capabilities: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, status: 'online', live: true, handlers_live: true, tags: [], capabilities: capabilities.map((c) => ({ name: c })), ...extra }
}

const NODES = [
  node('studio', ['spawn:codex', 'spawn:claude', 'relay:live-agents:v1']),
  node('Studio.local', ['spawn:claude']),
  node('offline-box', ['spawn:claude'], { status: 'offline' }),
  node('direct-node', ['spawn:claude'], { tags: ['direct'] }),
  node('no-handlers', ['spawn:claude'], { handlers_live: false }),
  node('chat-only', ['relay:live-agents:v1']),
  node('alpha', ['spawn:opencode'])
]

const INPUT: ChatSpawnInput = { node: 'studio', harness: 'claude', name: 'docs-fixer', task: 'Fix the docs' }

describe('parseSpawnNodes', () => {
  it('keeps online machines that advertise spawn capabilities, one per machine, sorted', () => {
    expect(parseSpawnNodes(NODES)).toEqual([
      { name: 'alpha', harnesses: ['opencode'] },
      { name: 'studio', harnesses: ['claude', 'codex'] }
    ])
  })

  it('accepts a wrapped list and ignores junk', () => {
    expect(parseSpawnNodes({ nodes: [node('a', ['spawn:claude']), null, 'x'] })).toEqual([{ name: 'a', harnesses: ['claude'] }])
    expect(parseSpawnNodes(null)).toEqual([])
  })
})

describe('nodeNamesById', () => {
  it('maps node ids to names, for any node status', () => {
    expect([...nodeNamesById([{ id: 'n1', name: 'studio', status: 'offline' }, { node_id: 'n2', name: 'box' }, { id: 'n3' }])])
      .toEqual([['n1', 'studio'], ['n2', 'box']])
  })
})

describe('nodeHasLiveAgent', () => {
  it('reads the node live-agent capability', () => {
    const raw = [{ ...node('studio', []), capabilities: [{ name: 'relay:live-agents:v1', metadata: { names: ['docs-fixer'] } }] }]
    expect(nodeHasLiveAgent(raw, 'studio', 'docs-fixer')).toBe(true)
    expect(nodeHasLiveAgent(raw, 'studio', 'other')).toBe(false)
    expect(nodeHasLiveAgent(raw, 'elsewhere', 'docs-fixer')).toBe(false)
  })
})

describe('spawnInputProblem', () => {
  const studio = { name: 'studio', harnesses: ['claude'] }
  it('accepts a valid form', () => {
    expect(spawnInputProblem(INPUT, studio)).toBeNull()
    expect(spawnInputProblem({ ...INPUT, workingDirectory: '/Users/me/app' }, studio)).toBeNull()
  })
  it('rejects bad names, missing tasks, unknown harnesses, and relative folders', () => {
    expect(spawnInputProblem(INPUT, undefined)).toMatch(/no longer available/)
    expect(spawnInputProblem({ ...INPUT, harness: 'codex' }, studio)).toMatch(/can't start codex/)
    expect(spawnInputProblem({ ...INPUT, name: 'Docs' }, studio)).toMatch(/lowercase/)
    expect(spawnInputProblem({ ...INPUT, task: ' ' }, studio)).toMatch(/Describe/)
    expect(spawnInputProblem({ ...INPUT, workingDirectory: '~/app' }, studio)).toMatch(/not expanded/)
    expect(spawnInputProblem({ ...INPUT, workingDirectory: 'app' }, studio)).toMatch(/starting with \//)
  })
})

describe('spawnFailureMessage', () => {
  it('explains common failures and keeps the raw detail', () => {
    expect(spawnFailureMessage('name_in_use', 'studio', 'docs-fixer', 'claude')).toBe(
      'The name docs-fixer is already in use, possibly by an earlier start still being cleaned up. Choose another name.\nDetails: name_in_use'
    )
    expect(spawnFailureMessage('ENOENT: /nope', 'studio', 'x', 'claude')).toMatch(/^That folder does not exist on studio/)
    expect(spawnFailureMessage('', 'studio', 'x', 'claude')).toBe('studio did not start x.')
  })
})

function harness(receipts: unknown[], options: { liveAfter?: number } = {}) {
  let nodeCalls = 0
  const calls: Array<{ path: string; method?: string; body?: unknown }> = []
  const request = vi.fn(async (path: string, opts: { method?: string; body?: unknown }) => {
    calls.push({ path, ...opts })
    if (path === '/nodes') {
      nodeCalls += 1
      const live = options.liveAfter !== undefined && nodeCalls > options.liveAfter
      return [{ ...node('studio', ['spawn:claude']), capabilities: [
        { name: 'spawn:claude' },
        { name: 'relay:live-agents:v1', metadata: { names: live ? ['docs-fixer'] : [] } }
      ] }]
    }
    if (path.endsWith('/actions/spawn/invoke')) return { invocation_id: 'inv-1' }
    const next = receipts.shift()
    if (next instanceof Error) throw next
    return next ?? { status: 'pending' }
  }) as unknown as SpawnRequest & ReturnType<typeof vi.fn>
  const spawner = new RelaySpawner(request, async () => undefined, 12, 0)
  return { spawner, calls }
}

describe('RelaySpawner', () => {
  it('invokes spawn on the node and returns ready on a completed receipt', async () => {
    const { spawner, calls } = harness([{ status: 'pending' }, { status: 'completed', output: { spawned: true, ready: true } }])
    await expect(spawner.spawn({ ...INPUT, workingDirectory: '/Users/me/app' })).resolves.toEqual({ outcome: 'ready', name: 'docs-fixer', node: 'studio' })
    const invoke = calls.find((call) => call.path === '/nodes/studio/actions/spawn/invoke')
    expect(invoke?.method).toBe('POST')
    expect(invoke?.body).toEqual({ input: {
      capability: 'spawn:claude', cli: 'claude', node: 'studio', target_node: 'studio',
      name: 'docs-fixer', task: 'Fix the docs', verify_ready: true, worker_cwd: '/Users/me/app'
    } })
  })

  it('shares one attempt between duplicate requests for the same agent', async () => {
    const { spawner, calls } = harness([{ status: 'completed', output: { spawned: true } }])
    const [a, b] = await Promise.all([spawner.spawn(INPUT), spawner.spawn({ ...INPUT })])
    expect(a).toEqual(b)
    expect(calls.filter((call) => call.path.endsWith('/actions/spawn/invoke'))).toHaveLength(1)
  })

  it('turns a failed receipt into a readable error', async () => {
    const { spawner } = harness([{ status: 'failed', error: 'spawn_readiness_timeout' }])
    await expect(spawner.spawn(INPUT)).rejects.toThrow(/did not become ready on studio/)
  })

  it('rejects a completed receipt that did not spawn', async () => {
    const { spawner } = harness([{ status: 'completed', output: { spawned: false, error: 'preflight failed' } }])
    await expect(spawner.spawn(INPUT)).rejects.toThrow(/could not set up Agent Relay tools/)
  })

  it('keeps waiting through a dropped poll', async () => {
    const { spawner } = harness([new Error('network'), { status: 'completed', output: { spawned: true } }])
    await expect(spawner.spawn(INPUT)).resolves.toMatchObject({ outcome: 'ready' })
  })

  it('counts the node listing the agent as running when no receipt completes', async () => {
    const { spawner } = harness([], { liveAfter: 1 })
    await expect(spawner.spawn(INPUT)).resolves.toMatchObject({ outcome: 'running' })
  })

  it('reports unconfirmed, without sending again, when nothing confirms the start', async () => {
    const { spawner, calls } = harness([])
    await expect(spawner.spawn(INPUT)).resolves.toMatchObject({ outcome: 'unconfirmed' })
    expect(calls.filter((call) => call.path.endsWith('/actions/spawn/invoke'))).toHaveLength(1)
  })

  it('validates against the live machine list before sending', async () => {
    const { spawner, calls } = harness([])
    await expect(spawner.spawn({ ...INPUT, harness: 'codex' })).rejects.toThrow(/can't start codex/)
    expect(calls.some((call) => call.path.endsWith('/actions/spawn/invoke'))).toBe(false)
  })
})
