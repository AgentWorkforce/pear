import type React from 'react'
import { useEffect } from 'react'
import { WorkspaceSidebar } from '@/components/sidebar/WorkspaceSidebar'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { StatusBar } from '@/components/common/StatusBar'
import { AddWorkspaceDialog } from '@/components/sidebar/AddWorkspaceDialog'
import { SpawnAgentDialog } from '@/components/sidebar/SpawnAgentDialog'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'
import { useBrokerEvents } from '@/hooks/use-broker-events'

export default function App(): React.ReactNode {
  const activeDialog = useUIStore((s) => s.activeDialog)
  const load = useWorkspaceStore((s) => s.load)

  useBrokerEvents()

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
          <div className="min-h-0 flex-1">
            <TerminalPane />
          </div>
        </div>
      </div>

      <StatusBar />

      {activeDialog === 'add-workspace' && <AddWorkspaceDialog />}
      {activeDialog === 'spawn-agent' && <SpawnAgentDialog />}
    </div>
  )
}
