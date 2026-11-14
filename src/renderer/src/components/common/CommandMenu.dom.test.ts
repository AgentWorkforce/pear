// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandMenu } from './CommandMenu'
import { searchConversations, useChatStore } from '@/stores/chat-store'
import { useUIStore } from '@/stores/ui-store'
import type { RelayChatConversation } from '@/lib/ipc'

const chatMocks = vi.hoisted(() => ({
  listConversations: vi.fn(async () => []),
  getHistory: vi.fn(async () => []),
  markRead: vi.fn(async () => undefined),
  onInvalidated: vi.fn(() => () => undefined),
  onMessage: vi.fn(() => () => undefined)
}))

vi.mock('@/lib/ipc', () => ({
  pear: { chat: chatMocks }
}))

vi.mock('@/hooks/use-active-agent-delivery-mode', () => ({
  useActiveAgentDeliveryMode: () => ({
    activeAgent: null,
    currentMode: 'drive',
    canToggle: false,
    toggle: async () => undefined
  })
}))

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

const conversations: RelayChatConversation[] = [
  { kind: 'agent', id: 'relay:agentcorespike', name: 'agentcorespike', cli: 'claude', status: 'online', summary: 'Spike the agent core' },
  { kind: 'dm', id: 'conversation:dm-1', name: 'agentcorespike', participants: ['agentcorespike'], lastMessageAt: minutesAgo(1) },
  { kind: 'agent', id: 'relay:core-infra', name: 'core-infra', cli: 'codex', lastMessageAt: minutesAgo(30) },
  { kind: 'agent', id: 'relay:docs-writer', name: 'docs-writer', summary: 'Rewrite the core docs' },
  { kind: 'channel', id: 'channel:general', name: '#general' }
]

beforeEach(() => {
  useChatStore.getState().reset()
  useChatStore.setState({ conversations })
  useUIStore.setState({ activeDialog: 'command-menu' })
})

afterEach(() => {
  cleanup()
  useUIStore.setState({ activeDialog: null })
  useChatStore.getState().reset()
})

describe('searchConversations', () => {
  it('ranks name prefix, then name match, then summary match, and skips agent-owned DM threads', () => {
    expect(searchConversations(conversations, 'core').map((c) => c.id)).toEqual([
      'relay:core-infra',
      'relay:agentcorespike',
      'relay:docs-writer'
    ])
  })

  it('returns nothing for an empty query and honors the limit', () => {
    expect(searchConversations(conversations, '  ')).toEqual([])
    expect(searchConversations(conversations, 'e', 2)).toHaveLength(2)
  })

  it('matches channels by name without the hash', () => {
    expect(searchConversations(conversations, 'genera').map((c) => c.id)).toEqual(['channel:general'])
  })
})

describe('CommandMenu agent search', () => {
  it('lists matching agents above commands and opens the thread on Enter', async () => {
    render(React.createElement(CommandMenu))
    const input = screen.getByPlaceholderText('Search agents or type a command...')
    fireEvent.change(input, { target: { value: 'spike' } })

    const rows = screen.getAllByRole('button')
    expect(rows[0].textContent).toContain('agentcorespike')
    expect(rows[0].textContent).toContain('Spike the agent core')
    // The DM thread opens from the agent row, so it is not offered twice.
    expect(screen.getAllByText('agentcorespike')).toHaveLength(1)

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(useChatStore.getState().selectedId).toBe('relay:agentcorespike')
    expect(useUIStore.getState().activeDialog).toBeNull()
    const ui = useUIStore.getState()
    expect(ui.tabs.find((tab) => tab.id === ui.activeTabId)?.kind).toBe('agents')
  })

  it('shows only commands until something is typed', () => {
    render(React.createElement(CommandMenu))
    expect(screen.queryByText('agentcorespike')).toBeNull()
    expect(screen.getByText('Toggle theme')).toBeTruthy()
  })
})
