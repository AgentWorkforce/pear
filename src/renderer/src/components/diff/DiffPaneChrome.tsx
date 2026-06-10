import type React from 'react'
import type { Project, ProjectRoot } from '@/stores/project-store'
import { CurrentRootSelector } from './RepoHeader'
import { SOURCE_HEADER_HEIGHT, type PaneTab, type RootGitState } from './diffPaneUtils'

export function EmptyRepoState({
  rootMessage,
  project,
  activeRoot,
  gitStates,
  width,
  onSelectRoot
}: {
  rootMessage: string
  project: Project | undefined
  activeRoot: ProjectRoot | undefined
  gitStates: Record<string, RootGitState>
  width: number
  onSelectRoot: (id: string) => void
}): React.ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
      <div
        className="relative z-30 flex shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
        style={{ height: SOURCE_HEADER_HEIGHT }}
      >
        <CurrentRootSelector
          project={project}
          activeRoot={activeRoot}
          gitStates={gitStates}
          width={width}
          onSelect={onSelectRoot}
        />
        <div className="flex min-w-0 flex-1 items-center px-4 text-[13px] font-medium text-[var(--pear-text-faint)]">
          {rootMessage}
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center px-8">
        <p className="text-[13px] text-[var(--pear-text-faint)]">{rootMessage}</p>
      </div>
    </div>
  )
}

export function PaneTabs({
  activeTab,
  onSelectTab,
  fileCount
}: {
  activeTab: PaneTab
  onSelectTab: (tab: PaneTab) => void
  fileCount: number
}): React.ReactNode {
  return (
    <div className="grid h-11 shrink-0 grid-cols-2 border-b border-[var(--pear-border-subtle)]">
      <button
        type="button"
        onClick={() => onSelectTab('changes')}
        className={`flex items-center justify-center gap-2 border-b-2 px-4 text-[14px] font-semibold transition-colors hover:bg-[var(--pear-bg-surface-hover)] ${
          activeTab === 'changes'
            ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
            : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
        }`}
      >
        Changes
        {fileCount > 0 && (
          <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[11px] leading-none text-[var(--pear-text-secondary)]">
            {fileCount}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => onSelectTab('history')}
        className={`flex items-center justify-center gap-2 border-b-2 px-4 text-[14px] font-semibold transition-colors hover:bg-[var(--pear-bg-surface-hover)] ${
          activeTab === 'history'
            ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
            : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
        }`}
      >
        History
      </button>
    </div>
  )
}
