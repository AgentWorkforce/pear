import type React from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Check,
  MessageCircle,
  Settings,
  User,
  UserPlus,
  X
} from 'lucide-react'
import {
  getDirectMessageAgentNames,
  getDirectMessageRoomTitle,
  isDirectMessageRoomHumanIncluded,
  messageMatchesDirectMessageRoom,
  sortDirectMessageParticipants
} from '@/lib/direct-messages'
import { pear, type AuthUser } from '@/lib/ipc'
import {
  useAgentStore,
  type Agent,
  type ChatMessage as ChatMessageType
} from '@/stores/agent-store'
import { normalizeChannelName, useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { ChatMessage } from './ChatMessage'
import { ComposeBar } from './ComposeBar'
import { ThreadPanel } from './ThreadPanel'

type ChannelTab = 'messages' | 'settings'

function normalizeMessageChannel(target: string): string {
  return target.trim().replace(/^#/, '')
}

function isChannelMessage(message: ChatMessageType, channelName: string): boolean {
  return normalizeMessageChannel(message.to) === channelName
}

function isSameDay(left: number, right: number): boolean {
  const leftDate = new Date(left)
  const rightDate = new Date(right)

  return leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
}

function getStartOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function formatDateDivider(timestamp: number): string {
  const date = new Date(timestamp)
  const today = getStartOfDay(new Date())
  const messageDay = getStartOfDay(date)
  const dayDelta = Math.round((today - messageDay) / 86_400_000)

  if (dayDelta === 0) return 'Today'
  if (dayDelta === 1) return 'Yesterday'

  const currentYear = new Date().getFullYear()
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === currentYear ? {} : { year: 'numeric' })
  })
}

function DateDivider({ timestamp }: { timestamp: number }): React.ReactNode {
  return (
    <div className="relative my-4 flex items-center justify-center">
      <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--pear-border-subtle)]" />
      <span className="relative rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-1 text-xs font-medium text-[var(--pear-text-secondary)]">
        {formatDateDivider(timestamp)}
      </span>
    </div>
  )
}

function CountPill({
  count,
  icon: Icon,
  label
}: {
  count: number
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
}): React.ReactNode {
  return (
    <div
      className="flex h-9 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 px-3 text-[var(--pear-text-secondary)]"
      title={label}
      aria-label={`${count} ${label}`}
    >
      <Icon size={17} className="text-[var(--pear-text-faint)]" />
      <span className="text-sm font-semibold text-[var(--pear-text)]">{count}</span>
    </div>
  )
}

function ChannelNavButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  onClick: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-11 items-center gap-2 border-b-2 px-1 text-sm font-semibold ${
        active
          ? 'border-[var(--pear-text)] text-[var(--pear-text)]'
          : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
      }`}
    >
      <Icon size={16} />
      <span>{label}</span>
    </button>
  )
}

function isAgentInChannel(agent: Agent, channelName: string | null): boolean {
  if (!channelName) return true
  if (!agent.channels) return true
  return agent.channels.includes(channelName)
}

interface ChannelSettingsViewProps {
  activeChannelName: string
  agents: Agent[]
  agentsInRoom: Agent[]
  invitedHumans: string[]
  humanInviteDraft: string
  renameDraft: string
  error: string | null
  savingName: boolean
  changingAgentName: string | null
  onHumanInviteDraftChange: (value: string) => void
  onRenameDraftChange: (value: string) => void
  onRename: (event: React.FormEvent<HTMLFormElement>) => void
  onInviteHuman: (event: React.FormEvent<HTMLFormElement>) => void
  onKickHuman: (name: string) => void
  onAgentMembershipChange: (agent: Agent, subscribed: boolean) => void
}

function ChannelSettingsView({
  activeChannelName,
  agents,
  agentsInRoom,
  invitedHumans,
  humanInviteDraft,
  renameDraft,
  error,
  savingName,
  changingAgentName,
  onHumanInviteDraftChange,
  onRenameDraftChange,
  onRename,
  onInviteHuman,
  onKickHuman,
  onAgentMembershipChange
}: ChannelSettingsViewProps): React.ReactNode {
  const normalizedRenameDraft = normalizeChannelName(renameDraft)
  const canSaveName = Boolean(normalizedRenameDraft && normalizedRenameDraft !== activeChannelName)
  const canInviteHuman = Boolean(humanInviteDraft.trim())

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-8">
        {error && (
          <div className="rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
            {error}
          </div>
        )}

        <section>
          <h2 className="text-sm font-semibold text-[var(--pear-text)]">Channel Name</h2>
          <form className="mt-3 flex max-w-xl items-end gap-3" onSubmit={onRename}>
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-xs text-[var(--pear-text-faint)]">Name</span>
              <input
                value={renameDraft}
                onChange={(event) => onRenameDraftChange(normalizeChannelName(event.target.value))}
                className="h-10 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
              />
            </label>
            <button
              type="submit"
              disabled={!canSaveName || savingName}
              className="flex h-10 items-center gap-2 rounded-md border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
            >
              <Check size={14} />
              Save
            </button>
          </form>
        </section>

        <section>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-[var(--pear-text)]">People</h2>
            <span className="text-xs text-[var(--pear-text-faint)]">{1 + invitedHumans.length} in room</span>
          </div>
          <form className="mt-3 flex max-w-xl items-center gap-3" onSubmit={onInviteHuman}>
            <input
              value={humanInviteDraft}
              onChange={(event) => onHumanInviteDraftChange(event.target.value)}
              placeholder="Name or email"
              className="h-10 min-w-0 flex-1 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
            />
            <button
              type="submit"
              disabled={!canInviteHuman}
              className="flex h-10 items-center gap-2 rounded-md border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
            >
              <UserPlus size={14} />
              Invite
            </button>
          </form>
          <div className="mt-4 divide-y divide-[var(--pear-border-subtle)] border-y border-[var(--pear-border-subtle)]">
            <div className="flex items-center gap-3 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)]">
                <User size={15} />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--pear-text)]">You</span>
              <span className="text-xs text-[var(--pear-text-faint)]">Owner</span>
            </div>
            {invitedHumans.map((name) => (
              <div key={name} className="flex items-center gap-3 py-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--pear-bg-overlay)] text-[var(--pear-text-secondary)]">
                  <User size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--pear-text)]">{name}</span>
                <button
                  type="button"
                  onClick={() => onKickHuman(name)}
                  className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-red)]"
                >
                  <X size={13} />
                  Kick
                </button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-[var(--pear-text)]">Agents</h2>
            <span className="text-xs text-[var(--pear-text-faint)]">{agentsInRoom.length} in room</span>
          </div>
          <div className="mt-4 divide-y divide-[var(--pear-border-subtle)] border-y border-[var(--pear-border-subtle)]">
            {agents.length === 0 ? (
              <div className="py-6 text-sm text-[var(--pear-text-faint)]">No agents available</div>
            ) : (
              agents.map((agent) => {
                const subscribed = isAgentInChannel(agent, activeChannelName)
                const changing = changingAgentName === agent.name

                return (
                  <div key={`${agent.projectId || 'unknown'}:${agent.name}`} className="flex items-center gap-3 py-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--pear-bg-overlay)] text-[var(--pear-text-secondary)]">
                      <Bot size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[var(--pear-text)]">{agent.name}</div>
                      <div className="mt-0.5 text-xs text-[var(--pear-text-faint)]">
                        {subscribed ? 'In room' : 'Not in room'}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={changing}
                      onClick={() => onAgentMembershipChange(agent, !subscribed)}
                      className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:opacity-40 ${
                        subscribed
                          ? 'text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-red)]'
                          : 'text-[var(--pear-accent-bright)] hover:bg-[var(--pear-bg-overlay)]'
                      }`}
                    >
                      {subscribed ? <X size={13} /> : <UserPlus size={13} />}
                      {subscribed ? 'Kick' : 'Invite'}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

export function ChatView(): React.ReactNode {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const currentAppTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const allMessages = useAgentStore((s) => s.messages)
  const allAgents = useAgentStore((s) => s.agents)
  const addChannelJoinNotice = useAgentStore((s) => s.addChannelJoinNotice)
  const addThreadReply = useAgentStore((s) => s.addThreadReply)
  const renameMessageChannel = useAgentStore((s) => s.renameMessageChannel)
  const setAgentChannelMembership = useAgentStore((s) => s.setAgentChannelMembership)
  const toggleMessageReaction = useAgentStore((s) => s.toggleMessageReaction)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const activeProject = useProjectStore((s) => s.projects.find((project) => project.id === s.activeProjectId))
  const renameChannel = useProjectStore((s) => s.renameChannel)
  const setChannelPeople = useProjectStore((s) => s.setChannelPeople)
  const directMessageParticipants = useMemo(
    () => currentAppTab?.kind === 'dm'
      ? sortDirectMessageParticipants(currentAppTab.dmParticipants || [])
      : null,
    [currentAppTab]
  )
  const directMessageTitle = directMessageParticipants
    ? getDirectMessageRoomTitle(directMessageParticipants)
    : null
  const directMessageAgentNames = useMemo(
    () => directMessageParticipants ? getDirectMessageAgentNames(directMessageParticipants) : [],
    [directMessageParticipants]
  )
  const directMessageHumanIncluded = directMessageParticipants
    ? isDirectMessageRoomHumanIncluded(directMessageParticipants)
    : false
  const directMessageReadOnly = Boolean(directMessageParticipants && !directMessageHumanIncluded)
  const scrollRef = useRef<HTMLDivElement>(null)
  const preserveSettingsAfterRenameRef = useRef(false)
  const [activeThreadMessageId, setActiveThreadMessageId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<ChannelTab>('messages')
  const [renameDraft, setRenameDraft] = useState(activeChannelName || '')
  const [humanInviteDraft, setHumanInviteDraft] = useState('')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savingName, setSavingName] = useState(false)
  const [changingAgentName, setChangingAgentName] = useState<string | null>(null)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)

  const projectMessages = useMemo(
    () => activeProjectId
      ? allMessages.filter((message) => message.projectId === activeProjectId)
      : allMessages,
    [activeProjectId, allMessages]
  )
  // The store is the source of truth for message identity — each chat message
  // arrives with a unique `id` (broker event_id) and the store's
  // reconcileChatMessages / isDuplicateHumanEcho paths handle dedupe on insert.
  // Trust those ids here and just scope to the current channel/DM so we don't
  // re-run a content+timestamp heuristic on every render that could collapse
  // legitimately distinct messages (or miss duplicates outside the 10s window).
  const messages = useMemo(
    () => directMessageParticipants
      ? projectMessages.filter((message) => messageMatchesDirectMessageRoom(message, directMessageParticipants))
      : activeChannelName
      ? projectMessages.filter((message) => isChannelMessage(message, activeChannelName))
      : projectMessages,
    [activeChannelName, directMessageParticipants, projectMessages]
  )
  const agents = useMemo(
    () => activeProjectId
      ? allAgents.filter((agent) => agent.projectId === activeProjectId)
      : allAgents,
    [activeProjectId, allAgents]
  )
  const agentsInRoom = useMemo(
    () => directMessageParticipants
      ? agents.filter((agent) =>
          directMessageAgentNames.some((name) => name.toLowerCase() === agent.name.toLowerCase())
        )
      : agents.filter((agent) => isAgentInChannel(agent, activeChannelName)),
    [activeChannelName, agents, directMessageAgentNames, directMessageParticipants]
  )
  const invitedHumans = activeChannelName
    ? activeProject?.channelPeople[activeChannelName] || []
    : []
  const humanCount = directMessageParticipants
    ? directMessageHumanIncluded ? 1 : 0
    : 1 + invitedHumans.length
  const activeThreadMessage = activeThreadMessageId
    ? messages.find((message) => message.id === activeThreadMessageId) || null
    : null

  useEffect(() => {
    setActiveTab(preserveSettingsAfterRenameRef.current ? 'settings' : 'messages')
    preserveSettingsAfterRenameRef.current = false
    setRenameDraft(activeChannelName || '')
    setHumanInviteDraft('')
    setSettingsError(null)
  }, [activeChannelName, directMessageParticipants])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [activeChannelName, directMessageParticipants, messages.length])

  useEffect(() => {
    if (!activeThreadMessageId || activeThreadMessage) return
    setActiveThreadMessageId(null)
  }, [activeThreadMessage, activeThreadMessageId])

  useEffect(() => {
    let cancelled = false

    pear.auth.status()
      .then((status) => {
        if (!cancelled) setAuthUser(status.loggedIn ? status.user || null : null)
      })
      .catch(() => {
        if (!cancelled) setAuthUser(null)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'messages' && !directMessageReadOnly) return
    setActiveThreadMessageId(null)
  }, [activeTab, directMessageReadOnly])

  const handleRenameChannel = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!activeChannelName) return

    const nextChannelName = normalizeChannelName(renameDraft)
    if (!nextChannelName || nextChannelName === activeChannelName) return

    setSavingName(true)
    setSettingsError(null)
    preserveSettingsAfterRenameRef.current = true
    try {
      const renamedChannelName = await renameChannel(activeChannelName, nextChannelName)
      if (renamedChannelName) {
        renameMessageChannel(activeProjectId || undefined, activeChannelName, renamedChannelName)
        setRenameDraft(renamedChannelName)
      }
    } catch (err) {
      preserveSettingsAfterRenameRef.current = false
      setSettingsError(err instanceof Error ? err.message : 'Failed to rename channel')
    } finally {
      setSavingName(false)
    }
  }

  const handleInviteHuman = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!activeChannelName) return

    const nextName = humanInviteDraft.trim()
    if (!nextName) return

    if (invitedHumans.some((name) => name.toLowerCase() === nextName.toLowerCase())) {
      setHumanInviteDraft('')
      return
    }

    setSettingsError(null)
    try {
      const nextPeople = await setChannelPeople(activeChannelName, [...invitedHumans, nextName])
      const joinedName = nextPeople.find((name) => name.toLowerCase() === nextName.toLowerCase())
      if (joinedName) {
        addChannelJoinNotice(activeProjectId || undefined, activeChannelName, joinedName)
      }
      setHumanInviteDraft('')
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to invite person')
    }
  }

  const handleKickHuman = async (name: string): Promise<void> => {
    if (!activeChannelName) return

    setSettingsError(null)
    try {
      await setChannelPeople(
        activeChannelName,
        invitedHumans.filter((candidate) => candidate !== name)
      )
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to kick person')
    }
  }

  const handleAgentMembershipChange = async (agent: Agent, subscribed: boolean): Promise<void> => {
    if (!activeChannelName) return

    setChangingAgentName(agent.name)
    setSettingsError(null)
    try {
      if (subscribed) {
        await pear.broker.subscribeAgentChannel(activeProjectId || undefined, agent.name, activeChannelName)
      } else {
        await pear.broker.unsubscribeAgentChannel(activeProjectId || undefined, agent.name, activeChannelName)
      }
      setAgentChannelMembership(activeProjectId || undefined, agent.name, activeChannelName, subscribed)
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to update channel members')
    } finally {
      setChangingAgentName(null)
    }
  }

  const showChannelSettings = Boolean(activeChannelName && !directMessageParticipants)
  const roomTitle = directMessageTitle || (activeChannelName ? `# ${activeChannelName}` : 'Messages')
  const emptyMessage = directMessageTitle
    ? `No messages in ${directMessageTitle} yet.`
    : activeChannelName
      ? `No messages in #${activeChannelName} yet.`
      : 'No messages yet.'
  const agentCount = directMessageParticipants ? directMessageAgentNames.length : agentsInRoom.length
  const canInteractWithMessages = !directMessageReadOnly

  if (agents.length === 0 && !activeChannelName && !directMessageParticipants) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)]">
        <p className="text-xs text-[var(--pear-text-faint)]">Spawn an agent to start messaging</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg)]">
      <header className="shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
        <div className="flex min-h-[72px] items-center justify-between gap-4 px-5">
          <div className="flex min-w-0 items-center gap-3">
            {directMessageParticipants ? (
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-text-faint)]">
                <MessageCircle size={25} />
              </div>
            ) : null}
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold text-[var(--pear-text)]">
                {roomTitle}
              </h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CountPill icon={User} count={humanCount} label="people" />
            <CountPill icon={Bot} count={agentCount} label="agents" />
          </div>
        </div>

        <nav className="flex h-11 items-end gap-8 px-6">
          <ChannelNavButton
            active={activeTab === 'messages'}
            icon={MessageCircle}
            label="Messages"
            onClick={() => setActiveTab('messages')}
          />
          {showChannelSettings ? (
            <ChannelNavButton
              active={activeTab === 'settings'}
              icon={Settings}
              label="Settings"
              onClick={() => setActiveTab('settings')}
            />
          ) : null}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {activeTab === 'messages' ? (
            <>
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
                {messages.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-[var(--pear-text-faint)]">
                    {emptyMessage}
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {messages.map((message, index) => {
                      const previousMessage = messages[index - 1]
                      const showDateDivider = !previousMessage || !isSameDay(previousMessage.timestamp, message.timestamp)

                      return (
                        <Fragment key={message.id}>
                          {showDateDivider && <DateDivider timestamp={message.timestamp} />}
                          <ChatMessage
                            message={message}
                            authUser={authUser}
                            showRoute={!activeChannelName && !directMessageParticipants}
                            showActions={canInteractWithMessages}
                            showThreadSummary={canInteractWithMessages}
                            activeThread={activeThreadMessageId === message.id}
                            onReply={canInteractWithMessages
                              ? (nextMessage) => setActiveThreadMessageId(nextMessage.id)
                              : undefined}
                            onReact={canInteractWithMessages ? toggleMessageReaction : undefined}
                          />
                        </Fragment>
                      )
                    })}
                  </div>
                )}
              </div>

              {directMessageReadOnly ? (
                <div className="shrink-0 border-t border-[var(--pear-bg-surface)] bg-[var(--pear-bg-raised)] px-5 py-4 text-sm text-[var(--pear-text-faint)]">
                  View only
                </div>
              ) : (
                <ComposeBar directMessageParticipants={directMessageParticipants || undefined} />
              )}
            </>
          ) : showChannelSettings && activeChannelName ? (
            <ChannelSettingsView
              activeChannelName={activeChannelName}
              agents={agents}
              agentsInRoom={agentsInRoom}
              invitedHumans={invitedHumans}
              humanInviteDraft={humanInviteDraft}
              renameDraft={renameDraft}
              error={settingsError}
              savingName={savingName}
              changingAgentName={changingAgentName}
              onHumanInviteDraftChange={setHumanInviteDraft}
              onRenameDraftChange={setRenameDraft}
              onRename={(event) => void handleRenameChannel(event)}
              onInviteHuman={(event) => void handleInviteHuman(event)}
              onKickHuman={(name) => void handleKickHuman(name)}
              onAgentMembershipChange={(agent, subscribed) => void handleAgentMembershipChange(agent, subscribed)}
            />
          ) : null}
        </div>

        {activeTab === 'messages' && activeThreadMessage && canInteractWithMessages && (
          <ThreadPanel
            message={activeThreadMessage}
            authUser={authUser}
            onClose={() => setActiveThreadMessageId(null)}
            onReply={addThreadReply}
          />
        )}
      </div>
    </div>
  )
}
