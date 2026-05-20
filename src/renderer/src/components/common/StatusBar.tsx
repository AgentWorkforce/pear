import type React from 'react'
import { FileDiff, Moon, Sun } from 'lucide-react'
import { useAgentStore } from '@/stores/agent-store'
import { useGitStore } from '@/stores/git-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

export function StatusBar(): React.ReactNode {
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const brokerErrors = useAgentStore((s) => s.brokerErrors)
  const agents = useAgentStore((s) => s.agents)
  const project = useProjectStore((s) => s.getActiveProject())
  const root = useProjectStore((s) => s.getActiveRoot())
  const changedFiles = useGitStore((s) => s.files)
  const summary = useGitStore((s) => s.summary)
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const openTab = useUIStore((s) => s.openTab)

  const runningAgents = agents.filter(
    (a) => a.status === 'running' && (!project || a.projectId === project.id)
  ).length

  const statusColor =
    brokerStatus === 'connected'
      ? 'bg-[var(--pear-accent)]'
      : brokerStatus === 'error'
        ? 'bg-[var(--pear-red)]'
        : 'bg-[var(--pear-text-faint)]'

  return (
    <div className="relative flex h-[38px] shrink-0 items-center gap-6 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-6 text-xs text-[var(--pear-text-dim)]">
      <button
        type="button"
        title="Open broker details"
        aria-label={`Broker status ${brokerStatus}. Open broker details.`}
        onClick={() => openTab({ kind: 'broker-details' })}
        className={`flex items-center gap-2 rounded-full px-2.5 py-1 transition-colors ${
          brokerStatus === 'error'
            ? 'border border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 text-[var(--pear-text)] hover:bg-[var(--pear-red)]/15'
            : 'hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]'
        }`}
      >
        <div className={`h-2 w-2 rounded-full ${statusColor}`} />
        <span>{brokerStatus}</span>
        {brokerErrors.length > 0 && (
          <span className="rounded-full bg-[var(--pear-red)]/15 px-1.5 py-0.5 text-[10px] text-[var(--pear-red)]">
            {brokerErrors.length}
          </span>
        )}
      </button>

      {runningAgents > 0 && (
        <span>{runningAgents} agent{runningAgents !== 1 ? 's' : ''}</span>
      )}

      {project && (
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--pear-text-secondary)]">{project.name}</span>
        </div>
      )}

      {project && root?.pathExists && summary?.rootPath === root.path && (
        <button
          type="button"
          onClick={() => openTab({ kind: 'source-control', projectId: project.id })}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
          title="Open source control"
          aria-label={`Open source control. ${changedFiles.length} changed files.`}
        >
          <FileDiff size={12} className="text-[var(--pear-text-faint)]" />
          <span>{changedFiles.length} changed file{changedFiles.length === 1 ? '' : 's'}</span>
          {(summary.additions > 0 || summary.deletions > 0) && (
            <span className="tabular-nums">
              <span className="text-[var(--pear-green)]">+{summary.additions}</span>
              <span className="mx-1 text-[var(--pear-text-faint)]">/</span>
              <span className="text-[var(--pear-red)]">-{summary.deletions}</span>
            </span>
          )}
        </button>
      )}

      <div className="flex-1" />

      <button
        onClick={toggleTheme}
        className="ml-1 rounded-lg p-1.5 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text-dim)]"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>
    </div>
  )
}
