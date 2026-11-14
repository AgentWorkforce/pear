import { useCallback, useMemo } from 'react'
import { useAgentStore, type Agent, getAgentKeyForAgent } from '@/stores/agent-store'

export type ActiveAgentDeliveryMode = 'drive' | 'auto'

function terminalToDelivery(mode: Agent['terminalMode']): ActiveAgentDeliveryMode {
  return mode === 'drive' ? 'drive' : 'auto'
}

/**
 * Read the focused agent's Hold/Live (drive/auto) delivery mode.
 *
 * Mode switching left with the terminal: the broker:no longer exposes a
 * set-terminal-mode channel, so `toggle` is intentionally inert and
 * `canToggle` is always false. The hook stays so the command palette can
 * keep displaying the current mode without re-implementing the lookup.
 */
export function useActiveAgentDeliveryMode(): {
  activeAgent: Agent | null
  currentMode: ActiveAgentDeliveryMode | null
  canToggle: boolean
  toggle: () => Promise<void>
} {
  const agents = useAgentStore((s) => s.agents)
  const activeAgentKey = useAgentStore((s) => s.activeAgentKey)

  const activeAgent = useMemo(() => {
    if (!activeAgentKey) return null
    return agents.find((agent) => getAgentKeyForAgent(agent) === activeAgentKey) ?? null
  }, [agents, activeAgentKey])

  const currentMode = activeAgent ? terminalToDelivery(activeAgent.terminalMode) : null

  // No-op: delivery-mode switching required the removed terminal channel.
  // Kept (guarded by `canToggle: false`) so existing callers compile.
  const toggle = useCallback(async () => {}, [])

  return {
    activeAgent,
    currentMode,
    canToggle: false,
    toggle
  }
}
