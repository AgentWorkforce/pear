import type React from 'react'
import { useEffect } from 'react'
import { Hash, LayoutGrid, X } from 'lucide-react'
import { AgentAvatar } from '@/components/common/AgentAvatar'
import { MAX_GRID_PANES, useChatStore } from '@/stores/chat-store'
import { conversationDetails } from './ChatTitle'
import { Composer } from './Composer'
import { ThreadView } from './ThreadView'

/** Columns for `count` panes: 1, 2×1, 2×2, 3×2, then 4×2. */
export function gridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 6) return 3
  return 4
}

function GridPane({ id, focused }: { id: string; focused: boolean }): React.ReactNode {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === id))
  const focusGridPane = useChatStore((s) => s.focusGridPane)
  const closeGridPane = useChatStore((s) => s.closeGridPane)
  const name = conversation?.name ?? id.replace(/^(relay|conversation|channel):/, '')
  const details = conversation ? conversationDetails(conversation) : ''
  return (
    <section
      aria-label={name}
      data-testid="grid-pane"
      onPointerDown={() => focusGridPane(id)}
      onFocus={() => focusGridPane(id)}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-[var(--pear-bg)] ${
        focused ? 'border-[var(--pear-accent-dim)]' : 'border-[var(--pear-border-subtle)]'
      }`}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2">
        {conversation?.kind === 'channel' ? (
          <Hash size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
        ) : (
          <AgentAvatar name={name} cli={conversation?.cli} human={!!conversation?.human} size={20} />
        )}
        <span className="truncate text-[12.5px] font-semibold text-[var(--pear-text)]">{name}</span>
        {details && <span className="min-w-0 truncate text-[11px] text-[var(--pear-text-faint)]">{details}</span>}
        <button
          type="button"
          aria-label={`Close ${name}`}
          title="Close pane"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => closeGridPane(id)}
          className="ml-auto shrink-0 rounded p-1 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
        >
          <X size={13} />
        </button>
      </header>
      {conversation ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            <ThreadView conversationId={id} />
          </div>
          <Composer conversationId={id} compact />
        </>
      ) : (
        <p className="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--pear-text-faint)]">
          This conversation isn&apos;t in the list right now.
        </p>
      )}
    </section>
  )
}

/** Several conversations side by side: an opt-in layout for working with many agents at once. */
export function ChatGrid(): React.ReactNode {
  const gridIds = useChatStore((s) => s.gridIds)
  const selectedId = useChatStore((s) => s.selectedId)
  const conversations = useChatStore((s) => s.conversations)
  const history = useChatStore((s) => s.history)
  const loadHistory = useChatStore((s) => s.loadHistory)

  useEffect(() => {
    for (const id of gridIds) {
      if (!history[id] && conversations.some((c) => c.id === id)) void loadHistory(id)
    }
  }, [gridIds, conversations, history, loadHistory])

  if (gridIds.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <LayoutGrid size={28} className="text-[var(--pear-text-faint)]" />
        <p className="text-sm text-[var(--pear-text-secondary)]">Pick conversations from the list to add them here.</p>
        <p className="max-w-sm text-xs text-[var(--pear-text-faint)]">
          Up to {MAX_GRID_PANES} at once. Once the grid is full, a new pick replaces the focused pane.
        </p>
      </div>
    )
  }

  const columns = gridColumns(gridIds.length)
  return (
    <div
      data-testid="chat-grid"
      className="grid min-h-0 flex-1 gap-2 p-2"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${Math.ceil(gridIds.length / columns)}, minmax(0, 1fr))`
      }}
    >
      {gridIds.map((id) => (
        <GridPane key={id} id={id} focused={id === selectedId} />
      ))}
    </div>
  )
}
