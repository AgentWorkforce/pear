import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  pear,
  type ChatInvalidatedEvent,
  type ChatMessageEvent,
  type RelayChatAttachment,
  type RelayChatConversation,
  type RelayChatMessage
} from '@/lib/ipc'

/**
 * Renderer chat-desktop state on top of the phase-1 `chat.*` IPC bridge.
 *
 * Main owns the 30s poll scheduler; this store mirrors the scheduler's
 * broadcasts (`chat:invalidated` / `chat:message`), adds its own 30s
 * list refresh + a foreground (focus/visible) refresh, and loads full
 * history per opened conversation — channel history never rides the
 * background tick, only open / foreground / manual refresh.
 */

/** A DM participant is reachable when its thread spoke in the last 5 minutes. */
export const CHAT_REACHABLE_WINDOW_MS = 5 * 60 * 1_000

/** Pending rows use `local:*` ids so the server echo never collides with them. */
export const CHAT_OPTIMISTIC_ID_PREFIX = 'local:'

export interface ChatPendingMessage {
  localId: string
  conversationId: string
  kind: 'dm' | 'channel'
  to: string
  text: string
  attachmentIds: string[]
  status: 'sending' | 'failed'
  error?: string
  createdAt: string
}

interface ChatDesktopState {
  conversations: RelayChatConversation[]
  conversationsLoading: boolean
  conversationsError: string | null
  selectedId: string | null
  history: Record<string, RelayChatMessage[]>
  historyLoading: Record<string, boolean>
  historyError: Record<string, string | null>
  pending: Record<string, ChatPendingMessage[]>
  unreadConversationIDs: string[]
  /** messageId -> delivered (readers-based, non-sender rule applied in main). */
  delivery: Record<string, boolean>
  pinnedConversationIDs: string[]
  hiddenConversationIDs: string[]
  showHidden: boolean
  composerDraft: string
  lastRefreshAt: string | null

  refreshConversations: () => Promise<void>
  selectConversation: (id: string | null) => Promise<void>
  loadHistory: (id: string) => Promise<void>
  sendMessage: (text: string, attachmentIds?: string[]) => Promise<void>
  editFailedPending: (localId: string) => void
  retryPending: (localId: string) => Promise<void>
  togglePin: (id: string) => void
  toggleHide: (id: string) => void
  setShowHidden: (show: boolean) => void
  setComposerDraft: (draft: string) => void
  applyChatMessage: (event: ChatMessageEvent) => void
  applyInvalidated: (event: ChatInvalidatedEvent) => void
  startSync: () => void
  stopSync: () => void
  reset: () => void
}

/** `name@host` -> `host`. Bare names have no machine to filter on. */
export function parseChatHost(participant: string): string | null {
  const at = participant.lastIndexOf('@')
  if (at <= 0 || at === participant.length - 1) return null
  return participant.slice(at + 1)
}

/** Distinct machine hosts across DM participants, sorted for the filter. */
export function selectChatHosts(conversations: RelayChatConversation[]): string[] {
  const hosts = new Set<string>()
  for (const conversation of conversations) {
    if (conversation.kind !== 'dm') continue
    for (const participant of conversation.participants || []) {
      const host = parseChatHost(participant)
      if (host) hosts.add(host)
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b))
}

/**
 * Reachability without a roster endpoint on the `chat.*` bridge: a DM
 * thread counts as reachable when its last message is inside the 5-minute
 * window. Channels aggregate many agents, so no dot is derived for them.
 */
export function isConversationReachable(
  conversation: RelayChatConversation,
  now: number = Date.now()
): boolean {
  if (conversation.kind !== 'dm' || !conversation.lastMessageAt) return false
  const at = Date.parse(conversation.lastMessageAt)
  if (!Number.isFinite(at)) return false
  return now - at <= CHAT_REACHABLE_WINDOW_MS
}

/** Strip the Pear-side prefix down to what `chat.getHistory` expects. */
export function historyIdFor(conversation: RelayChatConversation): string {
  if (conversation.kind === 'channel') {
    return conversation.id.replace(/^channel:/, '').replace(/^#+/, '')
  }
  return conversation.id
}

/**
 * What `chat.send` expects as `to`: the bare channel name, or the raw DM
 * conversation id. Main derives the broadcast `conversationId` back from
 * this value (`conversation:<to>` for DMs), so the two stay in sync.
 */
export function sendTargetFor(conversation: RelayChatConversation): { kind: 'dm' | 'channel'; to: string } {
  if (conversation.kind === 'channel') {
    return { kind: 'channel', to: conversation.id.replace(/^channel:/, '').replace(/^#+/, '') }
  }
  return { kind: 'dm', to: conversation.id.replace(/^conversation:/, '') }
}

let pendingSeq = 0
let syncUnsubscribes: Array<() => void> | null = null
let syncInterval: ReturnType<typeof setInterval> | null = null

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Chat request failed'
}

function latestServerMessageId(messages: RelayChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && !message.id.startsWith(CHAT_OPTIMISTIC_ID_PREFIX)) return message.id
  }
  return null
}

const initialState = {
  conversations: [] as RelayChatConversation[],
  conversationsLoading: false,
  conversationsError: null as string | null,
  selectedId: null as string | null,
  history: {} as Record<string, RelayChatMessage[]>,
  historyLoading: {} as Record<string, boolean>,
  historyError: {} as Record<string, string | null>,
  pending: {} as Record<string, ChatPendingMessage[]>,
  unreadConversationIDs: [] as string[],
  delivery: {} as Record<string, boolean>,
  pinnedConversationIDs: [] as string[],
  hiddenConversationIDs: [] as string[],
  showHidden: false,
  composerDraft: '',
  lastRefreshAt: null as string | null
}

export const useChatStore = create<ChatDesktopState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,

    refreshConversations: async () => {
      set({ conversationsLoading: true, conversationsError: null })
      try {
        const conversations = await pear.chat.listConversations()
        const serverUnread = new Set(
          conversations.filter((c) => (c.unreadCount || 0) > 0).map((c) => c.id)
        )
        const previousUnread = get().unreadConversationIDs.filter((id) =>
          conversations.some((c) => c.id === id)
        )
        set({
          conversations,
          conversationsLoading: false,
          lastRefreshAt: new Date().toISOString(),
          unreadConversationIDs: [...new Set([...serverUnread, ...previousUnread])]
        })
      } catch (error) {
        set({ conversationsLoading: false, conversationsError: toErrorMessage(error) })
      }
    },

    selectConversation: async (id) => {
      set({ selectedId: id })
      if (!id) return
      const conversation = get().conversations.find((c) => c.id === id)
      if (conversation && !get().history[id]) {
        await get().loadHistory(id)
      }
      const messages = get().history[id] || []
      const latestId = latestServerMessageId(messages)
      if (latestId) {
        try {
          await pear.chat.markRead(latestId)
        } catch {
          // Read receipts are advisory — a failure must not break opening.
        }
      }
      set((state) => ({
        unreadConversationIDs: state.unreadConversationIDs.filter((unread) => unread !== id)
      }))
    },

    loadHistory: async (id) => {
      const conversation = get().conversations.find((c) => c.id === id)
      if (!conversation) return
      set((state) => ({
        historyLoading: { ...state.historyLoading, [id]: true },
        historyError: { ...state.historyError, [id]: null }
      }))
      try {
        const messages = await pear.chat.getHistory({
          kind: conversation.kind,
          id: historyIdFor(conversation),
          limit: 100,
          withDelivery: true
        })
        set((state) => {
          const delivery = { ...state.delivery }
          for (const message of messages) {
            if (message.delivered !== undefined) delivery[message.id] = message.delivered
          }
          return {
            history: { ...state.history, [id]: messages },
            historyLoading: { ...state.historyLoading, [id]: false },
            delivery
          }
        })
      } catch (error) {
        set((state) => ({
          historyLoading: { ...state.historyLoading, [id]: false },
          historyError: { ...state.historyError, [id]: toErrorMessage(error) }
        }))
      }
    },

    sendMessage: async (text, attachmentIds = []) => {
      const { selectedId, conversations } = get()
      const conversation = conversations.find((c) => c.id === selectedId)
      const body = text.trim()
      // Messages compose only inside a Pear-owned conversation — there is
      // no free-form recipient path, so a missing selection is a no-op.
      if (!conversation || (!body && attachmentIds.length === 0)) return
      const target = sendTargetFor(conversation)
      pendingSeq += 1
      const localId = `${CHAT_OPTIMISTIC_ID_PREFIX}${Date.now()}-${pendingSeq}`
      const pendingMessage: ChatPendingMessage = {
        localId,
        conversationId: conversation.id,
        kind: target.kind,
        to: target.to,
        text: body,
        attachmentIds,
        status: 'sending',
        createdAt: new Date().toISOString()
      }
      set((state) => ({
        pending: {
          ...state.pending,
          [conversation.id]: [...(state.pending[conversation.id] || []), pendingMessage]
        },
        composerDraft: ''
      }))
      try {
        await pear.chat.send({
          kind: target.kind,
          to: target.to,
          text: body,
          ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
          idempotencyKey: localId
        })
        set((state) => ({
          pending: {
            ...state.pending,
            [conversation.id]: (state.pending[conversation.id] || []).filter(
              (item) => item.localId !== localId
            )
          }
        }))
        // Optimistic send, then refresh the list and reload history so the
        // server echo (broadcast or polled) becomes the canonical row.
        await get().refreshConversations()
        await get().loadHistory(conversation.id)
      } catch (error) {
        set((state) => ({
          pending: {
            ...state.pending,
            [conversation.id]: (state.pending[conversation.id] || []).map((item) =>
              item.localId === localId
                ? { ...item, status: 'failed' as const, error: toErrorMessage(error) }
                : item
            )
          }
        }))
      }
    },

    /** Tap-to-edit on a failed pending row: restore its text, drop the row. */
    editFailedPending: (localId) => {
      const { pending } = get()
      for (const [conversationId, rows] of Object.entries(pending)) {
        const row = rows.find((item) => item.localId === localId && item.status === 'failed')
        if (row) {
          set((state) => ({
            pending: {
              ...state.pending,
              [conversationId]: (state.pending[conversationId] || []).filter(
                (item) => item.localId !== localId
              )
            },
            composerDraft: row.text
          }))
          return
        }
      }
    },

    retryPending: async (localId) => {
      const { pending } = get()
      for (const rows of Object.values(pending)) {
        const row = rows.find((item) => item.localId === localId && item.status === 'failed')
        if (row) {
          const selected = get().selectedId
          if (selected !== row.conversationId) await get().selectConversation(row.conversationId)
          set((state) => ({
            pending: {
              ...state.pending,
              [row.conversationId]: (state.pending[row.conversationId] || []).filter(
                (item) => item.localId !== localId
              )
            }
          }))
          await get().sendMessage(row.text, row.attachmentIds)
          return
        }
      }
    },

    togglePin: (id) => {
      set((state) => ({
        pinnedConversationIDs: state.pinnedConversationIDs.includes(id)
          ? state.pinnedConversationIDs.filter((pinned) => pinned !== id)
          : [...state.pinnedConversationIDs, id]
      }))
    },

    toggleHide: (id) => {
      set((state) => ({
        hiddenConversationIDs: state.hiddenConversationIDs.includes(id)
          ? state.hiddenConversationIDs.filter((hidden) => hidden !== id)
          : [...state.hiddenConversationIDs, id]
      }))
    },

    setShowHidden: (show) => set({ showHidden: show }),

    setComposerDraft: (draft) => set({ composerDraft: draft }),

    applyChatMessage: (event) => {
      const { conversationId, message } = event
      const { selectedId, history } = get()
      if (message.delivered !== undefined) {
        set((state) => ({ delivery: { ...state.delivery, [message.id]: message.delivered as boolean } }))
      }
      if (history[conversationId]) {
        set((state) => ({
          history: {
            ...state.history,
            [conversationId]: [...(state.history[conversationId] || []), message]
          }
        }))
      }
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, lastMessageAt: message.createdAt }
            : conversation
        )
      }))
      if (conversationId === selectedId) {
        void pear.chat.markRead(message.id).catch(() => undefined)
      } else {
        set((state) => ({
          unreadConversationIDs: state.unreadConversationIDs.includes(conversationId)
            ? state.unreadConversationIDs
            : [...state.unreadConversationIDs, conversationId]
        }))
      }
    },

    applyInvalidated: (event) => {
      void get().refreshConversations()
      // Foreground / open / manual invalidations also reload the open
      // thread; the interval tick only refreshes the list.
      if (event.reason !== 'poll' && get().selectedId) {
        void get().loadHistory(get().selectedId as string)
      }
    },

    startSync: () => {
      if (syncUnsubscribes) return
      const unsubscribes: Array<() => void> = []
      unsubscribes.push(pear.chat.onInvalidated((event) => get().applyInvalidated(event)))
      unsubscribes.push(pear.chat.onMessage((event) => get().applyChatMessage(event)))
      const foregroundRefresh = (): void => {
        void get().refreshConversations()
        const selectedId = get().selectedId
        if (selectedId) void get().loadHistory(selectedId)
      }
      const onFocus = (): void => foregroundRefresh()
      const onVisibility = (): void => {
        if (document.visibilityState === 'visible') foregroundRefresh()
      }
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
      unsubscribes.push(() => window.removeEventListener('focus', onFocus))
      unsubscribes.push(() => document.removeEventListener('visibilitychange', onVisibility))
      syncInterval = setInterval(() => {
        void get().refreshConversations()
      }, 30_000)
      syncUnsubscribes = unsubscribes
      void get().refreshConversations()
    },

    stopSync: () => {
      if (syncInterval) {
        clearInterval(syncInterval)
        syncInterval = null
      }
      if (syncUnsubscribes) {
        for (const unsubscribe of syncUnsubscribes) unsubscribe()
        syncUnsubscribes = null
      }
    },

    reset: () => {
      get().stopSync()
      pendingSeq = 0
      set({ ...initialState })
    }
  })))

export type { RelayChatAttachment, RelayChatConversation, RelayChatMessage }
