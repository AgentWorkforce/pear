import type React from 'react'
import { Loader2, UserPlus, WandSparkles } from 'lucide-react'
import type { AuthUser } from '@/lib/ipc'
import { CommitAuthorAvatar } from './commitAuthors'
import { CoAuthorPicker } from './CoAuthorPicker'
import { type CoAuthor } from './diffPaneUtils'

export function CommitForm({
  authUser,
  title,
  onTitleChange,
  body,
  onBodyChange,
  coAuthorTriggerRef,
  coAuthorPanelVisible,
  onAddCoAuthor,
  onGenerate,
  generateDisabled,
  generating,
  coAuthors,
  coAuthorInputRef,
  coAuthorPanelRef,
  coAuthorInput,
  coAuthorSuggestions,
  selectedCoAuthorSuggestionIndex,
  showCoAuthorSuggestions,
  onCoAuthorInputChange,
  onCoAuthorInputKeyDown,
  onSelectCoAuthorSuggestion,
  onRemoveCoAuthor,
  onCommit,
  canCommit,
  actionLoading,
  selectedCommitFileCount,
  commitTarget,
  message
}: {
  authUser: AuthUser | null
  title: string
  onTitleChange: (value: string) => void
  body: string
  onBodyChange: (value: string) => void
  coAuthorTriggerRef: React.Ref<HTMLButtonElement>
  coAuthorPanelVisible: boolean
  onAddCoAuthor: () => void
  onGenerate: () => void
  generateDisabled: boolean
  generating: boolean
  coAuthors: CoAuthor[]
  coAuthorInputRef: React.Ref<HTMLInputElement>
  coAuthorPanelRef: React.Ref<HTMLDivElement>
  coAuthorInput: string
  coAuthorSuggestions: CoAuthor[]
  selectedCoAuthorSuggestionIndex: number
  showCoAuthorSuggestions: boolean
  onCoAuthorInputChange: (value: string) => void
  onCoAuthorInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onSelectCoAuthorSuggestion: (coAuthor: CoAuthor) => void
  onRemoveCoAuthor: (username: string) => void
  onCommit: () => void
  canCommit: boolean
  actionLoading: boolean
  selectedCommitFileCount: number
  commitTarget: string
  message: string | null
}): React.ReactNode {
  return (
    <div className="shrink-0 space-y-2.5 p-3">
      <div className="flex items-center gap-2.5">
        <CommitAuthorAvatar user={authUser} />
        <input
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Summary (required)"
          className="h-9 min-w-0 flex-1 rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg)] px-2.5 text-[13px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30"
        />
      </div>
      <div className="rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg)] focus-within:border-[var(--pear-accent)] focus-within:ring-1 focus-within:ring-[var(--pear-accent)]/30">
        <textarea
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder="Description"
          rows={5}
          className="h-28 w-full resize-none border-0 bg-transparent px-2.5 py-2 text-[13px] leading-5 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
        />
        <div className="flex h-8 items-center gap-2 px-2.5 pb-2">
          <button
            ref={coAuthorTriggerRef}
            type="button"
            onClick={onAddCoAuthor}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              coAuthorPanelVisible
                ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)] ring-1 ring-[var(--pear-accent-dim)]'
                : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
            }`}
            title="Add co-author"
            aria-label="Add co-author"
            aria-pressed={coAuthorPanelVisible}
          >
            <UserPlus size={16} />
          </button>
          <span className="h-6 w-px bg-[var(--pear-border)]" />
          <button
            type="button"
            onClick={onGenerate}
            disabled={generateDisabled}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-40"
            title="Generate commit message"
            aria-label="Generate commit message"
          >
            {generating ? <Loader2 size={15} className="animate-spin" /> : <WandSparkles size={16} />}
          </button>
        </div>
        {coAuthorPanelVisible && (
          <CoAuthorPicker
            coAuthors={coAuthors}
            inputRef={coAuthorInputRef}
            panelRef={coAuthorPanelRef}
            inputValue={coAuthorInput}
            suggestions={coAuthorSuggestions}
            selectedSuggestionIndex={selectedCoAuthorSuggestionIndex}
            showSuggestions={showCoAuthorSuggestions}
            onInputChange={onCoAuthorInputChange}
            onInputKeyDown={onCoAuthorInputKeyDown}
            onSelectSuggestion={onSelectCoAuthorSuggestion}
            onRemoveCoAuthor={onRemoveCoAuthor}
          />
        )}
      </div>
      <button
        type="button"
        onClick={onCommit}
        disabled={!canCommit}
        className="flex h-9 w-full items-center justify-center rounded-md bg-[var(--pear-accent-dim)] px-3 text-[13px] font-medium text-white transition-colors hover:bg-[var(--pear-accent)] disabled:bg-[var(--pear-bg-surface)] disabled:text-[var(--pear-text-faint)]"
      >
        {actionLoading ? (
          <Loader2 size={15} className="mr-2 animate-spin" />
        ) : null}
        Commit {selectedCommitFileCount} file{selectedCommitFileCount === 1 ? '' : 's'} to{' '}
        <span className="ml-1 font-semibold">{commitTarget}</span>
      </button>
      {message && (
        <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-xs text-[var(--pear-text-dim)]">
          {message}
        </div>
      )}
    </div>
  )
}
