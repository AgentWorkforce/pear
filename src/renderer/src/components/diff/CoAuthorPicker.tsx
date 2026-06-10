import type React from 'react'
import { X } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { coAuthorKey, type CoAuthor } from './diffPaneUtils'

export function CoAuthorPicker({
  coAuthors,
  inputRef,
  panelRef,
  inputValue,
  suggestions,
  selectedSuggestionIndex,
  showSuggestions,
  onInputChange,
  onInputKeyDown,
  onSelectSuggestion,
  onRemoveCoAuthor
}: {
  coAuthors: CoAuthor[]
  inputRef: React.Ref<HTMLInputElement>
  panelRef: React.Ref<HTMLDivElement>
  inputValue: string
  suggestions: CoAuthor[]
  selectedSuggestionIndex: number
  showSuggestions: boolean
  onInputChange: (value: string) => void
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onSelectSuggestion: (coAuthor: CoAuthor) => void
  onRemoveCoAuthor: (username: string) => void
}): React.ReactNode {
  return (
    <div ref={panelRef} className="flex min-h-10 items-center gap-2 border-t border-[var(--pear-border-subtle)] px-2.5 py-2">
      <span className="shrink-0 text-[13px] font-medium text-[var(--pear-text-secondary)]">Co-Authors</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {coAuthors.map((coAuthor) => (
          <span
            key={coAuthorKey(coAuthor.username)}
            className="flex h-7 max-w-[180px] items-center gap-1 rounded-md border border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] px-2 text-[13px] font-semibold text-[var(--pear-text)]"
          >
            <span className="min-w-0 truncate">@{coAuthor.username}</span>
            <button
              type="button"
              onClick={() => onRemoveCoAuthor(coAuthor.username)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
              aria-label={`Remove @${coAuthor.username}`}
              title={`Remove @${coAuthor.username}`}
            >
              <X size={16} />
            </button>
          </span>
        ))}
        <div className="relative min-w-[132px] flex-1">
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="@username"
            className="h-7 w-full min-w-[132px] border-0 bg-transparent text-[13px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
            aria-label="Co-author username"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
          {showSuggestions && (
            <div className="absolute left-0 top-full z-50 mt-1 max-h-56 min-w-[320px] overflow-hidden rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] shadow-2xl">
              {suggestions.map((suggestion, index) => {
                const active = index === selectedSuggestionIndex
                return (
                  <button
                    key={coAuthorKey(suggestion.username)}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelectSuggestion(suggestion)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] ${
                      active
                        ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                        : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                    }`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]">
                      <AgentHarnessIcon cli={suggestion.cli} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="truncate font-semibold text-[var(--pear-text)]">{suggestion.username}</span>
                      {suggestion.name && (
                        <span className="ml-2 truncate text-[var(--pear-text-dim)]">{suggestion.name}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
