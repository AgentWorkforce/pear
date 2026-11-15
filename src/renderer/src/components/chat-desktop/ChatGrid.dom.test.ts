// @vitest-environment happy-dom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatGrid, gridColumns } from './ChatGrid'
import { useChatStore } from '@/stores/chat-store'

vi.mock('@/lib/ipc', () => ({
  pear: {
    chat: {
      getHistory: vi.fn(async () => []),
      markRead: vi.fn(async () => undefined),
      readers: vi.fn(async () => [])
    },
    aiHist: { transcript: vi.fn(async () => []) }
  }
}))

afterEach(() => {
  cleanup()
  useChatStore.getState().reset()
  localStorage.clear()
})

describe('ChatGrid', () => {
  it('lays out up to 8 panes in at most 4 columns', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(gridColumns)).toEqual([1, 2, 2, 2, 3, 3, 4, 4])
  })

  it('shows a pane per open conversation and closes one on request', () => {
    useChatStore.setState({
      conversations: [
        { kind: 'dm', id: 'conversation:a', name: 'alice', participants: ['alice'] },
        { kind: 'dm', id: 'conversation:b', name: 'bob', participants: ['bob'] }
      ],
      chatLayout: 'grid',
      gridIds: ['conversation:a', 'conversation:b'],
      selectedId: 'conversation:a',
      history: { 'conversation:a': [], 'conversation:b': [] }
    })
    render(React.createElement(ChatGrid))
    expect(screen.getAllByTestId('grid-pane')).toHaveLength(2)
    expect(screen.getAllByLabelText('Message')).toHaveLength(2)
    fireEvent.click(screen.getByLabelText('Close bob'))
    expect(screen.getAllByTestId('grid-pane')).toHaveLength(1)
  })

  it('explains how to fill an empty grid', () => {
    useChatStore.setState({ chatLayout: 'grid', gridIds: [] })
    render(React.createElement(ChatGrid))
    expect(screen.getByText(/Pick conversations from the list/)).toBeTruthy()
  })
})
