import type React from 'react'
import { useEffect } from 'react'
import { Allotment } from 'allotment'
import { WorkspaceSidebar } from '@/components/sidebar/WorkspaceSidebar'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { ChatView } from '@/components/chat/ChatView'
import { GraphView } from '@/components/graph/GraphView'
import { DiffPane } from '@/components/diff/DiffPane'
import { StatusBar } from '@/components/common/StatusBar'
import { AddWorkspaceDialog } from '@/components/sidebar/AddWorkspaceDialog'
import { AddWorktreeDialog } from '@/components/sidebar/AddWorktreeDialog'
import { SpawnAgentDialog } from '@/components/sidebar/SpawnAgentDialog'
import { AgentToolbar } from '@/components/common/AgentToolbar'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'
import { useBrokerEvents } from '@/hooks/use-broker-events'
import { useGitStatus } from '@/hooks/use-git-status'

export default function App(): React.ReactNode {
  const viewMode = useUIStore((s) => s.viewMode)
  const activeDialog = useUIStore((s) => s.activeDialog)
  const load = useWorkspaceStore((s) => s.load)

  useBrokerEvents()
  useGitStatus()

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="h-full w-[232px] min-w-[188px] max-w-[340px] shrink-0">
          <WorkspaceSidebar />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="titlebar-drag h-[40px] shrink-0" />

          <AgentToolbar />

          <div className="min-h-0 flex-1">
            <Allotment>
              <Allotment.Pane>
                {viewMode === 'terminal' && <TerminalPane />}
                {viewMode === 'chat' && <ChatView />}
                {viewMode === 'graph' && <GraphView />}
              </Allotment.Pane>

              <Allotment.Pane preferredSize={280} minSize={200} maxSize={500}>
                <DiffPane />
              </Allotment.Pane>
            </Allotment>
          </div>
        </div>
      </div>

      <StatusBar />

      {activeDialog === 'add-workspace' && <AddWorkspaceDialog />}
      {activeDialog === 'add-worktree' && <AddWorktreeDialog />}
      {activeDialog === 'spawn-agent' && <SpawnAgentDialog />}
    </div>
  )
}
