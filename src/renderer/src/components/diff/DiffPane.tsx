import type React from 'react'
import { useState } from 'react'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useGitStore } from '@/stores/git-store'
import { FileList } from './FileList'
import { DiffViewer } from './DiffViewer'
import { FileExplorer } from './FileExplorer'

type PaneTab = 'changes' | 'files'

export function DiffPane(): React.ReactNode {
  const [activeTab, setActiveTab] = useState<PaneTab>('changes')
  const worktree = useWorkspaceStore((s) => s.getActiveWorktree())
  const files = useGitStore((s) => s.files)
  const diff = useGitStore((s) => s.diff)
  const selectedFile = useGitStore((s) => s.selectedFile)

  if (!worktree) {
    return (
      <div className="flex h-full items-center justify-center border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
        <p className="text-sm text-[var(--pear-text-faint)]">Select a worktree to see changes</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="shrink-0 border-b border-[var(--pear-border-subtle)] px-2">
        <div className="flex items-center gap-1">
          {(['changes', 'files'] as const).map((tab) => {
            const isActive = activeTab === tab
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`border-b px-3 py-3 text-sm transition-colors ${
                  isActive
                    ? 'border-[var(--pear-text)] text-[var(--pear-text)]'
                    : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
                }`}
              >
                {tab === 'changes' ? 'Changes' : 'Files'}
              </button>
            )
          })}
        </div>
      </div>

      {activeTab === 'changes' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--pear-border-subtle)] p-3">
            <textarea
              disabled
              rows={2}
              placeholder="Commit message"
              className="mb-2 w-full resize-none rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] disabled:cursor-not-allowed disabled:opacity-100"
            />
            <button
              type="button"
              disabled
              className="w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-sm text-[var(--pear-text-faint)]"
            >
              Commit
            </button>
          </div>

          {files.length > 0 && (
            <FileList files={files} selectedFile={selectedFile} worktreePath={worktree.path} />
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {diff ? (
              <DiffViewer diff={diff} />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-sm text-[var(--pear-text-faint)]">
                {files.length === 0 ? 'No changes detected' : 'Select a file to view diff'}
              </div>
            )}
          </div>
        </div>
      ) : (
        <FileExplorer rootPath={worktree.path} />
      )}
    </div>
  )
}
