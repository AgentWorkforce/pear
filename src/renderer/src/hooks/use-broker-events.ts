import { useEffect } from 'react'
import { pear } from '@/lib/ipc'
import { getAgentKeyForAgent, useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'

export function useBrokerEvents(): void {
  const handleBrokerEvent = useAgentStore((s) => s.handleBrokerEvent)
  const handleBrokerStatus = useAgentStore((s) => s.handleBrokerStatus)
  const openDialog = useUIStore((s) => s.openDialog)

  useEffect(() => {
    const unsubEvent = pear.broker.onEvent((event) => {
      handleBrokerEvent(event as Parameters<typeof handleBrokerEvent>[0])
    })

    const unsubStatus = pear.broker.onStatus((status) => {
      handleBrokerStatus(status)
    })

    // Menu handlers
    const unsubNewWs = pear.onMenu('menu:new-project', () => openDialog('add-project'))
    const unsubSpawn = pear.onMenu('menu:spawn-agent', () => openDialog('spawn-agent'))
    const unsubRelease = pear.onMenu('menu:release-agent', () => {
      const activeAgentKey = useAgentStore.getState().activeAgentKey
      const agent = useAgentStore.getState().agents.find((entry) => getAgentKeyForAgent(entry) === activeAgentKey)
      if (agent) pear.broker.releaseAgent(agent.projectId, agent.name)
    })

    return () => {
      unsubEvent()
      unsubStatus()
      unsubNewWs()
      unsubSpawn()
      unsubRelease()
    }
  }, [handleBrokerEvent, handleBrokerStatus, openDialog])
}
