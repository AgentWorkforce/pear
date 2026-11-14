import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isReachableAgent, listedRosterAgents, wireMetadata, type RosterAgent } from '../agent-roster.ts'
import { agentCli, agentSessionBinding } from '../session-transcript.ts'

describe('wireMetadata', () => {
  it('restores the snake_case keys the SDK camelized, so session rules can read them', () => {
    const camelized = { sessionId: '01d8eea5-c7ac-44b2-9810-1d09620d2ad3', sessionKind: 'claude-terminal', injectable: 'true', source: 'relay-desktop' }
    const metadata = wireMetadata(camelized)
    assert.deepEqual(metadata, {
      session_id: '01d8eea5-c7ac-44b2-9810-1d09620d2ad3',
      session_kind: 'claude-terminal',
      injectable: 'true',
      source: 'relay-desktop'
    })
    assert.equal(agentSessionBinding(camelized), null)
    assert.equal(agentSessionBinding(metadata)?.sessionId, '01d8eea5-c7ac-44b2-9810-1d09620d2ad3')
    assert.equal(agentCli('relay-21', metadata), 'claude')
    assert.equal(wireMetadata({ renamedTo: 'b' })?.renamed_to, 'b')
  })
})

const NOW = Date.parse('2026-11-13T12:00:00Z')
const recent = '2026-11-13T11:59:00Z'
const stale = '2026-11-13T11:50:00Z'

describe('isReachableAgent', () => {
  it('accepts live statuses seen inside the presence window', () => {
    for (const status of ['active', 'online', 'waiting', 'blocked', 'idle']) {
      assert.equal(isReachableAgent({ name: 'a', status, lastSeen: recent }, NOW), true, status)
    }
  })

  it('rejects offline agents and agents not seen for five minutes', () => {
    assert.equal(isReachableAgent({ name: 'a', status: 'offline', lastSeen: recent }, NOW), false)
    assert.equal(isReachableAgent({ name: 'a', status: 'online', lastSeen: stale }, NOW), false)
    assert.equal(isReachableAgent({ name: 'a' }, NOW), false)
  })

  it('treats an idle desktop registration as unreachable', () => {
    const agent: RosterAgent = { name: 'a', status: 'idle', lastSeen: recent, metadata: { source: 'relay-desktop' } }
    assert.equal(isReachableAgent(agent, NOW), false)
  })
})

describe('listedRosterAgents', () => {
  it('lists reachable agents and people once, without the companion or renamed registrations', () => {
    const agents: RosterAgent[] = [
      { name: 'alice', status: 'online', lastSeen: recent },
      { name: 'alice', status: 'online', lastSeen: recent },
      { name: 'bob', status: 'offline', lastSeen: recent },
      { name: 'carol', status: 'online', lastSeen: stale },
      { name: 'dave', status: 'online', lastSeen: recent, metadata: { renamed_to: 'dave-2' } },
      { name: 'pear-chat-mini', status: 'online', lastSeen: recent },
      { name: 'khaliq', type: 'human', status: 'offline', lastSeen: stale },
      { name: '', status: 'online', lastSeen: recent }
    ]
    assert.deepEqual(
      listedRosterAgents(agents, 'pear-chat-mini', NOW).map((agent) => agent.name),
      ['alice', 'khaliq']
    )
  })
})
