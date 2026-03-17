import type React from 'react'
import { useState } from 'react'
import { ChevronRight, ChevronDown, FolderGit2, Trash2, Plus } from 'lucide-react'
import { useWorkspaceStore, type Workspace } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'
import { WorktreeItem } from './WorktreeItem'

interface Props {
  workspace: Workspace
  isActive: boolean
}

export function WorkspaceItem({ workspace, isActive }: Props): React.ReactNode {
  const [expanded, setExpanded] = useState(isActive)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const openDialog = useUIStore((s) => s.openDialog)

  const handleSelect = async (): Promise<void> => {
    if (!isActive) {
      await setActiveWorkspace(workspace.id)
    }
    setExpanded(!expanded)
  }

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
          isActive
            ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
            : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]/50'
        }`}
        onClick={handleSelect}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FolderGit2 size={14} className="text-[var(--pear-accent)]" />
        <span className="flex-1 truncate">{workspace.name}</span>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              openDialog('add-worktree')
            }}
            className="rounded p-0.5 hover:bg-[var(--pear-bg-overlay)]"
            title="Add worktree"
            aria-label="Add worktree"
          >
            <Plus size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (window.confirm(`Remove workspace "${workspace.name}"? This won't delete any files.`)) {
                removeWorkspace(workspace.id)
              }
            }}
            className="rounded p-0.5 text-[var(--pear-red)] hover:bg-[var(--pear-bg-overlay)]"
            title="Remove workspace"
            aria-label="Remove workspace"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="ml-4">
          {workspace.worktrees.length === 0 ? (
            <div className="px-2 py-2 text-xs text-[var(--pear-text-faint)]">No worktrees</div>
          ) : (
            workspace.worktrees.map((wt) => <WorktreeItem key={wt.id} worktree={wt} />)
          )}
        </div>
      )}
    </div>
  )
}
