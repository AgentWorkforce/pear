import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  AgentCurrentState,
  BrokerDetails,
  BrokerEventRecord,
  BrokerListAgent,
  BrokerReconciledChatMessage,
  InboundDeliveryMode,
  TerminalAttachMode
} from '@/lib/ipc'
import { normalizeChannelName, useProjectStore } from '@/stores/project-store'
import {
  compactBrokerEvent as compactBrokerEventPayload,
  normalizeEventTimestamp
} from '@shared/lib/broker-events'
import { getBrokerErrorKey } from '@shared/lib/broker-errors'
import { useTypingStore } from '@/stores/typing-store'
import { clearPtyBuffer, getPtyChunks } from '@/stores/pty-buffer-store'

export interface Agent {
  name: string
  cli: string
  model?: string
  status: 'running' | 'exited'
  activity: 'idle' | 'active'
  currentState: AgentCurrentState
  projectId?: string
  rootPath?: string
  rootId?: string
  parent?: string
  channels?: string[]
  terminalMode: TerminalAttachMode
  pendingDeliveryIds: string[]
}

export interface ChatMessage {
  id: string
  kind?: 'message' | 'notice'
  from: string
  to: string
  body: string
  timestamp: number
  isHuman: boolean
  projectId?: string
  conversationId?: string
  reactions?: ChatReaction[]
  threadReplies?: ChatThreadReply[]
  // True for messages added via the optimistic local-UUID path
  // (addHumanMessage). Lets reconciliation distinguish a pending
  // local echo from a canonical broker record so the canonical
  // record only replaces the optimistic, not another real human
  // message that happens to match by body/target/time.
  local?: boolean
}

export interface ChatReaction {
  emoji: string
  count: number
  reactedByHuman: boolean
}

export interface ChatThreadReply {
  id: string
  from: string
  body: string
  timestamp: number
  isHuman: boolean
  projectId?: string
}

export interface RelayMessage {
  from: string
  target: string
  body: string
  timestamp: number
  projectId?: string
}

export interface BrokerErrorEntry {
  id: string
  message: string
  timestamp: number
  projectId?: string
}

export const MAX_BROKER_ERRORS = 12

export function prependBrokerError(entries: BrokerErrorEntry[], entry: BrokerErrorEntry): BrokerErrorEntry[] {
  const key = getBrokerErrorKey(entry)
  return [
    entry,
    ...entries.filter((candidate) => getBrokerErrorKey(candidate) !== key)
  ].slice(0, MAX_BROKER_ERRORS)
}

const MAX_BROKER_EVENTS = 3_000
const BROKER_EVENT_RETENTION_MS = 12 * 60 * 60 * 1_000
// Chat + relay history are display buffers, not a source of truth, so cap
// them the same way broker events are capped. Without this they grow for the
// life of the session (one entry per relay_inbound), which is the dominant
// renderer memory leak behind long-session crashes.
const MAX_CHAT_MESSAGES = 5_000
const MAX_RELAY_MESSAGES = 5_000
const HUMAN_SENDER_NAME = 'human'
const SYSTEM_NOTICE_SENDER_NAME = 'system'
const HUMAN_MESSAGE_DEDUPE_WINDOW_MS = 10_000
const JOIN_NOTICE_DEDUPE_WINDOW_MS = 30_000
// Tighter window for agent-message dedupe — agents reply fast and a
// 10s window would falsely collapse two legitimately distinct messages
// with similar bodies. Only catches the broker-replay / cross-stream
// case where the same logical agent message arrives twice within ~2s
// with different event_ids (per AGENTS.md: renderer is the final
// guardrail; stable event_id is the broker's job).
const AGENT_MESSAGE_DEDUPE_WINDOW_MS = 2_000

export function getAgentKey(projectId: string | undefined, name: string): string {
  return `${projectId || 'unknown'}:${name}`
}

export function getAgentKeyForAgent(agent: Pick<Agent, 'projectId' | 'name'>): string {
  return getAgentKey(agent.projectId, agent.name)
}

function matchesAgent(agent: Agent, projectId: string | undefined, name: string): boolean {
  if (projectId) {
    return agent.projectId === projectId && agent.name === name
  }
  return agent.name === name
}

// Matches the real BrokerEvent discriminated union from @agent-relay/harness-driver
interface BrokerEvent {
  kind: string
  projectId?: string
  historyId?: string
  observedAt?: number
  timestamp?: number
  seq?: number
  name?: string
  chunk?: string
  stream?: string
  cli?: string
  model?: string
  runtime?: string
  parent?: string
  channels?: string[]
  from?: string
  target?: string
  body?: string
  event_id?: string
  idle_secs?: number
  blocked_secs?: number
  pending_delivery_count?: number
  mode?: InboundDeliveryMode
  code?: number
  signal?: string
  reason?: string
  message?: string
  lastError?: string
  [key: string]: unknown
}

interface TrackSpawnedAgentOptions {
  currentState?: AgentCurrentState
  terminalMode?: TerminalAttachMode
  lastActivityAt?: string
  lastActivityMs?: number
  channels?: string[]
}

function activityFromCurrentState(currentState: AgentCurrentState): Agent['activity'] {
  return currentState === 'idle' ? 'idle' : 'active'
}

function terminalModeFromInboundDeliveryMode(mode?: InboundDeliveryMode): TerminalAttachMode | undefined {
  if (!mode) return undefined
  return mode === 'manual_flush' ? 'drive' : 'passthrough'
}

function getActivityTimestampMs(
  lastActivityAt?: string,
  lastActivityMs?: number,
  now = Date.now()
): number | undefined {
  if (lastActivityAt) {
    const timestamp = Date.parse(lastActivityAt)
    if (Number.isFinite(timestamp)) return timestamp
  }

  if (typeof lastActivityMs !== 'number' || !Number.isFinite(lastActivityMs) || lastActivityMs < 0) {
    return undefined
  }

  return lastActivityMs > 1_000_000_000_000 ? lastActivityMs : now - lastActivityMs
}

function addPendingDelivery(agent: Agent, eventId?: string): Agent {
  if (!eventId || agent.pendingDeliveryIds.includes(eventId)) {
    return agent
  }

  return {
    ...agent,
    pendingDeliveryIds: [...agent.pendingDeliveryIds, eventId]
  }
}

function clearPendingDeliveries(agent: Agent, eventId?: string): Agent {
  if (!agent.pendingDeliveryIds.length) {
    return agent
  }

  if (!eventId) {
    return {
      ...agent,
      pendingDeliveryIds: []
    }
  }

  const nextPending = agent.pendingDeliveryIds.filter((id) => id !== eventId)
  if (nextPending.length === agent.pendingDeliveryIds.length) {
    return agent
  }

  return {
    ...agent,
    pendingDeliveryIds: nextPending
  }
}

function compactBrokerEvent(event: Record<string, unknown>): BrokerEventRecord['event'] {
  return compactBrokerEventPayload(event) as BrokerEventRecord['event']
}

function capByCount<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items
}

function pruneBrokerEvents(events: BrokerEventRecord[], now = Date.now()): BrokerEventRecord[] {
  const cutoff = now - BROKER_EVENT_RETENTION_MS
  return events
    .filter((entry) => entry.timestamp >= cutoff)
    .slice(-MAX_BROKER_EVENTS)
}

function toBrokerEventRecord(event: BrokerEvent): BrokerEventRecord {
  const timestamp =
    normalizeEventTimestamp(event.observedAt) ??
    normalizeEventTimestamp(event.timestamp) ??
    Date.now()
  const projectId = event.projectId || 'unknown'
  const seq = typeof event.seq === 'number' ? event.seq : undefined
  const eventId = typeof event.event_id === 'string' || typeof event.event_id === 'number'
    ? String(event.event_id)
    : undefined
  const id = typeof event.historyId === 'string' && event.historyId
    ? event.historyId
    : `${projectId}:${seq ?? eventId ?? crypto.randomUUID()}`

  return {
    id,
    projectId,
    timestamp,
    event: compactBrokerEvent(event as Record<string, unknown>)
  }
}

function normalizeMessageTarget(target: string): string {
  return target.trim().replace(/^#/, '')
}

function normalizeChannelList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  return Array.from(new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((channel) => normalizeChannelName(normalizeMessageTarget(channel)))
      .filter(Boolean)
  ))
}

function isHumanSender(sender: string): boolean {
  return sender.trim().toLowerCase() === HUMAN_SENDER_NAME
}

function isHumanMessage(message: Pick<ChatMessage, 'from' | 'isHuman'>): boolean {
  return message.isHuman || isHumanSender(message.from)
}

type AgentEchoCandidate = Pick<ChatMessage, 'from' | 'body' | 'projectId' | 'timestamp' | 'to' | 'isHuman'>
type TimestampCounts = Map<number, number>
type AgentEchoBuckets = Map<number, TimestampCounts>

function incrementCount<TKey>(counts: Map<TKey, number>, key: TKey): void {
  counts.set(key, (counts.get(key) || 0) + 1)
}

function decrementCount<TKey>(counts: Map<TKey, number>, key: TKey): void {
  const count = counts.get(key)
  if (count === undefined) return
  if (count <= 1) {
    counts.delete(key)
    return
  }
  counts.set(key, count - 1)
}

// Same shape as the old scan: non-human messages match by trimmed/lowercase
// sender, exact body, exact projectId (undefined is not a wildcard), and a
// target normalized only by trimming and removing a leading "#".
function agentEchoIdentityKey(message: AgentEchoCandidate): string {
  const projectScope = message.projectId === undefined
    ? ['undefined']
    : ['string', message.projectId]
  return JSON.stringify([
    message.from.trim().toLowerCase(),
    projectScope,
    normalizeMessageTarget(message.to),
    message.body
  ])
}

function agentEchoBucket(timestamp: number): number {
  return Math.floor(timestamp / AGENT_MESSAGE_DEDUPE_WINDOW_MS)
}

// Indexes the renderer's final guardrail for broker replay / cross-stream
// races where the same logical agent message arrives with different ids.
// Bucket width equals the 2s dedupe window, so an exact match can only live
// in the candidate bucket or an adjacent bucket.
class ChatMessageDedupIndex {
  private readonly ids = new Map<string, number>()
  private readonly agentEchoBucketsByIdentity = new Map<string, AgentEchoBuckets>()

  constructor(messages: Iterable<ChatMessage>) {
    for (const message of messages) {
      this.add(message)
    }
  }

  hasId(id: string): boolean {
    return (this.ids.get(id) || 0) > 0
  }

  hasAgentEcho(candidate: AgentEchoCandidate): boolean {
    if (isHumanMessage(candidate)) return false
    if (!Number.isFinite(candidate.timestamp)) return false

    const buckets = this.agentEchoBucketsByIdentity.get(agentEchoIdentityKey(candidate))
    if (!buckets) return false

    const candidateBucket = agentEchoBucket(candidate.timestamp)
    for (let bucket = candidateBucket - 1; bucket <= candidateBucket + 1; bucket += 1) {
      const timestamps = buckets.get(bucket)
      if (!timestamps) continue

      for (const timestamp of timestamps.keys()) {
        if (Math.abs(timestamp - candidate.timestamp) < AGENT_MESSAGE_DEDUPE_WINDOW_MS) {
          return true
        }
      }
    }

    return false
  }

  add(message: ChatMessage): void {
    incrementCount(this.ids, message.id)
    if (isHumanMessage(message)) return
    if (!Number.isFinite(message.timestamp)) return

    const key = agentEchoIdentityKey(message)
    const bucket = agentEchoBucket(message.timestamp)
    let buckets = this.agentEchoBucketsByIdentity.get(key)
    if (!buckets) {
      buckets = new Map()
      this.agentEchoBucketsByIdentity.set(key, buckets)
    }

    let timestamps = buckets.get(bucket)
    if (!timestamps) {
      timestamps = new Map()
      buckets.set(bucket, timestamps)
    }
    incrementCount(timestamps, message.timestamp)
  }

  delete(message: ChatMessage): void {
    decrementCount(this.ids, message.id)
    if (isHumanMessage(message)) return
    if (!Number.isFinite(message.timestamp)) return

    const key = agentEchoIdentityKey(message)
    const buckets = this.agentEchoBucketsByIdentity.get(key)
    if (!buckets) return

    const bucket = agentEchoBucket(message.timestamp)
    const timestamps = buckets.get(bucket)
    if (!timestamps) return

    decrementCount(timestamps, message.timestamp)
    if (timestamps.size === 0) buckets.delete(bucket)
    if (buckets.size === 0) this.agentEchoBucketsByIdentity.delete(key)
  }

  replace(previous: ChatMessage, next: ChatMessage): void {
    this.delete(previous)
    this.add(next)
  }
}

let chatMessageDedupIndexCache: {
  source: ChatMessage[]
  index: ChatMessageDedupIndex
} | null = null

function getChatMessageDedupIndex(messages: ChatMessage[]): ChatMessageDedupIndex {
  if (chatMessageDedupIndexCache?.source === messages) {
    return chatMessageDedupIndexCache.index
  }

  const index = new ChatMessageDedupIndex(messages)
  chatMessageDedupIndexCache = { source: messages, index }
  return index
}

function setChatMessageDedupIndexCache(messages: ChatMessage[], index: ChatMessageDedupIndex): void {
  chatMessageDedupIndexCache = { source: messages, index }
}

function resetChatMessageDedupIndexCache(): void {
  chatMessageDedupIndexCache = null
}

function appendChatMessageWithDedupIndex(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = getChatMessageDedupIndex(messages)
  const nextMessages = capByCount([...messages, message], MAX_CHAT_MESSAGES)
  const droppedCount = messages.length + 1 - nextMessages.length

  for (let indexToDrop = 0; indexToDrop < droppedCount; indexToDrop += 1) {
    const dropped = messages[indexToDrop]
    if (dropped) index.delete(dropped)
  }
  index.add(message)
  setChatMessageDedupIndexCache(nextMessages, index)
  return nextMessages
}

function isDuplicateAgentEcho(
  index: ChatMessageDedupIndex,
  candidate: AgentEchoCandidate
): boolean {
  return index.hasAgentEcho(candidate)
}

function humanMessageContentMatches(
  message: ChatMessage,
  candidate: Pick<ChatMessage, 'body' | 'projectId' | 'timestamp' | 'to'>
): boolean {
  return isHumanMessage(message) &&
    message.body === candidate.body &&
    (!message.projectId || !candidate.projectId || message.projectId === candidate.projectId) &&
    normalizeMessageTarget(message.to) === normalizeMessageTarget(candidate.to) &&
    Math.abs(message.timestamp - candidate.timestamp) < HUMAN_MESSAGE_DEDUPE_WINDOW_MS
}

// Detects the canonical-of-optimistic case: an incoming broker record
// that matches an existing optimistic local-UUID record by content +
// time window. Scoped to local: true records so it doesn't collapse two
// legitimately distinct identical user messages (e.g. "ok" then "ok").
function isCanonicalEchoOfLocalHuman(
  messages: ChatMessage[],
  candidate: Pick<ChatMessage, 'body' | 'projectId' | 'timestamp' | 'to'>
): boolean {
  return messages.some((message) => message.local === true && humanMessageContentMatches(message, candidate))
}

// Detects the inverse race: the canonical broker echo for this exact send
// already landed (e.g. relay_inbound beat the optimistic append while the
// channel/broker was still spinning up on the very first send). Without
// this check, addHumanMessage appends a second, optimistic copy that
// reconcileChatMessages can never clean up — once the canonical id is
// already present in `messages`, reconcile's id-match branch short-circuits
// before it ever reaches the content-based optimistic-matching logic,
// leaving the duplicate stuck permanently. Scoped to local !== true records
// for the same reason as isCanonicalEchoOfLocalHuman above.
function isCanonicalAlreadyPresent(
  messages: ChatMessage[],
  candidate: Pick<ChatMessage, 'body' | 'projectId' | 'timestamp' | 'to'>
): boolean {
  return messages.some((message) => message.local !== true && humanMessageContentMatches(message, candidate))
}

function createChannelJoinNotice(
  projectId: string | undefined,
  channelName: string,
  participantName: string,
  timestamp = Date.now()
): ChatMessage | null {
  const normalizedChannelName = normalizeChannelName(normalizeMessageTarget(channelName))
  const displayName = participantName.trim()
  if (!normalizedChannelName || !displayName) return null

  return {
    id: crypto.randomUUID(),
    kind: 'notice',
    from: SYSTEM_NOTICE_SENDER_NAME,
    to: `#${normalizedChannelName}`,
    body: `${displayName} joined the channel`,
    timestamp,
    isHuman: false,
    projectId
  }
}

function isDuplicateJoinNotice(messages: ChatMessage[], candidate: ChatMessage): boolean {
  return messages.some((message) =>
    message.kind === 'notice' &&
    message.body === candidate.body &&
    (!message.projectId || !candidate.projectId || message.projectId === candidate.projectId) &&
    normalizeMessageTarget(message.to) === normalizeMessageTarget(candidate.to) &&
    Math.abs(message.timestamp - candidate.timestamp) < JOIN_NOTICE_DEDUPE_WINDOW_MS
  )
}

function appendJoinNotices(messages: ChatMessage[], notices: ChatMessage[]): ChatMessage[] {
  let nextMessages = messages

  for (const notice of notices) {
    if (isDuplicateJoinNotice(nextMessages, notice)) continue
    nextMessages = [...nextMessages, notice]
  }

  const cappedMessages = capByCount(nextMessages, MAX_CHAT_MESSAGES)
  setChatMessageDedupIndexCache(cappedMessages, new ChatMessageDedupIndex(cappedMessages))
  return cappedMessages
}

function isBrokerDebugEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem('pear-broker-debug') === '1' ||
    localStorage.getItem('pear-broker-debug') === 'true'
}

function reactionsEqual(left: ChatReaction[] | undefined, right: ChatReaction[] | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((reaction, index) => {
    const candidate = right[index]
    return candidate &&
      reaction.emoji === candidate.emoji &&
      reaction.count === candidate.count &&
      reaction.reactedByHuman === candidate.reactedByHuman
  })
}

function threadRepliesEqual(left: ChatThreadReply[] | undefined, right: ChatThreadReply[] | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((reply, index) => {
    const candidate = right[index]
    return candidate &&
      reply.id === candidate.id &&
      reply.from === candidate.from &&
      reply.body === candidate.body &&
      reply.timestamp === candidate.timestamp &&
      reply.isHuman === candidate.isHuman &&
      reply.projectId === candidate.projectId
  })
}

function chatMessagesEqual(left: ChatMessage, right: ChatMessage): boolean {
  return left.kind === right.kind &&
    left.from === right.from &&
    left.to === right.to &&
    left.body === right.body &&
    left.timestamp === right.timestamp &&
    left.isHuman === right.isHuman &&
    left.projectId === right.projectId &&
    left.conversationId === right.conversationId &&
    reactionsEqual(left.reactions, right.reactions) &&
    threadRepliesEqual(left.threadReplies, right.threadReplies)
}

// Find an existing optimistic local-UUID human echo that matches an incoming
// canonical broker record. Optimistic messages are appended by `addHumanMessage`
// with `crypto.randomUUID()` and `local: true`; the broker subsequently
// reconciles the same message with its canonical `event_id`. Without identity
// replacement, both records survive id-based reconciliation and the user sees
// their message twice. Match only against `local: true` records — without the
// scope, two distinct human messages sharing body/target inside the dedupe
// window would collapse, deleting a real message.
function findOptimisticHumanMatch(
  byId: Map<string, ChatMessage>,
  incoming: ChatMessage
): ChatMessage | null {
  if (!isHumanMessage(incoming)) return null
  for (const existing of byId.values()) {
    if (existing.id === incoming.id) continue
    if (!existing.local) continue
    if (!isHumanMessage(existing)) continue
    if (existing.body !== incoming.body) continue
    if (
      existing.projectId &&
      incoming.projectId &&
      existing.projectId !== incoming.projectId
    ) continue
    if (normalizeMessageTarget(existing.to) !== normalizeMessageTarget(incoming.to)) continue
    if (Math.abs(existing.timestamp - incoming.timestamp) > HUMAN_MESSAGE_DEDUPE_WINDOW_MS) continue
    return existing
  }
  return null
}

function reconcileChatMessages(
  existingMessages: ChatMessage[],
  incomingMessages: BrokerReconciledChatMessage[]
): ChatMessage[] {
  if (incomingMessages.length === 0) return existingMessages

  const byId = new Map(existingMessages.map((message) => [message.id, message]))
  const dedupIndex = new ChatMessageDedupIndex(byId.values())
  let changed = false

  for (const incoming of incomingMessages) {
    const next: ChatMessage = {
      ...incoming,
      kind: incoming.kind || 'message'
    }
    const previous = byId.get(next.id)
    if (previous) {
      const merged = {
        ...previous,
        ...next,
        threadReplies: next.threadReplies || previous.threadReplies,
        reactions: next.reactions || previous.reactions
      }
      if (!chatMessagesEqual(previous, merged)) {
        byId.set(next.id, merged)
        dedupIndex.replace(previous, merged)
        changed = true
      }
      continue
    }
    // No id match — check whether this is the canonical echo of an
    // optimistic local-UUID record we already have. If so, replace
    // (preserving any client-side UI state from the optimistic record)
    // rather than appending and creating a visible duplicate. The
    // `local: false` reset ensures a subsequent optimistic with the
    // same body/target/time can still match its own future canonical
    // echo, rather than being seen as already-replaced.
    const optimistic = findOptimisticHumanMatch(byId, next)
    if (optimistic) {
      dedupIndex.delete(optimistic)
      byId.delete(optimistic.id)
      const replacement: ChatMessage = {
        ...optimistic,
        ...next,
        threadReplies: next.threadReplies || optimistic.threadReplies,
        reactions: next.reactions || optimistic.reactions,
        local: false
      }
      byId.set(next.id, replacement)
      dedupIndex.add(replacement)
      changed = true
      continue
    }
    // No id match and not an optimistic-echo case — check the
    // agent-duplicate guardrail: if a non-human message with the
    // same (from, body, project, target) arrived within the agent
    // dedupe window via another stream (relay_inbound), don't append
    // a second copy under a different id. The index is kept in lockstep with
    // byId during this batch, so accepted earlier messages suppress later
    // replays exactly like the old byId.values() scan did.
    if (
      !isHumanMessage(next) &&
      isDuplicateAgentEcho(dedupIndex, next)
    ) {
      continue
    }
    byId.set(next.id, next)
    dedupIndex.add(next)
    changed = true
  }

  if (!changed) {
    setChatMessageDedupIndexCache(existingMessages, dedupIndex)
    return existingMessages
  }

  const nextMessages = capByCount(
    Array.from(byId.values()).sort((left, right) => left.timestamp - right.timestamp),
    MAX_CHAT_MESSAGES
  )
  setChatMessageDedupIndexCache(nextMessages, new ChatMessageDedupIndex(nextMessages))
  return nextMessages
}

interface AgentState {
  agents: Agent[]
  activeAgentKey: string | null
  messages: ChatMessage[]
  relayMessages: RelayMessage[]
  brokerStatus: 'disconnected' | 'connected' | 'error'
  brokerError: string | null
  brokerErrors: BrokerErrorEntry[]
  brokerEvents: BrokerEventRecord[]
  lastHumanMessageSentAt: number

  setActiveAgentKey: (key: string | null) => void
  markAgentActive: (projectId: string | undefined, name: string) => void
  setAgentTerminalMode: (projectId: string | undefined, name: string, mode: TerminalAttachMode) => void
  trackSpawnedAgent: (
    name: string,
    projectId: string,
    rootId?: string,
    cli?: string,
    rootPath?: string,
    options?: TrackSpawnedAgentOptions
  ) => void
  syncBrokerAgents: (agents: BrokerListAgent[], projectId?: string) => void
  syncBrokerDetailsStatus: (details: Pick<BrokerDetails, 'projectId' | 'health'>[]) => void
  hydrateBrokerEvents: (events: BrokerEventRecord[]) => void
  recordBrokerEvent: (event: BrokerEvent) => void
  reconcileMessages: (messages: BrokerReconciledChatMessage[]) => void
  handleBrokerEvent: (event: BrokerEvent) => void
  handleBrokerStatus: (status: { projectId?: string; status: string; error?: string }) => void
  addHumanMessage: (to: string, body: string, projectId?: string) => void
  addChannelJoinNotice: (projectId: string | undefined, channelName: string, participantName: string) => void
  addThreadReply: (messageId: string, body: string) => void
  toggleMessageReaction: (messageId: string, emoji: string) => void
  renameMessageChannel: (projectId: string | undefined, oldName: string, newName: string) => void
  setAgentChannelMembership: (
    projectId: string | undefined,
    name: string,
    channelName: string,
    subscribed: boolean
  ) => void
  clearAll: () => void
  getAgentBuffer: (projectId: string | undefined, name: string) => string[]
}

export const useAgentStore = create<AgentState>()(subscribeWithSelector((set, get) => ({
  agents: [],
  activeAgentKey: null,
  messages: [],
  relayMessages: [],
  brokerStatus: 'disconnected',
  brokerError: null,
  brokerErrors: [],
  brokerEvents: [],
  lastHumanMessageSentAt: 0,

  setActiveAgentKey: (key) => set({ activeAgentKey: key }),

  // Used by the PTY-chunk fast path to flip an agent into active/working on
  // the first chunk after idle, without sending a full handleBrokerEvent
  // through the regular pipeline.
  markAgentActive: (projectId, name) => {
    const agent = get().agents.find((a) => matchesAgent(a, projectId, name))
    if (!agent) return
    if (agent.activity === 'active' && agent.currentState === 'working') return
    set((state) => ({
      agents: state.agents.map((a) =>
        matchesAgent(a, projectId, name)
          ? { ...a, activity: 'active', currentState: 'working' }
          : a
      )
    }))
  },

  setAgentTerminalMode: (projectId, name, mode) => {
    set((state) => ({
      agents: state.agents.map((agent) =>
        matchesAgent(agent, projectId, name) ? { ...agent, terminalMode: mode } : agent
      )
    }))
  },

  // Called right after spawning to associate the agent with a project.
  trackSpawnedAgent: (name, projectId, rootId, cli, rootPath, options) => {
    const currentState = options?.currentState || 'idle'
    const activity = activityFromCurrentState(currentState)
    const lastActivityAtMs = getActivityTimestampMs(options?.lastActivityAt, options?.lastActivityMs)
    const channels = normalizeChannelList(options?.channels)
    set((state) => ({
      agents: state.agents.some((a) => matchesAgent(a, projectId, name))
        ? state.agents.map((a) =>
            matchesAgent(a, projectId, name)
              ? {
                  ...a,
                  projectId,
                  rootId,
                  rootPath,
                  cli: cli || a.cli,
                  currentState,
                  activity,
                  channels: channels ?? a.channels,
                  terminalMode: options?.terminalMode || a.terminalMode
                }
              : a
          )
        : [
            ...state.agents,
            {
              name,
              cli: cli || 'unknown',
              status: 'running',
              activity,
              currentState,
              projectId,
              rootId,
              rootPath,
              channels,
              terminalMode: options?.terminalMode || 'passthrough',
              pendingDeliveryIds: []
            }
          ]
    }))
    useTypingStore.getState().setFromState(getAgentKey(projectId, name), currentState, lastActivityAtMs)
  },

  syncBrokerAgents: (liveAgents, snapshotProjectId) => {
    const now = Date.now()
    set((state) => {
      const liveByKey = new Map(
        liveAgents.map((agent) => [getAgentKey(agent.projectId, agent.name), agent])
      )
      const existingKeys = new Set(state.agents.map(getAgentKeyForAgent))
      const staleKeys: string[] = []
      const nextAgents = state.agents.flatMap((agent) => {
        const key = getAgentKeyForAgent(agent)
        const liveAgent = liveByKey.get(key)
        if (!liveAgent) {
          if (snapshotProjectId && agent.projectId === snapshotProjectId) {
            staleKeys.push(key)
            return [{
              ...agent,
              status: 'exited' as const,
              activity: 'idle' as const,
              currentState: 'idle' as const,
              pendingDeliveryIds: []
            }]
          }
          return [agent]
        }

        const channels = normalizeChannelList(liveAgent.channels)
        const currentState = liveAgent.current_state || 'idle'
        const lastActivityAtMs = getActivityTimestampMs(
          liveAgent.last_activity_at,
          liveAgent.last_activity_ms,
          now
        )
        const terminalMode = terminalModeFromInboundDeliveryMode(liveAgent.inboundDeliveryMode)
        useTypingStore.getState().setFromState(getAgentKeyForAgent(agent), currentState, lastActivityAtMs)

        return [{
          ...agent,
          cli: liveAgent.cli || agent.cli,
          model: liveAgent.model || agent.model,
          status: 'running' as const,
          currentState,
          activity: activityFromCurrentState(currentState),
          channels,
          parent: liveAgent.parent || agent.parent,
          terminalMode: terminalMode || agent.terminalMode
        }]
      })

      for (const liveAgent of liveAgents) {
        const key = getAgentKey(liveAgent.projectId, liveAgent.name)
        if (existingKeys.has(key)) continue

        const currentState = liveAgent.current_state || 'idle'
        const lastActivityAtMs = getActivityTimestampMs(liveAgent.last_activity_at, liveAgent.last_activity_ms, now)
        const channels = normalizeChannelList(liveAgent.channels)
        useTypingStore.getState().setFromState(key, currentState, lastActivityAtMs)
        nextAgents.push({
          name: liveAgent.name,
          cli: liveAgent.cli || 'unknown',
          model: liveAgent.model,
          status: 'running',
          activity: activityFromCurrentState(currentState),
          currentState,
          projectId: liveAgent.projectId,
          channels,
          parent: liveAgent.parent,
          terminalMode: terminalModeFromInboundDeliveryMode(liveAgent.inboundDeliveryMode) || 'passthrough',
          pendingDeliveryIds: []
        })
      }

      for (const key of staleKeys) {
        useTypingStore.getState().clear(key)
      }
      const needNewActive = state.activeAgentKey ? staleKeys.includes(state.activeAgentKey) : false
      const nextActiveAgent = needNewActive
        ? nextAgents.find((agent) => agent.status === 'running')
        : undefined

      return {
        agents: nextAgents,
        ...(needNewActive
          ? { activeAgentKey: nextActiveAgent ? getAgentKeyForAgent(nextActiveAgent) : null }
          : {})
      }
    })
  },

  syncBrokerDetailsStatus: (details) => {
    set((state) => {
      const connectedProjectIds = new Set(
        details
          .filter((detail) => detail.health === 'connected')
          .map((detail) => detail.projectId)
      )
      const brokerErrors = connectedProjectIds.size > 0
        ? state.brokerErrors.filter((entry) => !entry.projectId || !connectedProjectIds.has(entry.projectId))
        : state.brokerErrors

      return {
        brokerStatus: connectedProjectIds.size > 0
          ? 'connected'
          : brokerErrors.length > 0
            ? 'error'
            : 'disconnected',
        brokerError: brokerErrors.length > 0 ? brokerErrors[0].message : null,
        brokerErrors
      }
    })
  },

  hydrateBrokerEvents: (events) => {
    set((state) => {
      const byId = new Map(state.brokerEvents.map((entry) => [entry.id, entry]))
      for (const entry of events) {
        byId.set(entry.id, {
          ...entry,
          event: compactBrokerEvent(entry.event)
        })
      }
      return {
        brokerEvents: pruneBrokerEvents(
          Array.from(byId.values()).sort((left, right) => left.timestamp - right.timestamp)
        )
      }
    })
  },

  recordBrokerEvent: (event) => {
    const entry = toBrokerEventRecord(event)
    set((state) => {
      if (state.brokerEvents.some((candidate) => candidate.id === entry.id)) {
        return {}
      }
      // Broker events arrive in order, so append; BrokerDetailsPage sorts at
      // display time and we don't want to pay O(n log n) on every event.
      return {
        brokerEvents: pruneBrokerEvents([...state.brokerEvents, entry])
      }
    })
  },

  reconcileMessages: (messages) => {
    set((state) => {
      const nextMessages = reconcileChatMessages(state.messages, messages)
      if (nextMessages === state.messages) return {}
      if (isBrokerDebugEnabled()) {
        console.info('[broker:renderer-reconcile]', {
          incoming: messages.length,
          before: state.messages.length,
          after: nextMessages.length
        })
      }
      return { messages: nextMessages }
    })
  },

  handleBrokerEvent: (event) => {
    // Destructure the discriminator and the two fields the guards key off.
    // Because `name`/`parent` are `const`, a `&& name` guard narrows them to
    // `string` for the whole branch — including the `set(...)` closures — so we
    // no longer need non-null assertions on event fields inside those closures.
    const { kind, name, parent } = event

    if (kind === 'agent_spawned' && name) {
      set((state) => {
        const parentAgent = parent
          ? state.agents.find((agent) => matchesAgent(agent, event.projectId, parent))
          : undefined
        const { brokerProjectId, activeProjectId } = useProjectStore.getState()
        const projectId = event.projectId || parentAgent?.projectId || activeProjectId || brokerProjectId || undefined
        const rootId = parentAgent?.rootId
        const rootPath = parentAgent?.rootPath
        const agentKey = getAgentKey(projectId, name)
        const currentState: AgentCurrentState = 'idle'
        const channels = normalizeChannelList(event.channels)
        const existingAgent = state.agents.find((a) => matchesAgent(a, projectId, name))
        const existingChannels = existingAgent?.channels || []
        const notices = channels
          ? channels
              .filter((channel) => !existingChannels.includes(channel))
              .map((channel) => createChannelJoinNotice(projectId, channel, name))
              .filter((notice): notice is ChatMessage => notice !== null)
          : []

        return {
          agents: state.agents.some((a) => matchesAgent(a, projectId, name))
            ? state.agents.map((a) =>
                matchesAgent(a, projectId, name)
                  ? {
                      ...a,
                      cli: event.cli || a.cli,
                      model: event.model || a.model,
                      status: 'running',
                      activity: activityFromCurrentState(currentState),
                      currentState,
                      channels: channels ?? a.channels,
                      projectId: a.projectId || projectId,
                      rootId: a.rootId || rootId,
                      rootPath: a.rootPath || rootPath,
                      parent: event.parent || a.parent,
                      terminalMode: a.terminalMode || 'passthrough'
                    }
                  : a
              )
            : [
                ...state.agents,
                {
                  name,
                  cli: event.cli || 'unknown',
                  model: event.model,
                  status: 'running',
                  activity: activityFromCurrentState(currentState),
                  currentState,
                  channels,
                  projectId,
                  rootId,
                  rootPath,
                  parent: event.parent,
                  terminalMode: 'passthrough',
                  pendingDeliveryIds: []
                }
              ],
          activeAgentKey: state.activeAgentKey || agentKey,
          messages: notices.length > 0 ? appendJoinNotices(state.messages, notices) : state.messages
        }
      })
    } else if ((kind === 'channel_subscribed' || kind === 'channel_unsubscribed') && name) {
      const channels = normalizeChannelList(event.channels)
      if (!channels || channels.length === 0) return

      set((state) => {
        const notices: ChatMessage[] = []
        let matchedAgent = false

        const agents = state.agents.map((agent) => {
          if (!matchesAgent(agent, event.projectId, name)) return agent
          matchedAgent = true

          const projectChannels = useProjectStore.getState().projects
            .find((project) => project.id === (event.projectId || agent.projectId))
            ?.channels || []
          const currentChannels = agent.channels ?? projectChannels
          const joinedChannels = kind === 'channel_subscribed'
            ? channels.filter((channel) => !currentChannels.includes(channel))
            : []
          const nextChannels = kind === 'channel_subscribed'
            ? Array.from(new Set([...currentChannels, ...channels]))
            : currentChannels.filter((channel) => !channels.includes(channel))

          for (const channel of joinedChannels) {
            const notice = createChannelJoinNotice(event.projectId || agent.projectId, channel, name)
            if (notice) notices.push(notice)
          }

          return { ...agent, channels: nextChannels }
        })

        if (!matchedAgent && kind === 'channel_subscribed') {
          for (const channel of channels) {
            const notice = createChannelJoinNotice(event.projectId, channel, name)
            if (notice) notices.push(notice)
          }
        }

        return {
          agents,
          messages: notices.length > 0 ? appendJoinNotices(state.messages, notices) : state.messages
        }
      })
    } else if ((kind === 'agent_exited' || kind === 'agent_released') && name) {
      const removedKeyForExpiry = getAgentKey(event.projectId, name)
      set((state) => {
        const removed = state.agents.find((a) => matchesAgent(a, event.projectId, name))
        const removedKey = removed ? getAgentKeyForAgent(removed) : removedKeyForExpiry
        const remaining = state.agents.filter((a) => !matchesAgent(a, event.projectId, name))
        const needNewActive = state.activeAgentKey === removedKey
        const nextActiveAgent = remaining.find((a) => a.status === 'running') || remaining[0]
        useTypingStore.getState().clear(removedKey)
        clearPtyBuffer(removedKey)
        return {
          agents: remaining,
          activeAgentKey: needNewActive && nextActiveAgent
            ? getAgentKeyForAgent(nextActiveAgent)
            : needNewActive
              ? null
              : state.activeAgentKey
        }
      })
    } else if (kind === 'worker_stream') {
      // worker_stream is delivered out-of-band via broker:pty-chunk for typing
      // latency reasons; nothing to do here.
    } else if (kind === 'delivery_queued' && name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          matchesAgent(a, event.projectId, name)
            ? {
                ...addPendingDelivery(a, event.event_id),
                activity: a.terminalMode === 'drive' ? a.activity : 'active',
                currentState: a.terminalMode === 'drive' ? a.currentState : 'working'
              }
            : a
        )
      }))
    } else if (kind === 'delivery_active' && name) {
      useTypingStore.getState().noteActivity(getAgentKey(event.projectId, name))
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, name)) return a
          return {
            ...addPendingDelivery(a, event.event_id),
            activity: 'active',
            currentState: 'working'
          }
        })
      }))
    } else if (
      ['delivery_injected', 'delivery_verified', 'delivery_ack', 'delivery_failed', 'message_delivery_confirmed', 'message_delivery_failed'].includes(kind) &&
      name
    ) {
      const startsActivity = ['delivery_injected', 'delivery_verified', 'message_delivery_confirmed'].includes(kind)
      if (startsActivity) {
        useTypingStore.getState().noteActivity(getAgentKey(event.projectId, name))
      }
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, name)) return a
          const nextAgent = clearPendingDeliveries(a, event.event_id)
          if (!startsActivity) {
            return nextAgent
          }
          return { ...nextAgent, activity: 'active', currentState: 'working' }
        })
      }))
    } else if (kind === 'agent_pending_drained' && name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          matchesAgent(a, event.projectId, name) ? clearPendingDeliveries(a) : a
        )
      }))
    } else if (kind === 'agent_inbound_delivery_mode_changed' && name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, name)) return a
          if (event.mode === 'manual_flush') {
            return { ...a, terminalMode: 'drive' }
          }
          return { ...a, terminalMode: 'passthrough' }
        })
      }))
    } else if (kind === 'relay_inbound' && event.from && event.target && event.body) {
      const eventFrom = event.from
      const eventTarget = event.target
      const eventBody = event.body
      set((state) => {
        const projectId = event.projectId || state.agents.find((a) => a.name === eventFrom)?.projectId
        const timestamp = Date.now()
        const isHuman = isHumanSender(eventFrom)
        const msg: ChatMessage = {
          id: event.event_id || crypto.randomUUID(),
          from: eventFrom,
          to: eventTarget,
          body: eventBody,
          timestamp,
          isHuman,
          projectId
        }
        const relay: RelayMessage = {
          from: eventFrom,
          target: eventTarget,
          body: eventBody,
          timestamp,
          projectId
        }
        const dedupIndex = getChatMessageDedupIndex(state.messages)
        const targetName = eventTarget.startsWith('#') ? null : normalizeMessageTarget(eventTarget)
        const alreadySeenById = dedupIndex.hasId(msg.id)
        const isDuplicate = alreadySeenById ||
          (isHuman && isCanonicalEchoOfLocalHuman(state.messages, msg)) ||
          (!isHuman && isDuplicateAgentEcho(dedupIndex, msg))
        const messages = isDuplicate
          ? state.messages
          : appendChatMessageWithDedupIndex(state.messages, msg)

        if (messages !== state.messages && isBrokerDebugEnabled()) {
          console.info('[broker:renderer-receipt]', {
            projectId,
            eventId: msg.id,
            kind,
            from: msg.from,
            to: msg.to
          })
        }

        return {
          agents: state.agents.map((a) => {
            const nextAgent = matchesAgent(a, projectId, eventFrom) ? clearPendingDeliveries(a) : a
            if (targetName && matchesAgent(nextAgent, projectId, targetName) && nextAgent.terminalMode !== 'drive') {
              useTypingStore.getState().noteActivity(getAgentKeyForAgent(nextAgent))
              return { ...nextAgent, activity: 'active', currentState: 'working' }
            }
            return nextAgent
          }),
          messages,
          relayMessages: capByCount([...state.relayMessages, relay], MAX_RELAY_MESSAGES)
        }
      })
    } else if (kind === 'agent_blocked_on_send' && name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, name)) return a
          useTypingStore.getState().clear(getAgentKeyForAgent(a))
          return { ...a, activity: 'active', currentState: 'blocked_on_send' }
        })
      }))
    } else if (kind === 'agent_idle' && name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, name)) return a
          useTypingStore.getState().clear(getAgentKeyForAgent(a))
          return { ...clearPendingDeliveries(a), activity: 'idle', currentState: 'idle' }
        })
      }))
    }
  },

  handleBrokerStatus: (status) => {
    set((state) => {
      const nextStatus = status.status as 'connected' | 'disconnected' | 'error'
      const nextError = status.error || null
      if (nextStatus === 'connected') {
        return {
          brokerStatus: nextStatus,
          brokerError: null,
          brokerErrors: status.projectId
            ? state.brokerErrors.filter((entry) => entry.projectId !== status.projectId)
            : []
        }
      }

      const shouldRecord =
        nextStatus === 'error' &&
        !!nextError &&
        (
          state.brokerStatus !== 'error' ||
          state.brokerErrors[0]?.message !== nextError ||
          state.brokerErrors[0]?.projectId !== status.projectId
        )

      return {
        brokerStatus: nextStatus,
        brokerError: nextError,
        brokerErrors: shouldRecord
          ? prependBrokerError(
              state.brokerErrors,
              {
                id: crypto.randomUUID(),
                message: nextError,
                timestamp: Date.now(),
                projectId: status.projectId
              }
            )
          : state.brokerErrors
      }
    })
  },

  addHumanMessage: (to, body, projectId) => {
    const timestamp = Date.now()
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: HUMAN_SENDER_NAME,
      to,
      body,
      timestamp,
      isHuman: true,
      projectId,
      local: true
    }
    // Append the optimistic record, unless the canonical echo for this
    // exact send already arrived first (see isCanonicalAlreadyPresent).
    // The previous isDuplicateHumanEcho check here silently dropped the
    // second of two identical sends within 10s ("ok", "ok"), losing a
    // real message — isCanonicalAlreadyPresent avoids that by only
    // matching against non-local (canonical) records, not other
    // optimistic ones.
    set((state) => {
      if (isCanonicalAlreadyPresent(state.messages, msg)) {
        return { lastHumanMessageSentAt: timestamp }
      }
      return {
        messages: appendChatMessageWithDedupIndex(state.messages, msg),
        lastHumanMessageSentAt: timestamp
      }
    })
  },

  addChannelJoinNotice: (projectId, channelName, participantName) => {
    const notice = createChannelJoinNotice(projectId, channelName, participantName)
    if (!notice) return

    set((state) => ({
      messages: appendJoinNotices(state.messages, [notice])
    }))
  },

  addThreadReply: (messageId, body) => {
    const trimmedBody = body.trim()
    if (!trimmedBody) return

    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== messageId) return message

        const reply: ChatThreadReply = {
          id: crypto.randomUUID(),
          from: HUMAN_SENDER_NAME,
          body: trimmedBody,
          timestamp: Date.now(),
          isHuman: true,
          projectId: message.projectId
        }

        return {
          ...message,
          threadReplies: [...(message.threadReplies || []), reply]
        }
      })
    }))
  },

  toggleMessageReaction: (messageId, emoji) => {
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== messageId) return message

        const reactions = message.reactions || []
        const existingReaction = reactions.find((reaction) => reaction.emoji === emoji)

        if (!existingReaction) {
          return {
            ...message,
            reactions: [...reactions, { emoji, count: 1, reactedByHuman: true }]
          }
        }

        if (!existingReaction.reactedByHuman) {
          return {
            ...message,
            reactions: reactions.map((reaction) =>
              reaction.emoji === emoji
                ? { ...reaction, count: reaction.count + 1, reactedByHuman: true }
                : reaction
            )
          }
        }

        const nextCount = existingReaction.count - 1
        const nextReactions = nextCount <= 0
          ? reactions.filter((reaction) => reaction.emoji !== emoji)
          : reactions.map((reaction) =>
              reaction.emoji === emoji
                ? { ...reaction, count: nextCount, reactedByHuman: false }
                : reaction
            )

        return {
          ...message,
          reactions: nextReactions
        }
      })
    }))
  },

  renameMessageChannel: (projectId, oldName, newName) => {
    const oldTarget = normalizeMessageTarget(oldName)
    const nextTarget = normalizeMessageTarget(newName)
    if (!oldTarget || !nextTarget || oldTarget === nextTarget) return

    set((state) => ({
      messages: state.messages.map((message) => {
        if (projectId && message.projectId !== projectId) return message
        if (normalizeMessageTarget(message.to) !== oldTarget) return message
        return {
          ...message,
          to: message.to.startsWith('#') ? `#${nextTarget}` : nextTarget
        }
      }),
      relayMessages: state.relayMessages.map((message) => {
        if (projectId && message.projectId !== projectId) return message
        if (normalizeMessageTarget(message.target) !== oldTarget) return message
        return {
          ...message,
          target: message.target.startsWith('#') ? `#${nextTarget}` : nextTarget
        }
      })
    }))
  },

  setAgentChannelMembership: (projectId, name, channelName, subscribed) => {
    const nextChannelName = normalizeMessageTarget(channelName)
    if (!nextChannelName) return

    set((state) => {
      const notices: ChatMessage[] = []

      return {
        agents: state.agents.map((agent) => {
          if (!matchesAgent(agent, projectId, name)) return agent

          const channels = agent.channels || []
          const alreadySubscribed = channels.includes(nextChannelName)
          const nextChannels = subscribed
            ? alreadySubscribed
              ? channels
              : [...channels, nextChannelName]
            : channels.filter((channel) => channel !== nextChannelName)
          const notice = subscribed && !alreadySubscribed
            ? createChannelJoinNotice(projectId || agent.projectId, nextChannelName, name)
            : null
          if (notice) notices.push(notice)

          return { ...agent, channels: nextChannels }
        }),
        messages: notices.length > 0 ? appendJoinNotices(state.messages, notices) : state.messages
      }
    })
  },

  clearAll: () => {
    resetChatMessageDedupIndexCache()
    set({
      agents: [],
      activeAgentKey: null,
      messages: [],
      relayMessages: [],
      brokerStatus: 'disconnected',
      brokerError: null,
      brokerErrors: [],
      brokerEvents: [],
      lastHumanMessageSentAt: 0
    })
  },

  getAgentBuffer: (projectId, name) => getPtyChunks(getAgentKey(projectId, name))
})))

// Cache for the agents-by-(projectId, name) lookup map. Rebuilding it costs
// O(n) on every PTY tick if we use a useMemo or selector that touches the
// agents array, so we key it on the array reference (which only changes when
// the store actually mutates agents) and reuse the same Map across renders.
// Callers like ChatMessage / ThreadParticipantAvatar previously did
// `state.agents.find(...)` inside a Zustand selector, which made every
// message component re-render whenever the agents array changed (every PTY
// chunk that flips activity / currentState).
let agentMapCache: { source: Agent[]; map: Map<string, Agent> } | null = null

function getAgentLookup(agents: Agent[]): Map<string, Agent> {
  if (agentMapCache && agentMapCache.source === agents) return agentMapCache.map

  const map = new Map<string, Agent>()
  for (const agent of agents) {
    map.set(getAgentKeyForAgent(agent), agent)
    // Also key by name only so callers without a projectId can fall back to
    // any matching agent — preserves the prior `agents.find` semantics for the
    // few call sites where projectId is unknown.
    const nameOnlyKey = `*:${agent.name}`
    if (!map.has(nameOnlyKey)) map.set(nameOnlyKey, agent)
  }

  agentMapCache = { source: agents, map }
  return map
}

/**
 * Look up an agent by (projectId, name) using a cached map that only rebuilds
 * when the agents array reference changes. The selector returns the agent
 * object directly so components only re-render when *their* agent changes,
 * not when any other agent's activity/state ticks.
 */
export function useAgentByName(
  projectId: string | undefined,
  name: string
): Agent | undefined {
  return useAgentStore((state) => {
    const lookup = getAgentLookup(state.agents)
    if (projectId !== undefined) {
      return lookup.get(getAgentKey(projectId, name))
    }
    return lookup.get(`*:${name}`)
  })
}
