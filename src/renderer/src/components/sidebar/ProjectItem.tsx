import type React from 'react'
import { useMemo, useState } from 'react'
import { AlertTriangle, Hash, LayoutGrid, Settings } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { getAgentKeyForAgent, useAgentStore, type Agent } from '@/stores/agent-store'
import { useProjectStore, type Project } from '@/stores/project-store'
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

function AgentActivityIndicator({ agent }: { agent: Agent }): React.ReactNode {
  if (agent.pendingDeliveryIds.length > 0) {
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
  const allAgents = useAgentStore((s) => s.agents)
  const agents = useMemo(
    () => allAgents.filter((agent) => agent.projectId === project.id),
    [allAgents, project.id]
  )
  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)
  const viewMode = useUIStore((s) => s.viewMode)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const hasAvailableRoot = project.roots.some((root) => root.pathExists)
  const settingsActive = isActive && viewMode === 'project-settings'

  const handleSelect = (): void => {
    setError(null)
    setViewMode('terminal')
    setActiveProject(project.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleOpenSettings = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    setError(null)
    setViewMode('project-settings')
    setActiveProject(project.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleSelectAgent = (agent: Agent): void => {
    setActiveChannel(null)
    setViewMode('terminal')
    setActiveAgentKey(getAgentKeyForAgent(agent))
  }

  const handleSelectChannel = (channel: string): void => {
    setActiveAgentKey(null)
    setActiveChannel(channel)
    setViewMode('chat')
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
                    activeChannelName === channel
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
