// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from './Composer'
import { useChatStore } from '@/stores/chat-store'
import type { RelayChatConversation } from '@/lib/ipc'

const chatMocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
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

const CONVERSATION: RelayChatConversation = {
  kind: 'dm',
  id: 'conversation:thread-1',
  name: 'alice@macbook',
  participants: ['alice@macbook'],
  lastMessageAt: new Date().toISOString(),
  unreadCount: 0
}

function seed(): void {
  useChatStore.setState({
    conversations: [CONVERSATION],
    conversationsLoading: false,
    conversationsError: null,
    selectedId: 'conversation:thread-1',
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
  useChatStore.getState().reset()
  seed()
  vi.clearAllMocks()
  chatMocks.listConversations.mockResolvedValue([CONVERSATION])
  chatMocks.getHistory.mockResolvedValue([])
  chatMocks.send.mockResolvedValue({
    id: 'm9',
    conversationId: 'thread-1',
    from: 'pear-companion',
    text: 'hello',
    createdAt: new Date().toISOString(),
    mine: true,
    hasServerID: true,
    attachments: []
  })
})

afterEach(() => {
  cleanup()
  useChatStore.getState().reset()
})

describe('Composer', () => {
  it('stays disabled when empty and sends on Enter', async () => {
    render(React.createElement(Composer, { conversationId: 'conversation:thread-1' }))
    const send = screen.getByLabelText('Send message')
    expect((send as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
    expect((send as HTMLButtonElement).disabled).toBe(false)

    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', shiftKey: false })
    await waitFor(() => {
      expect(chatMocks.send).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'dm', to: 'thread-1', text: 'hello' })
      )
    })
    await waitFor(() => {
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('')
    })
  })

  it('restores tap-to-edit drafts from failed pending rows', () => {
    useChatStore.setState({ composerDraft: 'failed text' })
    render(React.createElement(Composer, { conversationId: 'conversation:thread-1' }))
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('failed text')
  })

  it('uploads attachments and sends their file ids', async () => {
    const fileReader = vi.fn(function (this: unknown) {
      const self = this as {
        onload: (() => void) | null
        onerror: (() => void) | null
        result: string | null
        readAsDataURL: (_file: unknown) => void
      }
      self.result = null
      self.onload = null
      self.onerror = null
      self.readAsDataURL = () => {
        self.result = 'data:text/plain;base64,aGVsbG8='
        self.onload?.()
      }
    })
    vi.stubGlobal('FileReader', fileReader)
    try {
      chatMocks.uploadFile.mockResolvedValue({
        file_id: 'mock-file-1',
        filename: 'note.txt',
        content_type: 'text/plain',
        size_bytes: 5,
        downloadUrl: 'data:text/plain;base64,aGVsbG8='
      })
      render(React.createElement(Composer, { conversationId: 'conversation:thread-1' }))
      const input = screen.getByLabelText('Choose files to attach') as HTMLInputElement
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'note.txt', type: 'text/plain' }]
      })
      fireEvent.change(input)
      await waitFor(() => {
        expect(chatMocks.uploadFile).toHaveBeenCalledWith({
          filename: 'note.txt',
          contentType: 'text/plain',
          base64: 'aGVsbG8='
        })
      })
      expect(screen.getByText('note.txt')).toBeTruthy()

      fireEvent.click(screen.getByLabelText('Send message'))
      await waitFor(() => {
        expect(chatMocks.send).toHaveBeenCalledWith(
          expect.objectContaining({ attachments: ['mock-file-1'] })
        )
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
