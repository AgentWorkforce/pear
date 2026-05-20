import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  Folder,
  Hash,
  Plug,
  Plus,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { useAgentStore } from '@/stores/agent-store'
import { normalizeChannelName, useProjectStore, type ProjectRoot } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

function StatPill({
  icon: Icon,
  label,
  value
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: number
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] px-3 py-2 text-xs text-[var(--pear-text-dim)]">
      <Icon size={13} className="text-[var(--pear-text-faint)]" />
      <span>{label}</span>
      <span className="text-[var(--pear-text)]">{value}</span>
    </div>
  )
}

function Section({
  title,
  action,
  children
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <section className="border-t border-[var(--pear-border-subtle)] pt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function IconButton({
  label,
  onClick,
  children,
  variant = 'default',
  disabled = false
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  variant?: 'default' | 'danger'
  disabled?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md p-1.5 transition-colors disabled:opacity-40 ${
        variant === 'danger'
          ? 'text-[var(--pear-red)] hover:bg-[var(--pear-red)]/10'
          : 'text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]'
      }`}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  )
}

function RootRow({
  root,
  selected,
  removable,
  onSelect,
  onRemove
}: {
  root: ProjectRoot
  selected: boolean
  removable: boolean
  onSelect: () => void
  onRemove: () => void
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={root.path}
      >
        <Folder size={15} className="shrink-0 text-[var(--pear-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-[var(--pear-text)]">{root.name}</span>
            {selected && (
              <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-accent-bright)]">
                Active
              </span>
            )}
            {!root.pathExists && (
              <span className="flex items-center gap-1 rounded-full bg-[var(--pear-yellow)]/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-yellow)]">
                <AlertTriangle size={10} />
                Missing
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-[var(--pear-text-faint)]">{root.path}</div>
        </div>
      </button>
      <IconButton label="Remove root" onClick={onRemove} disabled={!removable} variant="danger">
        <X size={13} />
      </IconButton>
    </div>
  )
}

export function ProjectSettings(): React.ReactNode {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeRootId = useProjectStore((s) => s.activeRootId)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const setActiveRoot = useProjectStore((s) => s.setActiveRoot)
  const setActiveChannel = useProjectStore((s) => s.setActiveChannel)
  const updateProject = useProjectStore((s) => s.updateProject)
  const removeProject = useProjectStore((s) => s.removeProject)
  const addRoot = useProjectStore((s) => s.addRoot)
  const removeRoot = useProjectStore((s) => s.removeRoot)
  const addChannel = useProjectStore((s) => s.addChannel)
  const removeChannel = useProjectStore((s) => s.removeChannel)
  const addIntegration = useProjectStore((s) => s.addIntegration)
  const removeIntegration = useProjectStore((s) => s.removeIntegration)
  const allAgents = useAgentStore((s) => s.agents)
  const openDialog = useUIStore((s) => s.openDialog)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === activeProjectId),
    [activeProjectId, projects]
  )
  const agents = useMemo(
    () => allAgents.filter((agent) => agent.projectId === project?.id),
    [allAgents, project?.id]
  )

  const [draftName, setDraftName] = useState('')
  const [channelName, setChannelName] = useState('')
  const [integrationName, setIntegrationName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraftName(project?.name || '')
    setError(null)
  }, [project?.id, project?.name])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await operation()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)] px-8">
        <div className="text-center">
          <Settings size={24} className="mx-auto mb-3 text-[var(--pear-text-faint)]" />
          <div className="text-sm text-[var(--pear-text-dim)]">No project selected</div>
          <button
            type="button"
            onClick={() => openDialog('add-project')}
            className="mt-4 rounded-lg border border-[var(--pear-border)] px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
          >
            Add project
          </button>
        </div>
      </div>
    )
  }

  const selectedRootId =
    activeRootId && project.roots.some((root) => root.id === activeRootId)
      ? activeRootId
      : project.roots.find((root) => root.path === project.rootPath)?.id || project.roots[0]?.id
  const nameChanged = draftName.trim() !== project.name && draftName.trim().length > 0

  return (
    <div className="h-full overflow-y-auto bg-[var(--pear-bg)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-7 px-8 py-8">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">
              <Settings size={13} />
              Project settings
            </div>
            <h1 className="truncate text-2xl font-semibold text-[var(--pear-text)]">{project.name}</h1>
            <div className="mt-4 flex flex-wrap gap-2">
              <StatPill icon={Folder} label="Roots" value={project.roots.length} />
              <StatPill icon={Hash} label="Channels" value={project.channels.length} />
              <StatPill icon={Bot} label="Agents" value={agents.length} />
              <StatPill icon={Plug} label="Integrations" value={project.integrations.length} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => openDialog('add-project')}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
            >
              <Plus size={14} />
              Add project
            </button>
            <IconButton label="Close settings" onClick={() => setViewMode('terminal')}>
              <X size={16} />
            </IconButton>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
            {error}
          </div>
        )}

        <Section title="General">
          <form
            className="flex max-w-2xl items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void run(() => updateProject(project.id, { name: draftName.trim() }))
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-xs text-[var(--pear-text-faint)]">Name</span>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                className="h-10 w-full rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
              />
            </label>
            <button
              type="submit"
              disabled={!nameChanged}
              className="flex h-10 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
            >
              <Check size={14} />
              Save
            </button>
          </form>
        </Section>

        <Section
          title="Roots"
          action={
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await addRoot()
                })
              }
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
            >
              <Plus size={13} />
              Add root
            </button>
          }
        >
          <div className="space-y-2">
            {project.roots.map((root) => (
              <RootRow
                key={root.id}
                root={root}
                selected={selectedRootId === root.id}
                removable={project.roots.length > 1}
                onSelect={() => setActiveRoot(root.id)}
                onRemove={() => {
                  if (!window.confirm("Remove this root from the project? This won't delete any files.")) return
                  void run(() => removeRoot(root.id))
                }}
              />
            ))}
          </div>
        </Section>

        <Section title="Channels">
          <form
            className="mb-3 flex max-w-lg items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const name = normalizeChannelName(channelName)
              if (!name) return
              void run(async () => {
                await addChannel(name)
                setActiveChannel(name)
                setChannelName('')
              })
            }}
          >
            <input
              value={channelName}
              onChange={(event) => setChannelName(normalizeChannelName(event.target.value))}
              placeholder="channel-name"
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
            />
            <button
              type="submit"
              disabled={!channelName.trim()}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
            >
              <Plus size={13} />
              Add
            </button>
          </form>
          <div className="flex flex-wrap gap-2">
            {project.channels.map((channel) => (
              <div
                key={channel}
                className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm ${
                  activeChannelName === channel
                    ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                    : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveChannel(activeChannelName === channel ? null : channel)}
                  className="flex items-center gap-1.5"
                >
                  <Hash size={13} />
                  <span>{channel}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void run(() => removeChannel(channel))}
                  className="rounded-full p-0.5 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-red)]"
                  title={`Remove channel ${channel}`}
                  aria-label={`Remove channel ${channel}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Agents"
          action={
            <button
              type="button"
              onClick={() => openDialog('spawn-agent')}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
            >
              <Plus size={13} />
              Add agent
            </button>
          }
        >
          <div className="space-y-2">
            {agents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-faint)]">
                No agents
              </div>
            ) : (
              agents.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      agent.status === 'running' ? 'bg-[var(--pear-accent-bright)]' : 'bg-[var(--pear-text-faint)]'
                    }`}
                  />
                  <AgentHarnessIcon
                    cli={agent.cli}
                    className="h-3.5 w-3.5 shrink-0 text-[var(--pear-text-faint)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--pear-text)]">{agent.name}</span>
                  <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-text-dim)]">
                    {agent.cli}
                  </span>
                </div>
              ))
            )}
          </div>
        </Section>

        <Section title="Integrations">
          <form
            className="mb-3 flex max-w-lg items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const name = integrationName.trim()
              if (!name) return
              void run(async () => {
                await addIntegration(name)
                setIntegrationName('')
              })
            }}
          >
            <input
              value={integrationName}
              onChange={(event) => setIntegrationName(event.target.value)}
              placeholder="Integration name"
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
            />
            <button
              type="submit"
              disabled={!integrationName.trim()}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
            >
              <Plus size={13} />
              Add
            </button>
          </form>
          <div className="space-y-2">
            {project.integrations.map((integration) => (
              <div
                key={integration.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5"
              >
                <Plug size={15} className="text-[var(--pear-text-faint)]" />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--pear-text)]">{integration.name}</span>
                <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-text-dim)]">
                  {integration.type}
                </span>
                <IconButton
                  label={`Remove integration ${integration.name}`}
                  onClick={() => void run(() => removeIntegration(integration.id))}
                  variant="danger"
                >
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Danger">
          <button
            type="button"
            onClick={() => {
              if (!window.confirm(`Delete project "${project.name}"? This won't delete any files.`)) return
              void run(async () => {
                await removeProject(project.id)
                setViewMode('terminal')
              })
            }}
            className="flex items-center gap-2 rounded-lg border border-[var(--pear-red)]/30 px-4 py-2.5 text-sm text-[var(--pear-red)] hover:bg-[var(--pear-red)]/10"
          >
            <Trash2 size={14} />
            Delete project
          </button>
        </Section>
      </div>
    </div>
  )
}
