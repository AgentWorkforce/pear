import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  pear,
  type ChatInvalidatedEvent,
  type ChatMessageEvent,
  type ChatOpenConversationEvent,
  type RelayChatAttachment,
  type RelayChatConversation,
  type RelayChatMessage,
  type SessionTranscriptTurn
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
  /** Human and agent text from the open agent's declared session. */
  sessionTurns: Record<string, SessionTranscriptTurn[]>
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
  openFromNotification: (event: ChatOpenConversationEvent) => Promise<void>
  startSync: () => void
  stopSync: () => void
  reset: () => void
}

/** `relay:name@host` and `name@host` both reduce to `name`. */
export function agentIdentity(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/^relay:/, '')
  const at = trimmed.lastIndexOf('@')
  return at > 0 ? trimmed.slice(0, at) : trimmed
}

/**
 * A directory filter matches DMs and roster rows whose name or participant
 * is an agent working in that directory. Channels are not directory-scoped.
 */
export function conversationMatchesAgents(
  conversation: RelayChatConversation,
  agentNames: readonly string[]
): boolean {
  if (conversation.kind === 'channel') return false
  const known = new Set(agentNames.map(agentIdentity).filter((name) => name.length > 0))
  if (known.size === 0) return false
  const labels = [conversation.name, ...(conversation.participants || [])]
  return labels.some((label) => known.has(agentIdentity(label)))
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

export interface ChatFilters {
  project: string
  cli: string
  machine: string
}

export const NO_CHAT_FILTERS: ChatFilters = { project: '', cli: '', machine: '' }

/** `Mac.local`, `mac`, and `MAC` are one machine. */
export function machineKey(name: string): string {
  return name.trim().replace(/\.$/, '').replace(/\.local$/i, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function conversationMachines(conversation: RelayChatConversation): string[] {
  if (conversation.machine) return [conversation.machine]
  return (conversation.participants || []).flatMap((participant) => parseChatHost(participant) ?? [])
}

/** Filter choices present in the list: projects, agent types, machines (one label per machine). */
export function chatFilterOptions(conversations: readonly RelayChatConversation[]): {
  projects: string[]
  clis: string[]
  machines: string[]
} {
  const projects = new Set<string>()
  const clis = new Set<string>()
  const machines = new Map<string, string>()
  for (const conversation of conversations) {
    if (conversation.kind === 'channel') continue
    if (conversation.project) projects.add(conversation.project)
    if (conversation.cli) clis.add(conversation.cli)
    for (const machine of conversationMachines(conversation)) {
      const key = machineKey(machine)
      if (key && !machines.has(key)) machines.set(key, machine)
    }
  }
  const sorted = (values: Iterable<string>): string[] =>
    [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
  return { projects: sorted(projects), clis: sorted(clis), machines: sorted(machines.values()) }
}

/** Whether a conversation passes the filters. Channels aren't tied to one project, type, or machine. */
export function matchesChatFilters(conversation: RelayChatConversation, filters: ChatFilters): boolean {
  if (conversation.kind === 'channel') return true
  if (filters.project && conversation.project !== filters.project) return false
  if (filters.cli && conversation.cli !== filters.cli) return false
  if (filters.machine) {
    const wanted = machineKey(filters.machine)
    if (!conversationMachines(conversation).some((machine) => machineKey(machine) === wanted)) return false
  }
  return true
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
  if (conversation.kind === 'agent') {
    const status = conversation.status?.toLowerCase()
    return status === 'online' || status === 'active'
  }
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

/** The other party in a DM. `POST /dm` addresses an agent name, not a conversation id. */
export function dmRecipient(conversation: RelayChatConversation): string {
  const labels = conversation.participants && conversation.participants.length > 0
    ? conversation.participants
    : [conversation.name]
  const other = labels.find((label) => {
    const name = agentIdentity(label)
    return name.length > 0 && !name.startsWith('pear-chat-')
  })
  return (other || labels[0] || conversation.id.replace(/^conversation:/, '')).trim()
}

/** DM thread whose participants include this roster agent, when one already exists. */
export function findDmThread(
  conversations: readonly RelayChatConversation[],
  agent: RelayChatConversation
): RelayChatConversation | undefined {
  const identity = agentIdentity(agent.name || agent.id.replace(/^relay:/, ''))
  if (!identity) return undefined
  return conversations.find((candidate) =>
    candidate.kind === 'dm' &&
    [candidate.name, ...(candidate.participants || [])].some((label) => agentIdentity(label) === identity)
  )
}

/** Unread on the row itself, or on the DM thread an agent row shows. */
export function conversationUnread(
  conversations: readonly RelayChatConversation[],
  unreadIds: ReadonlySet<string>,
  conversation: RelayChatConversation
): boolean {
  const unread = (row: RelayChatConversation): boolean => unreadIds.has(row.id)
  if (unread(conversation)) return true
  if (conversation.kind !== 'agent') return false
  const thread = findDmThread(conversations, conversation)
  return !!thread && unread(thread)
}

/**
 * What the person has seen: conversation id → newest incoming message id,
 * and when tracking began. A conversation with no entry is unread only if
 * its last message came after `since`.
 */
export interface ReadMarkers {
  since: string
  seen: Record<string, string>
}

const READ_MARKERS_KEY = 'pear.chat.read'

export function loadReadMarkers(): ReadMarkers | null {
  try {
    const raw = localStorage.getItem(READ_MARKERS_KEY)
    const parsed = (raw ? JSON.parse(raw) : null) as Partial<ReadMarkers> | null
    return parsed && typeof parsed.since === 'string' && parsed.seen && typeof parsed.seen === 'object'
      ? { since: parsed.since, seen: parsed.seen }
      : null
  } catch {
    return null
  }
}

function saveReadMarkers(markers: ReadMarkers): void {
  try {
    localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(markers))
  } catch {
    // Read state is a convenience; storage failures only cost a stale dot.
  }
}

/**
 * Conversations whose newest incoming message differs from the one last seen.
 * With no markers at all (first launch) everything already there counts as
 * read; conversations in `open` are being looked at, so they are read too.
 */
export function readState(
  conversations: readonly RelayChatConversation[],
  markers: ReadMarkers | null,
  open: ReadonlySet<string>,
  now: Date = new Date()
): { markers: ReadMarkers; unread: string[] } {
  const since = markers?.since ?? now.toISOString()
  const seen = { ...(markers?.seen || {}) }
  const unread: string[] = []
  for (const conversation of conversations) {
    const latest = conversation.lastIncomingId
    if (!latest) continue
    const known = seen[conversation.id]
    const isNew = known
      ? known !== latest
      : !!markers && !!conversation.lastMessageAt && Date.parse(conversation.lastMessageAt) > Date.parse(since)
    if (isNew && !open.has(conversation.id)) unread.push(conversation.id)
    else seen[conversation.id] = latest
  }
  return { markers: { since, seen }, unread }
}

/** The selected row plus the DM thread an agent row shows. */
function openConversationIds(
  conversations: readonly RelayChatConversation[],
  selectedId: string | null
): Set<string> {
  const selected = selectedId ? conversations.find((c) => c.id === selectedId) : undefined
  if (!selected) return new Set()
  const thread = selected.kind === 'agent' ? findDmThread(conversations, selected) : undefined
  return new Set([selected.id, ...(thread ? [thread.id] : [])])
}

/** DM threads that open from an agent's roster row, so they aren't listed twice. */
export function agentThreadIds(conversations: readonly RelayChatConversation[]): Set<string> {
  return new Set(conversations.flatMap((conversation) => {
    if (conversation.kind !== 'agent') return []
    const thread = findDmThread(conversations, conversation)
    return thread ? [thread.id] : []
  }))
}

/**
 * Conversations matching a search, best first: name prefix, then name
 * substring, then summary or participants; most recent activity breaks ties.
 */
export function searchConversations(
  conversations: readonly RelayChatConversation[],
  query: string,
  limit = 8
): RelayChatConversation[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const claimed = agentThreadIds(conversations)
  const activity = (conversation: RelayChatConversation): string =>
    (conversation.kind === 'agent' ? findDmThread(conversations, conversation)?.lastMessageAt : undefined) ||
    conversation.lastMessageAt ||
    ''
  const ranked = conversations.flatMap((conversation) => {
    if (claimed.has(conversation.id)) return []
    const name = conversation.name.toLowerCase().replace(/^#/, '')
    const rest = [conversation.summary || '', ...(conversation.participants || [])].join(' ').toLowerCase()
    if (!tokens.every((token) => name.includes(token) || rest.includes(token))) return []
    const rank = name.startsWith(tokens[0]) ? 0 : tokens.every((token) => name.includes(token)) ? 1 : 2
    return [{ conversation, rank, at: activity(conversation) }]
  })
  ranked.sort((a, b) => a.rank - b.rank || b.at.localeCompare(a.at) || a.conversation.name.localeCompare(b.conversation.name))
  return ranked.slice(0, limit).map((entry) => entry.conversation)
}

/**
 * Every row a pushed message belongs to: the thread itself plus the roster
 * agent that shows it. A first DM from an agent has no thread in the list
 * yet, so it falls back to that agent's row.
 */
export function historyKeysForMessage(
  conversations: readonly RelayChatConversation[],
  conversationId: string,
  message: Pick<RelayChatMessage, 'from' | 'mine'>
): string[] {
  const keys = conversations
    .filter((conversation) =>
      conversation.id === conversationId ||
      (conversation.kind === 'agent' && findDmThread(conversations, conversation)?.id === conversationId))
    .map((conversation) => conversation.id)
  if (keys.length > 0 || message.mine || !conversationId.startsWith('conversation:')) return keys
  const sender = agentIdentity(message.from)
  return conversations
    .filter((conversation) => conversation.kind === 'agent' && agentIdentity(conversation.name) === sender)
    .map((conversation) => conversation.id)
}

/** The DM thread's last activity behind a row, to spot new messages after a list poll. */
function threadActivity(conversations: readonly RelayChatConversation[], id: string): string | undefined {
  const conversation = conversations.find((c) => c.id === id)
  if (!conversation) return undefined
  const thread = conversation.kind === 'agent' ? findDmThread(conversations, conversation) : conversation
  return thread?.lastMessageAt
}

/**
 * What `chat.send` expects as `to`: the bare channel name, or the other
 * agent's name. Relaycast rejects a conversation id in `to`.
 */
export function sendTargetFor(conversation: RelayChatConversation): { kind: 'dm' | 'channel'; to: string } {
  if (conversation.kind === 'channel') {
    return { kind: 'channel', to: conversation.id.replace(/^channel:/, '').replace(/^#+/, '') }
  }
  if (conversation.kind === 'agent') {
    const name = conversation.id.replace(/^relay:/, '').trim()
    return { kind: 'dm', to: name || conversation.name }
  }
  return { kind: 'dm', to: dmRecipient(conversation) }
}

let pendingSeq = 0
let syncUnsubscribes: Array<() => void> | null = null
let syncInterval: ReturnType<typeof setInterval> | null = null

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Chat request failed'
}

async function loadAgentSession(conversation: RelayChatConversation): Promise<SessionTranscriptTurn[]> {
  if (!conversation.sessionId || conversation.kind === 'channel') return []
  try {
    return await pear.aiHist.transcript(conversation.sessionId)
  } catch {
    return []
  }
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
  sessionTurns: {} as Record<string, SessionTranscriptTurn[]>,
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

/**
 * A send, a focus refresh, a push invalidation, and the 30s tick can all ask
 * for the same list or thread at once. Concurrent callers share the request
 * already in flight instead of starting another.
 */
let refreshInFlight: Promise<void> | null = null
const historyInFlight = new Map<string, Promise<void>>()

export const useChatStore = create<ChatDesktopState>()(
  subscribeWithSelector((set, get) => {
    const runRefreshConversations = async (): Promise<void> => {
      set({ conversationsLoading: true, conversationsError: null })
      try {
        const conversations = await pear.chat.listConversations()
        const open = openConversationIds(conversations, get().selectedId)
        const read = readState(conversations, loadReadMarkers(), open)
        saveReadMarkers(read.markers)
        const previousUnread = get().unreadConversationIDs.filter((id) =>
          !open.has(id) && conversations.some((c) => c.id === id)
        )
        set({
          conversations,
          conversationsLoading: false,
          lastRefreshAt: new Date().toISOString(),
          unreadConversationIDs: [...new Set([...read.unread, ...previousUnread])]
        })
      } catch (error) {
        set({ conversationsLoading: false, conversationsError: toErrorMessage(error) })
      }
    }

    const runLoadHistory = async (id: string): Promise<void> => {
      const conversation = get().conversations.find((c) => c.id === id)
      if (!conversation) return
      set((state) => ({
        historyLoading: { ...state.historyLoading, [id]: true },
        historyError: { ...state.historyError, [id]: null }
      }))
      const dmThread = conversation.kind === 'agent'
        ? findDmThread(get().conversations, conversation)
        : undefined
      const sessionTurns = await loadAgentSession(conversation)
      if (conversation.kind === 'agent' && !dmThread) {
        set((state) => ({
          history: { ...state.history, [id]: state.history[id] ?? [] },
          sessionTurns: { ...state.sessionTurns, [id]: sessionTurns },
          historyLoading: { ...state.historyLoading, [id]: false }
        }))
        return
      }
      try {
        const messages = await pear.chat.getHistory({
          kind: dmThread ? 'dm' : conversation.kind,
          id: historyIdFor(dmThread || conversation),
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
            sessionTurns: { ...state.sessionTurns, [id]: sessionTurns },
            historyLoading: { ...state.historyLoading, [id]: false },
            delivery
          }
        })
      } catch (error) {
        set((state) => ({
          sessionTurns: { ...state.sessionTurns, [id]: sessionTurns },
          historyLoading: { ...state.historyLoading, [id]: false },
          historyError: { ...state.historyError, [id]: toErrorMessage(error) }
        }))
      }
    }

    return {
    ...initialState,

    refreshConversations: () => {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runRefreshConversations().finally(() => {
        refreshInFlight = null
      })
      return refreshInFlight
    },

    loadHistory: (id) => {
      const existing = historyInFlight.get(id)
      if (existing) return existing
      const run = runLoadHistory(id).finally(() => {
        historyInFlight.delete(id)
      })
      historyInFlight.set(id, run)
      return run
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
      set((state) => {
        const read = openConversationIds(state.conversations, id)
        saveReadMarkers(readState(state.conversations, loadReadMarkers(), read).markers)
        return { unreadConversationIDs: state.unreadConversationIDs.filter((unread) => !read.has(unread)) }
      })
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
        const sent = await pear.chat.send({
          kind: target.kind,
          to: target.to,
          text: body,
          ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
          idempotencyKey: localId
        })
        set((state) => {
          const existing = state.history[conversation.id] || []
          const history = existing.some((item) => item.id === sent.id)
            ? existing
            : [...existing, sent]
          return {
            pending: {
              ...state.pending,
              [conversation.id]: (state.pending[conversation.id] || []).filter(
                (item) => item.localId !== localId
              )
            },
            history: { ...state.history, [conversation.id]: history }
          }
        })
        // The list refresh takes seconds (hundreds of roster agents), so a
        // thread that already exists reloads first. Only a first DM to a
        // roster agent needs the refreshed list to find its new thread.
        const hasThread = conversation.kind !== 'agent' || !!findDmThread(get().conversations, conversation)
        if (hasThread) {
          void get().loadHistory(conversation.id)
          void get().refreshConversations()
        } else {
          void get().refreshConversations().then(() => get().loadHistory(conversation.id))
        }
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
      const { selectedId, conversations } = get()
      if (message.delivered !== undefined) {
        set((state) => ({ delivery: { ...state.delivery, [message.id]: message.delivered as boolean } }))
      }
      // A delivery flip re-pushes a message the thread already shows.
      if (message.delivered === true) return
      const keys = historyKeysForMessage(conversations, conversationId, message)
      const isNew = (rows: RelayChatMessage[] | undefined): boolean =>
        !!rows && !rows.some((row) => row.id === message.id)
      const fresh = keys.filter((key) => isNew(get().history[key]))
      // A push can repeat (send echo, socket replay); keep one row per message id.
      if (fresh.length > 0) {
        set((state) => {
          const history = { ...state.history }
          for (const key of fresh) {
            if (isNew(history[key])) history[key] = [...history[key], message]
          }
          return { history }
        })
      }
      const touched = new Set([conversationId, ...keys])
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          touched.has(conversation.id)
            ? {
                ...conversation,
                lastMessageAt: message.createdAt,
                ...(message.mine || conversation.kind !== 'dm' ? {} : { lastIncomingId: message.id })
              }
            : conversation
        )
      }))
      if (!conversations.some((conversation) => conversation.id === conversationId)) {
        void get().refreshConversations()
      }
      if (message.mine) return
      if (selectedId && touched.has(selectedId)) {
        void pear.chat.markRead(message.id).catch(() => undefined)
        const latest = get().conversations
        saveReadMarkers(readState(latest, loadReadMarkers(), openConversationIds(latest, selectedId)).markers)
      } else {
        const unread = keys.length > 0 ? keys : [conversationId]
        set((state) => ({
          unreadConversationIDs: [
            ...state.unreadConversationIDs,
            ...unread.filter((id) => !state.unreadConversationIDs.includes(id))
          ]
        }))
      }
    },

    openFromNotification: async ({ conversationId, from }) => {
      const target = (): string | undefined =>
        historyKeysForMessage(get().conversations, conversationId, { from, mine: false })[0]
      // A first message can arrive before its thread is in the list.
      if (!target()) await get().refreshConversations()
      const id = target()
      if (id) await get().selectConversation(id)
    },

    applyInvalidated: (event) => {
      const selectedId = get().selectedId
      if (event.reason === 'summaries') {
        void get().refreshConversations()
        return
      }
      if (event.reason !== 'poll') {
        void get().refreshConversations()
        if (selectedId) void get().loadHistory(selectedId)
        return
      }
      // The interval tick reloads the open thread only when the list shows
      // it moved — the fallback for messages the live stream didn't push.
      const before = selectedId ? threadActivity(get().conversations, selectedId) : undefined
      void get().refreshConversations().then(() => {
        if (!selectedId || get().selectedId !== selectedId) return
        const conversation = get().conversations.find((c) => c.id === selectedId)
        if (!conversation || conversation.kind === 'channel') return
        const after = threadActivity(get().conversations, selectedId)
        if (after && after !== before) void get().loadHistory(selectedId)
      })
    },

    startSync: () => {
      if (syncUnsubscribes) return
      const unsubscribes: Array<() => void> = []
      unsubscribes.push(pear.chat.onInvalidated((event) => get().applyInvalidated(event)))
      unsubscribes.push(pear.chat.onMessage((event) => get().applyChatMessage(event)))
      const unsubscribeOpen = pear.chat.onOpenConversation?.((event) => {
        void get().openFromNotification(event)
      })
      if (unsubscribeOpen) unsubscribes.push(unsubscribeOpen)
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
      refreshInFlight = null
      historyInFlight.clear()
      set({ ...initialState })
    }
    }
  }))

export type { RelayChatAttachment, RelayChatConversation, RelayChatMessage }
