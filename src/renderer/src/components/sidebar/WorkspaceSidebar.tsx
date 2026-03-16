import type React from 'react'
import { Plus } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'
import { WorkspaceItem } from './WorkspaceItem'

export function WorkspaceSidebar(): React.ReactNode {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const openDialog = useUIStore((s) => s.openDialog)

  return (
    <div className="flex h-full flex-col border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="titlebar-nodrag flex items-center justify-between px-4 pb-2 pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">Workspaces</span>
        <button
          onClick={() => openDialog('add-workspace')}
          className="rounded p-1 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
          title="Add workspace"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3">
        {workspaces.length === 0 ? (
          <button
            onClick={() => openDialog('add-workspace')}
            className="w-full rounded-md border border-dashed border-[var(--pear-border)] px-4 py-5 text-center text-xs text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text-dim)]"
          >
            + Add workspace
          </button>
        ) : (
          workspaces.map((ws) => (
            <WorkspaceItem key={ws.id} workspace={ws} isActive={ws.id === activeWorkspaceId} />
          ))
        )}
      </div>
    </div>
  )
}
