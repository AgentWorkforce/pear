import { describe, it, expect } from 'vitest'
import { RelayPlacementError, type RelayNode } from '@agent-relay/sdk'
import {
  buildPlacementMessage,
  placementRequesterName,
  toBrokerNodeSummary
} from './placement'

function placementError(code: RelayPlacementError['code'], ctx: { capability?: string; node?: string; repo?: string } = {}): RelayPlacementError {
  return new RelayPlacementError(code, `raw ${code}`, {
    capability: ctx.capability ?? 'spawn:claude',
    node: ctx.node,
    repo: ctx.repo,
    attempts: 1
  })
}

describe('buildPlacementMessage', () => {
  it('names the offending node and cli for capability_mismatch', () => {
    const message = buildPlacementMessage(placementError('capability_mismatch', { node: 'gpu-box-1' }))
    expect(message).toBe('Node "gpu-box-1" can\'t run claude.')
  })

  it('falls back to a generic capability message when no node is named', () => {
    const message = buildPlacementMessage(placementError('capability_mismatch'))
    expect(message).toBe('No node can run claude.')
  })

  it('reports queue saturation for placement_queue_full', () => {
    expect(buildPlacementMessage(placementError('placement_queue_full'))).toMatch(/try again/i)
  })

  it('reports no eligible node for placement_ttl_expired (never a hang)', () => {
    expect(buildPlacementMessage(placementError('placement_ttl_expired'))).toBe(
      'No node advertises claude right now.'
    )
  })

  it('names the repo for unmapped_repo', () => {
    expect(buildPlacementMessage(placementError('unmapped_repo', { repo: 'pear' }))).toBe(
      'No node has repo "pear" checked out.'
    )
  })

  it('strips the spawn: prefix from the capability in messages', () => {
    const message = buildPlacementMessage(placementError('placement_ttl_expired', { capability: 'spawn:codex' }))
    expect(message).toContain('codex')
    expect(message).not.toContain('spawn:')
  })
})

describe('placementRequesterName', () => {
  it('derives a sanitized, workspace-safe requester identity per project', () => {
    expect(placementRequesterName('project-1')).toBe('pear-requester-project-1')
  })

  it('replaces path/space characters that a workspace name cannot carry', () => {
    expect(placementRequesterName('a/b c:d')).toBe('pear-requester-a-b-c-d')
  })

  it('never returns an empty name', () => {
    expect(placementRequesterName('')).toBe('pear-requester')
  })
})

describe('toBrokerNodeSummary', () => {
  const baseNode: RelayNode = {
    name: 'other-node',
    status: 'online',
    live: true,
    load: 2,
    activeAgents: 1,
    maxAgents: 4,
    capabilities: [{ name: 'spawn:claude' }, { name: 'spawn:codex' }],
    repoKeys: ['pear'],
    tags: ['pear', 'local']
  } as RelayNode

  it('flattens capabilities and preserves liveness/load for the picker', () => {
    const summary = toBrokerNodeSummary(baseNode, 'my-self-node')
    expect(summary.capabilities).toEqual(['spawn:claude', 'spawn:codex'])
    expect(summary.live).toBe(true)
    expect(summary.load).toBe(2)
    expect(summary.activeAgents).toBe(1)
    expect(summary.isSelf).toBe(false)
  })

  it('flags this machine when the node name matches the local fleet node', () => {
    const summary = toBrokerNodeSummary({ ...baseNode, name: 'my-self-node' }, 'my-self-node')
    expect(summary.isSelf).toBe(true)
  })

  it('treats an absent live flag as offline', () => {
    const summary = toBrokerNodeSummary({ ...baseNode, live: undefined }, 'my-self-node')
    expect(summary.live).toBe(false)
  })
})
