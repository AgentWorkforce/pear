import { useMemo, useState } from 'react'
import { Hash, Loader2, Pin, PinOff, Eye, EyeOff, Search } from 'lucide-react'
import {
  conversationMatchesAgents,
  findDmThread,
  isConversationReachable,
  parseChatHost,
  selectChatHosts,
  useChatStore
} from '@/stores/chat-store'
import { useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { AgentAvatar } from '@/components/common/AgentAvatar'
import type { RelayChatConversation } from '@/lib/ipc'

type ConversationTab = 'messages' | 'channels'

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
export function sortConversations(
  conversations: RelayChatConversation[],
  pinned: string[],
  order: ConversationSort = 'recent'
): RelayChatConversation[] {
  const pinnedSet = new Set(pinned)
  const messagedAt = new Map(conversations.map((conversation) => [
    conversation.id,
    conversation.kind === 'agent'
      ? findDmThread(conversations, conversation)?.lastMessageAt || ''
      : conversation.lastMessageAt || ''
  ]))
  return [...conversations].sort((a, b) => {
    const aPinned = pinnedSet.has(a.id)
    const bPinned = pinnedSet.has(b.id)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
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
  const directoryId = useUIStore((s) => s.chatDirectoryId)
  const setChatDirectoryId = useUIStore((s) => s.setChatDirectoryId)
  const agents = useAgentStore((s) => s.agents)
  const projects = useProjectStore((s) => s.projects)
  const directory = projects.find((project) => project.id === directoryId)

  const [tab, setTab] = useState<ConversationTab>('messages')
  const [search, setSearch] = useState('')
  const [machine, setMachine] = useState<string>('all')

  function openConversation(id: string): void {
    void selectConversation(id)
  }

  const hosts = useMemo(() => selectChatHosts(conversations), [conversations])
  const directoryAgentNames = useMemo(
    () => (directoryId
      ? agents.filter((agent) => agent.projectId === directoryId).map((agent) => agent.name)
      : null),
    [agents, directoryId]
  )
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
    // An agent's DM opens from its roster row, so the thread isn't listed twice.
    const agentThreads = new Set(conversations.flatMap((conversation) => {
      if (conversation.kind !== 'agent') return []
      const thread = findDmThread(conversations, conversation)
      return thread ? [thread.id] : []
    }))
    const filtered = conversations.filter((conversation) => {
      if (agentThreads.has(conversation.id)) return false
      if (tabFor(conversation) !== tab) return false
      if (
        directoryAgentNames &&
        conversation.kind !== 'channel' &&
        !conversationMatchesAgents(conversation, directoryAgentNames)
      ) {
        return false
      }
      if (!showHidden && hiddenSet.has(conversation.id)) return false
      if (machine !== 'all') {
        const onMachine = (conversation.participants || []).some(
          (participant) => parseChatHost(participant) === machine
        )
        if (!onMachine) return false
      }
      if (query) {
        const haystack = [conversation.name, conversation.summary || '', ...(conversation.participants || [])]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
    return sortConversations(filtered, pinned, sortOrder)
  }, [conversations, tab, showHidden, hiddenSet, machine, search, pinned, directoryAgentNames, sortOrder])

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
        {projects.length > 0 && (
          <select
            value={directoryId || ''}
            onChange={(event) => setChatDirectoryId(event.target.value || null)}
            aria-label="Filter by directory"
            className="mt-2 h-8 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2 text-xs text-[var(--pear-text-secondary)] outline-none focus:border-[var(--pear-accent-dim)]"
          >
            <option value="">All directories</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
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
        </div>
        {hosts.length > 0 && (
          <select
            value={machine}
            onChange={(event) => setMachine(event.target.value)}
            aria-label="Filter by machine"
            className="mt-2 h-8 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2 text-xs text-[var(--pear-text-secondary)] outline-none focus:border-[var(--pear-accent-dim)]"
          >
            <option value="all">All machines</option>
            {hosts.map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
          </select>
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
            {directoryId && tab === 'messages'
              ? `No chats with agents in ${directory?.name || 'this directory'}`
              : 'No conversations yet'}
          </p>
        )}
        {visible.map((conversation) => {
          const unread = unreadSet.has(conversation.id) || (conversation.unreadCount || 0) > 0
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
