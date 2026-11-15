// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConversationList } from './ConversationList'
import { useChatStore } from '@/stores/chat-store'
import type { RelayChatConversation } from '@/lib/ipc'

const chatMocks = vi.hoisted(() => ({
  listConversations: vi.fn(async () => []),
  getHistory: vi.fn(async () => []),
  send: vi.fn(),
  markRead: vi.fn(async () => undefined),
  joinChannel: vi.fn(),
  uploadFile: vi.fn(),
  onInvalidated: vi.fn(() => () => undefined),
  onMessage: vi.fn(() => () => undefined)
}))

vi.mock('@/lib/ipc', () => ({
  pear: { chat: chatMocks }
}))

function seed(): void {
  const now = Date.now()
  const conversations: RelayChatConversation[] = [
    {
      kind: 'dm',
      id: 'conversation:thread-1',
      name: 'alice@macbook',
      participants: ['alice@macbook'],
      lastMessageAt: new Date(now - 2 * 60_000).toISOString()
    },
    {
      kind: 'dm',
      id: 'conversation:thread-2',
      name: 'bob@linuxbox',
      participants: ['bob@linuxbox'],
      lastMessageAt: new Date(now - 60 * 60_000).toISOString()
    },
    { kind: 'channel', id: 'channel:general', name: '#general', isMember: true }
  ]
  useChatStore.setState({
    conversations,
    conversationsLoading: false,
    conversationsError: null,
    selectedId: null,
    history: {},
    historyLoading: {},
    historyError: {},
    pending: {},
    unreadConversationIDs: ['conversation:thread-1'],
    delivery: {},
    pinnedConversationIDs: [],
    hiddenConversationIDs: [],
    showHidden: false,
    composerDraft: '',
    lastRefreshAt: new Date().toISOString()
  })
}

beforeEach(() => {
  localStorage.removeItem('pear.chat.filters')
  seed()
})

afterEach(() => {
  cleanup()
  useChatStore.getState().reset()
  localStorage.removeItem('pear.chat.filters')
  vi.clearAllMocks()
})

describe('ConversationList', () => {
  it('shows unread and 5-minute reachable dots', () => {
    render(React.createElement(ConversationList))
    const alice = screen.getByLabelText('alice@macbook')
    expect(within(alice as HTMLElement).getByLabelText('unread')).toBeTruthy()
    expect(within(alice as HTMLElement).getByLabelText('reachable')).toBeTruthy()
    const bob = screen.getByLabelText('bob@linuxbox')
    expect(within(bob as HTMLElement).queryByLabelText('reachable')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'agents' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'sessions' })).toBeNull()
    expect(screen.queryByLabelText('#general')).toBeNull()
  })

  it('filters by Messages / Channels tabs', () => {
    render(React.createElement(ConversationList))
    expect(screen.queryByLabelText('alice@macbook')).not.toBeNull()
    expect(screen.queryByLabelText('bob@linuxbox')).not.toBeNull()
    expect(screen.queryByLabelText('#general')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'channels' }))
    const general = screen.getByLabelText('#general')
    expect(within(general as HTMLElement).queryByLabelText('reachable')).toBeNull()
    expect(screen.queryByLabelText('alice@macbook')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'messages' }))
    expect(screen.queryByLabelText('alice@macbook')).not.toBeNull()
    expect(screen.queryByLabelText('#general')).toBeNull()
  })

  it('searches by name and filters by machine', () => {
    render(React.createElement(ConversationList))
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'alice' } })
    expect(screen.queryByLabelText('alice@macbook')).not.toBeNull()
    expect(screen.queryByLabelText('bob@linuxbox')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by machine'), { target: { value: 'linuxbox' } })
    expect(screen.queryByLabelText('bob@linuxbox')).not.toBeNull()
    expect(screen.queryByLabelText('alice@macbook')).toBeNull()
    expect(screen.queryByLabelText('#general')).toBeNull()
  })

  it('pins to the top and hides with a show-hidden toggle', () => {
    const { container } = render(React.createElement(ConversationList))
    const order = (): Array<string | null> =>
      Array.from(container.querySelectorAll('div[role="button"][aria-label]')).map((node) =>
        node.getAttribute('aria-label')
      )

    fireEvent.click(screen.getByLabelText('Pin bob@linuxbox'))
    expect(order()[0]).toBe('bob@linuxbox')

    fireEvent.click(screen.getByLabelText('Hide bob@linuxbox'))
    expect(screen.queryByLabelText('bob@linuxbox')).toBeNull()
    fireEvent.click(screen.getByText('Show 1 hidden'))
    expect(screen.queryByLabelText('bob@linuxbox')).not.toBeNull()
  })

  it('filters agents by project, agent type, and machine, and remembers the choice', () => {
    const agent = (name: string, extra: Partial<RelayChatConversation>): RelayChatConversation => ({
      kind: 'agent', id: `relay:${name}`, name, participants: [name], ...extra
    })
    useChatStore.setState({
      conversations: [
        ...useChatStore.getState().conversations,
        agent('infra-claude', { project: 'infra', cli: 'claude', machine: 'Finn-Mac-Mini' }),
        agent('infra-codex', { project: 'infra', cli: 'codex', machine: 'studio' }),
        agent('app-claude', { project: 'relay-app', cli: 'claude', machine: 'finn-mac-mini.local' })
      ]
    })
    const { unmount } = render(React.createElement(ConversationList))
    const options = (label: string): string[] =>
      Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => option.text)
    expect(options('Filter by project')).toEqual(['All projects', 'infra', 'relay-app'])
    expect(options('Filter by agent type')).toEqual(['All types', 'claude', 'codex'])
    // One entry per machine, however its name is spelled.
    expect(options('Filter by machine')).toEqual(['All machines', 'Finn-Mac-Mini', 'linuxbox', 'macbook', 'studio'])

    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'infra' } })
    expect(screen.queryByLabelText('infra-claude')).not.toBeNull()
    expect(screen.queryByLabelText('infra-codex')).not.toBeNull()
    expect(screen.queryByLabelText('app-claude')).toBeNull()
    expect(screen.queryByLabelText('alice@macbook')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter by agent type'), { target: { value: 'claude' } })
    expect(screen.queryByLabelText('infra-codex')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by machine'), { target: { value: 'Finn-Mac-Mini' } })
    expect(screen.queryByLabelText('infra-claude')).not.toBeNull()
    expect(screen.queryByLabelText('app-claude')).not.toBeNull()

    unmount()
    render(React.createElement(ConversationList))
    expect((screen.getByLabelText('Filter by machine') as HTMLSelectElement).value).toBe('Finn-Mac-Mini')
    expect((screen.getByLabelText('Filter by agent type') as HTMLSelectElement).value).toBe('claude')
  })

  it('offers to clear filters that match nothing, and leaves channels unfiltered', () => {
    localStorage.setItem('pear.chat.filters', JSON.stringify({ project: 'gone', cli: '', machine: '' }))
    render(React.createElement(ConversationList))
    expect(screen.getByText('No conversations match these filters')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'channels' }))
    expect(screen.queryByLabelText('#general')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'messages' }))
    fireEvent.click(screen.getByText('Clear filters'))
    expect(screen.queryByLabelText('alice@macbook')).not.toBeNull()
  })

  it('shows a loading state until the first list arrives', () => {
    useChatStore.setState({ conversations: [], lastRefreshAt: null, conversationsLoading: false })
    render(React.createElement(ConversationList))
    expect(screen.getByTestId('conversation-skeleton')).toBeTruthy()
    expect(screen.getByLabelText('Loading conversations')).toBeTruthy()
    expect(screen.queryByText('No conversations yet')).toBeNull()
  })

  it('shows the agent tool icon and its summary', () => {
    useChatStore.setState({
      conversations: [{
        kind: 'agent',
        id: 'relay:builder',
        name: 'builder',
        participants: ['builder'],
        status: 'online',
        cli: 'claude',
        summary: 'Fixing the broker reconnect'
      }]
    })
    render(React.createElement(ConversationList))
    const row = screen.getByLabelText('builder')
    expect(within(row as HTMLElement).getByLabelText('claude agent')).toBeTruthy()
    expect(within(row as HTMLElement).getByText('Fixing the broker reconnect')).toBeTruthy()
    expect(within(row as HTMLElement).getByText('claude · online')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'reconnect' } })
    expect(screen.queryByLabelText('builder')).not.toBeNull()
  })

  it('sorts by recent messages by default, then alphabetically on request', () => {
    localStorage.removeItem('pear.chat.sort')
    const now = Date.now()
    const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString()
    useChatStore.setState({
      conversations: [
        { kind: 'agent', id: 'relay:zed', name: 'zed', participants: ['zed'], status: 'online', lastMessageAt: at(0) },
        { kind: 'agent', id: 'relay:bravo', name: 'bravo', participants: ['bravo'], status: 'online', lastMessageAt: at(0) },
        { kind: 'agent', id: 'relay:alpha', name: 'alpha', participants: ['alpha'], status: 'online', lastMessageAt: at(1) },
        { kind: 'dm', id: 'conversation:dm_z', name: 'zed', participants: ['pear-chat-mini', 'zed'], lastMessageAt: at(30) },
        { kind: 'dm', id: 'conversation:dm_b', name: 'bravo', participants: ['pear-chat-mini', 'bravo'], lastMessageAt: at(5) }
      ],
      pinnedConversationIDs: ['relay:alpha']
    })
    render(React.createElement(ConversationList))
    const order = (): string[] =>
      screen.getAllByRole('button').map((row) => row.getAttribute('aria-label') || '').filter((label) => ['alpha', 'bravo', 'zed'].includes(label))
    // Pinned first, then the most recent conversation, regardless of presence heartbeats.
    expect(order()).toEqual(['alpha', 'bravo', 'zed'])
    act(() => {
      useChatStore.setState({ pinnedConversationIDs: [] })
    })
    expect(order()).toEqual(['bravo', 'zed', 'alpha'])

    fireEvent.change(screen.getByLabelText('Sort conversations'), { target: { value: 'name' } })
    expect(order()).toEqual(['alpha', 'bravo', 'zed'])
    expect(localStorage.getItem('pear.chat.sort')).toBe('name')
    localStorage.removeItem('pear.chat.sort')
  })

  it('floats conversations with unread messages to the top, below pins, in either order', async () => {
    localStorage.removeItem('pear.chat.sort')
    const now = Date.now()
    const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString()
    useChatStore.setState({
      conversations: [
        { kind: 'agent', id: 'relay:alpha', name: 'alpha', participants: ['alpha'] },
        { kind: 'agent', id: 'relay:bravo', name: 'bravo', participants: ['bravo'] },
        { kind: 'agent', id: 'relay:zed', name: 'zed', participants: ['zed'] },
        { kind: 'dm', id: 'conversation:dm_a', name: 'alpha', participants: ['alpha'], lastMessageAt: at(1) },
        { kind: 'dm', id: 'conversation:dm_b', name: 'bravo', participants: ['bravo'], lastMessageAt: at(2) },
        // Unread state lives on the agent's DM thread, which the list folds into the agent row.
        { kind: 'dm', id: 'conversation:dm_z', name: 'zed', participants: ['zed'], lastMessageAt: at(60), lastIncomingId: 'm9' }
      ],
      pinnedConversationIDs: ['relay:bravo'],
      unreadConversationIDs: ['conversation:dm_z']
    })
    render(React.createElement(ConversationList))
    const order = (): string[] =>
      screen.getAllByRole('button').map((row) => row.getAttribute('aria-label') || '').filter((label) => ['alpha', 'bravo', 'zed'].includes(label))
    expect(order()).toEqual(['bravo', 'zed', 'alpha'])
    expect(within(screen.getByLabelText('zed') as HTMLElement).getByLabelText('unread')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Sort conversations'), { target: { value: 'name' } })
    expect(order()).toEqual(['bravo', 'zed', 'alpha'])
    localStorage.removeItem('pear.chat.sort')

    await act(async () => {
      await useChatStore.getState().selectConversation('relay:zed')
    })
    expect(useChatStore.getState().unreadConversationIDs).toEqual([])
    expect(within(screen.getByLabelText('zed') as HTMLElement).queryByLabelText('unread')).toBeNull()
    expect(order()).toEqual(['bravo', 'alpha', 'zed'])
  })

  it('lists an agent once when its DM thread is also loaded', () => {
    useChatStore.setState({
      conversations: [
        { kind: 'agent', id: 'relay:kjgrok', name: 'kjgrok', participants: ['kjgrok'], status: 'online', cli: 'grok' },
        {
          kind: 'dm',
          id: 'conversation:dm_1',
          name: 'pear-chat-mini, kjgrok',
          participants: ['pear-chat-mini', 'kjgrok'],
          lastMessageAt: new Date().toISOString()
        }
      ]
    })
    render(React.createElement(ConversationList))
    expect(screen.queryByLabelText('kjgrok')).not.toBeNull()
    expect(screen.queryByLabelText('pear-chat-mini, kjgrok')).toBeNull()
  })

  it('selects a conversation and marks it read', async () => {
    render(React.createElement(ConversationList))
    fireEvent.click(screen.getByLabelText('alice@macbook'))
    await waitFor(() => {
      expect(useChatStore.getState().selectedId).toBe('conversation:thread-1')
    })
  })
})
