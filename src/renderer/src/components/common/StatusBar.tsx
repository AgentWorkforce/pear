import type React from 'react'
import { GitBranch, Sun, Moon } from 'lucide-react'
import { useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore, type ViewMode } from '@/stores/ui-store'

export function StatusBar(): React.ReactNode {
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const agents = useAgentStore((s) => s.agents)
  const workspace = useWorkspaceStore((s) => s.getActiveWorkspace())
  const worktree = useWorkspaceStore((s) => s.getActiveWorktree())
  const viewMode = useUIStore((s) => s.viewMode)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)

  const runningAgents = agents.filter((a) => a.status === 'running').length

  const statusColor =
    brokerStatus === 'connected'
      ? 'bg-[var(--pear-accent)]'
      : brokerStatus === 'error'
        ? 'bg-[var(--pear-red)]'
        : 'bg-[var(--pear-text-faint)]'

  return (
    <div className="flex h-[32px] shrink-0 items-center gap-5 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-6 text-xs text-[var(--pear-text-dim)]">
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${statusColor}`} />
        <span>{brokerStatus}</span>
      </div>

      {runningAgents > 0 && (
        <span>{runningAgents} agent{runningAgents !== 1 ? 's' : ''}</span>
      )}

      {workspace && (
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--pear-text-secondary)]">{workspace.name}</span>
          {worktree && (
            <>
              <GitBranch size={10} />
              <span>{worktree.branch}</span>
            </>
          )}
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-1">
        {(['terminal', 'chat', 'graph'] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`rounded-md px-2.5 py-1 ${
              viewMode === mode
                ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                : 'text-[var(--pear-text-faint)] hover:text-[var(--pear-text-dim)]'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      <button
        onClick={toggleTheme}
        className="ml-1 rounded-md p-1 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text-dim)]"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>
    </div>
  )
}
