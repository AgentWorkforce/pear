// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ThreadView } from './ThreadView'
import { useChatStore } from '@/stores/chat-store'
import type { RelayChatConversation, RelayChatMessage } from '@/lib/ipc'

vi.mock('@/lib/ipc', () => ({
  pear: {
    chat: {
      listConversations: vi.fn(async () => []),
      getHistory: vi.fn(async () => []),
      send: vi.fn(),
      markRead: vi.fn(async () => undefined),
      joinChannel: vi.fn(),
      uploadFile: vi.fn(),
      onInvalidated: vi.fn(() => () => undefined),
      onMessage: vi.fn(() => () => undefined)
    }
  }
}))

const CONVERSATION: RelayChatConversation = {
  kind: 'channel',
  id: 'channel:general',
  name: '#general',
  isMember: true
}

function atNoonDaysAgo(days: number, minutes = 0): string {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return new Date(date.getTime() - days * 86_400_000 + minutes * 60_000).toISOString()
}

function msg(
  id: string,
  from: string,
  text: string,
  mine: boolean,
  createdAt: string,
  extra?: Partial<RelayChatMessage>
): RelayChatMessage {
  return {
    id,
    channelName: 'general',
    from,
    text,
    createdAt,
    mine,
    hasServerID: true,
    attachments: [],
    ...extra
  }
}

function seedHistory(messages: RelayChatMessage[], delivery: Record<string, boolean> = {}): void {
  useChatStore.setState({
    conversations: [CONVERSATION],
    conversationsLoading: false,
    conversationsError: null,
    selectedId: 'channel:general',
    history: { 'channel:general': messages },
    historyLoading: {},
    historyError: {},
    pending: {},
    unreadConversationIDs: [],
    delivery,
    pinnedConversationIDs: [],
    hiddenConversationIDs: [],
    showHidden: false,
    composerDraft: ''
  })
}

beforeEach(() => {
  useChatStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useChatStore.getState().reset()
  vi.clearAllMocks()
})

describe('ThreadView', () => {
  it('renders day dividers and groups same-sender rows inside 15 minutes', () => {
    seedHistory([
      msg('m1', 'alice', 'yesterday', false, atNoonDaysAgo(1)),
      msg('m2', 'alice', 'morning', false, atNoonDaysAgo(0, -30)),
      msg('m3', 'alice', 'still morning', false, atNoonDaysAgo(0, -25)),
      msg('m4', 'alice', 'much later', false, atNoonDaysAgo(0, 60))
    ])
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    // Yesterday + Today dividers.
    expect(screen.getByText('Yesterday')).toBeTruthy()
    expect(screen.getByText('Today')).toBeTruthy()
    // m2+m3 grouped under one sender chip; m1 and m4 stand alone.
    expect(screen.getAllByText('alice')).toHaveLength(3)
  })

  it('lays mine right and theirs left, with sender chips on theirs', () => {
    seedHistory([
      msg('m1', 'alice', 'hello there', false, atNoonDaysAgo(0)),
      msg('m2', 'me', 'my reply', true, atNoonDaysAgo(0, 1))
    ])
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    const mine = screen.getByText('my reply').closest('[data-testid="thread-row"]')
    const theirs = screen.getByText('hello there').closest('[data-testid="thread-row"]')
    expect(mine?.getAttribute('data-mine')).toBe('true')
    expect(mine?.className).toContain('justify-end')
    expect(theirs?.getAttribute('data-mine')).toBe('false')
    expect(theirs?.className).toContain('justify-start')
    expect(screen.getByText('alice')).toBeTruthy()
  })

  it('linkifies URLs and offers attachment downloads', () => {
    seedHistory([
      msg('m1', 'alice', 'see https://example.com/review now', false, atNoonDaysAgo(0), {
        attachments: [
          {
            file_id: 'f1',
            filename: 'report.pdf',
            content_type: 'application/pdf',
            size_bytes: 2048,
            downloadUrl: 'https://files.example.com/report.pdf'
          }
        ]
      })
    ])
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    const link = screen.getByRole('link', { name: 'https://example.com/review' })
    expect(link.getAttribute('href')).toBe('https://example.com/review')
    const download = screen.getByRole('link', { name: /report\.pdf/ })
    expect(download.getAttribute('href')).toBe('https://files.example.com/report.pdf')
    expect(download.getAttribute('download')).toBe('report.pdf')
  })

  it('shows the readers delivery label under the last own message', () => {
    seedHistory(
      [
        msg('m1', 'me', 'first', true, atNoonDaysAgo(0), { delivered: false }),
        msg('m2', 'alice', 'ack', false, atNoonDaysAgo(0, 1)),
        msg('m3', 'me', 'second', true, atNoonDaysAgo(0, 2), { delivered: true })
      ],
      { m1: false, m3: true }
    )
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    expect(screen.queryByText('Sent')).toBeNull()
    expect(screen.getByText('Delivered')).toBeTruthy()
  })

  it('shows a loading state before history arrives', () => {
    seedHistory([])
    useChatStore.setState({ history: {} })
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    expect(screen.getByText('Loading conversation…')).toBeTruthy()
    expect(screen.queryByText(/No messages yet/)).toBeNull()
  })

  it('shows the agent session conversation in the thread', () => {
    seedHistory([msg('m1', 'alice', 'live reply', false, atNoonDaysAgo(0))])
    useChatStore.setState({
      sessionTurns: {
        'channel:general': [
          { id: 't1', role: 'user', text: 'Fix the reconnect', timestampMs: Date.now() - 3_600_000 },
          { id: 't2', role: 'assistant', text: 'The broker reconnects.', timestampMs: Date.now() - 3_500_000 }
        ]
      }
    })
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    expect(screen.getByText('Fix the reconnect')).toBeTruthy()
    expect(screen.getByText('The broker reconnects.')).toBeTruthy()
    expect(screen.getByText('live reply')).toBeTruthy()
  })

  it('labels the person You on the right and gives the agent its tool avatar on the left', () => {
    const agent: RelayChatConversation = { kind: 'agent', id: 'relay:alice', name: 'alice', participants: ['alice'], cli: 'claude' }
    useChatStore.setState({
      conversations: [agent],
      history: { 'relay:alice': [] },
      historyLoading: {},
      historyError: {},
      sessionTurns: {
        'relay:alice': [
          { id: 't1', role: 'user', text: 'Ship it', timestampMs: Date.now() - 60_000 },
          { id: 't2', role: 'assistant', text: 'Shipping now.', timestampMs: Date.now() - 50_000 },
          { id: 't3', role: 'assistant', text: 'Done.', timestampMs: Date.now() - 40_000 }
        ]
      }
    })
    render(React.createElement(ThreadView, { conversationId: 'relay:alice' }))
    expect(screen.getByText('You').closest('[data-testid="thread-row"]')?.className).toContain('justify-end')
    expect(screen.getByText('Shipping now.').closest('[data-testid="thread-row"]')?.className).toContain('justify-start')
    // One avatar and name for the agent's two grouped replies.
    expect(screen.getAllByLabelText('claude agent')).toHaveLength(1)
    expect(screen.getAllByText('alice')).toHaveLength(1)
    const mine = screen.getByLabelText('You')
    expect(mine.closest('[data-testid="thread-row"]')?.getAttribute('data-mine')).toBe('true')
  })

  it('shows optimistic Sending rows and tap-to-edit on failure', () => {
    seedHistory([msg('m1', 'alice', 'hi', false, atNoonDaysAgo(0))])
    useChatStore.setState({
      pending: {
        'channel:general': [
          {
            localId: 'local:1',
            conversationId: 'channel:general',
            kind: 'channel',
            to: 'general',
            text: 'in flight',
            attachmentIds: [],
            status: 'sending',
            createdAt: new Date().toISOString()
          },
          {
            localId: 'local:2',
            conversationId: 'channel:general',
            kind: 'channel',
            to: 'general',
            text: 'failed text',
            attachmentIds: [],
            status: 'failed',
            error: 'offline',
            createdAt: new Date().toISOString()
          }
        ]
      }
    })
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.getByText(/tap to edit/)).toBeTruthy()

    fireEvent.click(screen.getByText('failed text'))
    expect(useChatStore.getState().composerDraft).toBe('failed text')
    expect(useChatStore.getState().pending['channel:general'] || []).toHaveLength(1)
  })

  it('renders message text as selectable text, not inside a button', () => {
    seedHistory([msg('m1', 'alice', 'copy me please', false, atNoonDaysAgo(0))])
    render(React.createElement(ThreadView, { conversationId: 'channel:general' }))
    const body = screen.getByText('copy me please').closest('[data-testid="message-body"]')
    expect(body?.tagName).toBe('DIV')
    expect(body?.getAttribute('role')).toBeNull()
    expect(screen.getByText('copy me please').closest('button')).toBeNull()
  })
})
