import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @/lib/ipc evaluates `window.pear` through project-store imports in the
// renderer. The store tests only need the type surface, so stub IPC.
vi.mock('@/lib/ipc', () => ({ pear: {} }))

import { getBrokerErrorKey } from '@shared/lib/broker-errors'
import {
  MAX_BROKER_ERRORS,
  getAgentKey,
  prependBrokerError,
  useAgentStore,
  type Agent,
  type BrokerErrorEntry
} from './agent-store'
import type { BrokerListAgent } from '@shared/types/ipc'

function agent(projectId: string, name: string, cli = 'codex'): Agent {
  return {
    name,
    cli,
    status: 'running',
    activity: 'idle',
    currentState: 'idle',
    projectId,
    terminalMode: 'passthrough',
    pendingDeliveryIds: []
  }
}

function liveAgent(projectId: string, name: string, cli = 'claude'): BrokerListAgent {
  return {
    projectId,
    name,
    cli,
    current_state: 'idle'
  }
}

function brokerError(id: string, message: string, projectId?: string): BrokerErrorEntry {
  return {
    id,
    message,
    projectId,
    timestamp: Number(id.replace(/\D/g, '')) || 1
  }
}

describe('agent-store broker error history', () => {
  it('uses a global broker error key when projectId is missing', () => {
    expect(getBrokerErrorKey({ message: 'offline' })).toBe('global\0offline')
    expect(getBrokerErrorKey({ message: 'offline', projectId: '' })).toBe('global\0offline')
  })

  it('moves duplicate broker errors to the front instead of duplicating them', () => {
    const oldEntry = brokerError('id-1', 'broker stopped', 'project-1')
    const otherEntry = brokerError('id-2', 'network unavailable', 'project-1')
    const freshEntry = brokerError('id-3', 'broker stopped', 'project-1')

    expect(prependBrokerError([oldEntry, otherEntry], freshEntry)).toEqual([
      freshEntry,
      otherEntry
    ])
  })

  it('caps broker error history to the newest entries', () => {
    let entries: BrokerErrorEntry[] = []
    for (let index = 0; index < MAX_BROKER_ERRORS + 3; index += 1) {
      entries = prependBrokerError(entries, brokerError(`id-${index}`, `error-${index}`, 'project-1'))
    }

    expect(entries).toHaveLength(MAX_BROKER_ERRORS)
    expect(entries[0]?.id).toBe(`id-${MAX_BROKER_ERRORS + 2}`)
    expect(entries.some((entry) => entry.id === 'id-0')).toBe(false)
  })

  it('keeps the same broker error message distinct across projects', () => {
    const entries = prependBrokerError(
      [brokerError('id-1', 'broker stopped', 'project-1')],
      brokerError('id-2', 'broker stopped', 'project-2')
    )

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.projectId)).toEqual(['project-2', 'project-1'])
  })
})

describe('agent-store broker snapshots', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0
    })
    useAgentStore.getState().clearAll()
  })

  afterEach(() => {
    useAgentStore.getState().clearAll()
    vi.unstubAllGlobals()
  })

  it('clears the active agent when a project snapshot proves it is stale', () => {
    const stale = agent('project-1', 'codex-1')
    useAgentStore.setState({
      agents: [stale],
      activeAgentKey: getAgentKey(stale.projectId, stale.name)
    })

    useAgentStore.getState().syncBrokerAgents([], 'project-1')

    const state = useAgentStore.getState()
    expect(state.agents).toEqual([expect.objectContaining({
      name: 'codex-1',
      status: 'exited',
      currentState: 'idle'
    })])
    expect(state.activeAgentKey).toBeNull()
  })

  it('moves active selection to a running replacement, not the stale agent', () => {
    const stale = agent('project-1', 'codex-1')
    useAgentStore.setState({
      agents: [stale],
      activeAgentKey: getAgentKey(stale.projectId, stale.name)
    })

    useAgentStore.getState().syncBrokerAgents([
      liveAgent('project-1', 'claude-1')
    ], 'project-1')

    const state = useAgentStore.getState()
    expect(state.agents.find((entry) => entry.name === 'codex-1')?.status).toBe('exited')
    expect(state.agents.find((entry) => entry.name === 'claude-1')?.status).toBe('running')
    expect(state.activeAgentKey).toBe(getAgentKey('project-1', 'claude-1'))
  })
})

describe('agent-store replay gap handling', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0
    })
    useAgentStore.getState().clearAll()
  })

  afterEach(() => {
    useAgentStore.getState().clearAll()
    vi.unstubAllGlobals()
  })

  it('bumps lastReplayGapAt on a replay_gap broker event', () => {
    expect(useAgentStore.getState().lastReplayGapAt).toBe(0)

    useAgentStore.getState().handleBrokerEvent({
      kind: 'replay_gap',
      requestedSinceSeq: 10,
      oldestAvailable: 42,
      seq: 100,
      projectId: 'project-1'
    })

    expect(useAgentStore.getState().lastReplayGapAt).toBeGreaterThan(0)
  })

  it('leaves agents and messages untouched for a replay_gap event', () => {
    const before = useAgentStore.getState()

    useAgentStore.getState().handleBrokerEvent({
      kind: 'replay_gap',
      requestedSinceSeq: 1,
      oldestAvailable: 2,
      seq: 3
    })

    const after = useAgentStore.getState()
    expect(after.agents).toBe(before.agents)
    expect(after.messages).toBe(before.messages)
  })
})
