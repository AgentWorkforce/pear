import { useCallback, useMemo } from 'react'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { useAgentStore, type Agent, getAgentKeyForAgent } from '@/stores/agent-store'

export type ActiveAgentDeliveryMode = 'drive' | 'auto'

function terminalToDelivery(mode: Agent['terminalMode']): ActiveAgentDeliveryMode {
  return mode === 'drive' ? 'drive' : 'auto'
}

function deliveryToTerminal(mode: ActiveAgentDeliveryMode): TerminalAttachMode {
  return mode === 'drive' ? 'drive' : 'passthrough'
}

/**
 * Read + toggle the Hold/Live (drive/auto) delivery mode for the focused agent.
 * Drives both the command-palette action and the global hotkey, so they stay in
 * sync without each re-implementing the agent-store + IPC dance.
 */
export function useActiveAgentDeliveryMode(): {
  activeAgent: Agent | null
  currentMode: ActiveAgentDeliveryMode | null
  canToggle: boolean
  toggle: () => Promise<void>
} {
  const agents = useAgentStore((s) => s.agents)
  const activeAgentKey = useAgentStore((s) => s.activeAgentKey)
  const setAgentTerminalMode = useAgentStore((s) => s.setAgentTerminalMode)

  const activeAgent = useMemo(() => {
    if (!activeAgentKey) return null
    return agents.find((agent) => getAgentKeyForAgent(agent) === activeAgentKey) ?? null
  }, [agents, activeAgentKey])

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
