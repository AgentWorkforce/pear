import type React from 'react'
import { Check, FileDiff, Loader2 } from 'lucide-react'
import type { FileStatus } from '@/stores/git-store'
import { FilterInput } from '@/components/common/PaneShell'
import { DiffViewer } from './DiffViewer'
import {
  FileChangeStatusIcon,
  FilePathLabel,
  fileChangeKindFromStatus,
  fileChangeStatusLabel
} from './FileChangeLabel'
import { selectedFilePathTone, selectedFileRowClass } from './diffPaneUtils'

function selectionCheckboxClass(
  state: 'checked' | 'mixed' | 'unchecked',
  active = false,
  windowFocused = false
): string {
  const base = 'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] border transition-colors'

  if (state === 'checked') {
    return `${base} ${
      active && windowFocused
        ? 'border-[#9bd4ff] bg-[#9bd4ff] text-[#05345f]'
        : 'border-[#1683e8] bg-[#1683e8] text-white'
    }`
  }

  if (state === 'mixed') {
    return `${base} border-[#b8c7d8] bg-[#b8c7d8] text-[#263443]`
  }

  return `${base} border-[var(--pear-text-faint)] bg-transparent text-transparent group-hover:border-[var(--pear-text)]`
}

export function SelectionCheckbox({
  state,
  active = false,
  windowFocused = false
}: {
  state: 'checked' | 'mixed' | 'unchecked'
  active?: boolean
  windowFocused?: boolean
}): React.ReactNode {
  return (
    <span className={selectionCheckboxClass(state, active, windowFocused)} aria-hidden="true">
      {state === 'checked' ? (
        <Check size={11} strokeWidth={3} />
      ) : state === 'mixed' ? (
        <span className="h-[2px] w-[8px] rounded-full bg-current" />
      ) : null}
    </span>
  )
}

export function EmptyFileState(): React.ReactNode {
  return (
    <div className="flex h-full items-center justify-center px-4 text-[13px] font-medium text-[var(--pear-text)]">
      The file is empty
    </div>
  )
}

export function FileListPanel({
  filter,
  onFilterChange,
  fileCount,
  filteredFiles,
  selectedFiles,
  fullySelectedLineFilePaths,
  partiallySelectedFilePaths,
  selectedFile,
  fileRowSelection,
  windowFocused,
  allVisibleSelected,
  someVisibleSelected,
  listRef,
  onListKeyDown,
  onToggleAllVisible,
  onToggleFile,
  onSelectRow,
  onContextMenu
}: {
  filter: string
  onFilterChange: (value: string) => void
  fileCount: number
  filteredFiles: FileStatus[]
  selectedFiles: Set<string>
  fullySelectedLineFilePaths: Set<string>
  partiallySelectedFilePaths: Set<string>
  selectedFile: string | null
  fileRowSelection: Set<string>
  windowFocused: boolean
  allVisibleSelected: boolean
  someVisibleSelected: boolean
  listRef: React.Ref<HTMLDivElement>
  onListKeyDown: (event: React.KeyboardEvent) => void
  onToggleAllVisible: () => void
  onToggleFile: (path: string, currentlySelected: boolean) => void
  onSelectRow: (path: string, event?: React.MouseEvent) => void
  onContextMenu: (event: React.MouseEvent, path: string) => void
}): React.ReactNode {
  return (
    <>
      <div className="shrink-0 border-b border-[var(--pear-border-subtle)] px-2 py-2">
        <FilterInput value={filter} onChange={onFilterChange} ariaLabel="Filter changed files" />
      </div>

      <div
        ref={listRef}
        data-focus-ring="none"
        className="min-h-0 flex-1 overflow-y-auto border-b border-[var(--pear-border-subtle)]"
        tabIndex={0}
        onKeyDown={onListKeyDown}
        aria-label="Changed files"
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={onToggleAllVisible}
          role="checkbox"
          aria-checked={someVisibleSelected ? 'mixed' : allVisibleSelected}
          className="group flex h-8 w-full items-center gap-2 border-b border-[var(--pear-border-subtle)] px-2.5 text-left text-[13px] text-[var(--pear-text)] outline-none hover:bg-[var(--pear-bg-surface-hover)] focus:outline-none focus-visible:outline-none"
        >
          <SelectionCheckbox
            state={allVisibleSelected ? 'checked' : someVisibleSelected ? 'mixed' : 'unchecked'}
          />
          <span className="flex-1">{fileCount} changed file{fileCount === 1 ? '' : 's'}</span>
        </button>

        {filteredFiles.length === 0 ? (
          <div className="px-3 py-8 text-[13px] text-[var(--pear-text-faint)]">
            {fileCount === 0 ? 'No changes detected' : 'No files match the filter'}
          </div>
        ) : (
          filteredFiles.map((file) => {
            const wholeFileSelected = selectedFiles.has(file.path)
            const fullySelectedByLines = !wholeFileSelected && fullySelectedLineFilePaths.has(file.path)
            const selected = wholeFileSelected || fullySelectedByLines
            const partiallySelected = !selected && partiallySelectedFilePaths.has(file.path)
            const active = selectedFile === file.path
            const rowActive = fileRowSelection.size > 0 ? fileRowSelection.has(file.path) : active
            const kind = fileChangeKindFromStatus(file.status)
            const statusLabel = fileChangeStatusLabel(kind)
            return (
              <div
                key={file.path}
                data-file-list-path={file.path}
                onContextMenu={(event) => onContextMenu(event, file.path)}
                className={`group flex h-8 items-center gap-2 border-b border-[var(--pear-border-subtle)] pr-2.5 ${
                  selectedFileRowClass(rowActive, windowFocused)
                }`}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => onToggleFile(file.path, selected)}
                  role="checkbox"
                  aria-checked={partiallySelected ? 'mixed' : selected}
                  className="group flex h-8 w-9 shrink-0 items-center justify-center outline-none transition-colors focus:outline-none focus-visible:outline-none"
                  title={selected ? 'Unselect file' : 'Select entire file'}
                  aria-label={selected ? `Unselect ${file.path}` : `Select entire ${file.path}`}
                >
                  <SelectionCheckbox
                    state={selected ? 'checked' : partiallySelected ? 'mixed' : 'unchecked'}
                    active={rowActive}
                    windowFocused={windowFocused}
                  />
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(event) => onSelectRow(file.path, event)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus:outline-none focus-visible:outline-none"
                >
                  <FilePathLabel
                    path={file.path}
                    oldPath={file.oldPath}
                    className="flex-1 text-[13px]"
                    tone={selectedFilePathTone(rowActive, windowFocused)}
                  />
                  {file.staged && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        rowActive && windowFocused
                          ? 'bg-white/20 text-white'
                          : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)]'
                      }`}
                    >
                      staged
                    </span>
                  )}
                  <FileChangeStatusIcon kind={kind} label={statusLabel} />
                </button>
              </div>
            )
          })
        )}
      </div>
    </>
  )
}

export function ChangesDiffView({
  selectedFileEntry,
  selectedFile,
  rootPath,
  diff,
  loading,
  selectedFiles,
  selectedLineIds,
  onToggleLine,
  onSetLines,
  selectedFileIsEmpty,
  selectedFileProbePending,
  fileCount
}: {
  selectedFileEntry: FileStatus | undefined
  selectedFile: string | null
  rootPath: string
  diff: string
  loading: boolean
  selectedFiles: Set<string>
  selectedLineIds: Set<string>
  onToggleLine: (filePath: string, lineId: string) => void
  onSetLines: (filePath: string, lineIds: string[], selected: boolean) => void
  selectedFileIsEmpty: boolean
  selectedFileProbePending: boolean
  fileCount: number
}): React.ReactNode {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-[12px] text-[var(--pear-text-secondary)]">
        <FileDiff size={13} className="text-[var(--pear-text-faint)]" />
        {selectedFileEntry ? (
          <FilePathLabel
            path={selectedFileEntry.path}
            oldPath={selectedFileEntry.oldPath}
            className="flex-1 text-[13px]"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">Select a file</span>
        )}
        {loading && <Loader2 size={14} className="ml-auto animate-spin text-[var(--pear-text-faint)]" />}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {diff ? (
          <DiffViewer
            diff={diff}
            rootPath={rootPath}
            focusedFilePath={selectedFileEntry?.path || selectedFile}
            selectable
            selectedFiles={selectedFiles}
            selectedLineIds={selectedLineIds}
            onToggleLine={onToggleLine}
            onSetLines={onSetLines}
          />
        ) : selectedFileIsEmpty ? (
          <EmptyFileState />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-[13px] text-[var(--pear-text-faint)]">
            {loading || selectedFileProbePending
              ? 'Loading diff...'
              : fileCount === 0
                ? 'No changes detected'
                : selectedFileEntry
                  ? 'No diff available'
                  : 'Select a file to view its diff'}
          </div>
        )}
      </div>
    </section>
  )
}
