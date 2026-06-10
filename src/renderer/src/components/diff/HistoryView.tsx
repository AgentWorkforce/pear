import type React from 'react'
import {
  Copy,
  Expand,
  GitBranch,
  GitCommitHorizontal,
  GripVertical,
  Loader2,
  Minimize2
} from 'lucide-react'
import type { AuthUser, GitHistoryCommit } from '@/lib/ipc'
import { PaneSidebar } from '@/components/common/PaneShell'
import { formatGitDiffLineCount } from '@/lib/format'
import { DiffViewer } from './DiffViewer'
import {
  FileChangeStatusIcon,
  FilePathLabel,
  fileChangeKindFromStatus,
  fileChangeStatusLabel
} from './FileChangeLabel'
import { CommitAuthorStack } from './commitAuthors'
import {
  avatarUrlsForCommit,
  commitAuthorLabel,
  commitCoAuthors,
  commitMessagePreview,
  formatRelativeDate,
  selectedFilePathTone,
  selectedFileRowClass,
  startPanelResize,
  HISTORY_FILES_MAX_WIDTH,
  HISTORY_FILES_MIN_WIDTH
} from './diffPaneUtils'

function HistoryCommit({
  commit,
  active,
  authorAvatarUrls,
  onSelect
}: {
  commit: GitHistoryCommit
  active: boolean
  authorAvatarUrls: string[]
  onSelect: () => void
}): React.ReactNode {
  const tags = commit.tags.slice(0, 2)

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onSelect}
      data-commit-list-hash={commit.hash}
      className={`commit-history-row w-full border-b border-[var(--pear-border-subtle)] px-2.5 py-2 text-left transition-colors ${
        active
          ? 'bg-[var(--pear-selection-blue)] text-white'
          : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)]'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5">{commit.subject}</span>
        {tags.map((tag) => (
          <span
            key={tag}
            className={`max-w-[104px] shrink-0 truncate rounded-full px-2 py-0.5 text-[12px] font-semibold leading-4 ${
              active ? 'bg-white/20 text-white' : 'bg-[#5c6672] text-white'
            }`}
            title={tag}
          >
            {tag}
          </span>
        ))}
      </div>
      <div className={`mt-1 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 ${active ? 'text-white/90' : 'text-[var(--pear-text-faint)]'}`}>
        <CommitAuthorStack commit={commit} authorAvatarUrls={authorAvatarUrls} active={active} />
        <span className="min-w-0 truncate">{commitAuthorLabel(commit)}</span>
        <span className="shrink-0">•</span>
        <span className="shrink-0">{formatRelativeDate(commit.date)}</span>
      </div>
    </button>
  )
}

function HistoryCommitDetails({
  commit,
  authorAvatarUrls,
  expanded,
  onCopyHash,
  onToggleExpanded
}: {
  commit: GitHistoryCommit
  authorAvatarUrls: string[]
  expanded: boolean
  onCopyHash: () => void
  onToggleExpanded: () => void
}): React.ReactNode {
  const message = commit.body.trim()
  const preview = commitMessagePreview(message)
  const coAuthors = commitCoAuthors(commit)
  const authorLabel = expanded
    ? [
        commit.authorEmail ? `${commit.author} <${commit.authorEmail}>` : commit.author,
        ...coAuthors.map((coAuthor) =>
          coAuthor.email ? `${coAuthor.name} <${coAuthor.email}>` : coAuthor.name
        )
      ].filter(Boolean).join(', ')
    : commitAuthorLabel(commit)
  const hashLabel = expanded ? commit.hash : commit.shortHash
  const additionsLabel = expanded
    ? `${formatGitDiffLineCount(commit.additions)} added ${commit.additions === 1 ? 'line' : 'lines'}`
    : `+${formatGitDiffLineCount(commit.additions)}`
  const deletionsLabel = expanded
    ? `${formatGitDiffLineCount(commit.deletions)} removed ${commit.deletions === 1 ? 'line' : 'lines'}`
    : `-${formatGitDiffLineCount(commit.deletions)}`

  return (
    <div className={`flex flex-col bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(116,184,226,0.035)_44%,rgba(255,255,255,0.015))] px-4 backdrop-blur-md ${
      expanded ? 'min-h-[180px] py-3' : 'min-h-[76px] justify-center py-2'
    }`}>
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 truncate text-[17px] font-semibold leading-5 text-[var(--pear-text)]">
          {commit.subject}
        </h2>
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] transition-colors hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title={expanded ? 'Collapse commit details' : 'Expand commit details'}
          aria-label={expanded ? 'Collapse commit details' : 'Expand commit details'}
          aria-expanded={expanded}
        >
          {expanded ? <Minimize2 size={15} /> : <Expand size={15} />}
        </button>
      </div>
      {message && (
        <pre
          className={expanded
            ? 'mt-2 max-h-[260px] overflow-y-auto whitespace-pre-wrap rounded bg-black/10 px-2.5 py-2 font-mono text-[13px] leading-5 text-[var(--pear-text-secondary)]'
            : 'mt-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] leading-4 text-[var(--pear-text-secondary)]'
          }
        >
          {expanded ? message : preview}
        </pre>
      )}
      <div className={`${expanded && message ? 'mt-2' : 'mt-1'} flex min-w-0 items-center gap-2.5 text-[13px] leading-5 text-[var(--pear-text-dim)]`}>
        <CommitAuthorStack commit={commit} authorAvatarUrls={authorAvatarUrls} active={false} />
        <span className="min-w-0 truncate font-semibold text-[var(--pear-text-secondary)]">
          {authorLabel}
        </span>
        <GitCommitHorizontal size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
        <span className={`${expanded ? 'max-w-[42ch]' : 'shrink-0'} min-w-0 truncate font-mono text-[var(--pear-text-secondary)]`}>
          {hashLabel}
        </span>
        <button
          type="button"
          onClick={onCopyHash}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--pear-text-faint)] transition-colors hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title="Copy commit hash"
          aria-label="Copy commit hash"
        >
          <Copy size={14} />
        </button>
        <span className="min-w-0 truncate">{formatRelativeDate(commit.date)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3 font-semibold">
          <span className="text-[var(--pear-green)]">{additionsLabel}</span>
          <span className="text-[var(--pear-red)]">{deletionsLabel}</span>
        </div>
      </div>
    </div>
  )
}

export function CommitHistoryList({
  history,
  historyLoading,
  selectedCommit,
  authUser,
  listRef,
  onKeyDown,
  onSelectCommit
}: {
  history: GitHistoryCommit[]
  historyLoading: boolean
  selectedCommit: GitHistoryCommit | null
  authUser: AuthUser | null
  listRef: React.Ref<HTMLDivElement>
  onKeyDown: (event: React.KeyboardEvent) => void
  onSelectCommit: (commit: GitHistoryCommit) => void
}): React.ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="shrink-0 border-b border-[var(--pear-border-subtle)] p-2">
        <button
          type="button"
          tabIndex={-1}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-left text-[13px] text-[var(--pear-text-faint)]"
        >
          <GitBranch size={14} />
          <span className="truncate">Select Branch to Compare...</span>
        </button>
      </div>
      <div
        ref={listRef}
        data-focus-ring="none"
        className="min-h-0 flex-1 overflow-y-auto"
        tabIndex={0}
        aria-label="Commit history"
      >
        {historyLoading && history.length === 0 ? (
          <div className="px-3 py-6 text-[13px] text-[var(--pear-text-faint)]">Loading history...</div>
        ) : history.length === 0 ? (
          <div className="px-3 py-6 text-[13px] text-[var(--pear-text-faint)]">No commits yet</div>
        ) : (
          <div>
            {history.map((commit) => (
              <HistoryCommit
                key={commit.hash}
                commit={commit}
                active={selectedCommit?.hash === commit.hash}
                authorAvatarUrls={avatarUrlsForCommit(commit, authUser)}
                onSelect={() => onSelectCommit(commit)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function CommitHistoryDetail({
  selectedCommit,
  authUser,
  commitDetailsExpanded,
  onCopyHash,
  onToggleExpanded,
  historyFilesWidth,
  onResizeHistoryFiles,
  historyFilesListRef,
  onHistoryFilesKeyDown,
  selectedCommitFile,
  onSelectCommitFile,
  windowFocused,
  loading,
  commitDiff
}: {
  selectedCommit: GitHistoryCommit | null
  authUser: AuthUser | null
  commitDetailsExpanded: boolean
  onCopyHash: () => void
  onToggleExpanded: () => void
  historyFilesWidth: number
  onResizeHistoryFiles: (value: number) => void
  historyFilesListRef: React.Ref<HTMLDivElement>
  onHistoryFilesKeyDown: (event: React.KeyboardEvent) => void
  selectedCommitFile: string | null
  onSelectCommitFile: (path: string) => void
  windowFocused: boolean
  loading: boolean
  commitDiff: string
}): React.ReactNode {
  const selectedCommitFileEntry = selectedCommit?.files.find((file) => file.path === selectedCommitFile)

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
        {selectedCommit ? (
          <HistoryCommitDetails
            commit={selectedCommit}
            authorAvatarUrls={avatarUrlsForCommit(selectedCommit, authUser)}
            expanded={commitDetailsExpanded}
            onCopyHash={onCopyHash}
            onToggleExpanded={onToggleExpanded}
          />
        ) : (
          <div className="flex min-h-[88px] items-center px-4 text-[13px] text-[var(--pear-text-faint)]">
            Select a commit to see its files and diff
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <PaneSidebar width={historyFilesWidth}>
          <div className="flex h-8 shrink-0 items-center justify-center border-b border-[var(--pear-border-subtle)] text-[13px] font-semibold text-[var(--pear-text)]">
            {selectedCommit?.files.length || 0} changed file{selectedCommit?.files.length === 1 ? '' : 's'}
          </div>
          <div
            ref={historyFilesListRef}
            data-focus-ring="none"
            className="min-h-0 flex-1 overflow-y-auto"
            tabIndex={0}
            onKeyDown={onHistoryFilesKeyDown}
            aria-label="Commit files"
          >
            {selectedCommit ? (
              selectedCommit.files.map((file) => {
                const active = selectedCommitFile === file.path
                const kind = fileChangeKindFromStatus(file.status)
                const statusLabel = fileChangeStatusLabel(kind)
                return (
                  <button
                    key={`${selectedCommit.hash}:${file.oldPath || ''}:${file.path}`}
                    type="button"
                    data-file-list-path={file.path}
                    onClick={() => onSelectCommitFile(file.path)}
                    className={`flex h-8 w-full min-w-0 items-center gap-2 border-b border-[var(--pear-border-subtle)] px-2.5 text-left outline-none focus:outline-none focus-visible:outline-none ${
                      selectedFileRowClass(active, windowFocused)
                    }`}
                  >
                    <FilePathLabel
                      path={file.path}
                      oldPath={file.oldPath}
                      className="flex-1 text-[13px]"
                      tone={selectedFilePathTone(active, windowFocused)}
                    />
                    <FileChangeStatusIcon kind={kind} label={statusLabel} />
                  </button>
                )
              })
            ) : (
              <div className="px-3 py-6 text-[13px] text-[var(--pear-text-faint)]">No commit selected</div>
            )}
          </div>
        </PaneSidebar>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Resize history files panel"
          className="group flex h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-[var(--pear-bg)] hover:bg-[var(--pear-bg-surface-hover)]"
          onPointerDown={(event) =>
            startPanelResize(event, {
              axis: 'x',
              startValue: historyFilesWidth,
              min: HISTORY_FILES_MIN_WIDTH,
              max: HISTORY_FILES_MAX_WIDTH,
              onResize: onResizeHistoryFiles
            })
          }
        >
          <GripVertical size={12} className="opacity-0 text-[var(--pear-text-faint)] group-hover:opacity-100" />
        </button>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-[12px] text-[var(--pear-text-secondary)]">
            {selectedCommitFileEntry ? (
              <FilePathLabel
                path={selectedCommitFileEntry.path}
                oldPath={selectedCommitFileEntry.oldPath}
                className="flex-1 text-[13px]"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">Commit diff</span>
            )}
            {loading && <Loader2 size={14} className="ml-auto animate-spin text-[var(--pear-text-faint)]" />}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {commitDiff ? (
              <DiffViewer diff={commitDiff} focusedFilePath={selectedCommitFile} />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-[13px] text-[var(--pear-text-faint)]">
                Select a commit file to see its diff
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}
