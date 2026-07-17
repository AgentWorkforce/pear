import { useCallback, useEffect } from 'react'
import { pear, type BrokerListAgent } from '@/lib/ipc'
import { getAgentKey, getAgentKeyForAgent, useAgentStore } from '@/stores/agent-store'
import { appendPtyChunk } from '@/stores/pty-buffer-store'
import { useProjectStore } from '@/stores/project-store'
import { useTypingStore } from '@/stores/typing-store'
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

// Monotonic token so overlapping `pear open` events resolve "latest wins":
// a slower earlier load/switch won't clobber a newer one that already applied.
let cliOpenSeq = 0

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
      syncBrokerAgents(agents, projectId)
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

    // PTY chunks ride a dedicated lightweight channel so per-character typing
    // doesn't pay for the broker:event metadata spread / structured clone.
    const unsubPtyChunk = pear.broker.onPtyChunk((projectId, name, chunk, offset, generation) => {
      const key = getAgentKey(projectId, name)
      appendPtyChunk(key, chunk, offset, generation)
      useTypingStore.getState().noteActivity(key)
      useAgentStore.getState().markAgentActive(projectId, name)
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
    const unsubCloseTab = pear.onMenu('menu:close-tab', () => {
      const { activeTabId, closeTab, tabs } = useUIStore.getState()

      if (tabs.length > 1) {
        closeTab(activeTabId)
        return
      }

      void pear.app.confirmQuit().catch((err) => {
        console.error('Failed to close Pear', err)
      })
    })
    const unsubRelease = pear.onMenu('menu:release-agent', () => {
      const activeAgentKey = useAgentStore.getState().activeAgentKey
      const agent = useAgentStore.getState().agents.find((entry) => getAgentKeyForAgent(entry) === activeAgentKey)
      if (agent) void pear.broker.releaseAgent(agent.projectId, agent.name)
    })

    // `pear open <dir>` from the CLI: the main process has already created or
    // selected the project on disk; reload to pick up any new project, then
    // switch the UI to it.
    const unsubOpenProject = pear.onMenu('cli:open-project', (projectId) => {
      if (typeof projectId !== 'string') return
      const seq = ++cliOpenSeq
      void (async () => {
        await useProjectStore.getState().load()
        // A newer open arrived while we were loading — let it win.
        if (seq !== cliOpenSeq) return
        useUIStore.getState().openTab({ kind: 'agents', projectId })
        await useProjectStore.getState().setActiveProject(projectId)
      })()
    })
    pear.app.notifyCliReady()

    return () => {
      unsubEvent()
      unsubPtyChunk()
      unsubStatus()
      unsubNewWs()
      unsubSpawn()
      unsubCloseTab()
      unsubRelease()
      unsubOpenProject()
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
