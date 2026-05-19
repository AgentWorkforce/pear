import { useEffect } from 'react'
import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
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
    const unsubNewWs = pear.onMenu('menu:new-workspace', () => openDialog('add-workspace'))
    const unsubSpawn = pear.onMenu('menu:spawn-agent', () => openDialog('spawn-agent'))
    const unsubRelease = pear.onMenu('menu:release-agent', () => {
      const activeAgent = useAgentStore.getState().activeAgentName
      if (activeAgent) pear.broker.releaseAgent(activeAgent)
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
