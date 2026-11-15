// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import {
  agentIdentity,
  conversationMatchesAgents,
  gridWithConversation,
  visibleConversationIds,
  historyIdFor,
  isConversationReachable,
  parseChatHost,
  selectChatHosts,
  sendTargetFor,
  useChatStore
} from './chat-store'
import type { RelayChatConversation, RelayChatMessage } from '@/lib/ipc'

const chatMocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  getHistory: vi.fn(),
  send: vi.fn(),
  markRead: vi.fn(),
  joinChannel: vi.fn(),
  uploadFile: vi.fn(),
  onInvalidated: vi.fn(() => () => undefined),
  onMessage: vi.fn(() => () => undefined)
}))

const transcriptMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock('@/lib/ipc', () => ({
  pear: { chat: chatMocks, aiHist: { transcript: transcriptMock } }
}))

function dm(id: string, name: string, minutesAgo: number | null, lastIncomingId?: string): RelayChatConversation {
  return {
    kind: 'dm',
    id: `conversation:${id}`,
    name,
    participants: [name],
    ...(minutesAgo !== null
      ? { lastMessageAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }
      : {}),
    ...(lastIncomingId ? { lastIncomingId } : {})
  }
}

function message(id: string, from: string, text: string, mine: boolean): RelayChatMessage {
  return {
    id,
    conversationId: 'thread-1',
    from,
    text,
    createdAt: new Date().toISOString(),
    mine,
    hasServerID: true,
    attachments: []
  }
}

beforeEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  useChatStore.getState().reset()
  vi.clearAllMocks()
  chatMocks.onInvalidated.mockImplementation(() => () => undefined)
  chatMocks.onMessage.mockImplementation(() => () => undefined)
  chatMocks.listConversations.mockResolvedValue([])
  chatMocks.getHistory.mockResolvedValue([])
  chatMocks.markRead.mockResolvedValue(undefined)
})

afterEach(() => {
  localStorage.clear()
  useChatStore.getState().reset()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('chat-store helpers', () => {
  it('parses machine hosts and lists them sorted', () => {
    expect(parseChatHost('alice@macbook')).toBe('macbook')
    expect(parseChatHost('bare-name')).toBeNull()
    expect(parseChatHost('@host')).toBeNull()
    const hosts = selectChatHosts([
      dm('a', 'alice@macbook', 1),
      dm('b', 'bob@linuxbox', 1),
      { kind: 'channel', id: 'channel:general', name: '#general' }
    ])
    expect(hosts).toEqual(['linuxbox', 'macbook'])
  })

  it('matches a roster name@host to the agent spawned in a directory', () => {
    expect(agentIdentity('relay:alice@macbook')).toBe('alice')
    const thread = dm('thread-1', 'alice@macbook', 1)
    const channel: RelayChatConversation = { kind: 'channel', id: 'channel:general', name: '#general' }
    expect(conversationMatchesAgents(thread, ['alice'])).toBe(true)
    expect(conversationMatchesAgents(thread, ['bob'])).toBe(false)
    expect(conversationMatchesAgents(channel, ['alice'])).toBe(false)
  })

  it('treats DMs active in the last 5 minutes as reachable', () => {
    const now = Date.now()
    expect(isConversationReachable(dm('a', 'alice@macbook', 4), now)).toBe(true)
    expect(isConversationReachable(dm('a', 'alice@macbook', 6), now)).toBe(false)
    expect(
      isConversationReachable({ kind: 'channel', id: 'channel:g', name: '#g' }, now)
    ).toBe(false)
    expect(isConversationReachable(dm('a', 'alice@x', null), now)).toBe(false)
    expect(
      isConversationReachable({ kind: 'agent', id: 'relay:worker', name: 'worker', status: 'online' }, now)
    ).toBe(true)
    expect(
      isConversationReachable({ kind: 'agent', id: 'relay:idle', name: 'idle', status: 'offline' }, now)
    ).toBe(false)
  })

  it('derives history ids and send targets per the main normalizers', () => {
    const channel = { kind: 'channel', id: 'channel:general', name: '#general' } as const
    expect(historyIdFor(channel)).toBe('general')
    expect(sendTargetFor(channel)).toEqual({ kind: 'channel', to: 'general' })
    const thread = dm('thread-1', 'alice@macbook', 1)
    expect(historyIdFor(thread)).toBe('conversation:thread-1')
    expect(sendTargetFor(thread)).toEqual({ kind: 'dm', to: 'alice@macbook' })
    expect(sendTargetFor({
      kind: 'dm',
      id: 'conversation:thread-9',
      name: 'alice@macbook, pear-chat-mini',
      participants: ['pear-chat-mini', 'alice@macbook']
    })).toEqual({ kind: 'dm', to: 'alice@macbook' })
    expect(sendTargetFor({ kind: 'agent', id: 'relay:worker@mbp', name: 'worker@mbp' })).toEqual({
      kind: 'dm',
      to: 'worker@mbp'
    })
  })
})

describe('chat-store sync', () => {
  it('treats every existing conversation as read on first launch', async () => {
    chatMocks.listConversations.mockResolvedValue([
      dm('thread-1', 'alice@macbook', 2, 'm1'),
      dm('thread-2', 'bob@linuxbox', 60, 'm2')
    ])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
    })
    const state = useChatStore.getState()
    expect(state.conversations).toHaveLength(2)
    expect(state.unreadConversationIDs).toEqual([])
    expect(state.conversationsError).toBeNull()
  })

  it('marks a conversation unread only when a newer incoming message arrives', async () => {
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2, 'm1'), dm('thread-2', 'bob@linuxbox', 60, 'm2')])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
    })
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 1, 'm3'), dm('thread-2', 'bob@linuxbox', 60, 'm2')])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().refreshConversations()
    })
    expect(useChatStore.getState().unreadConversationIDs).toEqual(['conversation:thread-1'])
  })

  it('ignores old conversations missing from saved read state, but flags new ones', async () => {
    localStorage.setItem('pear.chat.read', JSON.stringify({ since: new Date(Date.now() - 5 * 60_000).toISOString(), seen: {} }))
    chatMocks.listConversations.mockResolvedValue([dm('old', 'alice@macbook', 60, 'm1'), dm('new', 'bob@linuxbox', 1, 'm2')])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
    })
    expect(useChatStore.getState().unreadConversationIDs).toEqual(['conversation:new'])
  })

  it('re-baselines saved read state from an older format instead of flagging everything', async () => {
    localStorage.setItem('pear.chat.read', '{}')
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 1, 'm1')])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
    })
    expect(useChatStore.getState().unreadConversationIDs).toEqual([])
  })

  it('keeps an opened conversation read across later refreshes', async () => {
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2, 'm1')])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
    })
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 1, 'm2')])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
    })
    expect(useChatStore.getState().unreadConversationIDs).toEqual(['conversation:thread-1'])
    await act(async () => {
      await useChatStore.getState().selectConversation('conversation:thread-1')
      await useChatStore.getState().selectConversation(null)
      await useChatStore.getState().refreshConversations()
    })
    expect(useChatStore.getState().unreadConversationIDs).toEqual([])
  })

  it('select loads history with delivery, marks read, clears unread', async () => {
    localStorage.setItem('pear.chat.read', JSON.stringify({ since: new Date(Date.now() - 10 * 60_000).toISOString(), seen: {} }))
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2, 'm1')])
    chatMocks.getHistory.mockResolvedValue([message('m1', 'alice@macbook', 'hi', false)])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('conversation:thread-1')
    })
    expect(chatMocks.getHistory).toHaveBeenCalledWith({
      kind: 'dm',
      id: 'conversation:thread-1',
      limit: 100,
      withDelivery: true
    })
    expect(chatMocks.markRead).toHaveBeenCalledWith('m1')
    expect(useChatStore.getState().unreadConversationIDs).toEqual([])
    expect(useChatStore.getState().history['conversation:thread-1']).toHaveLength(1)
  })

  it('send is optimistic, then refreshes and reloads history', async () => {
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2)])
    chatMocks.send.mockResolvedValue(message('m9', 'pear-companion', 'hello', true))
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('conversation:thread-1')
    })
    chatMocks.getHistory.mockResolvedValue([message('m9', 'pear-companion', 'hello', true)])
    const sendPromise = act(async () => {
      await useChatStore.getState().sendMessage('hello')
    })
    // Optimistic row exists while the send is in flight.
    expect(
      (useChatStore.getState().pending['conversation:thread-1'] || []).map((p) => p.status)
    ).toContain('sending')
    await sendPromise
    expect(chatMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dm', to: 'alice@macbook', text: 'hello' })
    )
    expect(useChatStore.getState().pending['conversation:thread-1']).toEqual([])
    // Refresh + loadHistory after the optimistic send.
    expect(chatMocks.listConversations.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(chatMocks.getHistory.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('shares one in-flight list refresh and history load between callers', async () => {
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2)])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
    })
    chatMocks.listConversations.mockClear()
    await act(async () => {
      await Promise.all([
        useChatStore.getState().refreshConversations(),
        useChatStore.getState().refreshConversations(),
        useChatStore.getState().loadHistory('conversation:thread-1'),
        useChatStore.getState().loadHistory('conversation:thread-1')
      ])
    })
    expect(chatMocks.listConversations).toHaveBeenCalledTimes(1)
    expect(chatMocks.getHistory).toHaveBeenCalledTimes(1)
  })

  it('keeps one row when the same pushed message arrives twice', async () => {
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2)])
    chatMocks.getHistory.mockResolvedValue([])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('conversation:thread-1')
    })
    const event = { conversationId: 'conversation:thread-1', message: message('m5', 'alice@macbook', 'hi', false) }
    act(() => {
      useChatStore.getState().applyChatMessage(event)
      useChatStore.getState().applyChatMessage(event)
    })
    expect(useChatStore.getState().history['conversation:thread-1']?.map((row) => row.id)).toEqual(['m5'])
  })

  it('loads the open agent session into the thread', async () => {
    const agent: RelayChatConversation = {
      kind: 'agent',
      id: 'relay:alice@macbook',
      name: 'alice@macbook',
      sessionId: 'sess-alice',
      participants: ['alice@macbook']
    }
    transcriptMock.mockResolvedValue([
      { id: 't1', role: 'user', text: 'Fix the reconnect', timestampMs: 1 },
      { id: 't2', role: 'assistant', text: 'The broker reconnects.', timestampMs: 2 }
    ])
    chatMocks.listConversations.mockResolvedValue([agent])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('relay:alice@macbook')
    })
    expect(transcriptMock).toHaveBeenCalledWith('sess-alice')
    expect(chatMocks.getHistory).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessionTurns['relay:alice@macbook']?.map((turn) => turn.text)).toEqual([
      'Fix the reconnect',
      'The broker reconnects.'
    ])
  })

  it('shows an agent DM in the open thread and keeps a sent message there', async () => {
    const agent: RelayChatConversation = {
      kind: 'agent',
      id: 'relay:alice@macbook',
      name: 'alice@macbook',
      status: 'online',
      participants: ['alice@macbook']
    }
    chatMocks.listConversations.mockResolvedValue([agent, dm('thread-1', 'alice@macbook', 2)])
    chatMocks.getHistory.mockResolvedValue([message('m1', 'alice@macbook', 'hey', false)])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('relay:alice@macbook')
    })
    expect(chatMocks.getHistory).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'dm',
      id: 'conversation:thread-1'
    }))
    expect(useChatStore.getState().history['relay:alice@macbook']?.map((row) => row.id)).toEqual(['m1'])

    chatMocks.send.mockResolvedValue(message('m9', 'pear-chat-mini', 'hello', true))
    chatMocks.getHistory.mockResolvedValue([
      message('m1', 'alice@macbook', 'hey', false),
      message('m9', 'pear-chat-mini', 'hello', true)
    ])
    await act(async () => {
      await useChatStore.getState().sendMessage('hello')
    })
    expect(chatMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dm', to: 'alice@macbook', text: 'hello' })
    )
    expect(useChatStore.getState().history['relay:alice@macbook']?.map((row) => row.id)).toEqual(['m1', 'm9'])
    expect(useChatStore.getState().pending['relay:alice@macbook']).toEqual([])
  })

  it('failed send keeps a failed row; tap-to-edit restores the draft', async () => {
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2)])
    chatMocks.send.mockRejectedValue(new Error('offline'))
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('conversation:thread-1')
      await useChatStore.getState().sendMessage('retry me')
    })
    const rows = useChatStore.getState().pending['conversation:thread-1'] || []
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].error).toBe('offline')
    act(() => {
      useChatStore.getState().editFailedPending(rows[0].localId)
    })
    expect(useChatStore.getState().pending['conversation:thread-1']).toEqual([])
    expect(useChatStore.getState().composerDraft).toBe('retry me')
  })

  it('incoming messages append to open threads, unread-mark the rest', async () => {
    useChatStore.setState({
      conversations: [dm('thread-1', 'alice@macbook', 2), dm('thread-2', 'bob@linuxbox', 60)],
      selectedId: 'conversation:thread-1',
      history: { 'conversation:thread-1': [message('m1', 'alice@macbook', 'hi', false)] }
    })
    const incoming = message('m2', 'alice@macbook', 'again', false)
    act(() => {
      useChatStore.getState().applyChatMessage({ conversationId: 'conversation:thread-1', message: incoming })
    })
    expect(useChatStore.getState().history['conversation:thread-1']).toHaveLength(2)
    expect(useChatStore.getState().unreadConversationIDs).toEqual([])
    expect(chatMocks.markRead).toHaveBeenCalledWith('m2')

    const other = message('m3', 'bob@linuxbox', 'yo', false)
    act(() => {
      useChatStore.getState().applyChatMessage({ conversationId: 'conversation:thread-2', message: other })
    })
    expect(useChatStore.getState().unreadConversationIDs).toEqual(['conversation:thread-2'])
  })

  it('a live reply lands in the open agent row once, however often it is pushed', async () => {
    const agent: RelayChatConversation = {
      kind: 'agent',
      id: 'relay:alice@macbook',
      name: 'alice@macbook',
      status: 'online',
      participants: ['alice@macbook']
    }
    useChatStore.setState({
      conversations: [agent, dm('thread-1', 'alice@macbook', 2)],
      selectedId: 'relay:alice@macbook',
      history: { 'relay:alice@macbook': [message('m1', 'alice@macbook', 'hi', false)] }
    })
    const event = { conversationId: 'conversation:thread-1', message: message('m2', 'alice@macbook', 'reply', false) }
    act(() => {
      useChatStore.getState().applyChatMessage(event)
      useChatStore.getState().applyChatMessage(event)
    })
    expect(useChatStore.getState().history['relay:alice@macbook']?.map((row) => row.id)).toEqual(['m1', 'm2'])
    expect(useChatStore.getState().unreadConversationIDs).toEqual([])
    expect(chatMocks.markRead).toHaveBeenCalledWith('m2')
  })

  it('a first DM from an agent lands in its row before the thread is listed', async () => {
    const agent: RelayChatConversation = {
      kind: 'agent',
      id: 'relay:bob@linuxbox',
      name: 'bob@linuxbox',
      status: 'online',
      participants: ['bob@linuxbox']
    }
    useChatStore.setState({
      conversations: [agent],
      selectedId: 'relay:bob@linuxbox',
      history: { 'relay:bob@linuxbox': [] }
    })
    act(() => {
      useChatStore.getState().applyChatMessage({
        conversationId: 'conversation:new-thread',
        message: message('m5', 'bob@linuxbox', 'hello there', false)
      })
    })
    expect(useChatStore.getState().history['relay:bob@linuxbox']?.map((row) => row.id)).toEqual(['m5'])
    expect(chatMocks.listConversations).toHaveBeenCalled()
  })

  it('a notification click opens the agent row that shows the DM', async () => {
    const agent: RelayChatConversation = {
      kind: 'agent',
      id: 'relay:claude-infra-infra-7d',
      name: 'claude-infra-infra-7d',
      status: 'online',
      participants: ['claude-infra-infra-7d']
    }
    chatMocks.listConversations.mockResolvedValue([agent, dm('dm_7d', 'claude-infra-infra-7d', 1)])
    await act(async () => {
      await useChatStore.getState().openFromNotification({ conversationId: 'conversation:dm_7d', from: 'claude-infra-infra-7d' })
    })
    expect(chatMocks.listConversations).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().selectedId).toBe('relay:claude-infra-infra-7d')

    await act(async () => {
      await useChatStore.getState().openFromNotification({ conversationId: 'conversation:dm_7d', from: 'claude-infra-infra-7d' })
    })
    expect(chatMocks.listConversations).toHaveBeenCalledTimes(1)
  })

  it('a delivery flip updates the label without adding a row', () => {
    useChatStore.setState({
      conversations: [dm('thread-1', 'alice@macbook', 2)],
      selectedId: 'conversation:thread-1',
      history: { 'conversation:thread-1': [message('m9', 'pear-chat-mini', 'hello', true)] }
    })
    act(() => {
      useChatStore.getState().applyChatMessage({
        conversationId: 'conversation:thread-1',
        message: { ...message('m9', 'pear-chat-mini', 'hello', true), delivered: true }
      })
    })
    expect(useChatStore.getState().delivery.m9).toBe(true)
    expect(useChatStore.getState().history['conversation:thread-1']).toHaveLength(1)
  })

  it('a poll reloads the open thread only when the list shows it moved', async () => {
    const before = dm('thread-1', 'alice@macbook', 2)
    chatMocks.listConversations.mockResolvedValue([before])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('conversation:thread-1')
    })
    const historyCalls = chatMocks.getHistory.mock.calls.length
    chatMocks.listConversations.mockResolvedValue([{ ...before, lastMessageAt: new Date().toISOString() }])
    await act(async () => {
      useChatStore.getState().applyInvalidated({ reason: 'poll' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(chatMocks.getHistory.mock.calls.length).toBe(historyCalls + 1)
  })

  it('invalidation refreshes; non-poll reasons also reload the open thread', async () => {
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2)])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('conversation:thread-1')
    })
    const historyCalls = chatMocks.getHistory.mock.calls.length
    act(() => {
      useChatStore.getState().applyInvalidated({ reason: 'poll' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(chatMocks.getHistory.mock.calls.length).toBe(historyCalls)
    act(() => {
      useChatStore.getState().applyInvalidated({ reason: 'foreground' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(chatMocks.getHistory.mock.calls.length).toBeGreaterThan(historyCalls)
  })

  it('startSync subscribes, polls every 30s, and refreshes on focus', async () => {
    vi.useFakeTimers()
    try {
      chatMocks.listConversations.mockResolvedValue([])
      await act(async () => {
        useChatStore.getState().startSync()
        await Promise.resolve()
      })
      expect(chatMocks.onInvalidated).toHaveBeenCalledTimes(1)
      expect(chatMocks.onMessage).toHaveBeenCalledTimes(1)
      // Second start is a no-op (no duplicate subscriptions).
      useChatStore.getState().startSync()
      expect(chatMocks.onInvalidated).toHaveBeenCalledTimes(1)

      const before = chatMocks.listConversations.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(chatMocks.listConversations.mock.calls.length).toBeGreaterThan(before)

      const atFocus = chatMocks.listConversations.mock.calls.length
      await act(async () => {
        window.dispatchEvent(new FocusEvent('focus'))
        await Promise.resolve()
      })
      expect(chatMocks.listConversations.mock.calls.length).toBeGreaterThan(atFocus)

      // Wired scheduler events flow through the captured callbacks.
      const onMessage = chatMocks.onMessage.mock.calls[0][0]
      chatMocks.listConversations.mockResolvedValue([dm('thread-9', 'zed@macbook', 1)])
      await act(async () => {
        onMessage({
          conversationId: 'conversation:thread-9',
          message: message('mx', 'zed@macbook', 'ping', false)
        })
        await Promise.resolve()
      })
      expect(useChatStore.getState().unreadConversationIDs).toContain('conversation:thread-9')
    } finally {
      useChatStore.getState().stopSync()
      vi.useRealTimers()
    }
  })
})

describe('chat grid layout', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `conversation:t${i}`)

  it('adds panes once, and replaces the focused pane when full', () => {
    expect(gridWithConversation([], 'a', null)).toEqual(['a'])
    expect(gridWithConversation(['a', 'b'], 'a', 'b')).toEqual(['a', 'b'])
    expect(gridWithConversation(ids(8), 'new', 'conversation:t2')).toEqual([
      'conversation:t0', 'conversation:t1', 'new', 'conversation:t3',
      'conversation:t4', 'conversation:t5', 'conversation:t6', 'conversation:t7'
    ])
    expect(gridWithConversation(ids(8), 'new', null)[7]).toBe('new')
  })

  it('is single-conversation by default and remembers the grid', async () => {
    expect(useChatStore.getState().chatLayout).toBe('single')
    chatMocks.listConversations.mockResolvedValue([dm('thread-1', 'alice@macbook', 2), dm('thread-2', 'bob@linuxbox', 5)])
    await act(async () => {
      await useChatStore.getState().refreshConversations()
      await useChatStore.getState().selectConversation('conversation:thread-1')
      useChatStore.getState().setChatLayout('grid')
      await useChatStore.getState().selectConversation('conversation:thread-2')
      // A repeated pick (double click, notification + click) must not open a second pane.
      await useChatStore.getState().selectConversation('conversation:thread-2')
    })
    const state = useChatStore.getState()
    expect(state.gridIds).toEqual(['conversation:thread-1', 'conversation:thread-2'])
    expect(state.selectedId).toBe('conversation:thread-2')
    expect(visibleConversationIds(state)).toEqual(['conversation:thread-1', 'conversation:thread-2'])
    expect(localStorage.getItem('pear.chat.layout')).toBe('grid')
    expect(JSON.parse(localStorage.getItem('pear.chat.grid') || '[]')).toEqual(state.gridIds)

    act(() => useChatStore.getState().setChatLayout('single'))
    expect(visibleConversationIds(useChatStore.getState())).toEqual(['conversation:thread-2'])
  })

  it('sends from a pane into its own conversation, not the focused one', async () => {
    useChatStore.setState({
      conversations: [dm('thread-1', 'alice@macbook', 2), dm('thread-2', 'bob@linuxbox', 5)],
      chatLayout: 'grid',
      gridIds: ['conversation:thread-1', 'conversation:thread-2'],
      selectedId: 'conversation:thread-1'
    })
    chatMocks.send.mockResolvedValue(message('m9', 'khaliq-gant', 'hi bob', true))
    await act(async () => {
      await useChatStore.getState().sendMessage('hi bob', [], 'conversation:thread-2')
    })
    expect(chatMocks.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dm', to: 'bob@linuxbox', text: 'hi bob' }))
  })

  it('treats every visible pane as read, and only hidden ones as unread', () => {
    useChatStore.setState({
      conversations: [dm('thread-1', 'alice@macbook', 2), dm('thread-2', 'bob@linuxbox', 5), dm('thread-3', 'carol@mini', 9)],
      chatLayout: 'grid',
      gridIds: ['conversation:thread-1', 'conversation:thread-2'],
      selectedId: 'conversation:thread-1',
      history: { 'conversation:thread-2': [] }
    })
    act(() => {
      useChatStore.getState().applyChatMessage({ conversationId: 'conversation:thread-2', message: message('m2', 'bob@linuxbox', 'done', false) })
      useChatStore.getState().applyChatMessage({ conversationId: 'conversation:thread-3', message: message('m3', 'carol@mini', 'ping', false) })
    })
    expect(chatMocks.markRead).toHaveBeenCalledWith('m2')
    expect(useChatStore.getState().unreadConversationIDs).toEqual(['conversation:thread-3'])
  })

  it('closing the focused pane focuses its neighbour', () => {
    useChatStore.setState({ chatLayout: 'grid', gridIds: ['a', 'b', 'c'], selectedId: 'b' })
    act(() => useChatStore.getState().closeGridPane('b'))
    expect(useChatStore.getState().gridIds).toEqual(['a', 'c'])
    expect(useChatStore.getState().selectedId).toBe('c')
    act(() => useChatStore.getState().closeGridPane('b'))
    expect(useChatStore.getState().gridIds).toEqual(['a', 'c'])
  })
})

