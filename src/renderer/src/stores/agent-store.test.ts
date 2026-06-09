import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @/lib/ipc evaluates `window.pear` through project-store imports in the
// renderer. The store tests only need the type surface, so stub IPC.
vi.mock('@/lib/ipc', () => ({ pear: {} }))

import { getAgentKey, useAgentStore, type Agent } from './agent-store'
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
