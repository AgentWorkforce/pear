import { create } from 'zustand'

export interface Agent {
  name: string
  cli: string
  model?: string
  status: 'running' | 'exited'
  worktreePath?: string
  worktreeId?: string
  ptyBuffer: string[]
}

export interface ChatMessage {
  id: string
  from: string
  to: string
  body: string
  timestamp: number
  isHuman: boolean
  channel?: string
}

export interface RelayMessage {
  from: string
  target: string
  body: string
  timestamp: number
}

const MAX_PTY_BUFFER_CHUNKS = 10_000

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
  code?: number
  signal?: string
  [key: string]: unknown
}

interface AgentState {
  agents: Agent[]
  activeAgentName: string | null
  messages: ChatMessage[]
  relayMessages: RelayMessage[]
  brokerStatus: 'disconnected' | 'connected' | 'error'
  brokerError: string | null

  setActiveAgent: (name: string | null) => void
  trackSpawnedAgent: (name: string, worktreeId: string) => void
  handleBrokerEvent: (event: BrokerEvent) => void
  handleBrokerStatus: (status: { status: string; error?: string }) => void
  addHumanMessage: (to: string, body: string, channel?: string) => void
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

  setActiveAgent: (name) => set({ activeAgentName: name }),

  // Called right after spawning to associate the agent with a worktree
  trackSpawnedAgent: (name, worktreeId) => {
    set((state) => ({
      agents: state.agents.map((a) =>
        a.name === name ? { ...a, worktreeId } : a
      )
    }))
  },

  handleBrokerEvent: (event) => {
    const { kind } = event

    if (kind === 'agent_spawned' && event.name) {
      set((state) => ({
        agents: [
          ...state.agents,
          {
            name: event.name!,
            cli: event.cli || 'unknown',
            model: event.model,
            status: 'running',
            ptyBuffer: []
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
    } else if (kind === 'relay_inbound' && event.from && event.target && event.body) {
      const msg: ChatMessage = {
        id: event.event_id || crypto.randomUUID(),
        from: event.from,
        to: event.target,
        body: event.body,
        timestamp: Date.now(),
        isHuman: false,
        channel: event.channel as string | undefined
      }
      const relay: RelayMessage = {
        from: event.from,
        target: event.target,
        body: event.body,
        timestamp: Date.now()
      }
      set((state) => ({
        messages: [...state.messages, msg],
        relayMessages: [...state.relayMessages, relay]
      }))
    }
  },

  handleBrokerStatus: (status) => {
    set({
      brokerStatus: status.status as 'connected' | 'disconnected' | 'error',
      brokerError: status.error || null
    })
  },

  addHumanMessage: (to, body, channel?) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: 'human',
      to,
      body,
      timestamp: Date.now(),
      isHuman: true,
      channel
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
      brokerError: null
    }),

  getAgentBuffer: (name) => {
    return get().agents.find((a) => a.name === name)?.ptyBuffer || []
  }
}))
