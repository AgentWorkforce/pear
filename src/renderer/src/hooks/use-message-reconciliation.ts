import { useEffect, useMemo } from 'react'
import { getDirectMessageRoomId } from '@/lib/direct-messages'
import { pear } from '@/lib/ipc'
import { useAgentStore, type ChatMessage } from '@/stores/agent-store'
import { normalizeChannelName as normalizeProjectChannelName, useProjectStore } from '@/stores/project-store'
import { type AppTab, useUIStore } from '@/stores/ui-store'
import type {
  BrokerEventStreamDiagnostic,
  BrokerReconciledChatMessage,
  BrokerReconcileMessagesInput,
  PearAPI
} from '@/lib/ipc'

const DEFAULT_RECONCILE_LIMIT = 50
const DEFAULT_RECONCILE_DEBOUNCE_MS = 750
export const ACTIVE_ROOM_RECONCILE_POLL_MS = 3_000
const BROKER_CONNECTED_STATUSES = new Set([
  'connected',
  'event_stream_connected',
  'event_stream_reconnected',
  'event-stream-connected',
  'event-stream-reconnected'
])

const EVENT_STREAM_RECONCILED_STATUSES = new Set<BrokerEventStreamDiagnostic['status']>([
  'rebound',
  'received'
])

// TODO: Add explicit edit/delete/reaction/thread-reply event kinds here once
// the broker exposes payloads with a stable channel target for those mutations.
const CHANNEL_MESSAGE_EVENT_KINDS = new Set([
  'relay_inbound',
  'relaycast_published',
  'message_delivery_confirmed'
])

export type MessageReconciliationRequest = BrokerReconcileMessagesInput

interface BrokerWithMessageReconciliation {
  reconcileMessages?: (input: MessageReconciliationRequest) => Promise<BrokerReconciledChatMessage[]>
  refreshEventStream?: (projectId?: string, reason?: string) => Promise<void>
  onEventStreamDiagnostic?: (callback: (event: BrokerEventStreamDiagnostic) => void) => () => void
}

interface MessageReconcilerDeps {
  getRequest: () => MessageReconciliationRequest | null
  reconcileMessages: (input: MessageReconciliationRequest) => Promise<BrokerReconciledChatMessage[]>
  mergeMessages: (messages: ChatMessage[]) => void
  setTimeout: (handler: () => void, timeout: number) => number
  clearTimeout: (handle: number) => void
  debounceMs?: number
  now?: () => number
  debug?: (event: MessageReconciliationDebugEvent) => void
}

type BrokerEventLike = Record<string, unknown> & {
  kind?: string
  projectId?: string
}

export interface MessageReconciliationDebugEvent {
  kind: 'scheduled' | 'started' | 'skipped' | 'merged' | 'failed'
  reason: string
  timestamp: number
  messageCount?: number
  error?: string
}

export interface MessageReconciler {
  schedule: (reason: string) => void
  runNow: (reason: string) => Promise<void>
  scheduleRequest: (request: MessageReconciliationRequest, reason: string) => void
  runRequestNow: (request: MessageReconciliationRequest, reason: string) => Promise<void>
  dispose: () => void
}

export function scheduleHumanMessageSentReconciliation(input: {
  lastHumanMessageSentAt: number
  reconciler: Pick<MessageReconciler, 'schedule'>
}): void {
  if (input.lastHumanMessageSentAt > 0) {
    input.reconciler.schedule('human-message-sent')
  }
}

// A `replay_gap` event means the broker's dashboard-WS replay buffer couldn't
// cover a reconnect, so some events (possibly a dropped `relay_inbound` chat
// message) never reached the renderer. There's no single channel/DM target on
// the gap event itself, so — like the other reconnect-signal handlers below
// (broker-status, window-focus, etc.) — this just resyncs whatever room is
// currently active via `reconciler.schedule`, which reuses the same debounced
// `reconcileMessages` IPC round trip and single shared timer as every other
// trigger, so repeated gaps in a short window collapse into one resync.
export function scheduleReplayGapReconciliation(input: {
  lastReplayGapAt: number
  reconciler: Pick<MessageReconciler, 'schedule'>
}): void {
  if (input.lastReplayGapAt > 0) {
    input.reconciler.schedule('replay-gap')
  }
}

function normalizeChannelName(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^#/, '')
  return normalized || null
}

function brokerEventString(event: BrokerEventLike, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function messageReconciliationRequestKey(request: MessageReconciliationRequest): string {
  return JSON.stringify([
    request.projectId,
    request.kind,
    request.kind === 'channel' ? request.channelName : request.conversationId
  ])
}

export function getBrokerEventMessageReconciliationRequest(input: {
  event: BrokerEventLike
  fallbackProjectId?: string | null
  knownChannelNames?: string[]
  limit?: number
}): MessageReconciliationRequest | null {
  const kind = input.event.kind
  if (!kind || !CHANNEL_MESSAGE_EVENT_KINDS.has(kind)) return null

  const projectId = input.event.projectId || input.fallbackProjectId || ''
  if (!projectId.trim()) return null

  const rawTarget = brokerEventString(input.event, 'target') || brokerEventString(input.event, 'to')
  if (!rawTarget) return null

  const channelName = normalizeChannelName(rawTarget)
  if (!channelName) return null

  const normalizedKnownChannels = new Set(
    (input.knownChannelNames || [])
      .map((channel) => normalizeProjectChannelName(channel))
      .filter(Boolean)
  )
  const targetType = brokerEventString(input.event, 'target_type')?.toLowerCase()
  const isChannelTarget =
    rawTarget.trim().startsWith('#') ||
    targetType === 'channel' ||
    normalizedKnownChannels.has(channelName)

  if (!isChannelTarget) return null

  return {
    projectId,
    kind: 'channel',
    channelName,
    limit: input.limit ?? DEFAULT_RECONCILE_LIMIT
  }
}

function getActiveTab(tabs: AppTab[], activeTabId: string): AppTab | undefined {
  return tabs.find((tab) => tab.id === activeTabId)
}

export function getActiveMessageReconciliationRequest(input: {
  activeProjectId: string | null
  activeTab?: AppTab
  limit?: number
}): MessageReconciliationRequest | null {
  const projectId = input.activeTab?.projectId || input.activeProjectId
  if (!projectId) return null

  if (input.activeTab?.kind === 'channel') {
    const channelName = normalizeChannelName(input.activeTab.channelName)
    if (!channelName) return null
    return {
      projectId,
      kind: 'channel',
      channelName,
      limit: input.limit ?? DEFAULT_RECONCILE_LIMIT
    }
  }

  if (input.activeTab?.kind === 'dm') {
    const conversationId = getDirectMessageRoomId(input.activeTab.dmParticipants || [])
    if (!conversationId) return null
    return {
      projectId,
      kind: 'dm',
      conversationId,
      dmParticipants: input.activeTab.dmParticipants || [],
      limit: input.limit ?? DEFAULT_RECONCILE_LIMIT
    }
  }

  return null
}

export function createMessageReconciler(deps: MessageReconcilerDeps): MessageReconciler {
  const debounceMs = deps.debounceMs ?? DEFAULT_RECONCILE_DEBOUNCE_MS
  const now = deps.now ?? (() => Date.now())
  let timer: number | null = null
  const requestTimers = new Map<string, number>()
  const requestInFlight = new Map<string, Promise<void>>()
  const pendingRequestReruns = new Map<string, { request: MessageReconciliationRequest; reason: string }>()
  let disposed = false

  const debug = (event: Omit<MessageReconciliationDebugEvent, 'timestamp'>): void => {
    deps.debug?.({ ...event, timestamp: now() })
  }

  const runRequestNow = async (request: MessageReconciliationRequest, reason: string): Promise<void> => {
    if (disposed) return
    const requestKey = messageReconciliationRequestKey(request)
    const existingRun = requestInFlight.get(requestKey)
    if (existingRun) {
      pendingRequestReruns.set(requestKey, { request, reason })
      debug({ kind: 'scheduled', reason })
      await existingRun
      const followUpRun = requestInFlight.get(requestKey)
      if (followUpRun && followUpRun !== existingRun) {
        await followUpRun
      }
      return
    }

    const currentRun = (async () => {
      debug({ kind: 'started', reason })
      try {
        const messages = await deps.reconcileMessages(request)
        if (disposed) return
        if (messages.length > 0) {
          deps.mergeMessages(messages)
        }
        debug({ kind: 'merged', reason, messageCount: messages.length })
      } catch (err) {
        debug({
          kind: 'failed',
          reason,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })()
    requestInFlight.set(requestKey, currentRun)

    try {
      await currentRun
    } finally {
      if (requestInFlight.get(requestKey) === currentRun) {
        requestInFlight.delete(requestKey)
      }
      const rerun = pendingRequestReruns.get(requestKey)
      pendingRequestReruns.delete(requestKey)
      if (rerun && !disposed) {
        await runRequestNow(rerun.request, rerun.reason)
      }
    }
  }

  const runNow = async (reason: string): Promise<void> => {
    if (disposed) return
    const request = deps.getRequest()
    if (!request) {
      debug({ kind: 'skipped', reason })
      return
    }
    await runRequestNow(request, reason)
  }

  const scheduleRequest = (request: MessageReconciliationRequest, reason: string): void => {
    if (disposed) return
    const requestKey = messageReconciliationRequestKey(request)
    const existingTimer = requestTimers.get(requestKey)
    if (existingTimer) {
      deps.clearTimeout(existingTimer)
    }
    debug({ kind: 'scheduled', reason })
    const nextTimer = deps.setTimeout(() => {
      requestTimers.delete(requestKey)
      void runRequestNow(request, reason)
    }, debounceMs)
    requestTimers.set(requestKey, nextTimer)
  }

  const schedule = (reason: string): void => {
    if (disposed) return
    if (timer) {
      deps.clearTimeout(timer)
    }
    debug({ kind: 'scheduled', reason })
    timer = deps.setTimeout(() => {
      timer = null
      void runNow(reason)
    }, debounceMs)
  }

  return {
    schedule,
    runNow,
    scheduleRequest,
    runRequestNow,
    dispose: () => {
      disposed = true
      if (timer) {
        deps.clearTimeout(timer)
        timer = null
      }
      for (const requestTimer of requestTimers.values()) {
        deps.clearTimeout(requestTimer)
      }
      requestTimers.clear()
      pendingRequestReruns.clear()
    }
  }
}

function mergeReconciledMessages(messages: ChatMessage[]): void {
  useAgentStore.getState().reconcileMessages(messages)
}

function debugReconciliation(event: MessageReconciliationDebugEvent): void {
  if (typeof localStorage === 'undefined') return
  if (localStorage.getItem('pear:debug-message-reconciliation') !== '1') return
  console.debug('[broker:message-reconciliation]', event)
}

function refreshEventStream(reason: string): void {
  const projectId = useProjectStore.getState().activeProjectId || undefined
  const broker = pear?.broker as (PearAPI['broker'] & BrokerWithMessageReconciliation) | undefined
  void broker?.refreshEventStream?.(projectId, reason)?.catch(() => undefined)
}

export function shouldPollActiveRoom(activeRoomKey: string, visibilityState: DocumentVisibilityState): boolean {
  return activeRoomKey !== 'none' && visibilityState === 'visible'
}

export function useMessageReconciliation(): void {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeTabId = useUIStore((s) => s.activeTabId)
  const tabs = useUIStore((s) => s.tabs)
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const lastHumanMessageSentAt = useAgentStore((s) => s.lastHumanMessageSentAt)
  const lastReplayGapAt = useAgentStore((s) => s.lastReplayGapAt)
  const activeTab = getActiveTab(tabs, activeTabId)
  const activeRoomKey = activeTab?.kind === 'channel'
    ? `channel:${activeTab.projectId || activeProjectId || ''}:${normalizeChannelName(activeTab.channelName) || ''}`
    : activeTab?.kind === 'dm'
      ? `dm:${activeTab.projectId || activeProjectId || ''}:${getDirectMessageRoomId(activeTab.dmParticipants || [])}`
      : 'none'

  const reconciler = useMemo(() => createMessageReconciler({
    getRequest: () => {
      const ui = useUIStore.getState()
      const project = useProjectStore.getState()
      return getActiveMessageReconciliationRequest({
        activeProjectId: project.activeProjectId,
        activeTab: getActiveTab(ui.tabs, ui.activeTabId)
      })
    },
    reconcileMessages: (input) => {
      const broker = pear?.broker as (PearAPI['broker'] & BrokerWithMessageReconciliation) | undefined
      return broker?.reconcileMessages?.(input) ?? Promise.resolve([])
    },
    mergeMessages: mergeReconciledMessages,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    debug: debugReconciliation
  }), [])

  useEffect(() => () => reconciler.dispose(), [reconciler])

  useEffect(() => {
    reconciler.schedule('active-room')
  }, [activeRoomKey, reconciler])

  useEffect(() => {
    if (activeRoomKey === 'none') return
    const interval = window.setInterval(() => {
      if (shouldPollActiveRoom(activeRoomKey, document.visibilityState)) {
        reconciler.schedule('active-room-poll')
      }
    }, ACTIVE_ROOM_RECONCILE_POLL_MS)
    return () => window.clearInterval(interval)
  }, [activeRoomKey, reconciler])

  useEffect(() => {
    if (brokerStatus === 'connected') {
      refreshEventStream('broker-status')
      reconciler.schedule('broker-status')
    }
  }, [brokerStatus, reconciler])

  useEffect(() => {
    scheduleHumanMessageSentReconciliation({ lastHumanMessageSentAt, reconciler })
  }, [lastHumanMessageSentAt, reconciler])

  useEffect(() => {
    scheduleReplayGapReconciliation({ lastReplayGapAt, reconciler })
  }, [lastReplayGapAt, reconciler])

  useEffect(() => {
    const scheduleAfterRefresh = (reason: string): void => {
      refreshEventStream(reason)
      reconciler.schedule(reason)
    }
    const onFocus = (): void => scheduleAfterRefresh('window-focus')
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        scheduleAfterRefresh('document-visible')
      }
    }
    const onPageShow = (): void => scheduleAfterRefresh('pageshow')
    const onOnline = (): void => scheduleAfterRefresh('online')

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('online', onOnline)

    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('online', onOnline)
    }
  }, [reconciler])

  useEffect(() => {
    return pear?.broker?.onStatus?.((status) => {
      if (BROKER_CONNECTED_STATUSES.has(status.status)) {
        refreshEventStream(`broker:${status.status}`)
        reconciler.schedule(`broker:${status.status}`)
      }
    })
  }, [reconciler])

  useEffect(() => {
    const broker = pear?.broker as (PearAPI['broker'] & BrokerWithMessageReconciliation) | undefined
    if (!broker?.onEventStreamDiagnostic) return
    return broker.onEventStreamDiagnostic((event) => {
      if (EVENT_STREAM_RECONCILED_STATUSES.has(event.status)) {
        reconciler.schedule(`event-stream:${event.status}`)
      }
    })
  }, [reconciler])

  useEffect(() => {
    return pear?.broker?.onEvent?.((event) => {
      if (!event) return
      const brokerEvent = event as BrokerEventLike
      const project = useProjectStore.getState()
      const projectId = brokerEvent.projectId || project.activeProjectId
      const knownChannelNames = project.projects?.find((entry) => entry.id === projectId)?.channels || []
      const request = getBrokerEventMessageReconciliationRequest({
        event: brokerEvent,
        fallbackProjectId: project.activeProjectId,
        knownChannelNames
      })
      if (!request) return
      reconciler.scheduleRequest(request, `broker-event:${brokerEvent.kind}`)
    })
  }, [reconciler])
}
