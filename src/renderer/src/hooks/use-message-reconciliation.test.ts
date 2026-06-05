import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MessageReconciliationRequest } from './use-message-reconciliation'
import type { ChatMessage } from '@/stores/agent-store'

vi.mock('@/lib/ipc', () => ({
  pear: {
    broker: {},
    project: {}
  }
}))

let hooks: typeof import('./use-message-reconciliation')
let agentStore: typeof import('@/stores/agent-store')

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    }
  })

  hooks = await import('./use-message-reconciliation')
  agentStore = await import('@/stores/agent-store')
})

const channelMessage: ChatMessage = {
  id: 'msg-1',
  from: 'codex-1',
  to: '#general',
  body: 'missed while idle',
  timestamp: 1_717_000_000_000,
  isHuman: false,
  projectId: 'project-1'
}

describe('getActiveMessageReconciliationRequest', () => {
  it('builds a bounded channel reconciliation request for the active tab', () => {
    expect(hooks.getActiveMessageReconciliationRequest({
      activeProjectId: 'fallback-project',
      activeTab: {
        id: 'channel:project-1:general',
        kind: 'channel',
        title: 'general',
        projectId: 'project-1',
        channelName: '#general'
      }
    })).toEqual({
      projectId: 'project-1',
      kind: 'channel',
      channelName: 'general',
      limit: 50
    })
  })

  it('builds a DM request from the active tab participants', () => {
    expect(hooks.getActiveMessageReconciliationRequest({
      activeProjectId: 'project-1',
      activeTab: {
        id: 'dm:project-1:human|worker',
        kind: 'dm',
        title: 'Worker',
        dmParticipants: ['Worker', 'human']
      },
      limit: 25
    })).toEqual({
      projectId: 'project-1',
      kind: 'dm',
      conversationId: 'human|worker',
      dmParticipants: ['Worker', 'human'],
      limit: 25
    })
  })

  it('does not reconcile non-chat tabs', () => {
    expect(hooks.getActiveMessageReconciliationRequest({
      activeProjectId: 'project-1',
      activeTab: {
        id: 'agents',
        kind: 'agents',
        title: 'Agents'
      }
    })).toBeNull()
  })
})

describe('createMessageReconciler', () => {
  afterEach(() => {
    vi.useRealTimers()
    agentStore.useAgentStore.getState().clearAll()
  })

  it('debounces triggers, fetches canonical messages, and merges the result', async () => {
    vi.useFakeTimers()
    const request: MessageReconciliationRequest = {
      projectId: 'project-1',
      kind: 'channel',
      channelName: 'general',
      limit: 50
    }
    const reconcileMessages = vi.fn(async () => [channelMessage])
    const mergeMessages = vi.fn()
    const debug = vi.fn()
    const reconciler = hooks.createMessageReconciler({
      getRequest: () => request,
      reconcileMessages,
      mergeMessages,
      setTimeout: setTimeout as unknown as typeof window.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof window.clearTimeout,
      debounceMs: 250,
      now: () => 123,
      debug
    })

    reconciler.schedule('broker-status')
    reconciler.schedule('window-focus')
    await vi.advanceTimersByTimeAsync(249)

    expect(reconcileMessages).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(reconcileMessages).toHaveBeenCalledTimes(1)
    expect(reconcileMessages).toHaveBeenCalledWith(request)
    expect(mergeMessages).toHaveBeenCalledTimes(1)
    expect(mergeMessages).toHaveBeenCalledWith([channelMessage])
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merged',
      reason: 'window-focus',
      messageCount: 1,
      timestamp: 123
    }))
  })

  it('skips fetches when no active chat room can be reconciled', async () => {
    vi.useFakeTimers()
    const reconcileMessages = vi.fn(async () => [channelMessage])
    const mergeMessages = vi.fn()
    const reconciler = hooks.createMessageReconciler({
      getRequest: () => null,
      reconcileMessages,
      mergeMessages,
      setTimeout: setTimeout as unknown as typeof window.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof window.clearTimeout,
      debounceMs: 1
    })

    reconciler.schedule('active-room')
    await vi.advanceTimersByTimeAsync(1)

    expect(reconcileMessages).not.toHaveBeenCalled()
    expect(mergeMessages).not.toHaveBeenCalled()
  })

  it('merges reconciled messages into the Zustand store and dedups by id', () => {
    const store = agentStore.useAgentStore.getState()

    store.reconcileMessages([channelMessage])
    store.reconcileMessages([{
      ...channelMessage,
      body: 'updated canonical body',
      timestamp: channelMessage.timestamp + 1
    }])

    const messages = agentStore.useAgentStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: channelMessage.id,
      body: 'updated canonical body',
      timestamp: channelMessage.timestamp + 1
    })
  })
})
