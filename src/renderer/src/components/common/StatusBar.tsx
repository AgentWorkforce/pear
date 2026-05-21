import type React from 'react'
import { FileDiff, Moon, Sun } from 'lucide-react'
import { formatGitDiffLineCount } from '@/lib/format'
import { useAgentStore } from '@/stores/agent-store'
import { useGitStore } from '@/stores/git-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

export function StatusBar(): React.ReactNode {
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const brokerErrors = useAgentStore((s) => s.brokerErrors)
  const project = useProjectStore((s) => s.getActiveProject())
  const projectChangedFiles = useGitStore((s) => s.projectFiles)
  const projectSummary = useGitStore((s) => s.projectSummary)
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const openTab = useUIStore((s) => s.openTab)
  const projectRootPathKey = project?.roots
    .filter((root) => root.pathExists)
    .map((root) => root.path)
    .join('\0') || ''
  const projectSummaryMatchesRoots = !!projectSummary && projectSummary.rootPathKey === projectRootPathKey

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
        title="Open Agent Relay Status"
        aria-label={`Agent Relay status ${brokerStatus}. Open Agent Relay Status.`}
        onClick={() => openTab({
          kind: 'broker-details',
          projectId: project?.id,
          title: project ? `${project.name} Relay` : undefined
        })}
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

      {project && projectSummaryMatchesRoots && (
        <button
          type="button"
          onClick={() => openTab({ kind: 'source-control', projectId: project.id })}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
          title={`Open source control across ${projectSummary.rootCount} Git ${projectSummary.rootCount === 1 ? 'root' : 'roots'}`}
          aria-label={`Open source control. ${projectChangedFiles.length} changed files across ${projectSummary.rootCount} Git ${projectSummary.rootCount === 1 ? 'root' : 'roots'}.`}
        >
          <FileDiff size={12} className="text-[var(--pear-text-faint)]" />
          <span>{projectChangedFiles.length} changed file{projectChangedFiles.length === 1 ? '' : 's'}</span>
          {(projectSummary.additions > 0 || projectSummary.deletions > 0) && (
            <span className="tabular-nums">
              <span className="text-[var(--pear-green)]">+{formatGitDiffLineCount(projectSummary.additions)}</span>
              <span className="mx-1 text-[var(--pear-text-faint)]">/</span>
              <span className="text-[var(--pear-red)]">-{formatGitDiffLineCount(projectSummary.deletions)}</span>
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
