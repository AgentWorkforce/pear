import { describe, expect, it } from 'vitest'

import { GhCliGithubMergeGate, evaluateGithubMergeGate, type GhRunner } from './merge-gate'

const input = {
  repo: 'AgentWorkforce/pear',
  number: 123,
  expectedHeadSha: 'abc123',
}

const live = (overrides: Record<string, unknown> = {}) => ({
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: 'abc123',
  statusCheckRollup: [
    { name: 'test', conclusion: 'SUCCESS' },
  ],
  ...overrides,
})

describe('GithubMergeGate', () => {
  it('returns READY only for MERGEABLE+CLEAN, matching head, and all checks SUCCESS', async () => {
    const gate = new GhCliGithubMergeGate(async () => ({ stdout: JSON.stringify(live()) }))

    await expect(gate.check(input)).resolves.toMatchObject({
      verdict: 'READY',
      ready: true,
    })
  })

  it('refuses stale mount-clean snapshots when live GitHub contradicts readiness', () => {
    const staleMountSnapshot = {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRefOid: 'abc123',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }
    void staleMountSnapshot

    expect(evaluateGithubMergeGate(input, live({
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'UNSTABLE',
      headRefOid: 'def456',
      statusCheckRollup: [{ conclusion: 'FAILURE' }],
    }))).toMatchObject({
      verdict: 'REFUSE',
      ready: false,
    })
  })

  it('fails closed when gh returns UNKNOWN, errors, or partial output', async () => {
    const unknown = new GhCliGithubMergeGate(async () => ({
      stdout: JSON.stringify(live({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })),
    }))
    await expect(unknown.check(input)).resolves.toMatchObject({
      verdict: 'REFUSE',
      ready: false,
    })

    const errorRunner: GhRunner = async () => {
      throw new Error('gh timed out')
    }
    await expect(new GhCliGithubMergeGate(errorRunner).check(input)).resolves.toMatchObject({
      verdict: 'REFUSE',
      ready: false,
    })

    const partial = new GhCliGithubMergeGate(async () => ({
      stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    }))
    await expect(partial.check(input)).resolves.toMatchObject({
      verdict: 'REFUSE',
      ready: false,
    })
  })

  it('refuses missing or non-success status checks', () => {
    expect(evaluateGithubMergeGate(input, live({ statusCheckRollup: [] }))).toMatchObject({
      verdict: 'REFUSE',
      ready: false,
    })
    expect(evaluateGithubMergeGate(input, live({ statusCheckRollup: [{ conclusion: 'FAILURE' }] }))).toMatchObject({
      verdict: 'REFUSE',
      ready: false,
    })
  })
})
