import { useCallback } from 'react'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { useAgentStore, type Agent, getAgentKeyForAgent } from '@/stores/agent-store'

export type ActiveAgentDeliveryMode = 'drive' | 'auto'
type ActiveDeliveryAgent = Pick<Agent, 'name' | 'projectId' | 'terminalMode'>

let activeDeliveryAgentCache: ActiveDeliveryAgent | null = null

function terminalToDelivery(mode: Agent['terminalMode']): ActiveAgentDeliveryMode {
  return mode === 'drive' ? 'drive' : 'auto'
}

function deliveryToTerminal(mode: ActiveAgentDeliveryMode): TerminalAttachMode {
  return mode === 'drive' ? 'drive' : 'passthrough'
}

function selectActiveDeliveryAgent(state: ReturnType<typeof useAgentStore.getState>): ActiveDeliveryAgent | null {
  if (!state.activeAgentKey) {
    activeDeliveryAgentCache = null
    return null
  }

  const agent = state.agents.find((candidate) => getAgentKeyForAgent(candidate) === state.activeAgentKey)
  if (!agent) {
    activeDeliveryAgentCache = null
    return null
  }

  if (
    activeDeliveryAgentCache &&
    activeDeliveryAgentCache.name === agent.name &&
    activeDeliveryAgentCache.projectId === agent.projectId &&
    activeDeliveryAgentCache.terminalMode === agent.terminalMode
  ) {
    return activeDeliveryAgentCache
  }

  activeDeliveryAgentCache = {
    name: agent.name,
    projectId: agent.projectId,
    terminalMode: agent.terminalMode
  }
  return activeDeliveryAgentCache
}

/**
 * Read + toggle the Hold/Live (drive/auto) delivery mode for the focused agent.
 * Drives both the command-palette action and the global hotkey, so they stay in
 * sync without each re-implementing the agent-store + IPC dance.
 */
export function useActiveAgentDeliveryMode(): {
  activeAgent: ActiveDeliveryAgent | null
  currentMode: ActiveAgentDeliveryMode | null
  canToggle: boolean
  toggle: () => Promise<void>
} {
  const activeAgent = useAgentStore(selectActiveDeliveryAgent)
  const setAgentTerminalMode = useAgentStore((s) => s.setAgentTerminalMode)

  const currentMode = activeAgent ? terminalToDelivery(activeAgent.terminalMode) : null

  const toggle = useCallback(async () => {
    if (!activeAgent) return
    const next: ActiveAgentDeliveryMode = currentMode === 'drive' ? 'auto' : 'drive'
    const nextTerminal = deliveryToTerminal(next)
    const previousTerminal = activeAgent.terminalMode

    setAgentTerminalMode(activeAgent.projectId, activeAgent.name, nextTerminal)
    try {
      await pear.broker.setTerminalMode(activeAgent.projectId, activeAgent.name, nextTerminal)
    } catch (err) {
      setAgentTerminalMode(activeAgent.projectId, activeAgent.name, previousTerminal)
      console.error('[active-agent-delivery-mode] toggle failed', err)
    }
  }, [activeAgent, currentMode, setAgentTerminalMode])

  return {
    activeAgent,
    currentMode,
    canToggle: !!activeAgent,
    toggle
  }
}
