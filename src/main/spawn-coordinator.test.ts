import { describe, expect, it } from 'vitest'
import type { SpawnPtyInput } from '@agent-relay/harness-driver'
import {
  SpawnCoordinator,
  spawnRequestKey,
  personaSpawnRequestKey,
  normalizeSpawnPtyResult,
  getAvailableAgentName,
  isAgentNameConflict
} from './spawn-coordinator'

const baseInput = (overrides: Partial<SpawnPtyInput & { broker?: 'local' | 'cloud' }> = {}) =>
  ({ name: 'alice', cli: 'claude', ...overrides }) as SpawnPtyInput & { broker?: 'local' | 'cloud' }

describe('spawnRequestKey', () => {
  it('is stable across equivalent inputs (missing optionals normalize identically)', () => {
    const a = spawnRequestKey('proj', baseInput(), {})
    const b = spawnRequestKey('proj', baseInput({ args: [], task: '', model: '' }), {
      parentAgentName: ''
    })
    expect(a).toBe(b)
  })

  it('defaults an unspecified broker to "auto"', () => {
    const key = spawnRequestKey('proj', baseInput(), {})
    expect(JSON.parse(key).broker).toBe('auto')
  })

  it('distinguishes spawns by every keyed field', () => {
    const ref = spawnRequestKey('proj', baseInput(), {})
    expect(spawnRequestKey('other', baseInput(), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput({ broker: 'cloud' }), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput({ name: 'bob' }), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput({ cli: 'codex' }), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput({ cwd: '/tmp' }), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput({ args: ['-l'] }), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput({ task: 'do it' }), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput({ model: 'opus' }), {})).not.toBe(ref)
    expect(spawnRequestKey('proj', baseInput(), { parentAgentName: 'lead' })).not.toBe(ref)
  })
})

describe('personaSpawnRequestKey', () => {
  it('is keyed only by project + persona id', () => {
    expect(personaSpawnRequestKey('proj', 'reviewer')).toBe(
      JSON.stringify({ projectId: 'proj', personaId: 'reviewer' })
    )
    expect(personaSpawnRequestKey('proj', 'reviewer')).not.toBe(
      personaSpawnRequestKey('proj', 'writer')
    )
    expect(personaSpawnRequestKey('proj', 'reviewer')).not.toBe(
      personaSpawnRequestKey('other', 'reviewer')
    )
  })
})

describe('SpawnCoordinator.coalesceSpawn', () => {
  it('coalesces identical concurrent spawns onto one promise', async () => {
    const coordinator = new SpawnCoordinator()
    let calls = 0
    let resolve!: (v: { name: string; runtime: string }) => void
    const factory = () => {
      calls += 1
      return new Promise<{ name: string; runtime: string }>((r) => {
        resolve = r
      })
    }

    const first = coordinator.coalesceSpawn('k', factory)
    const second = coordinator.coalesceSpawn('k', factory)
    expect(first).toBe(second)
    expect(calls).toBe(1)

    resolve({ name: 'alice', runtime: 'pty' })
    await expect(first).resolves.toEqual({ name: 'alice', runtime: 'pty' })
  })

  it('clears the gate after settle so a later spawn re-runs the factory', async () => {
    const coordinator = new SpawnCoordinator()
    let calls = 0
    const factory = () => {
      calls += 1
      return Promise.resolve({ name: 'alice', runtime: 'pty' })
    }

    await coordinator.coalesceSpawn('k', factory)
    await coordinator.coalesceSpawn('k', factory)
    expect(calls).toBe(2)
  })

  it('clears the gate even when the spawn rejects', async () => {
    const coordinator = new SpawnCoordinator()
    let calls = 0
    const factory = () => {
      calls += 1
      return Promise.reject(new Error('boom'))
    }

    await expect(coordinator.coalesceSpawn('k', factory)).rejects.toThrow('boom')
    await expect(coordinator.coalesceSpawn('k', factory)).rejects.toThrow('boom')
    expect(calls).toBe(2)
  })

  it('keeps distinct keys independent', async () => {
    const coordinator = new SpawnCoordinator()
    const a = coordinator.coalesceSpawn('a', () => Promise.resolve({ name: 'a', runtime: 'pty' }))
    const b = coordinator.coalesceSpawn('b', () => Promise.resolve({ name: 'b', runtime: 'pty' }))
    expect(a).not.toBe(b)
    expect(await a).toEqual({ name: 'a', runtime: 'pty' })
    expect(await b).toEqual({ name: 'b', runtime: 'pty' })
  })
})

describe('SpawnCoordinator.coalescePersonaSpawn', () => {
  it('coalesces identical persona spawns and preserves the result', async () => {
    const coordinator = new SpawnCoordinator()
    let calls = 0
    let resolve!: (v: { name: string; runtime: string; cli?: string }) => void
    const factory = () => {
      calls += 1
      return new Promise<{ name: string; runtime: string; cli?: string }>((r) => {
        resolve = r
      })
    }

    const first = coordinator.coalescePersonaSpawn('p', factory)
    const second = coordinator.coalescePersonaSpawn('p', factory)
    expect(first).toBe(second)
    expect(calls).toBe(1)

    resolve({ name: 'reviewer', runtime: 'pty', cli: 'claude' })
    await expect(first).resolves.toEqual({ name: 'reviewer', runtime: 'pty', cli: 'claude' })
  })
})

describe('normalizeSpawnPtyResult', () => {
  it('falls back to the requested name/runtime when the result is malformed', () => {
    expect(normalizeSpawnPtyResult(null, 'alice')).toEqual({ name: 'alice', runtime: 'pty' })
    expect(normalizeSpawnPtyResult({ name: '  ' }, 'alice')).toEqual({ name: 'alice', runtime: 'pty' })
  })

  it('prefers the explicit cli over the echoed one, trimming both', () => {
    expect(normalizeSpawnPtyResult({ name: 'bob', runtime: 'docker', cli: 'codex' }, 'alice', ' claude ')).toEqual({
      name: 'bob',
      runtime: 'docker',
      cli: 'claude'
    })
    expect(normalizeSpawnPtyResult({ name: 'bob', cli: ' codex ' }, 'alice')).toEqual({
      name: 'bob',
      runtime: 'pty',
      cli: 'codex'
    })
  })
})

describe('getAvailableAgentName', () => {
  it('returns the requested name when free', () => {
    expect(getAvailableAgentName('alice', new Set())).toBe('alice')
  })

  it('appends the next numeric suffix on collision', () => {
    expect(getAvailableAgentName('alice', new Set(['alice']))).toBe('alice-2')
    expect(getAvailableAgentName('alice', new Set(['alice', 'alice-2']))).toBe('alice-3')
  })

  it('continues an existing numeric suffix instead of nesting', () => {
    expect(getAvailableAgentName('alice-2', new Set(['alice-2']))).toBe('alice-3')
  })
})

describe('isAgentNameConflict', () => {
  it('matches broker name-collision errors', () => {
    expect(isAgentNameConflict(new Error('agent "alice" already exists'))).toBe(true)
    expect(isAgentNameConflict('name already exists on relay')).toBe(true)
  })

  it('is false for unrelated errors', () => {
    expect(isAgentNameConflict(new Error('connection refused'))).toBe(false)
  })
})

describe('SpawnCoordinator persona readiness', () => {
  it('tracks pending readiness per session key + name', () => {
    const coordinator = new SpawnCoordinator()
    expect(coordinator.isPersonaReadinessPending('sess', 'alice')).toBe(false)

    coordinator.markPersonaReadinessPending('sess', 'alice')
    expect(coordinator.isPersonaReadinessPending('sess', 'alice')).toBe(true)
    // Same name on a different session is independent.
    expect(coordinator.isPersonaReadinessPending('other', 'alice')).toBe(false)

    coordinator.clearPersonaReadinessPending('sess', 'alice')
    expect(coordinator.isPersonaReadinessPending('sess', 'alice')).toBe(false)
  })
})
