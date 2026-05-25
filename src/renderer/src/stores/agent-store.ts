import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  AgentCurrentState,
  BrokerDetails,
  BrokerEventRecord,
  BrokerListAgent,
  InboundDeliveryMode,
  TerminalAttachMode
} from '@/lib/ipc'
import { normalizeChannelName, useProjectStore } from '@/stores/project-store'
import {
  compactBrokerEvent as compactBrokerEventPayload,
  normalizeEventTimestamp
} from '@shared/lib/broker-events'
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
  reactions?: ChatReaction[]
  threadReplies?: ChatThreadReply[]
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

const MAX_BROKER_ERRORS = 12
const MAX_BROKER_EVENTS = 3_000
const BROKER_EVENT_RETENTION_MS = 12 * 60 * 60 * 1_000
// Chat + relay history are display/graph buffers, not a source of truth, so cap
// them the same way broker events are capped. Without this they grow for the
// life of the session (one entry per relay_inbound), which is the dominant
// renderer memory leak behind long-session crashes.
const MAX_CHAT_MESSAGES = 5_000
const MAX_RELAY_MESSAGES = 5_000
const HUMAN_SENDER_NAME = 'human'
const SYSTEM_NOTICE_SENDER_NAME = 'system'
const HUMAN_MESSAGE_DEDUPE_WINDOW_MS = 10_000
const JOIN_NOTICE_DEDUPE_WINDOW_MS = 30_000

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

// Matches the real BrokerEvent discriminated union from @agent-relay/sdk
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

function isDuplicateHumanEcho(
  messages: ChatMessage[],
  candidate: Pick<ChatMessage, 'body' | 'projectId' | 'timestamp' | 'to'>
): boolean {
  return messages.some((message) =>
    isHumanMessage(message) &&
    message.body === candidate.body &&
    (!message.projectId || !candidate.projectId || message.projectId === candidate.projectId) &&
    normalizeMessageTarget(message.to) === normalizeMessageTarget(candidate.to) &&
    Math.abs(message.timestamp - candidate.timestamp) < HUMAN_MESSAGE_DEDUPE_WINDOW_MS
  )
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

  return capByCount(nextMessages, MAX_CHAT_MESSAGES)
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
  syncBrokerAgents: (agents: BrokerListAgent[]) => void
  syncBrokerDetailsStatus: (details: Pick<BrokerDetails, 'projectId' | 'health'>[]) => void
  hydrateBrokerEvents: (events: BrokerEventRecord[]) => void
  recordBrokerEvent: (event: BrokerEvent) => void
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

  syncBrokerAgents: (liveAgents) => {
    const now = Date.now()
    set((state) => {
      const liveByKey = new Map(
        liveAgents.map((agent) => [getAgentKey(agent.projectId, agent.name), agent])
      )
      const existingKeys = new Set(state.agents.map(getAgentKeyForAgent))
      const nextAgents = state.agents.map((agent) => {
        const liveAgent = liveByKey.get(getAgentKeyForAgent(agent))
        if (!liveAgent) return agent

        const channels = normalizeChannelList(liveAgent.channels)
        const currentState = liveAgent.current_state || 'idle'
        const lastActivityAtMs = getActivityTimestampMs(
          liveAgent.last_activity_at,
          liveAgent.last_activity_ms,
          now
        )
        const terminalMode = terminalModeFromInboundDeliveryMode(liveAgent.inboundDeliveryMode)
        useTypingStore.getState().setFromState(getAgentKeyForAgent(agent), currentState, lastActivityAtMs)

        return {
          ...agent,
          cli: liveAgent.cli || agent.cli,
          model: liveAgent.model || agent.model,
          currentState,
          activity: activityFromCurrentState(currentState),
          channels,
          parent: liveAgent.parent || agent.parent,
          terminalMode: terminalMode || agent.terminalMode
        }
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

      return { agents: nextAgents }
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

  handleBrokerEvent: (event) => {
    const { kind } = event

    if (kind === 'agent_spawned' && event.name) {
      set((state) => {
        const parentAgent = event.parent
          ? state.agents.find((agent) => matchesAgent(agent, event.projectId, event.parent!))
          : undefined
        const { brokerProjectId, activeProjectId } = useProjectStore.getState()
        const projectId = event.projectId || parentAgent?.projectId || activeProjectId || brokerProjectId || undefined
        const rootId = parentAgent?.rootId
        const rootPath = parentAgent?.rootPath
        const agentKey = getAgentKey(projectId, event.name!)
        const currentState: AgentCurrentState = 'idle'
        const channels = normalizeChannelList(event.channels)
        const existingAgent = state.agents.find((a) => matchesAgent(a, projectId, event.name!))
        const existingChannels = existingAgent?.channels || []
        const notices = channels
          ? channels
              .filter((channel) => !existingChannels.includes(channel))
              .map((channel) => createChannelJoinNotice(projectId, channel, event.name!))
              .filter((notice): notice is ChatMessage => notice !== null)
          : []

        return {
          agents: state.agents.some((a) => matchesAgent(a, projectId, event.name!))
            ? state.agents.map((a) =>
                matchesAgent(a, projectId, event.name!)
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
                  name: event.name!,
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
    } else if ((kind === 'channel_subscribed' || kind === 'channel_unsubscribed') && event.name) {
      const channels = normalizeChannelList(event.channels)
      if (!channels || channels.length === 0) return

      set((state) => {
        const notices: ChatMessage[] = []
        let matchedAgent = false

        const agents = state.agents.map((agent) => {
          if (!matchesAgent(agent, event.projectId, event.name!)) return agent
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
            const notice = createChannelJoinNotice(event.projectId || agent.projectId, channel, event.name!)
            if (notice) notices.push(notice)
          }

          return { ...agent, channels: nextChannels }
        })

        if (!matchedAgent && kind === 'channel_subscribed') {
          for (const channel of channels) {
            const notice = createChannelJoinNotice(event.projectId, channel, event.name!)
            if (notice) notices.push(notice)
          }
        }

        return {
          agents,
          messages: notices.length > 0 ? appendJoinNotices(state.messages, notices) : state.messages
        }
      })
    } else if ((kind === 'agent_exited' || kind === 'agent_released') && event.name) {
      const removedKeyForExpiry = getAgentKey(event.projectId, event.name!)
      set((state) => {
        const removed = state.agents.find((a) => matchesAgent(a, event.projectId, event.name!))
        const removedKey = removed ? getAgentKeyForAgent(removed) : removedKeyForExpiry
        const remaining = state.agents.filter((a) => !matchesAgent(a, event.projectId, event.name!))
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
    } else if (kind === 'delivery_queued' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          matchesAgent(a, event.projectId, event.name!)
            ? {
                ...addPendingDelivery(a, event.event_id),
                activity: a.terminalMode === 'drive' ? a.activity : 'active',
                currentState: a.terminalMode === 'drive' ? a.currentState : 'working'
              }
            : a
        )
      }))
    } else if (kind === 'delivery_active' && event.name) {
      useTypingStore.getState().noteActivity(getAgentKey(event.projectId, event.name))
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          return {
            ...addPendingDelivery(a, event.event_id),
            activity: 'active',
            currentState: 'working'
          }
        })
      }))
    } else if (
      ['delivery_injected', 'delivery_verified', 'delivery_ack', 'delivery_failed', 'message_delivery_confirmed', 'message_delivery_failed'].includes(kind) &&
      event.name
    ) {
      const startsActivity = ['delivery_injected', 'delivery_verified', 'message_delivery_confirmed'].includes(kind)
      if (startsActivity) {
        useTypingStore.getState().noteActivity(getAgentKey(event.projectId, event.name))
      }
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          const nextAgent = clearPendingDeliveries(a, event.event_id)
          if (!startsActivity) {
            return nextAgent
          }
          return { ...nextAgent, activity: 'active', currentState: 'working' }
        })
      }))
    } else if (kind === 'agent_pending_drained' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          matchesAgent(a, event.projectId, event.name!) ? clearPendingDeliveries(a) : a
        )
      }))
    } else if (kind === 'agent_inbound_delivery_mode_changed' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
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
        const targetName = eventTarget.startsWith('#') ? null : normalizeMessageTarget(eventTarget)
        const messages = isHuman && isDuplicateHumanEcho(state.messages, msg)
          ? state.messages
          : capByCount([...state.messages, msg], MAX_CHAT_MESSAGES)

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
    } else if (kind === 'agent_blocked_on_send' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          useTypingStore.getState().clear(getAgentKeyForAgent(a))
          return { ...a, activity: 'active', currentState: 'blocked_on_send' }
        })
      }))
    } else if (kind === 'agent_idle' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
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
          ? [
              {
                id: crypto.randomUUID(),
                message: nextError,
                timestamp: Date.now(),
                projectId: status.projectId
              },
              ...state.brokerErrors
            ].slice(0, MAX_BROKER_ERRORS)
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
      projectId
    }
    set((state) => ({
      messages: isDuplicateHumanEcho(state.messages, msg)
        ? state.messages
        : capByCount([...state.messages, msg], MAX_CHAT_MESSAGES)
    }))
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

  clearAll: () =>
    set({
      agents: [],
      activeAgentKey: null,
      messages: [],
      relayMessages: [],
      brokerStatus: 'disconnected',
      brokerError: null,
      brokerErrors: [],
      brokerEvents: []
    }),

  getAgentBuffer: (projectId, name) => getPtyChunks(getAgentKey(projectId, name))
})))
