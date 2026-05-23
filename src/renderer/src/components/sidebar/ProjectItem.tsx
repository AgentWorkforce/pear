import type React from 'react'
import { useMemo, useState } from 'react'
import { AlertTriangle, Folder, GitBranch, Hash, LayoutGrid, MessageCircle, Pause, Settings } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import {
  deriveDirectMessageRooms,
  getDirectMessageRoomId,
  type DirectMessageRoom
} from '@/lib/direct-messages'
import { formatGitDiffLineCount } from '@/lib/format'
import { getAgentKeyForAgent, useAgentStore, type Agent } from '@/stores/agent-store'
import { useIsAgentTyping } from '@/stores/typing-store'
import { useGitStore, type GitSummary } from '@/stores/git-store'
import { useProjectStore, type Project, type ProjectRoot } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

interface Props {
  project: Project
  isActive: boolean
}

interface SectionHeaderProps {
  title: string
  count: number
}

function SectionHeader({ title, count }: SectionHeaderProps): React.ReactNode {
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">
        {title}
      </span>
      <span className="flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 px-1 text-[9px] font-medium leading-none text-[var(--pear-text-faint)] opacity-55">
        {count}
      </span>
    </div>
  )
}

function formatPathTail(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) return normalized
  return `.../${parts.slice(-2).join('/')}`
}

function ProjectMeta({
  root,
  gitSummary
}: {
  root: ProjectRoot
  gitSummary: GitSummary | null
}): React.ReactNode {
  return (
    <div className="space-y-1 px-1.5 text-[11px]">
      <div
        className="flex min-w-0 items-center gap-1.5 text-[var(--pear-text-faint)]"
        title={root.path}
      >
        <Folder size={11} className="shrink-0" />
        <span className="min-w-0 truncate">{formatPathTail(root.path)}</span>
      </div>
      {gitSummary && (
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 text-[var(--pear-text-dim)]"
            title={gitSummary.branch}
          >
            <GitBranch size={11} className="shrink-0 text-[var(--pear-text-faint)]" />
            <span className="min-w-0 truncate">{gitSummary.branch}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
            <span className="text-right text-[var(--pear-green)]">
              +{formatGitDiffLineCount(gitSummary.additions)}
            </span>
            <span className="text-right text-[var(--pear-red)]">
              -{formatGitDiffLineCount(gitSummary.deletions)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function AgentActivityIndicator({ agent }: { agent: Agent }): React.ReactNode {
  const typing = useIsAgentTyping(agent)
  if (agent.terminalMode === 'drive' || agent.currentState === 'blocked_on_send') {
    const label = agent.currentState === 'blocked_on_send' ? 'Blocked on send' : 'Holding messages'
    return (
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-text-faint)] opacity-70"
        title={label}
        aria-label={label}
      >
        <Pause size={9} strokeWidth={2.4} />
      </span>
    )
  }

  if (typing) {
    return (
      <span
        className="flex h-4 w-6 shrink-0 items-center justify-center gap-0.5 rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 opacity-70"
        title="Thinking"
        aria-label="Thinking"
      >
        <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse" />
        <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse [animation-delay:120ms]" />
        <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse [animation-delay:240ms]" />
      </span>
    )
  }

  const active = agent.activity !== 'idle' && agent.status === 'running'

  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 opacity-70"
      title={active ? 'Active' : 'Idle'}
      aria-label={active ? 'Active' : 'Idle'}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          active ? 'bg-[var(--pear-teal)]' : 'bg-[var(--pear-yellow)]'
        }`}
      />
    </span>
  )
}

export function ProjectItem({ project, isActive }: Props): React.ReactNode {
  const [error, setError] = useState<string | null>(null)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const setActiveChannel = useProjectStore((s) => s.setActiveChannel)
  const activeRootId = useProjectStore((s) => s.activeRootId)
  const gitSummary = useGitStore((s) => s.summary)
  const allAgents = useAgentStore((s) => s.agents)
  const allMessages = useAgentStore((s) => s.messages)
  const agents = useMemo(
    () => allAgents.filter((agent) => agent.projectId === project.id),
    [allAgents, project.id]
  )
  const directMessageRooms = useMemo(
    () => deriveDirectMessageRooms(allMessages, project.id, project.channels),
    [allMessages, project.channels, project.id]
  )
  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const openTab = useUIStore((s) => s.openTab)
  const hasAvailableRoot = project.roots.some((root) => root.pathExists)
  const settingsActive = isActive &&
    activeTab?.kind === 'project-settings' &&
    activeTab.projectId === project.id
  const activeRoot = project.roots.find((root) => root.id === activeRootId) ||
    project.roots.find((root) => root.pathExists) ||
    project.roots[0]
  const activeRootGitSummary = gitSummary?.rootPath === activeRoot?.path ? gitSummary : null
  const activeDirectMessageRoomId = activeTab?.kind === 'dm' && activeTab.projectId === project.id
    ? getDirectMessageRoomId(activeTab.dmParticipants || [])
    : null

  const handleSelect = (): void => {
    setError(null)
    openTab({ kind: 'agents', projectId: project.id })
    setActiveProject(project.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleOpenSettings = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    setError(null)
    openTab({ kind: 'project-settings', projectId: project.id })
    setActiveProject(project.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleSelectAgent = (agent: Agent): void => {
    setActiveChannel(null)
    openTab({ kind: 'agents', projectId: project.id })
    setActiveAgentKey(getAgentKeyForAgent(agent))
  }

  const handleSelectChannel = (channel: string): void => {
    setActiveAgentKey(null)
    setActiveChannel(channel)
    openTab({ kind: 'channel', projectId: project.id, channelName: channel })
  }

  const handleSelectDirectMessage = (room: DirectMessageRoom): void => {
    setActiveAgentKey(null)
    setActiveChannel(null)
    openTab({
      kind: 'dm',
      projectId: project.id,
      dmParticipants: room.participants,
      title: room.title
    })
  }

  return (
    <div
      className={`group/project rounded-xl border transition-colors ${
        isActive
          ? 'border-[var(--pear-border)] bg-[var(--pear-bg-surface)]'
          : 'border-transparent hover:bg-[var(--pear-bg-surface-hover)]/45'
      }`}
    >
      <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          onClick={handleSelect}
        >
          <LayoutGrid size={14} className="shrink-0 text-[var(--pear-accent)]" />
          <span className="min-w-0 flex-1 truncate text-[var(--pear-text)]">{project.name}</span>
          {!hasAvailableRoot && (
            <AlertTriangle
              size={13}
              className="shrink-0 text-[var(--pear-yellow)]"
              aria-label="Project path missing"
            />
          )}
        </button>
        <button
          type="button"
          onClick={handleOpenSettings}
          className={`rounded-md p-1.5 text-[var(--pear-text-faint)] transition-opacity hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text-dim)] focus-visible:opacity-100 ${
            settingsActive ? 'bg-[var(--pear-bg-overlay)] opacity-100' : 'opacity-0 group-hover/project:opacity-100'
          }`}
          title="Project settings"
          aria-label="Project settings"
        >
          <Settings size={12} />
        </button>
      </div>

      {isActive && (
        <div className="space-y-3 px-3 pb-3">
          {activeRoot && (
            <ProjectMeta root={activeRoot} gitSummary={activeRootGitSummary} />
          )}

          <div>
            <SectionHeader title="Agents" count={agents.length} />
            <div className="space-y-0.5">
              {agents.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-[var(--pear-text-faint)]">No agents</div>
              ) : (
                agents.map((agent) => (
                  <button
                    key={getAgentKeyForAgent(agent)}
                    type="button"
                    onClick={() => handleSelectAgent(agent)}
                    className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                  >
                    <AgentHarnessIcon
                      cli={agent.cli}
                      className="h-3 w-3 shrink-0 text-[var(--pear-text-faint)]"
                    />
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    <AgentActivityIndicator agent={agent} />
                  </button>
                ))
              )}
            </div>
          </div>

          <div>
            <SectionHeader title="Channels" count={project.channels.length} />
            <div className="space-y-0.5">
              {project.channels.map((channel) => (
                <button
                  key={channel}
                  type="button"
                  onClick={() => handleSelectChannel(channel)}
                  className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] ${
                    (activeChannelName === channel && activeTab?.kind === 'channel')
                      ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                      : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                  }`}
                >
                  <Hash size={11} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{channel}</span>
                </button>
              ))}
            </div>
          </div>

          {directMessageRooms.length > 0 && (
            <div>
              <SectionHeader title="DMs" count={directMessageRooms.length} />
              <div className="space-y-0.5">
                {directMessageRooms.map((room) => (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() => handleSelectDirectMessage(room)}
                    className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] ${
                      activeDirectMessageRoomId === room.id
                        ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                        : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                    }`}
                  >
                    <MessageCircle size={11} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{room.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mx-3 mb-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-2 py-1.5 text-[11px] text-[var(--pear-red)]">
          {error}
        </p>
      )}
    </div>
  )
}
