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

function channelRequest(channelName: string): MessageReconciliationRequest {
  return {
    projectId: 'project-1',
    kind: 'channel',
    channelName,
    limit: 50
  }
}

function deferredMessages(): {
  promise: Promise<ChatMessage[]>
  resolve: (messages: ChatMessage[]) => void
} {
  let resolve!: (messages: ChatMessage[]) => void
  const promise = new Promise<ChatMessage[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
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

  it('polls only visible active chat rooms', () => {
    expect(hooks.shouldPollActiveRoom('channel:project-1:general', 'visible')).toBe(true)
    expect(hooks.shouldPollActiveRoom('dm:project-1:human|worker', 'visible')).toBe(true)
    expect(hooks.shouldPollActiveRoom('none', 'visible')).toBe(false)
    expect(hooks.shouldPollActiveRoom('channel:project-1:general', 'hidden')).toBe(false)
  })

  it('builds a channel reconciliation request from broker channel message events', () => {
    expect(hooks.getBrokerEventMessageReconciliationRequest({
      event: {
        kind: 'relaycast_published',
        event_id: 'evt-1',
        to: 'general',
        target_type: 'channel',
        projectId: 'project-1'
      },
      knownChannelNames: ['general']
    })).toEqual({
      projectId: 'project-1',
      kind: 'channel',
      channelName: 'general',
      limit: 50
    })

    expect(hooks.getBrokerEventMessageReconciliationRequest({
      event: {
        kind: 'message_delivery_confirmed',
        event_id: 'evt-2',
        to: '#general'
      },
      fallbackProjectId: 'project-1'
    })).toEqual({
      projectId: 'project-1',
      kind: 'channel',
      channelName: 'general',
      limit: 50
    })
  })

  it('does not treat agent-targeted delivery events as channel updates', () => {
    expect(hooks.getBrokerEventMessageReconciliationRequest({
      event: {
        kind: 'message_delivery_confirmed',
        event_id: 'evt-3',
        to: 'codex-1',
        projectId: 'project-1'
      },
      knownChannelNames: ['general']
    })).toBeNull()
  })

  it('schedules reconciliation after a human message send timestamp changes', () => {
    const reconciler = { schedule: vi.fn() }

    hooks.scheduleHumanMessageSentReconciliation({
      lastHumanMessageSentAt: 0,
      reconciler
    })
    hooks.scheduleHumanMessageSentReconciliation({
      lastHumanMessageSentAt: 1_717_000_000_000,
      reconciler
    })

    expect(reconciler.schedule).toHaveBeenCalledTimes(1)
    expect(reconciler.schedule).toHaveBeenCalledWith('human-message-sent')
  })

  it('schedules reconciliation after a replay-gap timestamp changes', () => {
    const reconciler = { schedule: vi.fn() }

    hooks.scheduleReplayGapReconciliation({
      lastReplayGapAt: 0,
      reconciler
    })
    hooks.scheduleReplayGapReconciliation({
      lastReplayGapAt: 1_717_000_000_000,
      reconciler
    })

    expect(reconciler.schedule).toHaveBeenCalledTimes(1)
    expect(reconciler.schedule).toHaveBeenCalledWith('replay-gap')
  })

  it('does not schedule reconciliation when no replay gap has occurred yet', () => {
    const reconciler = { schedule: vi.fn() }

    hooks.scheduleReplayGapReconciliation({ lastReplayGapAt: 0, reconciler })

    expect(reconciler.schedule).not.toHaveBeenCalled()
  })
})

describe('createMessageReconciler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

  it('queues a rerun when a trigger fires during an in-flight reconciliation', async () => {
    vi.useFakeTimers()
    const request: MessageReconciliationRequest = {
      projectId: 'project-1',
      kind: 'channel',
      channelName: 'general',
      limit: 50
    }
    const firstFetch = deferredMessages()
    const secondFetch = deferredMessages()
    const secondMessage = { ...channelMessage, id: 'msg-2', body: 'arrived during first fetch' }
    const reconcileMessages = vi.fn()
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise)
    const mergeMessages = vi.fn()
    const reconciler = hooks.createMessageReconciler({
      getRequest: () => request,
      reconcileMessages,
      mergeMessages,
      setTimeout: setTimeout as unknown as typeof window.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof window.clearTimeout,
      debounceMs: 1
    })

    reconciler.schedule('initial')
    await vi.advanceTimersByTimeAsync(1)
    expect(reconcileMessages).toHaveBeenCalledTimes(1)

    reconciler.schedule('window-focus')
    await vi.advanceTimersByTimeAsync(1)
    expect(reconcileMessages).toHaveBeenCalledTimes(1)

    firstFetch.resolve([channelMessage])
    await Promise.resolve()
    await Promise.resolve()

    expect(reconcileMessages).toHaveBeenCalledTimes(2)
    expect(reconcileMessages).toHaveBeenNthCalledWith(2, request)

    secondFetch.resolve([secondMessage])
    await Promise.resolve()
    await Promise.resolve()

    expect(mergeMessages).toHaveBeenNthCalledWith(1, [channelMessage])
    expect(mergeMessages).toHaveBeenNthCalledWith(2, [secondMessage])
  })

  it('coalesces duplicate targeted channel event reconciliations by room', async () => {
    vi.useFakeTimers()
    const request = channelRequest('general')
    const reconcileMessages = vi.fn(async () => [channelMessage])
    const mergeMessages = vi.fn()
    const debug = vi.fn()
    const reconciler = hooks.createMessageReconciler({
      getRequest: () => null,
      reconcileMessages,
      mergeMessages,
      setTimeout: setTimeout as unknown as typeof window.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof window.clearTimeout,
      debounceMs: 10,
      now: () => 123,
      debug
    })

    reconciler.scheduleRequest(request, 'broker-event:relaycast_published')
    reconciler.scheduleRequest(request, 'broker-event:message_delivery_confirmed')
    await vi.advanceTimersByTimeAsync(9)

    expect(reconcileMessages).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(reconcileMessages).toHaveBeenCalledTimes(1)
    expect(reconcileMessages).toHaveBeenCalledWith(request)
    expect(mergeMessages).toHaveBeenCalledTimes(1)
    expect(mergeMessages).toHaveBeenCalledWith([channelMessage])
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merged',
      reason: 'broker-event:message_delivery_confirmed',
      messageCount: 1,
      timestamp: 123
    }))
  })

  it('reruns dirty in-flight targeted reconciliations independently per channel', async () => {
    vi.useFakeTimers()
    const generalRequest = channelRequest('general')
    const triageRequest = channelRequest('triage')
    const generalFirst = deferredMessages()
    const generalSecond = deferredMessages()
    const triageFirst = deferredMessages()
    const triageSecond = deferredMessages()
    const reconcileMessages = vi.fn((request: MessageReconciliationRequest) => {
      if (request.kind === 'channel' && request.channelName === 'general') {
        return reconcileMessages.mock.calls.filter(([candidate]) =>
          candidate.kind === 'channel' && candidate.channelName === 'general'
        ).length === 1
          ? generalFirst.promise
          : generalSecond.promise
      }
      return reconcileMessages.mock.calls.filter(([candidate]) =>
        candidate.kind === 'channel' && candidate.channelName === 'triage'
      ).length === 1
        ? triageFirst.promise
        : triageSecond.promise
    })
    const mergeMessages = vi.fn()
    const reconciler = hooks.createMessageReconciler({
      getRequest: () => null,
      reconcileMessages,
      mergeMessages,
      setTimeout: setTimeout as unknown as typeof window.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof window.clearTimeout,
      debounceMs: 1
    })

    reconciler.scheduleRequest(generalRequest, 'broker-event:general:first')
    reconciler.scheduleRequest(triageRequest, 'broker-event:triage:first')
    await vi.advanceTimersByTimeAsync(1)

    expect(reconcileMessages).toHaveBeenCalledTimes(2)
    expect(reconcileMessages).toHaveBeenNthCalledWith(1, generalRequest)
    expect(reconcileMessages).toHaveBeenNthCalledWith(2, triageRequest)

    reconciler.scheduleRequest(generalRequest, 'broker-event:general:second')
    reconciler.scheduleRequest(triageRequest, 'broker-event:triage:second')
    await vi.advanceTimersByTimeAsync(1)

    expect(reconcileMessages).toHaveBeenCalledTimes(2)

    generalFirst.resolve([{ ...channelMessage, id: 'general-1', body: 'general first' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(reconcileMessages).toHaveBeenCalledTimes(3)
    expect(reconcileMessages).toHaveBeenNthCalledWith(3, generalRequest)

    triageFirst.resolve([{ ...channelMessage, id: 'triage-1', to: '#triage', body: 'triage first' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(reconcileMessages).toHaveBeenCalledTimes(4)
    expect(reconcileMessages).toHaveBeenNthCalledWith(4, triageRequest)

    generalSecond.resolve([{ ...channelMessage, id: 'general-2', body: 'general second' }])
    triageSecond.resolve([{ ...channelMessage, id: 'triage-2', to: '#triage', body: 'triage second' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(mergeMessages).toHaveBeenCalledTimes(4)
    expect(mergeMessages).toHaveBeenNthCalledWith(3, [{ ...channelMessage, id: 'general-2', body: 'general second' }])
    expect(mergeMessages).toHaveBeenNthCalledWith(4, [{ ...channelMessage, id: 'triage-2', to: '#triage', body: 'triage second' }])
  })

  it('awaits a queued dirty rerun when runRequestNow joins an in-flight request', async () => {
    const request = channelRequest('general')
    const firstFetch = deferredMessages()
    const secondFetch = deferredMessages()
    const reconcileMessages = vi.fn()
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise)
    const mergeMessages = vi.fn()
    const reconciler = hooks.createMessageReconciler({
      getRequest: () => null,
      reconcileMessages,
      mergeMessages,
      setTimeout: setTimeout as unknown as typeof window.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof window.clearTimeout,
      debounceMs: 1
    })
    let secondRunSettled = false

    void reconciler.runRequestNow(request, 'broker-event:first')
    await Promise.resolve()

    const secondRun = reconciler.runRequestNow(request, 'broker-event:second')
    secondRun.then(() => {
      secondRunSettled = true
    })
    await Promise.resolve()

    expect(reconcileMessages).toHaveBeenCalledTimes(1)

    firstFetch.resolve([{ ...channelMessage, id: 'general-1', body: 'general first' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(reconcileMessages).toHaveBeenCalledTimes(2)
    expect(secondRunSettled).toBe(false)

    secondFetch.resolve([{ ...channelMessage, id: 'general-2', body: 'general second' }])
    await secondRun

    expect(secondRunSettled).toBe(true)
    expect(mergeMessages).toHaveBeenCalledTimes(2)
  })

  it('cleans up keyed timers and suppresses in-flight merges after dispose', async () => {
    vi.useFakeTimers()
    const generalRequest = channelRequest('general')
    const triageRequest = channelRequest('triage')
    const inFlight = deferredMessages()
    const clearTimeout = vi.fn((handle: number) => globalThis.clearTimeout(handle))
    const reconcileMessages = vi.fn(() => inFlight.promise)
    const mergeMessages = vi.fn()
    const reconciler = hooks.createMessageReconciler({
      getRequest: () => null,
      reconcileMessages,
      mergeMessages,
      setTimeout: setTimeout as unknown as typeof window.setTimeout,
      clearTimeout,
      debounceMs: 10
    })

    void reconciler.runRequestNow(generalRequest, 'broker-event:general:first')
    void reconciler.runRequestNow(generalRequest, 'broker-event:general:second')
    reconciler.scheduleRequest(generalRequest, 'broker-event:general:timer')
    reconciler.scheduleRequest(triageRequest, 'broker-event:triage:timer')

    expect(reconcileMessages).toHaveBeenCalledTimes(1)

    reconciler.dispose()
    expect(clearTimeout).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(10)
    expect(reconcileMessages).toHaveBeenCalledTimes(1)

    inFlight.resolve([channelMessage])
    await Promise.resolve()
    await Promise.resolve()

    expect(mergeMessages).not.toHaveBeenCalled()
    expect(reconcileMessages).toHaveBeenCalledTimes(1)
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

    const messagesAfterUpdate = agentStore.useAgentStore.getState().messages
    store.reconcileMessages([messagesAfterUpdate[0]])
    expect(agentStore.useAgentStore.getState().messages).toBe(messagesAfterUpdate)
  })

  it('tracks optimistic human sends for reconciliation triggers', () => {
    const now = 1_717_000_123_000
    vi.spyOn(Date, 'now').mockReturnValue(now)

    agentStore.useAgentStore.getState().addHumanMessage('#general', 'hello from human', 'project-1')

    const state = agentStore.useAgentStore.getState()
    expect(state.lastHumanMessageSentAt).toBe(now)
    expect(state.messages[0]).toMatchObject({
      from: 'human',
      to: '#general',
      body: 'hello from human',
      projectId: 'project-1'
    })
  })

  it('wires human message sends into the reconciliation hook', () => {
    const source = hooks.useMessageReconciliation.toString()
    expect(source).toContain('s.lastHumanMessageSentAt')
    expect(source).toMatch(/scheduleHumanMessageSentReconciliation\([\s\S]*lastHumanMessageSentAt[\s\S]*reconciler/)
    expect(source).toMatch(/\[lastHumanMessageSentAt,\s*reconciler\]/)
  })

  it('wires replay-gap events into the reconciliation hook', () => {
    const source = hooks.useMessageReconciliation.toString()
    expect(source).toContain('s.lastReplayGapAt')
    expect(source).toMatch(/scheduleReplayGapReconciliation\([\s\S]*lastReplayGapAt[\s\S]*reconciler/)
    expect(source).toMatch(/\[lastReplayGapAt,\s*reconciler\]/)
  })

  it('wires active chat rooms into periodic reconciliation', () => {
    const source = hooks.useMessageReconciliation.toString()
    expect(source).toContain('ACTIVE_ROOM_RECONCILE_POLL_MS')
    expect(source).toContain('active-room-poll')
    expect(source).toMatch(/shouldPollActiveRoom\([\s\S]*activeRoomKey[\s\S]*document\.visibilityState/)
  })
})
