import { create } from 'zustand'
import type { TerminalAttachMode } from '@/lib/ipc'
import { useProjectStore } from '@/stores/project-store'

export interface Agent {
  name: string
  cli: string
  model?: string
  status: 'running' | 'exited'
  activity: 'idle' | 'active'
  projectId?: string
  rootPath?: string
  rootId?: string
  parent?: string
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
}

const MAX_PTY_BUFFER_CHUNKS = 10_000
const MAX_BROKER_ERRORS = 12

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
  code?: number
  signal?: string
  [key: string]: unknown
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

interface AgentState {
  agents: Agent[]
  activeAgentKey: string | null
  messages: ChatMessage[]
  relayMessages: RelayMessage[]
  brokerStatus: 'disconnected' | 'connected' | 'error'
  brokerError: string | null
  brokerErrors: BrokerErrorEntry[]

  setActiveAgentKey: (key: string | null) => void
  setAgentTerminalMode: (projectId: string | undefined, name: string, mode: TerminalAttachMode) => void
  trackSpawnedAgent: (name: string, projectId: string, rootId?: string, cli?: string, rootPath?: string) => void
  handleBrokerEvent: (event: BrokerEvent) => void
  handleBrokerStatus: (status: { projectId?: string; status: string; error?: string }) => void
  addHumanMessage: (to: string, body: string, projectId?: string) => void
  clearAll: () => void
  getAgentBuffer: (projectId: string | undefined, name: string) => string[]
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  activeAgentKey: null,
  messages: [],
  relayMessages: [],
  brokerStatus: 'disconnected',
  brokerError: null,
  brokerErrors: [],

  setActiveAgentKey: (key) => set({ activeAgentKey: key }),

  setAgentTerminalMode: (projectId, name, mode) => {
    set((state) => ({
      agents: state.agents.map((agent) =>
        matchesAgent(agent, projectId, name) ? { ...agent, terminalMode: mode } : agent
      )
    }))
  },

  // Called right after spawning to associate the agent with a project.
  trackSpawnedAgent: (name, projectId, rootId, cli, rootPath) => {
    set((state) => ({
      agents: state.agents.some((a) => matchesAgent(a, projectId, name))
        ? state.agents.map((a) =>
            matchesAgent(a, projectId, name)
              ? { ...a, projectId, rootId, rootPath, cli: cli || a.cli, activity: 'active' }
              : a
          )
        : [
            ...state.agents,
            {
              name,
              cli: cli || 'unknown',
              status: 'running',
              activity: 'active',
              projectId,
              rootId,
              rootPath,
              terminalMode: 'passthrough',
              ptyBuffer: [],
              pendingDeliveryIds: []
            }
          ]
    }))
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

        return {
          agents: state.agents.some((a) => matchesAgent(a, projectId, event.name!))
            ? state.agents.map((a) =>
                matchesAgent(a, projectId, event.name!)
                  ? {
                      ...a,
                      cli: event.cli || a.cli,
                      model: event.model || a.model,
                      status: 'running',
                      activity: 'active',
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
                  activity: 'active',
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
          const buffer = [...a.ptyBuffer, event.chunk!]
          return {
            ...a,
            activity: 'active',
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
            ? { ...addPendingDelivery(a, event.event_id), activity: 'active' }
            : a
        )
      }))
    } else if (kind === 'delivery_active' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          matchesAgent(a, event.projectId, event.name!)
            ? { ...addPendingDelivery(a, event.event_id), activity: 'active' }
            : a
        )
      }))
    } else if (
      ['delivery_injected', 'delivery_verified', 'delivery_ack', 'delivery_failed', 'message_delivery_confirmed', 'message_delivery_failed'].includes(kind) &&
      event.name
    ) {
      set((state) => ({
        agents: state.agents.map((a) =>
          matchesAgent(a, event.projectId, event.name!) ? clearPendingDeliveries(a, event.event_id) : a
        )
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
        const msg: ChatMessage = {
          id: event.event_id || crypto.randomUUID(),
          from: event.from,
          to: event.target,
          body: event.body,
          timestamp: Date.now(),
          isHuman: false,
          projectId
        }
        const relay: RelayMessage = {
          from: event.from,
          target: event.target,
          body: event.body,
          timestamp: Date.now(),
          projectId
        }
        return {
          agents: state.agents.map((a) =>
            matchesAgent(a, projectId, event.from!) ? clearPendingDeliveries(a) : a
          ),
          messages: [...state.messages, msg],
          relayMessages: [...state.relayMessages, relay]
        }
      })
    } else if (kind === 'agent_idle' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          matchesAgent(a, event.projectId, event.name!)
            ? { ...clearPendingDeliveries(a), activity: 'idle' }
            : a
        )
      }))
    }
  },

  handleBrokerStatus: (status) => {
    set((state) => {
      const nextStatus = status.status as 'connected' | 'disconnected' | 'error'
      const nextError = status.error || null
      const shouldRecord =
        nextStatus === 'error' &&
        !!nextError &&
        (state.brokerStatus !== 'error' || state.brokerErrors[0]?.message !== nextError)

      return {
        brokerStatus: nextStatus,
        brokerError: nextError,
        brokerErrors: shouldRecord
          ? [
              {
                id: crypto.randomUUID(),
                message: nextError,
                timestamp: Date.now()
              },
              ...state.brokerErrors
            ].slice(0, MAX_BROKER_ERRORS)
          : state.brokerErrors
      }
    })
  },

  addHumanMessage: (to, body, projectId) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: 'human',
      to,
      body,
      timestamp: Date.now(),
      isHuman: true,
      projectId
    }
    set((state) => ({ messages: [...state.messages, msg] }))
  },

  clearAll: () =>
    set({
      agents: [],
      activeAgentKey: null,
      messages: [],
      relayMessages: [],
      brokerStatus: 'disconnected',
      brokerError: null,
      brokerErrors: []
    }),

  getAgentBuffer: (projectId, name) => {
    return get().agents.find((a) => matchesAgent(a, projectId, name))?.ptyBuffer || []
  }
}))
