import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentCli, agentSessionBinding, agentSummary, conversationTurns, historyEventTurns } from '../session-transcript.ts'

describe('remote session history', () => {
  it('keeps what the person typed and what the agent said, oldest first', () => {
    const turns = historyEventTurns([
      { eventId: 'e5', ts: '2026-11-13T10:05:00Z', kind: 'assistant', actorRole: 'assistant', content: 'Done, tests pass.' },
      { eventId: 'e4', ts: '2026-11-13T10:04:00Z', kind: 'tool_result', actorRole: 'tool_result', content: 'ok' },
      { eventId: 'e3', ts: '2026-11-13T10:03:00Z', kind: 'tool_use', type: 'tool_use', content: 'Bash {"cmd":"npm test"}' },
      { eventId: 'e2b', ts: '2026-11-13T10:02:30Z', kind: 'assistant', actorRole: 'assistant', content: 'Bash {"cmd":"ls"}' },
      { eventId: 'e2', ts: '2026-11-13T10:02:00Z', kind: 'assistant', type: 'thinking', content: 'hmm' },
      { eventId: 'e1', ts: '2026-11-13T10:01:00Z', kind: 'prompt', actorRole: 'user', content: '<environment_context>cwd</environment_context>\nFix the tests' },
      { eventId: 'e1', ts: '2026-11-13T10:01:00Z', kind: 'prompt', actorRole: 'user', content: 'Fix the tests' }
    ])
    assert.deepEqual(turns.map((turn) => [turn.id, turn.role, turn.text]), [
      ['e1', 'user', 'Fix the tests'],
      ['e5', 'assistant', 'Done, tests pass.']
    ])
  })

  it('drops the assistant copies of Codex tool calls', () => {
    const command = "exec_command curl -s --unix-socket /run/relay.sock 'http://relay/send?address=a' --data-binary 'hi'"
    const turns = historyEventTurns([
      { eventId: 't1', ts: '2026-11-05T00:50:49.161Z', kind: 'tool_call', type: 'tool_call', content: command },
      { eventId: 'a1', ts: '2026-11-05T00:50:49.161Z', kind: 'session_event', type: 'assistant', actorRole: 'assistant', content: command },
      { eventId: 'a2', ts: '2026-11-05T00:50:49.170Z', kind: 'session_event', type: 'assistant', actorRole: 'assistant', content: 'exec {"input":"const r = await tools.exec_command({\\"cmd\\":\\"curl …' },
      { eventId: 'a3', ts: '2026-11-05T00:50:53.827Z', kind: 'session_event', type: 'assistant', actorRole: 'assistant', content: 'Sent the status report.' }
    ])
    assert.deepEqual(turns.map((turn) => turn.id), ['a3'])
  })

  it('leaves out relay deliveries and injected reminders, which the chat shows as DMs', () => {
    const turns = historyEventTurns([
      { eventId: 'r1', ts: '2026-11-13T10:00:00Z', kind: 'prompt', content: '[via Agent Relay — from pear-chat-mini]\nhello' },
      { eventId: 'r2', ts: '2026-11-13T10:00:01Z', kind: 'user', content: '<system-reminder>stay focused</system-reminder>' },
      { eventId: 'r3', ts: '2026-11-13T10:00:02Z', kind: 'history', actorRole: 'assistant', content: 'Replying now.' }
    ])
    assert.deepEqual(turns.map((turn) => turn.id), ['r3'])
  })
})

describe('cursor transcripts', () => {
  it('reads the role field and only the typed query', () => {
    const jsonl = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nship it\n</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Shipping.' }, { type: 'tool_use', name: 'Shell', input: {} }] } })
    ].join('\n')
    assert.deepEqual(conversationTurns(jsonl).map((turn) => [turn.role, turn.text]), [
      ['user', 'ship it'],
      ['assistant', 'Shipping.']
    ])
  })
})

describe('agent tool and summary', () => {
  it('reads the tool from metadata, then the name, then the persona', () => {
    assert.equal(agentCli('builder', { session_kind: 'claude-terminal' }), 'claude')
    assert.equal(agentCli('codex-reviewer', {}), 'codex')
    assert.equal(agentCli('helper', {}, 'You are a grok agent'), 'grok')
    assert.equal(agentCli('helper', {}), null)
  })

  it('names Grok Bot inboxes grok but not the agents they spawn', () => {
    assert.equal(agentCli('devopsgrok', {}), 'grok')
    assert.equal(agentCli('SOC2grok', {}), 'grok')
    assert.equal(agentCli('posthogrok-washburn', {}), 'grok')
    assert.equal(agentCli('grokbot-will-washburn', {}), 'grok')
    assert.equal(agentCli('emgrok-agent-access-wsname-codex', { source: 'relay-desktop' }), 'codex')
    assert.equal(agentCli('emgrok-agent-access-wsname-codex', {}), 'codex')
    assert.equal(agentCli('emgrok-agent-access-workspace-name', { source: 'relay-desktop' }), null)
    assert.equal(agentCli('helper', { provider: 'xai' }), 'grok')
  })

  it('summarizes with the objective before the session title', () => {
    assert.equal(agentSummary({ objective: 'Ship it', session_title: 'Title' }), 'Ship it')
    assert.equal(agentSummary({ session_title: 'Fix reconnect' }), 'Fix reconnect')
    assert.equal(agentSummary({}), null)
    assert.equal(agentSummary({ session_title: 'Fix reconnect', activity: { doing: 'Pull latest changes' } }), 'Pull latest changes')
    assert.equal(agentSummary({ session_title: 'khaliqgant-0e' }), null)
    assert.equal(agentSummary({ session_title: 'infra-7d', activity: { doing: 'infra-7d', repo: 'infra' } }), null)
    assert.equal(agentSummary({ session_title: 'khaliqgant-0e', card: { description: 'Company knowledge agent' } }), 'Company knowledge agent')
  })
})

describe('agent session binding', () => {
  it('uses the session an injectable or fleet agent declared', () => {
    expectBinding({ session_id: 'sess-1', injectable: 'true', session_kind: 'claude' }, 'sess-1', 'claude')
    expectBinding({ session_id: 'sess-2', fleet: { node_id: 'n1' } }, 'sess-2', null)
    expectBinding({ session_id: 'not-a-session' }, null, null)
    expectBinding({ session_id: 'main', session_scope: 'agent', injectable: 'true' }, null, null)
  })
})

function expectBinding(
  metadata: Record<string, unknown>,
  sessionId: string | null,
  sessionKind: string | null
): void {
  const binding = agentSessionBinding(metadata)
  if (!sessionId) {
    assert.equal(binding, null)
    return
  }
  assert.equal(binding?.sessionId, sessionId)
  assert.equal(binding?.sessionKind, sessionKind)
}

describe('session conversation transcript', () => {
  it('keeps Claude human and agent text and drops tool calls', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-11-13T12:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Fix the reconnect' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'I will look at the broker.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'secret output' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'The broker now reconnects.' }
      })
    ].join('\n')

    assert.deepEqual(
      conversationTurns(jsonl).map((turn) => [turn.role, turn.text]),
      [
        ['user', 'Fix the reconnect'],
        ['assistant', 'I will look at the broker.'],
        ['assistant', 'The broker now reconnects.']
      ]
    )
  })

  it('keeps Codex messages and drops command and function calls', () => {
    const jsonl = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Ship the release' }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: 'npm test' }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Released.' }]
        }
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test' }
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'Done.' }
      })
    ].join('\n')

    assert.deepEqual(
      conversationTurns(jsonl).map((turn) => [turn.role, turn.text]),
      [
        ['user', 'Ship the release'],
        ['assistant', 'Released.'],
        ['assistant', 'Done.']
      ]
    )
  })
})
