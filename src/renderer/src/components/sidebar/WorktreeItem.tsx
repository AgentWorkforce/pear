import type React from 'react'
import { GitBranch } from 'lucide-react'
import { useWorkspaceStore, type Worktree } from '@/stores/workspace-store'

interface Props {
  workspaceId: string
  worktree: Worktree
}

export function WorktreeItem({ workspaceId, worktree }: Props): React.ReactNode {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree)
  const isActive = activeWorktreeId === worktree.id

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-left transition-colors ${
        isActive
          ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
          : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]'
      }`}
      onClick={async () => {
        if (activeWorkspaceId !== workspaceId) {
          await setActiveWorkspace(workspaceId)
        }
        setActiveWorktree(worktree.id)
      }}
    >
      <GitBranch size={12} className="text-[var(--pear-accent-bright)]" />
      <span className="truncate">{worktree.branch}</span>
    </button>
  )
}
