import { describe, expect, it } from 'vitest'

import { FactoryConfigSchema, createFactory, parseLinearIssue, type FactoryConfig, type TriageDecision, type TriageEngine } from '../index'
import { FakeFleetClient, FakeMountClient } from '../testing'
import type { LinearIssue } from '../types'

const ready = 'b9bec744-b60c-4745-8022-d90d6ab59ae3'
const implementing = '39b9881d-1196-4c95-8b80-a20f0c7263f7'

const config = (overrides: Partial<FactoryConfig> = {}): FactoryConfig => FactoryConfigSchema.parse({
  workspaceId: 'factory-test',
  repos: {
    byLabel: { pear: 'AgentWorkforce/pear' },
    clonePaths: { 'AgentWorkforce/pear': '/work/pear' },
    default: 'AgentWorkforce/pear',
  },
  batchSize: 2,
  ...overrides,
})

const issuePath = (n: number) => `/linear/issues/AR-${n}__uuid-${n}.json`

const issuePayload = (n: number, stateId = ready) => ({
  id: `uuid-${n}`,
  identifier: `AR-${n}`,
  title: `Fix factory issue ${n}`,
  description: 'Implement the requested fix in packages/factory-sdk/src/orchestrator/factory.ts and verify it with tests.',
  stateId,
  labels: [{ name: 'pear' }],
  project: { name: 'Factory' },
  state: { id: stateId, name: stateId === ready ? 'Ready for Agent' : 'Implementing' },
})

const issueFile = (n: number, stateId = ready) => ({
  provider: 'linear',
  objectType: 'issue',
  objectId: `uuid-${n}`,
  payload: issuePayload(n, stateId),
})

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

class StaticTriage implements TriageEngine {
  async triage(issue: LinearIssue): Promise<TriageDecision> {
    const number = issue.key.match(/\d+/)?.[0] ?? '0'
    return {
      issue: { uuid: issue.uuid, key: issue.key, path: issue.path },
      routes: [{ repo: 'AgentWorkforce/pear', clonePath: '/work/pear', rationale: 'test route' }],
      scope: 'single',
      implementers: [{
        name: `ar-${number}-impl`,
        role: 'implementer',
        capability: 'spawn:codex',
        model: 'codex',
        task: `Implement ${issue.key}`,
        repo: 'AgentWorkforce/pear',
        clonePath: '/work/pear',
        node: 'self',
      }],
      reviewer: {
        name: `ar-${number}-review`,
        role: 'reviewer',
        capability: 'spawn:claude',
        model: 'claude',
        task: `Review ${issue.key}`,
        repo: 'AgentWorkforce/pear',
        clonePath: '/work/pear',
        node: 'self',
      },
      thin: false,
      confidence: 'high',
      rationale: 'static test decision',
    }
  }
}

describe('FactoryLoop', () => {
  it('parses wrapped Linear issue records', () => {
    expect(parseLinearIssue(issuePath(1), issueFile(1))).toMatchObject({
      uuid: 'uuid-1',
      key: 'AR-1',
      title: 'Fix factory issue 1',
      stateId: ready,
      labels: ['pear'],
      project: 'Factory',
    })
  })

  it('runOnce caps active issues, skips stale state, and pulls queued work after completion', async () => {
    const mount = new FakeMountClient({
      [issuePath(1)]: issueFile(1),
      [issuePath(2)]: issueFile(2),
      [issuePath(3)]: issueFile(3),
      [issuePath(4)]: issueFile(4, implementing),
    })
    const fleet = new FakeFleetClient()
    fleet.setSessionRef('ar-1-impl', 'session-impl-1')
    fleet.setSessionRef('ar-1-review', 'session-review-1')
    fleet.setSessionRef('ar-2-impl', 'session-impl-2')
    fleet.setSessionRef('ar-2-review', 'session-review-2')
    fleet.setSessionRef('ar-3-impl', 'session-impl-3')
    fleet.setSessionRef('ar-3-review', 'session-review-3')
    const factory = createFactory(config(), { mount, fleet, triage: new StaticTriage() })

    const report = await factory.runOnce()

    expect(report.pulled.map((issue) => issue.key)).toEqual(['AR-1', 'AR-2', 'AR-3', 'AR-4'])
    expect(report.dispatched.map((result) => result.issue.key)).toEqual(['AR-1', 'AR-2'])
    expect(report.skipped).toContainEqual({ issue: { uuid: 'uuid-3', key: 'AR-3', path: issuePath(3) }, reason: 'queued or escalated' })
    expect(report.skipped).toContainEqual({ issue: { uuid: 'uuid-4', key: 'AR-4', path: issuePath(4) }, reason: 'live state is not ready-for-agent' })
    expect(fleet.spawns).toHaveLength(4)
    expect(factory.status().inFlight.map((issue) => issue.key)).toEqual(['AR-1', 'AR-2'])
    expect(factory.status().queued.map((issue) => issue.key)).toEqual(['AR-3'])
    expect(mount.writes.some((write) => write.path === issuePath(1) && (write.content as { stateId?: string }).stateId === implementing)).toBe(true)

    fleet.emitAgentExit('ar-1-impl', 'issue-done')
    await flush()

    expect(fleet.releases.map((release) => release.name)).toEqual(['ar-1-impl', 'ar-1-review'])
    expect(fleet.spawns.map((spawn) => spawn.name)).toContain('ar-3-impl')
    expect(factory.status().inFlight.map((issue) => issue.key)).toEqual(['AR-2', 'AR-3'])
    expect(factory.status().queued).toEqual([])
  })

  it('dedupes repeated dispatch by stable invocation id', async () => {
    const mount = new FakeMountClient({ [issuePath(5)]: issueFile(5) })
    const fleet = new FakeFleetClient()
    const factory = createFactory(config(), { mount, fleet, triage: new StaticTriage() })
    const decision = await factory.triageIssue(parseLinearIssue(issuePath(5), issueFile(5)))

    await factory.dispatch(decision)
    await factory.dispatch(decision)

    expect(fleet.spawns.map((spawn) => spawn.name)).toEqual(['ar-5-impl', 'ar-5-review'])
    expect(new Set(fleet.spawns.map((spawn) => spawn.invocationId)).size).toBe(2)
  })

  it('resumes exited open agents by sessionRef with the original capability', async () => {
    const mount = new FakeMountClient({ [issuePath(6)]: issueFile(6) })
    const fleet = new FakeFleetClient()
    fleet.setSessionRef('ar-6-review', 'session-review-6')
    const factory = createFactory(config(), { mount, fleet, triage: new StaticTriage() })
    const decision = await factory.triageIssue(parseLinearIssue(issuePath(6), issueFile(6)))

    await factory.dispatch(decision)
    fleet.emitAgentExit('ar-6-review', 'crash')
    await flush()

    expect(fleet.resumes).toEqual([{
      name: 'ar-6-review',
      sessionRef: 'session-review-6',
      node: 'self',
      capability: 'spawn:claude',
    }])
    expect(fleet.spawns.map((spawn) => spawn.name)).toEqual(['ar-6-impl', 'ar-6-review'])
  })

  it('coalesces duplicate exit callbacks for the same open issue, agent, and sessionRef', async () => {
    const mount = new FakeMountClient({ [issuePath(10)]: issueFile(10) })
    const fleet = new FakeFleetClient()
    fleet.setSessionRef('ar-10-review', 'session-review-10')
    const factory = createFactory(config(), { mount, fleet, triage: new StaticTriage() })
    const decision = await factory.triageIssue(parseLinearIssue(issuePath(10), issueFile(10)))

    await factory.dispatch(decision)
    fleet.emitAgentExit('ar-10-review', 'exited')
    fleet.emitAgentExit('ar-10-review', 'crashed')
    await flush()
    fleet.emitAgentExit('ar-10-review', 'code:1')
    await flush()

    expect(fleet.resumes).toEqual([{
      name: 'ar-10-review',
      sessionRef: 'session-review-10',
      node: 'self',
      capability: 'spawn:claude',
    }])
  })

  it('fresh-spawns on exit only when sessionRef is absent', async () => {
    const mount = new FakeMountClient({ [issuePath(7)]: issueFile(7) })
    const fleet = new FakeFleetClient()
    const factory = createFactory(config(), { mount, fleet, triage: new StaticTriage() })
    const decision = await factory.triageIssue(parseLinearIssue(issuePath(7), issueFile(7)))

    await factory.dispatch(decision)
    fleet.emitAgentExit('ar-7-impl', 'crash')
    await flush()

    expect(fleet.resumes).toEqual([])
    expect(fleet.spawns.map((spawn) => spawn.name)).toEqual(['ar-7-impl', 'ar-7-review', 'ar-7-impl'])
    expect(fleet.spawns.at(-1)?.invocationId).toContain(':restart:')
  })

  it('emits an escalation on delivery_failed for an in-flight agent', async () => {
    const mount = new FakeMountClient({ [issuePath(8)]: issueFile(8) })
    const fleet = new FakeFleetClient()
    const factory = createFactory(config(), { mount, fleet, triage: new StaticTriage() })
    const errors: unknown[] = []
    factory.on('error', (payload) => errors.push(payload))
    await factory.start()

    const decision = await factory.triageIssue(parseLinearIssue(issuePath(8), issueFile(8)))
    await factory.dispatch(decision)
    fleet.emitDeliveryFailed({ to: 'ar-8-review', reason: 'dead-lettered' })
    await flush()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ issue: { key: 'AR-8' } })
    await factory.stop()
  })

  it('emits error and rejects when writeback verification fails', async () => {
    const mount = new FakeMountClient({ [issuePath(9)]: issueFile(9) })
    mount.setConfirmWrite(issuePath(9), 'failed')
    const fleet = new FakeFleetClient()
    const factory = createFactory(config(), { mount, fleet, triage: new StaticTriage() })
    const errors: unknown[] = []
    factory.on('error', (payload) => errors.push(payload))
    const decision = await factory.triageIssue(parseLinearIssue(issuePath(9), issueFile(9)))

    await expect(factory.dispatch(decision)).rejects.toThrow('Writeback not acked')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ issue: { key: 'AR-9' } })
  })
})
