import { useCallback, useEffect } from 'react'
import { pear, type BrokerListAgent } from '@/lib/ipc'
import { getAgentKeyForAgent, useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

type BrokerEventLike = Record<string, unknown> & {
  kind?: string
  projectId?: string
}

const CHANNEL_SNAPSHOT_EVENT_KINDS = new Set([
  'agent_spawned',
  'channel_subscribed',
  'channel_unsubscribed'
])

function getEventChannels(event: BrokerEventLike): string[] {
  const channels = event.channels
  if (!Array.isArray(channels)) return []
  return channels.filter((channel): channel is string => typeof channel === 'string' && channel.trim().length > 0)
}

function collectAgentChannelsByProject(agents: BrokerListAgent[]): Map<string, string[]> {
  const channelsByProject = new Map<string, string[]>()

  for (const agent of agents) {
    if (!agent.projectId || !agent.channels?.length) continue

    const channels = channelsByProject.get(agent.projectId) || []
    channels.push(...agent.channels)
    channelsByProject.set(agent.projectId, channels)
  }

  return channelsByProject
}

export function useBrokerEvents(): void {
  const handleBrokerEvent = useAgentStore((s) => s.handleBrokerEvent)
  const handleBrokerStatus = useAgentStore((s) => s.handleBrokerStatus)
  const recordBrokerEvent = useAgentStore((s) => s.recordBrokerEvent)
  const syncBrokerAgents = useAgentStore((s) => s.syncBrokerAgents)
  const rememberDiscoveredChannels = useProjectStore((s) => s.rememberDiscoveredChannels)
  const openDialog = useUIStore((s) => s.openDialog)

  const syncBrokerSnapshot = useCallback(async (projectId?: string): Promise<void> => {
    try {
      const agents = await pear.broker.listAgents(projectId)
      syncBrokerAgents(agents)
      for (const [agentProjectId, channels] of collectAgentChannelsByProject(agents)) {
        rememberDiscoveredChannels(agentProjectId, channels)
      }
    } catch {
      // The broker is not guaranteed to be running for every app state.
    }
  }, [rememberDiscoveredChannels, syncBrokerAgents])

  useEffect(() => {
    const unsubEvent = pear.broker.onEvent((event) => {
      const brokerEvent = event as Parameters<typeof handleBrokerEvent>[0] & BrokerEventLike
      recordBrokerEvent(brokerEvent)
      handleBrokerEvent(brokerEvent)

      if (brokerEvent.kind === 'channel_subscribed' || brokerEvent.kind === 'agent_spawned') {
        rememberDiscoveredChannels(brokerEvent.projectId, getEventChannels(brokerEvent))
      }
      if (brokerEvent.kind && CHANNEL_SNAPSHOT_EVENT_KINDS.has(brokerEvent.kind)) {
        void syncBrokerSnapshot(brokerEvent.projectId)
      }
    })

    const unsubStatus = pear.broker.onStatus((status) => {
      handleBrokerStatus(status)
      if (status.status === 'connected') {
        void syncBrokerSnapshot(status.projectId)
      }
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
  }, [
    handleBrokerEvent,
    handleBrokerStatus,
    openDialog,
    recordBrokerEvent,
    rememberDiscoveredChannels,
    syncBrokerSnapshot
  ])

  useEffect(() => {
    void syncBrokerSnapshot()
  }, [syncBrokerSnapshot])
}
