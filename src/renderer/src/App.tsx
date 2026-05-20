import type React from 'react'
import { useEffect } from 'react'
import { ProjectSidebar } from '@/components/sidebar/ProjectSidebar'
import { ProjectSettings } from '@/components/settings/ProjectSettings'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { ChatView } from '@/components/chat/ChatView'
import { BrokerDetailsPage } from '@/components/broker/BrokerDetailsPage'
import { DiffPane } from '@/components/diff/DiffPane'
import { AppTopBar } from '@/components/common/AppTopBar'
import { CommandMenu } from '@/components/common/CommandMenu'
import { StatusBar } from '@/components/common/StatusBar'
import { AddProjectDialog } from '@/components/sidebar/AddProjectDialog'
import { SpawnAgentDialog } from '@/components/sidebar/SpawnAgentDialog'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useBrokerEvents } from '@/hooks/use-broker-events'
import { useGitStatus } from '@/hooks/use-git-status'
import { useAgentStore } from '@/stores/agent-store'

export default function App(): React.ReactNode {
  const activeDialog = useUIStore((s) => s.activeDialog)
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const load = useProjectStore((s) => s.load)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const setActiveChannel = useProjectStore((s) => s.setActiveChannel)
  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)

  useBrokerEvents()
  useGitStatus()

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!activeTab) return

    let cancelled = false

    const syncActiveContext = async (): Promise<void> => {
      const tabProjectExists = activeTab.projectId
        ? projects.some((project) => project.id === activeTab.projectId)
        : false

      if (activeTab.projectId && tabProjectExists && activeProjectId !== activeTab.projectId) {
        await setActiveProject(activeTab.projectId)
      }

      if (cancelled) return

      if (activeTab.kind === 'channel') {
        setActiveAgentKey(null)
        setActiveChannel(activeTab.channelName || null)
      } else if (activeTab.kind === 'dm') {
        setActiveAgentKey(null)
        setActiveChannel(null)
      } else {
        setActiveChannel(null)
      }
    }

    void syncActiveContext()

    return () => {
      cancelled = true
    }
  }, [
    activeProjectId,
    activeTab,
    projects,
    setActiveAgentKey,
    setActiveChannel,
    setActiveProject
  ])

  const mainView = activeTab?.kind === 'project-settings'
    ? <ProjectSettings />
    : activeTab?.kind === 'broker-details'
      ? <BrokerDetailsPage />
    : activeTab?.kind === 'source-control'
      ? <DiffPane />
    : activeTab?.kind === 'channel' || activeTab?.kind === 'dm'
      ? <ChatView />
      : <TerminalPane />

  return (
    <div className="relative flex h-full flex-col">
      <AppTopBar />

      <div className="flex min-h-0 flex-1">
        <div
          className={`h-full shrink-0 transition-[width] duration-150 ${
            sidebarCollapsed ? 'w-[56px]' : 'w-[272px] min-w-[220px] max-w-[380px]'
          }`}
        >
          <ProjectSidebar />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {mainView}
          </div>
        </div>
      </div>

      <StatusBar />

      {activeDialog === 'add-project' && <AddProjectDialog />}
      {activeDialog === 'spawn-agent' && <SpawnAgentDialog />}
      <CommandMenu />
    </div>
  )
}
