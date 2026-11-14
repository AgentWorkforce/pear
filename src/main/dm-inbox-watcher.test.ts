import { describe, expect, it } from 'vitest'
import { DmInboxWatcher } from './dm-inbox-watcher'
import type { RelayDMThread } from './relay-chat-client'

function thread(id: string, lastId: string, from: string, mine = false, createdAt = '2026-11-14T16:00:00Z'): RelayDMThread {
  return {
    id: `conversation:${id}`,
    conversationId: id,
    participants: [from],
    lastMessage: { id: lastId, conversationId: id, from, text: `hi from ${from}`, createdAt, mine, hasServerID: true, attachments: [] }
  }
}

describe('DmInboxWatcher', () => {
  it('baselines on the first check, then reports each new incoming message once', () => {
    const watcher = new DmInboxWatcher()
    expect(watcher.observe([thread('a', 'm1', 'agentcorespike'), thread('b', 'm2', 'grok')])).toEqual([])

    const update = [thread('a', 'm3', 'agentcorespike', false, '2026-11-14T16:05:00Z'), thread('b', 'm2', 'grok')]
    const fresh = watcher.observe(update)
    expect(fresh.map((item) => [item.conversationId, item.message.id])).toEqual([['conversation:a', 'm3']])
    // The same list again (a repeated poll) reports nothing.
    expect(watcher.observe(update)).toEqual([])
  })

  it('skips your own messages and threads without a last message', () => {
    const watcher = new DmInboxWatcher()
    watcher.observe([thread('a', 'm1', 'grok')])
    const quiet: RelayDMThread = { id: 'conversation:c', conversationId: 'c', participants: ['x'] }
    expect(watcher.observe([thread('a', 'm2', 'khaliq-gant', true), quiet])).toEqual([])
  })

  it('reports a brand-new thread after the baseline, oldest first', () => {
    const watcher = new DmInboxWatcher()
    watcher.observe([])
    const fresh = watcher.observe([
      thread('late', 'm9', 'b', false, '2026-11-14T16:09:00Z'),
      thread('early', 'm8', 'a', false, '2026-11-14T16:08:00Z')
    ])
    expect(fresh.map((item) => item.message.id)).toEqual(['m8', 'm9'])
  })

  it('baselines again after a reset, so a reconnect never replays old messages', () => {
    const watcher = new DmInboxWatcher()
    watcher.observe([thread('a', 'm1', 'grok')])
    watcher.reset()
    expect(watcher.observe([thread('a', 'm2', 'grok')])).toEqual([])
  })
})
