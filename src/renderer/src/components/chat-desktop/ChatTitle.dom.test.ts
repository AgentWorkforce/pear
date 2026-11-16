// @vitest-environment happy-dom

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatTitle, conversationDetails } from './ChatTitle'
import { useChatStore } from '@/stores/chat-store'

afterEach(() => {
  cleanup()
  useChatStore.getState().reset()
})

describe('ChatTitle', () => {
  it('shows the open agent with its details and summary', () => {
    useChatStore.setState({
      conversations: [{
        kind: 'agent',
        id: 'relay:claude-infra-7d',
        name: 'claude-infra-7d',
        cli: 'claude',
        status: 'online',
        project: 'infra',
        machine: 'dogpatch-mini',
        summary: 'Rotating the RDS certificates'
      }],
      selectedId: 'relay:claude-infra-7d'
    })
    render(React.createElement(ChatTitle))
    const title = screen.getByTestId('chat-title')
    expect(title.textContent).toContain('claude-infra-7d')
    expect(title.textContent).toContain('claude · online · infra · dogpatch-mini')
    expect(title.textContent).toContain('Rotating the RDS certificates')
  })

  it('shows the whole summary, wrapped rather than cut off', () => {
    const summary = 'Requested by Khaliq (via testingrok). AUDIT + PROPOSAL ONLY: do not push.\nReview every AGENTS.md and propose fixes.'
    useChatStore.setState({
      conversations: [{ kind: 'agent', id: 'relay:agents-md-auditor', name: 'agents-md-auditor', summary }],
      selectedId: 'relay:agents-md-auditor'
    })
    render(React.createElement(ChatTitle))
    const shown = screen.getByTestId('chat-title-summary')
    expect(shown.textContent).toBe(summary)
    expect(shown.className).not.toContain('truncate')
    expect(shown.className).toContain('whitespace-pre-wrap')
  })

  it('renders nothing when no conversation is open', () => {
    useChatStore.setState({ conversations: [], selectedId: null })
    render(React.createElement(ChatTitle))
    expect(screen.queryByTestId('chat-title')).toBeNull()
  })

  it('describes people and channels plainly', () => {
    expect(conversationDetails({ kind: 'agent', id: 'relay:khaliq', name: 'khaliq', human: true, status: 'online' })).toBe('person · online')
    expect(conversationDetails({ kind: 'channel', id: 'channel:general', name: '#general' })).toBe('Channel')
  })
})
