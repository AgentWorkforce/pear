import { create } from 'zustand'

export interface Agent {
  name: string
  cli: string
  model?: string
  status: 'running' | 'exited'
  workspaceId?: string
  worktreePath?: string
  worktreeId?: string
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
  workspaceId?: string
}

export interface RelayMessage {
  from: string
  target: string
  body: string
  timestamp: number
  workspaceId?: string
}

export interface BrokerErrorEntry {
  id: string
  message: string
  timestamp: number
}

const MAX_PTY_BUFFER_CHUNKS = 10_000
const MAX_BROKER_ERRORS = 12

// Matches the real BrokerEvent discriminated union from @agent-relay/sdk
interface BrokerEvent {
  kind: string
  name?: string
  chunk?: string
  stream?: string
  cli?: string
  model?: string
  runtime?: string
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
  activeAgentName: string | null
  messages: ChatMessage[]
  relayMessages: RelayMessage[]
  brokerStatus: 'disconnected' | 'connected' | 'error'
  brokerError: string | null
  brokerErrors: BrokerErrorEntry[]

  setActiveAgent: (name: string | null) => void
  trackSpawnedAgent: (name: string, workspaceId: string, worktreeId?: string, cli?: string) => void
  handleBrokerEvent: (event: BrokerEvent) => void
  handleBrokerStatus: (status: { status: string; error?: string }) => void
  addHumanMessage: (to: string, body: string, workspaceId?: string) => void
  clearAll: () => void
  getAgentBuffer: (name: string) => string[]
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  activeAgentName: null,
  messages: [],
  relayMessages: [],
  brokerStatus: 'disconnected',
  brokerError: null,
  brokerErrors: [],

  setActiveAgent: (name) => set({ activeAgentName: name }),

  // Called right after spawning to associate the agent with a workspace.
  trackSpawnedAgent: (name, workspaceId, worktreeId, cli) => {
    set((state) => ({
      agents: state.agents.some((a) => a.name === name)
        ? state.agents.map((a) =>
            a.name === name ? { ...a, workspaceId, worktreeId, cli: cli || a.cli } : a
          )
        : [
            ...state.agents,
            {
              name,
              cli: cli || 'unknown',
              status: 'running',
              workspaceId,
              worktreeId,
              ptyBuffer: [],
              pendingDeliveryIds: []
            }
          ]
    }))
  },

  handleBrokerEvent: (event) => {
    const { kind } = event

    if (kind === 'agent_spawned' && event.name) {
      set((state) => ({
        agents: state.agents.some((a) => a.name === event.name)
          ? state.agents.map((a) =>
              a.name === event.name
                ? {
                    ...a,
                    cli: event.cli || a.cli,
                    model: event.model || a.model,
                    status: 'running'
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
                ptyBuffer: [],
                pendingDeliveryIds: []
              }
            ],
        activeAgentName: state.activeAgentName || event.name!
      }))
    } else if ((kind === 'agent_exited' || kind === 'agent_released') && event.name) {
      set((state) => {
        const remaining = state.agents.filter((a) => a.name !== event.name)
        const needNewActive = state.activeAgentName === event.name
        return {
          agents: remaining,
          activeAgentName: needNewActive
            ? (remaining.find((a) => a.status === 'running')?.name || remaining[0]?.name || null)
            : state.activeAgentName
        }
      })
    } else if (kind === 'worker_stream' && event.name && event.chunk) {
      set((state) => ({
        agents: state.agents.map((a) => {
          if (a.name !== event.name) return a
          const buffer = [...a.ptyBuffer, event.chunk!]
          return {
            ...a,
            ptyBuffer: buffer.length > MAX_PTY_BUFFER_CHUNKS
              ? buffer.slice(buffer.length - MAX_PTY_BUFFER_CHUNKS)
              : buffer
          }
        })
      }))
    } else if (
      ['delivery_queued', 'delivery_injected', 'delivery_active', 'delivery_ack'].includes(kind) &&
      event.name
    ) {
      set((state) => ({
        agents: state.agents.map((a) =>
          a.name === event.name ? addPendingDelivery(a, event.event_id) : a
        )
      }))
    } else if (kind === 'delivery_failed' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          a.name === event.name ? clearPendingDeliveries(a, event.event_id) : a
        )
      }))
    } else if (kind === 'relay_inbound' && event.from && event.target && event.body) {
      set((state) => {
        const workspaceId = state.agents.find((a) => a.name === event.from)?.workspaceId
        const msg: ChatMessage = {
          id: event.event_id || crypto.randomUUID(),
          from: event.from,
          to: event.target,
          body: event.body,
          timestamp: Date.now(),
          isHuman: false,
          workspaceId
        }
        const relay: RelayMessage = {
          from: event.from,
          target: event.target,
          body: event.body,
          timestamp: Date.now(),
          workspaceId
        }
        return {
        agents: state.agents.map((a) =>
          a.name === event.from ? clearPendingDeliveries(a) : a
        ),
        messages: [...state.messages, msg],
        relayMessages: [...state.relayMessages, relay]
        }
      })
    } else if (kind === 'agent_idle' && event.name) {
      set((state) => ({
        agents: state.agents.map((a) =>
          a.name === event.name ? clearPendingDeliveries(a) : a
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

  addHumanMessage: (to, body, workspaceId) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: 'human',
      to,
      body,
      timestamp: Date.now(),
      isHuman: true,
      workspaceId
    }
    set((state) => ({ messages: [...state.messages, msg] }))
  },

  clearAll: () =>
    set({
      agents: [],
      activeAgentName: null,
      messages: [],
      relayMessages: [],
      brokerStatus: 'disconnected',
      brokerError: null,
      brokerErrors: []
    }),

  getAgentBuffer: (name) => {
    return get().agents.find((a) => a.name === name)?.ptyBuffer || []
  }
}))
