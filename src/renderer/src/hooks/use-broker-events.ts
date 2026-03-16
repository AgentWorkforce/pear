import { useEffect } from 'react'
import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'

export function useBrokerEvents(): void {
  const handleBrokerEvent = useAgentStore((s) => s.handleBrokerEvent)
  const handleBrokerStatus = useAgentStore((s) => s.handleBrokerStatus)
  const setViewMode = useUIStore((s) => s.setViewMode)
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
    const unsubNewWt = pear.onMenu('menu:new-worktree', () => openDialog('add-worktree'))
    const unsubSpawn = pear.onMenu('menu:spawn-agent', () => openDialog('spawn-agent'))
    const unsubView = pear.onMenu('menu:view-mode', (mode) => {
      setViewMode(mode as 'terminal' | 'chat' | 'graph')
    })
    const unsubRelease = pear.onMenu('menu:release-agent', () => {
      const activeAgent = useAgentStore.getState().activeAgentName
      if (activeAgent) pear.broker.releaseAgent(activeAgent)
    })

    return () => {
      unsubEvent()
      unsubStatus()
      unsubNewWs()
      unsubNewWt()
      unsubSpawn()
      unsubView()
      unsubRelease()
    }
  }, [handleBrokerEvent, handleBrokerStatus, setViewMode, openDialog])
}
