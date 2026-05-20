import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, Cloud, Copy, KeyRound, RefreshCw, Server, TerminalSquare } from 'lucide-react'
import { pear, type BrokerDetails, type BrokerListAgent } from '@/lib/ipc'
import { type BrokerErrorEntry, useAgentStore } from '@/stores/agent-store'
import { useProjectStore, type Project } from '@/stores/project-store'

const errorTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

function formatErrorTimestamp(timestamp: number): string {
  return errorTimeFormatter.format(new Date(timestamp))
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return 'unknown'
  }

  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${Math.max(1, minutes)}m`
}

function getProjectName(projects: Project[], projectId: string): string {
  return projects.find((project) => project.id === projectId)?.name || projectId
}

function getConnectionStatusLabel(status: BrokerDetails['connectionFileStatus']): string {
  if (status === 'matches') return 'ready'
  if (status === 'different') return 'different broker'
  if (status === 'invalid') return 'invalid'
  if (status === 'missing') return 'missing'
  return 'n/a'
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getCliTargetName(broker: BrokerDetails): string {
  return broker.agents[0]?.name || '<agent>'
}

function getStateDir(connectionPath: string | undefined): string | undefined {
  return connectionPath?.replace(/\/connection\.json$/, '')
}

function buildAgentFallbackDetails(
  liveAgents: BrokerListAgent[],
  projects: Project[],
  brokerStatus: 'connected' | 'disconnected' | 'error'
): BrokerDetails[] {
  const agentsByProject = new Map<string, BrokerListAgent[]>()
  for (const agent of liveAgents) {
    const agents = agentsByProject.get(agent.projectId) || []
    agents.push(agent)
    agentsByProject.set(agent.projectId, agents)
  }

  return Array.from(agentsByProject.entries()).map(([projectId, projectAgents]) => {
    const project = projects.find((candidate) => candidate.id === projectId)
    const channels = Array.from(new Set([
      ...(project?.channels || []),
      ...projectAgents.flatMap((agent) => agent.channels || [])
    ]))

    return {
      projectId,
      name: project ? `pear-${project.relayWorkspaceId}` : projectId,
      cwd: project?.rootPath || '',
      channels,
      kind: 'local',
      apiKeyAvailable: false,
      health: brokerStatus === 'error' ? 'unreachable' : 'connected',
      agentCount: projectAgents.length,
      pendingDeliveryCount: 0,
      agents: projectAgents.map((agent) => ({
        name: agent.name,
        runtime: agent.runtime || 'pty',
        cli: agent.cli,
        model: agent.model,
        channels: agent.channels || channels,
        parent: agent.parent,
        pid: agent.pid,
        currentState: agent.current_state
      }))
    }
  })
}

function getIssueLabel(entry: BrokerErrorEntry, index: number, currentErrorId: string | undefined): string {
  if (entry.id === currentErrorId) return 'Current issue'
  return index === 0 ? 'Latest issue' : 'Broker error'
}

function BrokerErrorRows({
  entries,
  currentErrorId
}: {
  entries: BrokerErrorEntry[]
  currentErrorId?: string
}): React.ReactNode {
  return (
    <div className="space-y-2">
      {entries.map((entry, index) => (
        <div
          key={entry.id}
          className="rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--pear-red)]">
            <span className="font-medium uppercase tracking-[0.12em]">
              {getIssueLabel(entry, index, currentErrorId)}
            </span>
            <span className="shrink-0 text-[var(--pear-text-faint)]">
              {formatErrorTimestamp(entry.timestamp)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--pear-text)]">
            {entry.message}
          </p>
        </div>
      ))}
    </div>
  )
}

function BrokerIssueBlock({
  entries,
  currentErrorId
}: {
  entries: BrokerErrorEntry[]
  currentErrorId?: string
}): React.ReactNode {
  if (entries.length === 0) return null

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <AlertCircle size={15} className="text-[var(--pear-red)]" />
        <h3 className="text-sm font-semibold text-[var(--pear-text)]">Broker issues</h3>
      </div>
      <BrokerErrorRows entries={entries} currentErrorId={currentErrorId} />
    </div>
  )
}

function ProjectBrokerIssueSection({
  projectName,
  entries,
  currentErrorId
}: {
  projectName: string
  entries: BrokerErrorEntry[]
  currentErrorId?: string
}): React.ReactNode {
  return (
    <section className="rounded-lg border border-[var(--pear-red)]/25 bg-[var(--pear-bg-surface)]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--pear-red)]/15 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 text-[var(--pear-red)]">
            <AlertCircle size={17} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-[var(--pear-text)]">{projectName}</h2>
              <span className="rounded-full bg-[var(--pear-red)]/10 px-2 py-0.5 text-[11px] text-[var(--pear-red)]">
                issue
              </span>
            </div>
            <p className="mt-1 text-sm text-[var(--pear-text-faint)]">
              Broker did not start or is not currently managed by this window.
            </p>
          </div>
        </div>
      </div>
      <div className="p-5">
        <BrokerErrorRows entries={entries} currentErrorId={currentErrorId} />
      </div>
    </section>
  )
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }): React.ReactNode {
  const [copied, setCopied] = useState(false)

  const copyValue = async (): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = value
        textarea.style.position = 'fixed'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copyValue()}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--pear-border-subtle)] px-2 text-[11px] text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
      title={label}
      aria-label={label}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  )
}

function CommandRow({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">
          {label}
        </p>
        <CopyButton value={value} />
      </div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--pear-bg-raised)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--pear-text-secondary)]">
        {value}
      </pre>
    </div>
  )
}

function DetailField({
  label,
  value,
  copy
}: {
  label: string
  value: string
  copy?: boolean
}): React.ReactNode {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--pear-text-faint)]">{label}</p>
        {copy && value !== 'n/a' && <CopyButton value={value} label="Copy" />}
      </div>
      <p className="truncate font-mono text-[12px] text-[var(--pear-text-secondary)]" title={value}>
        {value}
      </p>
    </div>
  )
}

function BrokerCommands({ broker }: { broker: BrokerDetails }): React.ReactNode {
  const target = getCliTargetName(broker)
  const quotedTarget = target === '<agent>' ? target : shellQuote(target)
  const stateDir = getStateDir(broker.connectionPath)
  const explicitBrokerArgs = broker.url && broker.apiKey
    ? `--broker-url ${shellQuote(broker.url)} --api-key ${shellQuote(broker.apiKey)}`
    : null
  const commands = [
    explicitBrokerArgs
      ? {
          label: 'Read-only view',
          value: `agent-relay view ${quotedTarget} ${explicitBrokerArgs}`
        }
      : null,
    explicitBrokerArgs
      ? {
          label: 'Drive agent',
          value: `agent-relay drive ${quotedTarget} ${explicitBrokerArgs}`
        }
      : null,
    explicitBrokerArgs
      ? {
          label: 'Passthrough',
          value: `agent-relay passthrough ${quotedTarget} ${explicitBrokerArgs}`
        }
      : null,
    explicitBrokerArgs
      ? {
          label: 'Export once',
          value: [
            `export RELAY_BROKER_URL=${shellQuote(broker.url)}`,
            `export RELAY_BROKER_API_KEY=${shellQuote(broker.apiKey)}`,
            `agent-relay view ${quotedTarget}`
          ].join('\n')
        }
      : null,
    stateDir
      ? {
          label: 'Connection file',
          value: `agent-relay view ${quotedTarget} --state-dir ${shellQuote(stateDir)}`
        }
      : null,
    broker.cwd
      ? {
          label: 'From project root',
          value: `cd ${shellQuote(broker.cwd)} && agent-relay view ${quotedTarget}`
        }
      : null
  ].filter((entry): entry is { label: string; value: string } => entry !== null)

  if (!commands.length) {
    return (
      <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 p-4 text-sm text-[var(--pear-text-faint)]">
        Restart Pear to load full broker connection details for CLI commands.
      </div>
    )
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {commands.map((command) => (
        <CommandRow key={command.label} label={command.label} value={command.value} />
      ))}
    </div>
  )
}

function BrokerCard({
  broker,
  projectName,
  statusErrors,
  currentErrorId
}: {
  broker: BrokerDetails
  projectName: string
  statusErrors: BrokerErrorEntry[]
  currentErrorId?: string
}): React.ReactNode {
  const Icon = broker.kind === 'cloud' ? Cloud : Server
  const apiKey = broker.apiKey || (broker.apiKeyAvailable ? 'stored in connection file' : 'n/a')

  return (
    <section className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--pear-border-subtle)] px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-accent)]">
            <Icon size={17} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-[var(--pear-text)]">{projectName}</h2>
              <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[11px] uppercase text-[var(--pear-text-secondary)]">
                {broker.kind}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  broker.health === 'connected'
                    ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)]'
                    : 'bg-[var(--pear-red)]/10 text-[var(--pear-red)]'
                }`}
              >
                {broker.health}
              </span>
            </div>
            <p className="mt-1 truncate text-sm text-[var(--pear-text-faint)]" title={broker.name}>
              {broker.name}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {broker.channels.map((channel) => (
            <span
              key={channel}
              className="rounded-full border border-[var(--pear-border-subtle)] px-2 py-1 text-[11px] text-[var(--pear-text-faint)]"
            >
              #{channel}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-5 p-5">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <DetailField label="Broker URL" value={broker.url || 'n/a'} copy={!!broker.url} />
          <DetailField label="API key" value={apiKey} copy={!!broker.apiKey} />
          <DetailField label="Port" value={broker.port ? String(broker.port) : 'n/a'} />
          <DetailField label="PID / sandbox" value={String(broker.brokerPid || broker.cloudSandboxId || 'n/a')} />
          <DetailField label="Root" value={broker.cwd || 'cloud sandbox'} copy={!!broker.cwd} />
          <DetailField label="Connection file" value={broker.connectionPath || 'n/a'} copy={!!broker.connectionPath} />
          <DetailField label="Connection status" value={getConnectionStatusLabel(broker.connectionFileStatus)} />
          <DetailField label="Uptime" value={formatUptime(broker.session?.uptimeSecs)} />
          <DetailField label="Protocol" value={broker.session ? `v${broker.session.protocolVersion}` : 'unknown'} />
          <DetailField label="Mode" value={broker.session?.mode || 'unknown'} />
          <DetailField label="Agents" value={String(broker.agentCount)} />
          <DetailField label="Pending deliveries" value={String(broker.pendingDeliveryCount)} />
        </div>

        <div>
          <div className="mb-3 flex items-center gap-2">
            <TerminalSquare size={15} className="text-[var(--pear-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--pear-text)]">CLI strings</h3>
          </div>
          <BrokerCommands broker={broker} />
        </div>

        <div>
          <div className="mb-3 flex items-center gap-2">
            <KeyRound size={15} className="text-[var(--pear-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--pear-text)]">Agents</h3>
          </div>
          {broker.agents.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-[var(--pear-border-subtle)]">
              <div className="grid min-w-[560px] grid-cols-[minmax(160px,1.2fr)_minmax(90px,0.7fr)_minmax(90px,0.7fr)_minmax(120px,1fr)_minmax(80px,0.5fr)] border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2 text-[11px] uppercase tracking-[0.1em] text-[var(--pear-text-faint)]">
                <span>Name</span>
                <span>Runtime</span>
                <span>CLI</span>
                <span>State</span>
                <span>PID</span>
              </div>
              {broker.agents.map((agent) => (
                <div
                  key={agent.name}
                  className="grid min-w-[560px] grid-cols-[minmax(160px,1.2fr)_minmax(90px,0.7fr)_minmax(90px,0.7fr)_minmax(120px,1fr)_minmax(80px,0.5fr)] border-b border-[var(--pear-border-subtle)] px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="min-w-0 truncate font-medium text-[var(--pear-text)]" title={agent.name}>
                    {agent.name}
                  </span>
                  <span className="min-w-0 truncate text-[var(--pear-text-secondary)]">{agent.runtime}</span>
                  <span className="min-w-0 truncate text-[var(--pear-text-secondary)]">{agent.cli || 'unknown'}</span>
                  <span className="min-w-0 truncate text-[var(--pear-text-secondary)]">{agent.currentState || 'unknown'}</span>
                  <span className="min-w-0 truncate text-[var(--pear-text-secondary)]">{agent.pid || 'n/a'}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-6 text-center text-sm text-[var(--pear-text-faint)]">
              No agents registered with this broker
            </div>
          )}
        </div>

        {broker.error && (
          <div className="rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5 text-sm text-[var(--pear-red)]">
            {broker.error}
          </div>
        )}

        <BrokerIssueBlock entries={statusErrors} currentErrorId={currentErrorId} />
      </div>
    </section>
  )
}

export function BrokerDetailsPage(): React.ReactNode {
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const brokerError = useAgentStore((s) => s.brokerError)
  const brokerErrors = useAgentStore((s) => s.brokerErrors)
  const projects = useProjectStore((s) => s.projects)
  const [brokerDetails, setBrokerDetails] = useState<BrokerDetails[]>([])
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)

  const currentErrorId = brokerStatus === 'error' && brokerError && brokerErrors[0]?.message === brokerError
    ? brokerErrors[0].id
    : undefined
  const brokerErrorsByProject = useMemo(() => {
    const grouped = new Map<string, BrokerErrorEntry[]>()
    for (const entry of brokerErrors) {
      if (!entry.projectId) continue
      const entries = grouped.get(entry.projectId) || []
      entries.push(entry)
      grouped.set(entry.projectId, entries)
    }
    return grouped
  }, [brokerErrors])
  const unmatchedProjectErrorGroups = useMemo(() => {
    const brokerProjectIds = new Set(brokerDetails.map((broker) => broker.projectId))
    return Array.from(brokerErrorsByProject.entries()).filter(([projectId]) => !brokerProjectIds.has(projectId))
  }, [brokerDetails, brokerErrorsByProject])
  const unattributedBrokerErrors = useMemo(
    () => brokerErrors.filter((entry) => !entry.projectId),
    [brokerErrors]
  )
  const hasBrokerSections = brokerDetails.length > 0 || unmatchedProjectErrorGroups.length > 0

  const loadBrokerDetails = useCallback(async (): Promise<void> => {
    setDetailsLoading(true)
    setDetailsError(null)
    try {
      if (typeof pear.broker.listDetails === 'function') {
        setBrokerDetails(await pear.broker.listDetails())
        return
      }

      const liveAgents = await pear.broker.listAgents()
      setBrokerDetails(buildAgentFallbackDetails(liveAgents, projects, brokerStatus))
      setDetailsError(
        'Broker details API is not loaded in this window. Restart Pear for full broker diagnostics and API-key CLI strings.'
      )
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetailsLoading(false)
    }
  }, [brokerStatus, projects])

  useEffect(() => {
    void loadBrokerDetails()
  }, [loadBrokerDetails])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
      <div className="shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-[var(--pear-text)]">Broker details</h1>
            <p className="mt-1 text-sm text-[var(--pear-text-faint)]">
              Running broker sessions, local connection metadata, and CLI-ready commands.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadBrokerDetails()}
            disabled={detailsLoading}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--pear-border)] px-3 py-2 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-50"
          >
            <RefreshCw size={14} className={detailsLoading ? 'animate-spin' : ''} />
            <span>{detailsLoading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {detailsError && (
          <div className="mb-4 rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5 text-sm text-[var(--pear-red)]">
            {detailsError}
          </div>
        )}

        {detailsLoading && !hasBrokerSections ? (
          <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-3 py-12 text-center text-sm text-[var(--pear-text-faint)]">
            Loading broker details...
          </div>
        ) : hasBrokerSections ? (
          <div className="space-y-5">
            {brokerDetails.map((broker) => (
              <BrokerCard
                key={broker.projectId}
                broker={broker}
                projectName={getProjectName(projects, broker.projectId)}
                statusErrors={brokerErrorsByProject.get(broker.projectId) || []}
                currentErrorId={currentErrorId}
              />
            ))}
            {unmatchedProjectErrorGroups.map(([projectId, entries]) => (
              <ProjectBrokerIssueSection
                key={projectId}
                projectName={getProjectName(projects, projectId)}
                entries={entries}
                currentErrorId={currentErrorId}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-3 py-12 text-center text-sm text-[var(--pear-text-faint)]">
            No managed brokers running
          </div>
        )}

        {unattributedBrokerErrors.length > 0 && (
          <div className="mt-5">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">
              Unattributed broker errors
            </p>
            <BrokerErrorRows entries={unattributedBrokerErrors} currentErrorId={currentErrorId} />
          </div>
        )}
      </div>
    </div>
  )
}
