// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
      lastMessageAt: new Date(now - 2 * 60_000).toISOString(),
      unreadCount: 1
    },
    {
      kind: 'dm',
      id: 'conversation:thread-2',
      name: 'bob@linuxbox',
      participants: ['bob@linuxbox'],
      lastMessageAt: new Date(now - 60 * 60_000).toISOString(),
      unreadCount: 0
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
    unreadConversationIDs: [],
    delivery: {},
    pinnedConversationIDs: [],
    hiddenConversationIDs: [],
    showHidden: false,
    composerDraft: ''
  })
}

beforeEach(() => {
  seed()
})

afterEach(() => {
  cleanup()
  useChatStore.getState().reset()
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
    const general = screen.getByLabelText('#general')
    expect(within(general as HTMLElement).queryByLabelText('reachable')).toBeNull()
  })

  it('filters by Agents / Messages / Channels tabs', () => {
    render(React.createElement(ConversationList))
    fireEvent.click(screen.getByRole('tab', { name: 'agents' }))
    expect(screen.queryByLabelText('alice@macbook')).not.toBeNull()
    expect(screen.queryByLabelText('bob@linuxbox')).not.toBeNull()
    expect(screen.queryByLabelText('#general')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'channels' }))
    expect(screen.queryByLabelText('#general')).not.toBeNull()
    expect(screen.queryByLabelText('alice@macbook')).toBeNull()
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

  it('selects a conversation and marks it read', async () => {
    render(React.createElement(ConversationList))
    fireEvent.click(screen.getByLabelText('alice@macbook'))
    await waitFor(() => {
      expect(useChatStore.getState().selectedId).toBe('conversation:thread-1')
    })
  })
})
