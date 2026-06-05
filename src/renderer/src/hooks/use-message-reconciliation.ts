import { useEffect, useMemo } from 'react'
import { getDirectMessageRoomId } from '@/lib/direct-messages'
import { useAgentStore, type ChatMessage } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { type AppTab, useUIStore } from '@/stores/ui-store'
import type {
  BrokerEventStreamDiagnostic,
  BrokerReconciledChatMessage,
  BrokerReconcileMessagesInput,
  PearAPI
} from '@shared/types/ipc'

const DEFAULT_RECONCILE_LIMIT = 50
const DEFAULT_RECONCILE_DEBOUNCE_MS = 750
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

export type MessageReconciliationRequest = BrokerReconcileMessagesInput

interface BrokerWithMessageReconciliation {
  reconcileMessages: (input: MessageReconciliationRequest) => Promise<BrokerReconciledChatMessage[]>
  refreshEventStream?: (projectId?: string, reason?: string) => Promise<void>
  onEventStreamDiagnostic?: (callback: (event: BrokerEventStreamDiagnostic) => void) => () => void
}

interface StoreWithMessageReconciliation {
  reconcileMessages?: (messages: ChatMessage[]) => void
  handleBrokerEvent: (event: Record<string, unknown> & { kind: string }) => void
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
  dispose: () => void
}

function normalizeChannelName(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^#/, '')
  return normalized || null
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
  let disposed = false
  let inFlight: Promise<void> | null = null

  const debug = (event: Omit<MessageReconciliationDebugEvent, 'timestamp'>): void => {
    deps.debug?.({ ...event, timestamp: now() })
  }

  const runNow = async (reason: string): Promise<void> => {
    if (disposed) return
    if (inFlight) {
      debug({ kind: 'skipped', reason })
      return inFlight
    }

    const request = deps.getRequest()
    if (!request) {
      debug({ kind: 'skipped', reason })
      return
    }

    inFlight = (async () => {
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

    try {
      await inFlight
    } finally {
      inFlight = null
    }
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
    dispose: () => {
      disposed = true
      if (timer) {
        deps.clearTimeout(timer)
        timer = null
      }
    }
  }
}

function mergeReconciledMessages(messages: ChatMessage[]): void {
  const state = useAgentStore.getState() as unknown as StoreWithMessageReconciliation
  if (state.reconcileMessages) {
    state.reconcileMessages(messages)
    return
  }

  // Compatibility while the store merge action and IPC surface land together.
  for (const message of messages) {
    state.handleBrokerEvent({
      kind: 'relay_inbound',
      event_id: message.id,
      from: message.from,
      target: message.to,
      body: message.body,
      projectId: message.projectId
    })
  }
}

function debugReconciliation(event: MessageReconciliationDebugEvent): void {
  if (typeof localStorage === 'undefined') return
  if (localStorage.getItem('pear:debug-message-reconciliation') !== '1') return
  console.debug('[broker:message-reconciliation]', event)
}

function refreshEventStream(reason: string): void {
  const projectId = useProjectStore.getState().activeProjectId || undefined
  const broker = window.pear.broker as PearAPI['broker'] & BrokerWithMessageReconciliation
  void broker.refreshEventStream?.(projectId, reason).catch(() => undefined)
}

export function useMessageReconciliation(): void {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeTabId = useUIStore((s) => s.activeTabId)
  const tabs = useUIStore((s) => s.tabs)
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
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
    reconcileMessages: (input) =>
      (window.pear.broker as PearAPI['broker'] & BrokerWithMessageReconciliation).reconcileMessages(input),
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
    if (brokerStatus === 'connected') {
      refreshEventStream('broker-status')
      reconciler.schedule('broker-status')
    }
  }, [brokerStatus, reconciler])

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
    return window.pear.broker.onStatus((status) => {
      if (BROKER_CONNECTED_STATUSES.has(status.status)) {
        refreshEventStream(`broker:${status.status}`)
        reconciler.schedule(`broker:${status.status}`)
      }
    })
  }, [reconciler])

  useEffect(() => {
    const broker = window.pear.broker as PearAPI['broker'] & BrokerWithMessageReconciliation
    if (!broker.onEventStreamDiagnostic) return
    return broker.onEventStreamDiagnostic((event) => {
      if (EVENT_STREAM_RECONCILED_STATUSES.has(event.status)) {
        reconciler.schedule(`event-stream:${event.status}`)
      }
    })
  }, [reconciler])
}
