import { useMemo, useState } from 'react'
import { Hash, Pin, PinOff, Eye, EyeOff, Search } from 'lucide-react'
import {
  isConversationReachable,
  parseChatHost,
  selectChatHosts,
  useChatStore
} from '@/stores/chat-store'
import type { RelayChatConversation } from '@/lib/ipc'

type ConversationTab = 'agents' | 'messages' | 'channels'

function tabFor(conversation: RelayChatConversation): ConversationTab {
  return conversation.kind === 'channel' ? 'channels' : 'agents'
}

function sortConversations(
  conversations: RelayChatConversation[],
  pinned: string[]
): RelayChatConversation[] {
  const pinnedSet = new Set(pinned)
  return [...conversations].sort((a, b) => {
    const aPinned = pinnedSet.has(a.id)
    const bPinned = pinnedSet.has(b.id)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    return (b.lastMessageAt || '').localeCompare(a.lastMessageAt || '')
  })
}

export function ConversationList(): React.ReactNode {
  const conversations = useChatStore((s) => s.conversations)
  const loading = useChatStore((s) => s.conversationsLoading)
  const error = useChatStore((s) => s.conversationsError)
  const selectedId = useChatStore((s) => s.selectedId)
  const unreadIDs = useChatStore((s) => s.unreadConversationIDs)
  const pinned = useChatStore((s) => s.pinnedConversationIDs)
  const hidden = useChatStore((s) => s.hiddenConversationIDs)
  const showHidden = useChatStore((s) => s.showHidden)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const togglePin = useChatStore((s) => s.togglePin)
  const toggleHide = useChatStore((s) => s.toggleHide)
  const setShowHidden = useChatStore((s) => s.setShowHidden)

  const [tab, setTab] = useState<ConversationTab>('messages')
  const [search, setSearch] = useState('')
  const [machine, setMachine] = useState<string>('all')

  const hosts = useMemo(() => selectChatHosts(conversations), [conversations])
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const unreadSet = useMemo(() => new Set(unreadIDs), [unreadIDs])
  const now = Date.now()

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = conversations.filter((conversation) => {
      if (tab !== 'messages' && tabFor(conversation) !== tab) return false
      if (!showHidden && hiddenSet.has(conversation.id)) return false
      if (machine !== 'all') {
        const onMachine = (conversation.participants || []).some(
          (participant) => parseChatHost(participant) === machine
        )
        if (!onMachine) return false
      }
      if (query) {
        const haystack = [conversation.name, ...(conversation.participants || [])]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
    return sortConversations(filtered, pinned)
  }, [conversations, tab, showHidden, hiddenSet, machine, search, pinned])

  const hiddenCount = conversations.filter((c) => hiddenSet.has(c.id)).length

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="shrink-0 px-3 pt-3">
        <div className="flex gap-1" role="tablist" aria-label="Conversations">
          {(['agents', 'messages', 'channels'] as ConversationTab[]).map((value) => (
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
        </div>
        <div className="relative mt-2">
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
          <p className="px-2 py-6 text-center text-xs text-[var(--pear-text-faint)]">Loading…</p>
        )}
        {error && (
          <p className="px-2 py-6 text-center text-xs text-[var(--pear-red)]">{error}</p>
        )}
        {!loading && !error && visible.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--pear-text-faint)]">
            No conversations yet
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
              onClick={() => void selectConversation(conversation.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') void selectConversation(conversation.id)
              }}
              className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 ${
                active ? 'bg-[var(--pear-bg-overlay)]' : 'hover:bg-[var(--pear-bg)]/60'
              }`}
            >
              <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--pear-bg)]/60 text-[var(--pear-text-secondary)]">
                {conversation.kind === 'channel' ? (
                  <Hash size={15} />
                ) : (
                  <span className="text-xs font-bold">
                    {(conversation.name || '?').slice(0, 1).toUpperCase()}
                  </span>
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
                {(conversation.participants || []).length > 0 && conversation.kind === 'dm' && (
                  <span className="block truncate text-[11px] text-[var(--pear-text-faint)]">
                    {(conversation.participants || []).join(', ')}
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
