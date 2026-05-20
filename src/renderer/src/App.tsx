import type React from 'react'
import { useEffect } from 'react'
import { ProjectSidebar } from '@/components/sidebar/ProjectSidebar'
import { ProjectSettings } from '@/components/settings/ProjectSettings'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { CommandMenu } from '@/components/common/CommandMenu'
import { StatusBar } from '@/components/common/StatusBar'
import { AddProjectDialog } from '@/components/sidebar/AddProjectDialog'
import { SpawnAgentDialog } from '@/components/sidebar/SpawnAgentDialog'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useBrokerEvents } from '@/hooks/use-broker-events'

export default function App(): React.ReactNode {
  const activeDialog = useUIStore((s) => s.activeDialog)
  const viewMode = useUIStore((s) => s.viewMode)
  const load = useProjectStore((s) => s.load)

  useBrokerEvents()

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="h-full w-[272px] min-w-[220px] max-w-[380px] shrink-0">
          <ProjectSidebar />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {viewMode === 'project-settings' ? <ProjectSettings /> : <TerminalPane />}
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
