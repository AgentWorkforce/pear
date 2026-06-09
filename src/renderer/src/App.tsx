import type React from 'react'
import { useEffect } from 'react'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { ProjectSettings } from '@/components/settings/ProjectSettings'
import { AccountSettings } from '@/components/settings/AccountSettings'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { ChatView } from '@/components/chat/ChatView'
import { BrokerDetailsPage } from '@/components/broker/BrokerDetailsPage'
import { BurnSessionPage } from '@/components/burn/BurnSessionPage'
import { BurnProjectPage } from '@/components/burn/BurnProjectPage'
import { BurnSessionDetailPage } from '@/components/burn/BurnSessionDetailPage'
import { DiffPane } from '@/components/diff/DiffPane'
import { AttentionInbox } from '@/components/issues/AttentionInbox'
import ConversationsPanel from '@/components/ai-hist/ConversationsPanel'
import { AppTopBar } from '@/components/common/AppTopBar'
import { CommandMenu } from '@/components/common/CommandMenu'
import { StatusBar } from '@/components/common/StatusBar'
import { UpdateBanner } from '@/components/common/UpdateBanner'
import { AddProjectDialog } from '@/components/sidebar/AddProjectDialog'
import { AddChannelDialog } from '@/components/sidebar/AddChannelDialog'
import { SpawnAgentDialog } from '@/components/sidebar/SpawnAgentDialog'
import { AddAgentDialog } from '@/components/agents/AddAgentDialog'
import { CloudAgentDialog } from '@/components/agents/CloudAgentDialog'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useBrokerEvents } from '@/hooks/use-broker-events'
import { useCloudAgentEvents } from '@/hooks/use-cloud-agent'
import { useGitStatus } from '@/hooks/use-git-status'
import { useMessageReconciliation } from '@/hooks/use-message-reconciliation'
import { useUpdateEvents } from '@/hooks/use-update-events'
import { useAgentStore } from '@/stores/agent-store'
import { initTypingTrace } from '@/lib/typing-trace'

initTypingTrace()

export default function App(): React.ReactNode {
  const activeDialog = useUIStore((s) => s.activeDialog)
  const closeDialog = useUIStore((s) => s.closeDialog)
  const openDialog = useUIStore((s) => s.openDialog)
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const load = useProjectStore((s) => s.load)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const setActiveChannel = useProjectStore((s) => s.setActiveChannel)
  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)

  useBrokerEvents()
  useCloudAgentEvents()
  useGitStatus()
  useMessageReconciliation()
  useUpdateEvents()

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
    : activeTab?.kind === 'account-settings'
      ? <AccountSettings />
    : activeTab?.kind === 'broker-details'
      ? <BrokerDetailsPage />
    : activeTab?.kind === 'source-control'
      ? <DiffPane />
    : activeTab?.kind === 'issues'
      ? <AttentionInbox />
    : activeTab?.kind === 'ai-hist'
      ? <ConversationsPanel />
    : activeTab?.kind === 'burn-session'
      ? <BurnSessionPage />
    : activeTab?.kind === 'burn-project'
      ? <BurnProjectPage />
    : activeTab?.kind === 'burn-session-detail'
      ? <BurnSessionDetailPage />
    : activeTab?.kind === 'channel' || activeTab?.kind === 'dm'
      ? <ChatView />
      : <TerminalPane />

  return (
    <div className="relative flex h-full flex-col">
      <AppTopBar />
      <UpdateBanner />

      <div className="flex min-h-0 flex-1">
        <div
          className={`relative z-30 h-full shrink-0 transition-[width] duration-150 ${
            sidebarCollapsed ? 'w-[56px]' : 'w-[272px] min-w-[220px] max-w-[380px]'
          }`}
        >
          <Sidebar />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {mainView}
          </div>
        </div>
      </div>

      <StatusBar />

      {activeDialog === 'add-project' && <AddProjectDialog />}
      {activeDialog === 'add-channel' && <AddChannelDialog />}
      {activeDialog === 'spawn-agent' && (
        <AddAgentDialog
          open
          onClose={closeDialog}
          onSelectLocal={() => openDialog('spawn-local-agent')}
          onSelectCloud={() => openDialog('cloud-agent')}
        />
      )}
      {activeDialog === 'spawn-local-agent' && <SpawnAgentDialog />}
      {activeDialog === 'cloud-agent' && <CloudAgentDialog />}
      <CommandMenu />
    </div>
  )
}
