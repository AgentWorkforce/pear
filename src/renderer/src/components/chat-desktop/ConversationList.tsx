import { useMemo, useState } from 'react'
import { Hash, Loader2, Pin, PinOff, Plus, Eye, EyeOff, Search } from 'lucide-react'
import {
  NO_CHAT_FILTERS,
  agentThreadIds,
  chatFilterOptions,
  conversationUnread,
  findDmThread,
  isConversationReachable,
  matchesChatFilters,
  useChatStore,
  type ChatFilters
} from '@/stores/chat-store'
import { useUIStore } from '@/stores/ui-store'
import { AgentAvatar } from '@/components/common/AgentAvatar'
import type { RelayChatConversation } from '@/lib/ipc'

type ConversationTab = 'messages' | 'channels'

const FILTERS_KEY = 'pear.chat.filters'

function storedFilters(): ChatFilters {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') as Partial<ChatFilters>
    return {
      project: typeof raw.project === 'string' ? raw.project : '',
      cli: typeof raw.cli === 'string' ? raw.cli : '',
      machine: typeof raw.machine === 'string' ? raw.machine : ''
    }
  } catch {
    return NO_CHAT_FILTERS
  }
}

function tabFor(conversation: RelayChatConversation): ConversationTab {
  return conversation.kind === 'channel' ? 'channels' : 'messages'
}

/** Tool and presence under the summary, e.g. "claude · online". DMs fall back to participants. */
function rowMeta(conversation: RelayChatConversation): string {
  const parts = [conversation.cli, conversation.status].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  return conversation.kind === 'dm' ? (conversation.participants || []).join(', ') : ''
}

export type ConversationSort = 'recent' | 'name'

const SORT_STORAGE_KEY = 'pear.chat.sort'

function storedSort(): ConversationSort {
  try {
    return localStorage.getItem(SORT_STORAGE_KEY) === 'name' ? 'name' : 'recent'
  } catch {
    return 'recent'
  }
}

/**
 * Pinned rows first. Recent puts conversations with messages first, newest
 * on top, then the rest by when the agent was last seen; an agent row's own
 * `lastMessageAt` is its presence heartbeat, so it can't rank messages.
 */
/**
 * Pinned first, then anything unread, then by the chosen order. `all` is the
 * unfiltered list, where an agent row finds the DM thread it shows.
 */
export function sortConversations(
  conversations: RelayChatConversation[],
  pinned: string[],
  order: ConversationSort = 'recent',
  unreadIds: ReadonlySet<string> = new Set(),
  all: readonly RelayChatConversation[] = conversations
): RelayChatConversation[] {
  const pinnedSet = new Set(pinned)
  const messagedAt = new Map(conversations.map((conversation) => [
    conversation.id,
    conversation.kind === 'agent'
      ? findDmThread(all, conversation)?.lastMessageAt || ''
      : conversation.lastMessageAt || ''
  ]))
  const unread = new Set(conversations.filter((c) => conversationUnread(all, unreadIds, c)).map((c) => c.id))
  return [...conversations].sort((a, b) => {
    const aPinned = pinnedSet.has(a.id)
    const bPinned = pinnedSet.has(b.id)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    const aUnread = unread.has(a.id)
    const bUnread = unread.has(b.id)
    if (aUnread !== bUnread) return aUnread ? -1 : 1
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    if (order === 'name') return byName
    const aMessaged = messagedAt.get(a.id) || ''
    const bMessaged = messagedAt.get(b.id) || ''
    if (!!aMessaged !== !!bMessaged) return aMessaged ? -1 : 1
    const recency = aMessaged
      ? bMessaged.localeCompare(aMessaged)
      : (b.lastMessageAt || '').localeCompare(a.lastMessageAt || '')
    return recency || byName
  })
}

export function ConversationList(): React.ReactNode {
  const conversations = useChatStore((s) => s.conversations)
  const refreshing = useChatStore((s) => s.conversationsLoading)
  const error = useChatStore((s) => s.conversationsError)
  const loadedOnce = useChatStore((s) => s.lastRefreshAt !== null)
  const loading = refreshing || (!loadedOnce && !error)
  const selectedId = useChatStore((s) => s.selectedId)
  const unreadIDs = useChatStore((s) => s.unreadConversationIDs)
  const pinned = useChatStore((s) => s.pinnedConversationIDs)
  const hidden = useChatStore((s) => s.hiddenConversationIDs)
  const showHidden = useChatStore((s) => s.showHidden)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const togglePin = useChatStore((s) => s.togglePin)
  const toggleHide = useChatStore((s) => s.toggleHide)
  const setShowHidden = useChatStore((s) => s.setShowHidden)
  const openDialog = useUIStore((s) => s.openDialog)

  const [tab, setTab] = useState<ConversationTab>('messages')
  const [search, setSearch] = useState('')
  const [filters, setFiltersState] = useState<ChatFilters>(storedFilters)
  const setFilter = (key: keyof ChatFilters, value: string): void => {
    const next = { ...filters, [key]: value }
    setFiltersState(next)
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next))
    } catch {
      // The choice still applies for this session.
    }
  }

  function openConversation(id: string): void {
    void selectConversation(id)
  }

  const filterOptions = useMemo(() => chatFilterOptions(conversations), [conversations])
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const unreadSet = useMemo(() => new Set(unreadIDs), [unreadIDs])
  const now = Date.now()

  const [sortOrder, setSortOrderState] = useState<ConversationSort>(storedSort)
  const setSortOrder = (order: ConversationSort): void => {
    setSortOrderState(order)
    try {
      localStorage.setItem(SORT_STORAGE_KEY, order)
    } catch {
      // The choice still applies for this session.
    }
  }

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    const agentThreads = agentThreadIds(conversations)
    const filtered = conversations.filter((conversation) => {
      if (agentThreads.has(conversation.id)) return false
      if (tabFor(conversation) !== tab) return false
      if (!matchesChatFilters(conversation, filters)) return false
      if (!showHidden && hiddenSet.has(conversation.id)) return false
      if (query) {
        const haystack = [conversation.name, conversation.summary || '', ...(conversation.participants || [])]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
    return sortConversations(filtered, pinned, sortOrder, unreadSet, conversations)
  }, [conversations, tab, showHidden, hiddenSet, filters, search, pinned, sortOrder, unreadSet])
  const filtering = !!(filters.project || filters.cli || filters.machine)
  const filterSelects: Array<{ key: keyof ChatFilters; label: string; all: string; options: string[] }> = [
    { key: 'project', label: 'Filter by project', all: 'All projects', options: filterOptions.projects },
    { key: 'cli', label: 'Filter by agent type', all: 'All types', options: filterOptions.clis },
    { key: 'machine', label: 'Filter by machine', all: 'All machines', options: filterOptions.machines }
  ]

  const hiddenCount = conversations.filter((c) => hiddenSet.has(c.id)).length

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="shrink-0 px-3 pt-3">
        <div className="flex gap-1" role="tablist" aria-label="Conversations">
          {(['messages', 'channels'] as ConversationTab[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`h-8 flex-1 rounded-md px-2 text-xs font-semibold capitalize ${
                tab === value
                  ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                  : 'text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
              }`}
            >
              {value}
            </button>
          ))}
          <span className="flex w-6 shrink-0 items-center justify-center" aria-live="polite">
            {loading && (
              <Loader2
                size={14}
                aria-label="Loading conversations"
                className="animate-spin text-[var(--pear-text-faint)]"
              />
            )}
          </span>
        </div>
        <div className="mt-2 flex gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--pear-text-faint)]"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="h-8 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] pl-8 pr-2 text-xs text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
            />
          </div>
          <select
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value === 'name' ? 'name' : 'recent')}
            aria-label="Sort conversations"
            className="h-8 shrink-0 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2 text-xs text-[var(--pear-text-secondary)] outline-none focus:border-[var(--pear-accent-dim)]"
          >
            <option value="recent">Recent</option>
            <option value="name">A–Z</option>
          </select>
          <button
            type="button"
            onClick={() => openDialog('spawn-relay-agent')}
            aria-label="Start agent on a relay machine"
            title="Start agent on a relay machine"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] text-[var(--pear-text-secondary)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
          >
            <Plus size={14} />
          </button>
        </div>
        {tab === 'messages' && (
          <div className="mt-2 flex gap-1.5">
            {filterSelects.map(({ key, label, all, options }) => (
              <select
                key={key}
                value={filters[key]}
                onChange={(event) => setFilter(key, event.target.value)}
                aria-label={label}
                className={`h-8 min-w-0 flex-1 truncate rounded-md border bg-[var(--pear-bg)] px-1.5 text-xs outline-none focus:border-[var(--pear-accent-dim)] ${
                  filters[key]
                    ? 'border-[var(--pear-accent-dim)] text-[var(--pear-text)]'
                    : 'border-[var(--pear-border-subtle)] text-[var(--pear-text-secondary)]'
                }`}
              >
                <option value="">{all}</option>
                {filters[key] && !options.includes(filters[key]) && (
                  <option value={filters[key]}>{filters[key]}</option>
                )}
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && conversations.length === 0 && (
          <div data-testid="conversation-skeleton" aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="flex animate-pulse items-start gap-2.5 px-2.5 py-2.5">
                <span className="h-10 w-10 shrink-0 rounded-lg bg-[var(--pear-bg-overlay)]" />
                <span className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
                  <span className="h-3 w-1/2 rounded bg-[var(--pear-bg-overlay)]" />
                  <span className="h-2.5 w-5/6 rounded bg-[var(--pear-bg-overlay)]" />
                  <span className="h-2.5 w-1/3 rounded bg-[var(--pear-bg-overlay)]" />
                </span>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p className="px-2 py-6 text-center text-xs text-[var(--pear-red)]">{error}</p>
        )}
        {!loading && !error && visible.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--pear-text-faint)]">
            {filtering && tab === 'messages' ? 'No conversations match these filters' : 'No conversations yet'}
          </p>
        )}
        {!loading && !error && filtering && tab === 'messages' && (
          <button
            type="button"
            onClick={() => {
              setFiltersState(NO_CHAT_FILTERS)
              try {
                localStorage.removeItem(FILTERS_KEY)
              } catch {
                // Nothing stored.
              }
            }}
            className="mx-auto mb-1 block text-[11px] text-[var(--pear-text-faint)] underline hover:text-[var(--pear-text-secondary)]"
          >
            Clear filters
          </button>
        )}
        {visible.map((conversation) => {
          const unread = conversationUnread(conversations, unreadSet, conversation)
          const isPinned = pinned.includes(conversation.id)
          const isHidden = hiddenSet.has(conversation.id)
          const reachable = isConversationReachable(conversation, now)
          const active = selectedId === conversation.id
          return (
            <div
              key={conversation.id}
              role="button"
              tabIndex={0}
              aria-label={conversation.name}
              onClick={() => openConversation(conversation.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') openConversation(conversation.id)
              }}
              className={`group flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 ${
                active ? 'bg-[var(--pear-bg-overlay)]' : 'hover:bg-[var(--pear-bg)]/60'
              }`}
            >
              <span className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--pear-bg)]/60 text-[var(--pear-text-secondary)]">
                {conversation.kind === 'channel' ? (
                  <Hash size={17} />
                ) : (
                  <AgentAvatar name={conversation.name} cli={conversation.cli} human={conversation.human} size={40} />
                )}
                {reachable && (
                  <span
                    aria-label="reachable"
                    title="Active in the last 5 minutes"
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--pear-bg-raised)] bg-green-500"
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-[var(--pear-text)]">
                    {conversation.name}
                  </span>
                  {unread && (
                    <span
                      aria-label="unread"
                      className="h-2 w-2 shrink-0 rounded-full bg-[var(--pear-accent-bright)]"
                    />
                  )}
                </span>
                {conversation.summary && (
                  <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-[var(--pear-text-secondary)]">
                    {conversation.summary}
                  </span>
                )}
                {conversation.kind !== 'channel' && rowMeta(conversation) && (
                  <span className="mt-0.5 block truncate text-[11px] capitalize text-[var(--pear-text-faint)]">
                    {rowMeta(conversation)}
                  </span>
                )}
              </span>
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <button
                  type="button"
                  title={isPinned ? 'Unpin' : 'Pin'}
                  aria-label={isPinned ? `Unpin ${conversation.name}` : `Pin ${conversation.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    togglePin(conversation.id)
                  }}
                  className="rounded p-1 text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]"
                >
                  {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
                <button
                  type="button"
                  title={isHidden ? 'Unhide' : 'Hide'}
                  aria-label={isHidden ? `Unhide ${conversation.name}` : `Hide ${conversation.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleHide(conversation.id)
                  }}
                  className="rounded p-1 text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]"
                >
                  {isHidden ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </span>
            </div>
          )
        })}
      </div>

      {hiddenCount > 0 && (
        <div className="shrink-0 border-t border-[var(--pear-border-subtle)] px-3 py-2">
          <button
            type="button"
            onClick={() => setShowHidden(!showHidden)}
            className="text-xs text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]"
          >
            {showHidden ? 'Hide hidden' : `Show ${hiddenCount} hidden`}
          </button>
        </div>
      )}
    </div>
  )
}
