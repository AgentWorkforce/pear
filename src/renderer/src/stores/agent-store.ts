import { create } from 'zustand'
import type {
  AgentCurrentState,
  BrokerDetails,
  BrokerEventRecord,
  BrokerListAgent,
  InboundDeliveryMode,
  TerminalAttachMode
} from '@/lib/ipc'
import { useProjectStore } from '@/stores/project-store'

export interface Agent {
  name: string
  cli: string
  model?: string
  status: 'running' | 'exited'
  activity: 'idle' | 'active'
  currentState: AgentCurrentState
  lastActivityAtMs?: number
  typingUntilMs?: number
  projectId?: string
  rootPath?: string
  rootId?: string
  parent?: string
  channels?: string[]
  terminalMode: TerminalAttachMode
  ptyBuffer: string[]
  pendingDeliveryIds: string[]
}

export interface ChatMessage {
  id: string
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

const MAX_PTY_BUFFER_CHUNKS = 10_000
const MAX_BROKER_ERRORS = 12
const MAX_BROKER_EVENTS = 3_000
const BROKER_EVENT_RETENTION_MS = 12 * 60 * 60 * 1_000
const MAX_BROKER_EVENT_TEXT_CHARS = 1_200
const HUMAN_SENDER_NAME = 'human'
const HUMAN_MESSAGE_DEDUPE_WINDOW_MS = 10_000
const TYPING_ACTIVITY_WINDOW_MS = 12_000

export function getAgentKey(projectId: string | undefined, name: string): string {
  return `${projectId || 'unknown'}:${name}`
}

export function getAgentKeyForAgent(agent: Pick<Agent, 'projectId' | 'name'>): string {
  return getAgentKey(agent.projectId, agent.name)
}

export function isAgentTyping(
  agent: Pick<Agent, 'currentState' | 'typingUntilMs'>,
  now = Date.now()
): boolean {
  return agent.currentState === 'working' &&
    typeof agent.typingUntilMs === 'number' &&
    now < agent.typingUntilMs
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

function getTypingUntilMs(currentState: AgentCurrentState, lastActivityAtMs?: number): number | undefined {
  if (currentState !== 'working' || typeof lastActivityAtMs !== 'number') {
    return undefined
  }
  const typingUntilMs = lastActivityAtMs + TYPING_ACTIVITY_WINDOW_MS
  return typingUntilMs > Date.now() ? typingUntilMs : undefined
}

const typingExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

function normalizeEventTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value
}

function compactBrokerEventText(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= MAX_BROKER_EVENT_TEXT_CHARS) {
    return value
  }
  return `${value.slice(0, MAX_BROKER_EVENT_TEXT_CHARS)}...`
}

function compactBrokerEvent(event: Record<string, unknown>): BrokerEventRecord['event'] {
  const compacted = { ...event }
  for (const key of ['body', 'chunk', 'message', 'reason', 'lastError']) {
    if (key in compacted) {
      compacted[key] = compactBrokerEventText(compacted[key])
    }
  }
  return compacted as BrokerEventRecord['event']
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

function scheduleTypingExpiry(
  key: string,
  typingUntilMs: number | undefined,
  set: (updater: (state: AgentState) => Partial<AgentState>) => void
): void {
  const existingTimer = typingExpiryTimers.get(key)
  if (existingTimer) {
    window.clearTimeout(existingTimer)
    typingExpiryTimers.delete(key)
  }

  if (!typingUntilMs) return

  const delay = typingUntilMs - Date.now()
  if (delay <= 0) return

  const timer = window.setTimeout(() => {
    typingExpiryTimers.delete(key)
    set((state) => ({
      agents: state.agents.map((agent) =>
        getAgentKeyForAgent(agent) === key && agent.typingUntilMs === typingUntilMs
          ? { ...agent, typingUntilMs: undefined }
          : agent
      )
    }))
  }, delay + 50)

  typingExpiryTimers.set(key, timer)
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  activeAgentKey: null,
  messages: [],
  relayMessages: [],
  brokerStatus: 'disconnected',
  brokerError: null,
  brokerErrors: [],
  brokerEvents: [],

  setActiveAgentKey: (key) => set({ activeAgentKey: key }),

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
    const typingUntilMs = getTypingUntilMs(currentState, lastActivityAtMs)
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
                  lastActivityAtMs: lastActivityAtMs ?? a.lastActivityAtMs,
                  typingUntilMs,
                  channels: options?.channels || a.channels,
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
              lastActivityAtMs,
              typingUntilMs,
              projectId,
              rootId,
              rootPath,
              channels: options?.channels,
              terminalMode: options?.terminalMode || 'passthrough',
              ptyBuffer: [],
              pendingDeliveryIds: []
            }
          ]
    }))
    scheduleTypingExpiry(getAgentKey(projectId, name), typingUntilMs, set)
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

        const currentState = liveAgent.current_state || 'idle'
        const lastActivityAtMs = getActivityTimestampMs(
          liveAgent.last_activity_at,
          liveAgent.last_activity_ms,
          now
        )
        const typingUntilMs = getTypingUntilMs(currentState, lastActivityAtMs)
        const terminalMode = terminalModeFromInboundDeliveryMode(liveAgent.inboundDeliveryMode)
        scheduleTypingExpiry(getAgentKeyForAgent(agent), typingUntilMs, set)

        return {
          ...agent,
          cli: liveAgent.cli || agent.cli,
          model: liveAgent.model || agent.model,
          currentState,
          activity: activityFromCurrentState(currentState),
          lastActivityAtMs: lastActivityAtMs ?? agent.lastActivityAtMs,
          typingUntilMs,
          channels: liveAgent.channels,
          terminalMode: terminalMode || agent.terminalMode
        }
      })

      for (const liveAgent of liveAgents) {
        const key = getAgentKey(liveAgent.projectId, liveAgent.name)
        if (existingKeys.has(key)) continue

        const currentState = liveAgent.current_state || 'idle'
        const lastActivityAtMs = getActivityTimestampMs(liveAgent.last_activity_at, liveAgent.last_activity_ms, now)
        const typingUntilMs = getTypingUntilMs(currentState, lastActivityAtMs)
        scheduleTypingExpiry(key, typingUntilMs, set)
        nextAgents.push({
          name: liveAgent.name,
          cli: liveAgent.cli || 'unknown',
          model: liveAgent.model,
          status: 'running',
          activity: activityFromCurrentState(currentState),
          currentState,
          lastActivityAtMs,
          typingUntilMs,
          projectId: liveAgent.projectId,
          channels: liveAgent.channels,
          terminalMode: terminalModeFromInboundDeliveryMode(liveAgent.inboundDeliveryMode) || 'passthrough',
          ptyBuffer: [],
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
      return {
        brokerEvents: pruneBrokerEvents(
          [...state.brokerEvents, entry].sort((left, right) => left.timestamp - right.timestamp)
        )
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
        const agentKey = getAgentKey(projectId, event.name)
        const currentState: AgentCurrentState = 'idle'

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
                      lastActivityAtMs: a.lastActivityAtMs,
                      channels: a.channels,
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
                  lastActivityAtMs: undefined,
                  channels: undefined,
                  projectId,
                  rootId,
                  rootPath,
                  parent: event.parent,
                  terminalMode: 'passthrough',
                  ptyBuffer: [],
                  pendingDeliveryIds: []
                }
              ],
          activeAgentKey: state.activeAgentKey || agentKey
        }
      })
    } else if ((kind === 'agent_exited' || kind === 'agent_released') && event.name) {
      set((state) => {
        const removed = state.agents.find((a) => matchesAgent(a, event.projectId, event.name!))
        const removedKey = removed ? getAgentKeyForAgent(removed) : getAgentKey(event.projectId, event.name!)
        const remaining = state.agents.filter((a) => !matchesAgent(a, event.projectId, event.name!))
        const needNewActive = state.activeAgentKey === removedKey
        const nextActiveAgent = remaining.find((a) => a.status === 'running') || remaining[0]
        scheduleTypingExpiry(removedKey, undefined, set)
        return {
          agents: remaining,
          activeAgentKey: needNewActive && nextActiveAgent
            ? getAgentKeyForAgent(nextActiveAgent)
            : needNewActive
              ? null
              : state.activeAgentKey
        }
      })
    } else if (kind === 'worker_stream' && event.name && event.chunk) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          const lastActivityAtMs = Date.now()
          const typingUntilMs = lastActivityAtMs + TYPING_ACTIVITY_WINDOW_MS
          scheduleTypingExpiry(getAgentKeyForAgent(a), typingUntilMs, set)
          const buffer = [...a.ptyBuffer, event.chunk!]
          return {
            ...a,
            activity: 'active',
            currentState: 'working',
            lastActivityAtMs,
            typingUntilMs,
            ptyBuffer: buffer.length > MAX_PTY_BUFFER_CHUNKS
              ? buffer.slice(buffer.length - MAX_PTY_BUFFER_CHUNKS)
              : buffer
          }
        })
      }))
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
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          const lastActivityAtMs = Date.now()
          const typingUntilMs = lastActivityAtMs + TYPING_ACTIVITY_WINDOW_MS
          scheduleTypingExpiry(getAgentKeyForAgent(a), typingUntilMs, set)
          return {
            ...addPendingDelivery(a, event.event_id),
            activity: 'active',
            currentState: 'working',
            lastActivityAtMs,
            typingUntilMs
          }
        })
      }))
    } else if (
      ['delivery_injected', 'delivery_verified', 'delivery_ack', 'delivery_failed', 'message_delivery_confirmed', 'message_delivery_failed'].includes(kind) &&
      event.name
    ) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          const nextAgent = clearPendingDeliveries(a, event.event_id)
          if (!['delivery_injected', 'delivery_verified', 'message_delivery_confirmed'].includes(kind)) {
            return nextAgent
          }
          const lastActivityAtMs = Date.now()
          const typingUntilMs = lastActivityAtMs + TYPING_ACTIVITY_WINDOW_MS
          scheduleTypingExpiry(getAgentKeyForAgent(a), typingUntilMs, set)
          return { ...nextAgent, activity: 'active', currentState: 'working', lastActivityAtMs, typingUntilMs }
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
      set((state) => {
        const projectId = event.projectId || state.agents.find((a) => a.name === event.from)?.projectId
        const timestamp = Date.now()
        const isHuman = isHumanSender(event.from)
        const msg: ChatMessage = {
          id: event.event_id || crypto.randomUUID(),
          from: event.from,
          to: event.target,
          body: event.body,
          timestamp,
          isHuman,
          projectId
        }
        const relay: RelayMessage = {
          from: event.from,
          target: event.target,
          body: event.body,
          timestamp,
          projectId
        }
        const targetName = event.target.startsWith('#') ? null : normalizeMessageTarget(event.target)
        const messages = isHuman && isDuplicateHumanEcho(state.messages, msg)
          ? state.messages
          : [...state.messages, msg]

        return {
          agents: state.agents.map((a) => {
            const nextAgent = matchesAgent(a, projectId, event.from!) ? clearPendingDeliveries(a) : a
            if (targetName && matchesAgent(nextAgent, projectId, targetName) && nextAgent.terminalMode !== 'drive') {
              const lastActivityAtMs = Date.now()
              const typingUntilMs = lastActivityAtMs + TYPING_ACTIVITY_WINDOW_MS
              scheduleTypingExpiry(getAgentKeyForAgent(nextAgent), typingUntilMs, set)
              return { ...nextAgent, activity: 'active', currentState: 'working', lastActivityAtMs, typingUntilMs }
            }
            return nextAgent
          }),
          messages,
          relayMessages: [...state.relayMessages, relay]
        }
      })
    } else if (kind === 'agent_blocked_on_send' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          scheduleTypingExpiry(getAgentKeyForAgent(a), undefined, set)
          return { ...a, activity: 'active', currentState: 'blocked_on_send', lastActivityAtMs: Date.now(), typingUntilMs: undefined }
        })
      }))
    } else if (kind === 'agent_idle' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (!matchesAgent(a, event.projectId, event.name!)) return a
          scheduleTypingExpiry(getAgentKeyForAgent(a), undefined, set)
          return { ...clearPendingDeliveries(a), activity: 'idle', currentState: 'idle', typingUntilMs: undefined }
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
        : [...state.messages, msg]
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

    set((state) => ({
      agents: state.agents.map((agent) => {
        if (!matchesAgent(agent, projectId, name)) return agent

        const channels = agent.channels || []
        const nextChannels = subscribed
          ? channels.includes(nextChannelName)
            ? channels
            : [...channels, nextChannelName]
          : channels.filter((channel) => channel !== nextChannelName)

        return { ...agent, channels: nextChannels }
      })
    }))
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

  getAgentBuffer: (projectId, name) => {
    return get().agents.find((a) => matchesAgent(a, projectId, name))?.ptyBuffer || []
  }
}))
