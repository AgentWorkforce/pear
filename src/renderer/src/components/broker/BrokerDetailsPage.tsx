import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  Cloud,
  Copy,
  KeyRound,
  List,
  MessageSquare,
  RefreshCw,
  Server,
  Wrench
} from 'lucide-react'
import { pear, type BrokerDetails, type BrokerEventRecord, type BrokerListAgent } from '@/lib/ipc'
import { type BrokerErrorEntry, useAgentStore } from '@/stores/agent-store'
import { useProjectStore, type Project } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { getBrokerErrorKey } from '@shared/lib/broker-errors'

const errorTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

const chartTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
})

const MESSAGE_CHART_BUCKET_MS = 5 * 60 * 1_000
const MESSAGE_CHART_RANGES = [1, 3, 12] as const
type MessageChartRangeHours = typeof MESSAGE_CHART_RANGES[number]

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

function getProjectBrokerName(project: Project): string {
  return `pear-${project.relayWorkspaceId}`
}

function getDefaultProjectRoot(project: Project): Project['roots'][number] | undefined {
  return project.roots.find((root) => root.pathExists) || project.roots[0]
}

function isRecoverableBrokerRuntimeError(
  message: string,
  options: { allowLivePidConflict?: boolean } = {}
): boolean {
  const hasBrokerLockConflict = /another broker instance is already running in this directory/i.test(message)
  const hasLivePidConflict = /another broker instance is already running in this directory \(pid:\s*\d+/i.test(message)
  const hasStaleLockSignal =
    /stale broker lock detected/i.test(message) ||
    /broker lock held but no valid PID file found/i.test(message)

  return (options.allowLivePidConflict || !hasLivePidConflict) &&
    (hasStaleLockSignal || hasBrokerLockConflict)
}

function getAutoFixableBrokerError(
  entries: BrokerErrorEntry[],
  options: { allowLivePidConflict?: boolean } = {}
): BrokerErrorEntry | undefined {
  return entries.find((entry) => isRecoverableBrokerRuntimeError(entry.message, options))
}

function dedupeBrokerErrorEntries(entries: BrokerErrorEntry[]): BrokerErrorEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = getBrokerErrorKey(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getConnectionStatusLabel(status: BrokerDetails['connectionFileStatus']): string {
  if (status === 'matches') return 'ready'
  if (status === 'different') return 'different broker'
  if (status === 'invalid') return 'invalid'
  if (status === 'missing') return 'missing'
  return 'n/a'
}

function compactValue(value: string | undefined, fallback = 'n/a'): string {
  return value?.trim() || fallback
}

function getPrimaryRelaycastWorkspace(
  broker: BrokerDetails
): NonNullable<BrokerDetails['relaycast']>['workspaces'][number] | undefined {
  return broker.relaycast?.workspaces.find((workspace) => workspace.default) || broker.relaycast?.workspaces[0]
}

function getBrokerRuntimeSummary(broker: BrokerDetails): string {
  const owner = broker.brokerPid || broker.cloudSandboxId
  return [
    broker.kind,
    owner ? `owner ${owner}` : null,
    `uptime ${formatUptime(broker.session?.uptimeSecs)}`
  ].filter(Boolean).join(' / ')
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
  return index === 0 ? 'Latest issue' : 'Agent Relay error'
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
          className="min-w-0 overflow-hidden rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--pear-red)]">
            <span className="font-medium uppercase tracking-[0.12em]">
              {getIssueLabel(entry, index, currentErrorId)}
            </span>
            <span className="shrink-0 text-[var(--pear-text-faint)]">
              {formatErrorTimestamp(entry.timestamp)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--pear-text)] [overflow-wrap:anywhere]">
            {entry.message}
          </p>
        </div>
      ))}
    </div>
  )
}

function BrokerIssueBlock({
  entries,
  currentErrorId,
  project,
  fixing,
  fixError,
  onAutoFix,
  allowLivePidConflict = false
}: {
  entries: BrokerErrorEntry[]
  currentErrorId?: string
  project?: Project
  fixing?: boolean
  fixError?: string
  onAutoFix?: (project: Project, entry: BrokerErrorEntry) => void
  allowLivePidConflict?: boolean
}): React.ReactNode {
  if (entries.length === 0) return null

  const autoFixEntry = getAutoFixableBrokerError(entries, { allowLivePidConflict })
  const autoFixAction = project && autoFixEntry && onAutoFix
    ? { project, entry: autoFixEntry, run: onAutoFix }
    : null

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertCircle size={15} className="text-[var(--pear-red)]" />
          <h3 className="text-sm font-semibold text-[var(--pear-text)]">Agent Relay issues</h3>
        </div>
        {autoFixAction && (
          <button
            type="button"
            onClick={() => autoFixAction.run(autoFixAction.project, autoFixAction.entry)}
            disabled={fixing}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--pear-red)]/30 bg-[var(--pear-red)]/10 px-3 py-1.5 text-sm text-[var(--pear-red)] hover:bg-[var(--pear-red)]/15 disabled:cursor-wait disabled:opacity-60"
            title="Clear stale Agent Relay runtime files and restart this session"
          >
            {fixing ? <RefreshCw size={14} className="animate-spin" /> : <Wrench size={14} />}
            <span>{fixing ? 'Fixing' : 'Auto Fix'}</span>
          </button>
        )}
      </div>
      <BrokerErrorRows entries={entries} currentErrorId={currentErrorId} />
      {fixError && (
        <p className="mt-3 rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
          {fixError}
        </p>
      )}
    </div>
  )
}

function ProjectBrokerIssueSection({
  project,
  projectName,
  entries,
  currentErrorId,
  fixing,
  fixError,
  onAutoFix
}: {
  project?: Project
  projectName: string
  entries: BrokerErrorEntry[]
  currentErrorId?: string
  fixing?: boolean
  fixError?: string
  onAutoFix?: (project: Project, entry: BrokerErrorEntry) => void
}): React.ReactNode {
  const autoFixEntry = getAutoFixableBrokerError(entries)
  const autoFixAction = project && autoFixEntry && onAutoFix
    ? { project, entry: autoFixEntry, run: onAutoFix }
    : null

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
              Agent Relay did not start or is not currently managed by this window.
            </p>
          </div>
        </div>
        {autoFixAction && (
          <button
            type="button"
            onClick={() => autoFixAction.run(autoFixAction.project, autoFixAction.entry)}
            disabled={fixing}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--pear-red)]/30 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)] hover:bg-[var(--pear-red)]/15 disabled:cursor-wait disabled:opacity-60"
            title="Clear stale Agent Relay runtime files and restart this session"
          >
            {fixing ? <RefreshCw size={14} className="animate-spin" /> : <Wrench size={14} />}
            <span>{fixing ? 'Fixing' : 'Auto Fix'}</span>
          </button>
        )}
      </div>
      <div className="p-5">
        <BrokerErrorRows entries={entries} currentErrorId={currentErrorId} />
        {fixError && (
          <p className="mt-3 rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
            {fixError}
          </p>
        )}
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

function CompactMetaRow({
  label,
  value,
  copyValue
}: {
  label: string
  value: string
  copyValue?: string
}): React.ReactNode {
  return (
    <div className="grid min-w-0 grid-cols-[126px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[var(--pear-border-subtle)] py-2 last:border-b-0">
      <span className="text-[11px] text-[var(--pear-text-faint)]">{label}</span>
      <span className="min-w-0 truncate font-mono text-[12px] text-[var(--pear-text-secondary)]" title={value}>
        {value}
      </span>
      {copyValue ? <CopyButton value={copyValue} label="Copy" /> : <span />}
    </div>
  )
}

function BrokerMetadataSummary({ broker }: { broker: BrokerDetails }): React.ReactNode {
  const apiKey = broker.apiKey || (broker.apiKeyAvailable ? 'stored in connection file' : 'n/a')
  const primaryWorkspace = getPrimaryRelaycastWorkspace(broker)
  const workspaceId = broker.relaycast?.defaultWorkspaceId || primaryWorkspace?.workspaceId
  const workspaceKey = broker.relaycast?.workspaceKey || broker.session?.workspaceKey
  const workspaceAlias = primaryWorkspace?.workspaceAlias || undefined
  const selfAgent = primaryWorkspace
    ? `${primaryWorkspace.selfName} / ${primaryWorkspace.selfAgentId}`
    : 'n/a'
  const relaycastAuth = typeof broker.relaycast?.authenticated === 'boolean'
    ? broker.relaycast.authenticated ? 'authenticated' : 'not authenticated'
    : 'unknown'
  const workspaceCount = typeof broker.relaycast?.workspaceCount === 'number'
    ? `${broker.relaycast.workspaceCount} workspace${broker.relaycast.workspaceCount === 1 ? '' : 's'}`
    : 'workspace count unknown'

  return (
    <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-1">
      <CompactMetaRow label="Endpoint" value={compactValue(broker.url)} copyValue={broker.url} />
      <CompactMetaRow label="API key" value={apiKey} copyValue={broker.apiKey} />
      <CompactMetaRow
        label="Relaycast"
        value={[relaycastAuth, workspaceCount].filter(Boolean).join(' / ')}
      />
      <CompactMetaRow
        label="Workspace ID"
        value={compactValue(workspaceAlias ? `${workspaceAlias} (${workspaceId || 'no id'})` : workspaceId)}
        copyValue={workspaceId}
      />
      <CompactMetaRow label="Workspace key" value={compactValue(workspaceKey)} copyValue={workspaceKey} />
      <CompactMetaRow label="Self agent" value={selfAgent} copyValue={primaryWorkspace?.selfAgentId} />
      <CompactMetaRow
        label="Runtime"
        value={`${getBrokerRuntimeSummary(broker)} / protocol ${broker.session ? `v${broker.session.protocolVersion}` : 'unknown'}`}
      />
      <CompactMetaRow
        label="State"
        value={`${getConnectionStatusLabel(broker.connectionFileStatus)} / ${broker.agentCount} agents / ${broker.pendingDeliveryCount} pending`}
      />
      <CompactMetaRow label="Root" value={broker.cwd || 'cloud sandbox'} copyValue={broker.cwd || undefined} />
      <CompactMetaRow
        label="Connection file"
        value={compactValue(broker.connectionPath)}
        copyValue={broker.connectionPath}
      />
    </div>
  )
}

function getEventKind(entry: BrokerEventRecord): string {
  return typeof entry.event.kind === 'string' ? entry.event.kind : 'unknown'
}

function isDisplayBrokerEvent(entry: BrokerEventRecord): boolean {
  return getEventKind(entry) !== 'worker_stream'
}

function eventMatchesProject(entry: BrokerEventRecord, projectId: string | undefined): boolean {
  return !projectId || entry.projectId === projectId
}

function getEventString(event: BrokerEventRecord['event'], key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getEventChannels(event: BrokerEventRecord['event']): string | undefined {
  const channels = event.channels
  if (!Array.isArray(channels)) return undefined
  const names = channels.filter((channel): channel is string => typeof channel === 'string' && channel.trim().length > 0)
  return names.length > 0 ? names.join(', ') : undefined
}

function compactEventText(value: string | undefined, maxLength = 220): string | undefined {
  if (!value) return undefined
  const compacted = value.replace(/\s+/g, ' ').trim()
  if (compacted.length <= maxLength) return compacted
  return `${compacted.slice(0, maxLength)}...`
}

function humanizeEventKind(kind: string): string {
  return kind
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getEventDisplayName(kind: string): string {
  if (kind === 'broker_initialized') return 'Agent Relay initialized'
  return humanizeEventKind(kind)
}

const ERROR_EVENT_KINDS = new Set([
  'worker_error',
  'delivery_failed',
  'message_delivery_failed',
  'relaycast_publish_failed',
  'acl_denied',
  'agent_permanently_dead',
  'agent_restarting',
  'agent_exit',
  'agent_exited'
])

function isBrokerEventError(entry: BrokerEventRecord): boolean {
  const kind = getEventKind(entry)
  if (ERROR_EVENT_KINDS.has(kind)) return true
  return Boolean(
    getEventString(entry.event, 'lastError') ||
    (kind.includes('failed') && getEventString(entry.event, 'reason'))
  )
}

function getBrokerEventErrorMessage(entry: BrokerEventRecord): string {
  const event = entry.event
  return compactEventText(
    getEventString(event, 'message') ||
    getEventString(event, 'lastError') ||
    getEventString(event, 'reason') ||
    describeBrokerEvent(entry),
    360
  ) || getEventDisplayName(getEventKind(entry))
}

function describeBrokerEvent(entry: BrokerEventRecord): string {
  const event = entry.event
  const kind = getEventKind(entry)
  const name = getEventString(event, 'name')
  const from = getEventString(event, 'from')
  const target = getEventString(event, 'target') || getEventString(event, 'to')
  const body = compactEventText(getEventString(event, 'body'))
  const chunk = compactEventText(getEventString(event, 'chunk'))
  const message = compactEventText(getEventString(event, 'message') || getEventString(event, 'reason') || getEventString(event, 'lastError'))
  const eventId = getEventString(event, 'event_id')

  switch (kind) {
    case 'broker_initialized':
      return `Agent Relay initialized${getEventString(event, 'url') ? ` at ${getEventString(event, 'url')}` : ''}`
    case 'relay_inbound':
      return `${from || 'unknown'} sent to ${target || 'unknown'}${body ? `: ${body}` : ''}`
    case 'relaycast_published':
      return `Published ${eventId || 'message'} to ${target || 'target'}`
    case 'relaycast_publish_failed':
      return `Publish failed for ${eventId || 'message'} to ${target || 'target'}${message ? `: ${message}` : ''}`
    case 'message_delivery_confirmed':
      return `Delivered ${from || 'message'} to ${target || name || 'agent'}`
    case 'message_delivery_failed':
      return `Delivery failed from ${from || 'sender'} to ${target || name || 'agent'}${message ? `: ${message}` : ''}`
    case 'worker_stream':
      return `${name || 'worker'} ${getEventString(event, 'stream') || 'stream'}${chunk ? `: ${chunk}` : ''}`
    case 'worker_error':
      return `${name || 'worker'} error${message ? `: ${message}` : ''}`
    case 'agent_spawned':
      return `Spawned ${name || 'agent'}${getEventString(event, 'cli') ? ` with ${getEventString(event, 'cli')}` : ''}`
    case 'agent_released':
      return `Released ${name || 'agent'}`
    case 'agent_exit':
    case 'agent_exited':
      return `${name || 'agent'} exited${message ? `: ${message}` : ''}`
    case 'agent_idle':
      return `${name || 'agent'} is idle`
    case 'agent_blocked_on_send':
      return `${name || 'agent'} is blocked on send`
    case 'delivery_queued':
      return `Queued delivery for ${name || 'agent'}${eventId ? ` (${eventId})` : ''}`
    case 'delivery_active':
      return `Active delivery for ${name || 'agent'}${eventId ? ` (${eventId})` : ''}`
    case 'delivery_injected':
      return `Injected delivery into ${name || 'agent'}${eventId ? ` (${eventId})` : ''}`
    case 'delivery_verified':
      return `Verified delivery for ${name || 'agent'}${eventId ? ` (${eventId})` : ''}`
    case 'delivery_failed':
      return `Delivery failed for ${name || 'agent'}${message ? `: ${message}` : ''}`
    case 'delivery_ack':
      return `Acknowledged delivery for ${name || 'agent'}${eventId ? ` (${eventId})` : ''}`
    case 'channel_subscribed':
      return `${name || 'agent'} subscribed to ${getEventChannels(event) || 'channels'}`
    case 'channel_unsubscribed':
      return `${name || 'agent'} unsubscribed from ${getEventChannels(event) || 'channels'}`
    default:
      return [
        getEventDisplayName(kind),
        name || from,
        message || body || chunk
      ].filter(Boolean).join(': ')
  }
}

function isMessageThroughputEvent(entry: BrokerEventRecord): boolean {
  const kind = getEventKind(entry)
  return kind === 'relay_inbound' || kind === 'relaycast_published'
}

function getMessageThroughputKey(entry: BrokerEventRecord): string {
  return getEventString(entry.event, 'event_id') || entry.id
}

function buildMessageBuckets(
  events: BrokerEventRecord[],
  rangeHours: MessageChartRangeHours,
  now = Date.now()
): Array<{ timestamp: number; count: number }> {
  const bucketCount = rangeHours * 12
  const endBucket = Math.floor(now / MESSAGE_CHART_BUCKET_MS) * MESSAGE_CHART_BUCKET_MS
  const startBucket = endBucket - ((bucketCount - 1) * MESSAGE_CHART_BUCKET_MS)
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    timestamp: startBucket + (index * MESSAGE_CHART_BUCKET_MS),
    count: 0
  }))
  const seenByBucket = buckets.map(() => new Set<string>())

  for (const entry of events) {
    if (!isMessageThroughputEvent(entry)) continue
    const index = Math.floor((entry.timestamp - startBucket) / MESSAGE_CHART_BUCKET_MS)
    if (index < 0 || index >= buckets.length) continue
    const key = getMessageThroughputKey(entry)
    if (seenByBucket[index].has(key)) continue
    seenByBucket[index].add(key)
    buckets[index].count += 1
  }

  return buckets
}

function MessageThroughputPanel({ events }: { events: BrokerEventRecord[] }): React.ReactNode {
  const [rangeHours, setRangeHours] = useState<MessageChartRangeHours>(1)
  const buckets = useMemo(() => buildMessageBuckets(events, rangeHours), [events, rangeHours])
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.count))
  const average = buckets.length > 0 ? total / buckets.length : 0
  const chartWidth = 640
  const chartHeight = 170
  const padding = { top: 16, right: 18, bottom: 18, left: 18 }
  const plotWidth = chartWidth - padding.left - padding.right
  const plotHeight = chartHeight - padding.top - padding.bottom
  const maxCount = Math.max(1, peak)
  const points = buckets.map((bucket, index) => {
    const x = padding.left + ((plotWidth * index) / Math.max(1, buckets.length - 1))
    const y = padding.top + plotHeight - ((bucket.count / maxCount) * plotHeight)
    return { x, y, count: bucket.count }
  })
  const linePoints = points.map((point) => `${point.x},${point.y}`).join(' ')
  const areaPath = points.length > 0
    ? [
        `M ${points[0].x} ${padding.top + plotHeight}`,
        ...points.map((point) => `L ${point.x} ${point.y}`),
        `L ${points[points.length - 1].x} ${padding.top + plotHeight}`,
        'Z'
      ].join(' ')
    : ''
  const firstBucket = buckets[0]
  const middleBucket = buckets[Math.floor(buckets.length / 2)]
  const lastBucket = buckets[buckets.length - 1]

  return (
    <section className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--pear-border-subtle)] px-5 py-4">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-[var(--pear-accent)]" />
          <h2 className="text-sm font-semibold text-[var(--pear-text)]">Messages per 5 minutes</h2>
        </div>
        <div className="flex rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 p-0.5">
          {MESSAGE_CHART_RANGES.map((hours) => (
            <button
              key={hours}
              type="button"
              onClick={() => setRangeHours(hours)}
              className={`h-7 rounded px-2.5 text-[11px] ${
                rangeHours === hours
                  ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                  : 'text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
              }`}
            >
              {hours}h
            </button>
          ))}
        </div>
      </div>
      <div className="p-5">
        <div className="mb-4 grid grid-cols-3 gap-3">
          <DetailField label="Total" value={String(total)} />
          <DetailField label="Peak block" value={String(peak)} />
          <DetailField label="Avg block" value={average.toFixed(1)} />
        </div>
        <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-3">
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="h-44 w-full"
            role="img"
            aria-label={`Messages sent per 5 minute block for the past ${rangeHours} hours`}
          >
            {[0, 1, 2, 3].map((line) => {
              const y = padding.top + ((plotHeight * line) / 3)
              return (
                <line
                  key={line}
                  x1={padding.left}
                  x2={chartWidth - padding.right}
                  y1={y}
                  y2={y}
                  stroke="var(--pear-border-subtle)"
                  strokeWidth="1"
                />
              )
            })}
            {areaPath && (
              <path d={areaPath} fill="var(--pear-bg-overlay)" opacity="0.9" />
            )}
            <polyline
              points={linePoints}
              fill="none"
              stroke="var(--pear-accent-bright)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {points.filter((point) => point.count > 0).map((point, index) => (
              <circle
                key={`${point.x}-${index}`}
                cx={point.x}
                cy={point.y}
                r="3.5"
                fill="var(--pear-accent-bright)"
              />
            ))}
          </svg>
          <div className="mt-2 flex justify-between text-[11px] text-[var(--pear-text-faint)]">
            <span>{firstBucket ? chartTimeFormatter.format(new Date(firstBucket.timestamp)) : ''}</span>
            <span>{middleBucket ? chartTimeFormatter.format(new Date(middleBucket.timestamp)) : ''}</span>
            <span>{lastBucket ? chartTimeFormatter.format(new Date(lastBucket.timestamp)) : ''}</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function BrokerEventErrorPanel({
  events,
  projects
}: {
  events: BrokerEventRecord[]
  projects: Project[]
}): React.ReactNode {
  const errorEvents = events.filter(isBrokerEventError).slice(-6).reverse()
  if (errorEvents.length === 0) return null

  return (
    <section className="rounded-lg border border-[var(--pear-red)]/25 bg-[var(--pear-bg-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--pear-red)]/15 px-5 py-4">
        <AlertTriangle size={16} className="text-[var(--pear-red)]" />
        <h2 className="text-sm font-semibold text-[var(--pear-text)]">Recent event errors</h2>
      </div>
      <div className="space-y-2 p-5">
        {errorEvents.map((entry) => (
          <div
            key={entry.id}
            className="rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--pear-red)]">
              <span className="font-medium uppercase">{getEventDisplayName(getEventKind(entry))}</span>
              <span className="text-[var(--pear-text-faint)]">{formatErrorTimestamp(entry.timestamp)}</span>
            </div>
            <p className="mt-1 text-sm text-[var(--pear-text)]">{getBrokerEventErrorMessage(entry)}</p>
            <p className="mt-1 text-[11px] text-[var(--pear-text-faint)]">
              {getProjectName(projects, entry.projectId)}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

function BrokerEventFeed({
  events,
  projects
}: {
  events: BrokerEventRecord[]
  projects: Project[]
}): React.ReactNode {
  const recentEvents = events.slice(-150).reverse()

  return (
    <section className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--pear-border-subtle)] px-5 py-4">
        <div className="flex items-center gap-2">
          <List size={16} className="text-[var(--pear-accent)]" />
          <h2 className="text-sm font-semibold text-[var(--pear-text)]">Broker event feed</h2>
        </div>
        <span className="rounded-full border border-[var(--pear-border-subtle)] px-2 py-1 text-[11px] text-[var(--pear-text-faint)]">
          {events.length} events
        </span>
      </div>
      {recentEvents.length > 0 ? (
        <div className="max-h-[520px] overflow-y-auto">
          {recentEvents.map((entry) => {
            const kind = getEventKind(entry)
            const isError = isBrokerEventError(entry)
            return (
              <div
                key={entry.id}
                className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-[var(--pear-border-subtle)] px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 text-[11px] text-[var(--pear-text-faint)]">
                  <div>{formatErrorTimestamp(entry.timestamp)}</div>
                  <div className="mt-1 truncate" title={getProjectName(projects, entry.projectId)}>
                    {getProjectName(projects, entry.projectId)}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                        isError
                          ? 'bg-[var(--pear-red)]/10 text-[var(--pear-red)]'
                          : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text-secondary)]'
                      }`}
                    >
                      {isError ? <AlertCircle size={11} /> : <MessageSquare size={11} />}
                      {getEventDisplayName(kind)}
                    </span>
                    {getEventString(entry.event, 'name') && (
                      <span className="truncate text-[11px] text-[var(--pear-text-faint)]">
                        {getEventString(entry.event, 'name')}
                      </span>
                    )}
                  </div>
                  <p className="break-words text-sm leading-5 text-[var(--pear-text-secondary)]">
                    {describeBrokerEvent(entry)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="px-5 py-12 text-center text-sm text-[var(--pear-text-faint)]">
          No broker events recorded yet
        </div>
      )}
    </section>
  )
}

function BrokerCard({
  broker,
  projectName,
  statusErrors,
  currentErrorId,
  project,
  fixing,
  fixError,
  onAutoFix
}: {
  broker: BrokerDetails
  projectName: string
  statusErrors: BrokerErrorEntry[]
  currentErrorId?: string
  project?: Project
  fixing?: boolean
  fixError?: string
  onAutoFix?: (project: Project, entry: BrokerErrorEntry) => void
}): React.ReactNode {
  const Icon = broker.kind === 'cloud' ? Cloud : Server

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
        <BrokerMetadataSummary broker={broker} />

        <div>
          <div className="mb-3 flex items-center gap-2">
            <KeyRound size={15} className="text-[var(--pear-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--pear-text)]">Agents</h3>
          </div>
          {broker.agents.length > 0 ? (
            <div className="space-y-2">
              {broker.agents.map((agent) => (
                <div
                  key={agent.name}
                  className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2"
                >
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium text-[var(--pear-text)]" title={agent.name}>
                      {agent.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[11px] text-[var(--pear-text-secondary)]">
                      {agent.currentState || 'unknown'}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-[var(--pear-text-faint)]">
                    {[agent.runtime, agent.cli || 'unknown cli', agent.pid ? `pid ${agent.pid}` : 'no pid'].join(' / ')}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-6 text-center text-sm text-[var(--pear-text-faint)]">
              No agents registered with this Agent Relay session
            </div>
          )}
        </div>

        {broker.error && (
          <div className="rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5 text-sm text-[var(--pear-red)]">
            {broker.error}
          </div>
        )}

        <BrokerIssueBlock
          entries={statusErrors}
          currentErrorId={currentErrorId}
          project={project}
          fixing={fixing}
          fixError={fixError}
          onAutoFix={onAutoFix}
          allowLivePidConflict
        />
      </div>
    </section>
  )
}

export function BrokerDetailsPage(): React.ReactNode {
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const brokerError = useAgentStore((s) => s.brokerError)
  const brokerErrors = useAgentStore((s) => s.brokerErrors)
  const brokerEvents = useAgentStore((s) => s.brokerEvents)
  const hydrateBrokerEvents = useAgentStore((s) => s.hydrateBrokerEvents)
  const syncBrokerDetailsStatus = useAgentStore((s) => s.syncBrokerDetailsStatus)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeBrokerTabProjectId = useUIStore((s) => {
    const activeTab = s.tabs.find((tab) => tab.id === s.activeTabId)
    return activeTab?.kind === 'broker-details' ? activeTab.projectId : undefined
  })
  const [brokerDetails, setBrokerDetails] = useState<BrokerDetails[]>([])
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [autoFixingProjectId, setAutoFixingProjectId] = useState<string | null>(null)
  const [autoFixErrors, setAutoFixErrors] = useState<Record<string, string>>({})

  const pageProjectId = activeBrokerTabProjectId || activeProjectId || undefined
  const pageProjectName = pageProjectId ? getProjectName(projects, pageProjectId) : 'All projects'
  const visibleBrokerErrors = useMemo(() => dedupeBrokerErrorEntries(brokerErrors), [brokerErrors])
  const currentErrorId = brokerStatus === 'error' && brokerError && visibleBrokerErrors[0]?.message === brokerError
    ? visibleBrokerErrors[0].id
    : undefined
  const scopedBrokerDetails = useMemo(
    () => pageProjectId
      ? brokerDetails.filter((broker) => broker.projectId === pageProjectId)
      : brokerDetails,
    [brokerDetails, pageProjectId]
  )
  const brokerErrorsByProject = useMemo(() => {
    const grouped = new Map<string, BrokerErrorEntry[]>()
    for (const entry of visibleBrokerErrors) {
      if (!entry.projectId) continue
      if (pageProjectId && entry.projectId !== pageProjectId) continue
      const entries = grouped.get(entry.projectId) || []
      entries.push(entry)
      grouped.set(entry.projectId, entries)
    }
    return grouped
  }, [pageProjectId, visibleBrokerErrors])
  const unmatchedProjectErrorGroups = useMemo(() => {
    const brokerProjectIds = new Set(scopedBrokerDetails.map((broker) => broker.projectId))
    return Array.from(brokerErrorsByProject.entries()).filter(([projectId]) => !brokerProjectIds.has(projectId))
  }, [brokerErrorsByProject, scopedBrokerDetails])
  const unattributedBrokerErrors = useMemo(
    () => pageProjectId ? [] : visibleBrokerErrors.filter((entry) => !entry.projectId),
    [pageProjectId, visibleBrokerErrors]
  )
  const sortedBrokerEvents = useMemo(
    () => [...brokerEvents].sort((left, right) => left.timestamp - right.timestamp),
    [brokerEvents]
  )
  const scopedBrokerEvents = useMemo(
    () => sortedBrokerEvents.filter((entry) =>
      isDisplayBrokerEvent(entry) && eventMatchesProject(entry, pageProjectId)
    ),
    [pageProjectId, sortedBrokerEvents]
  )
  const hasBrokerSections = scopedBrokerDetails.length > 0 || unmatchedProjectErrorGroups.length > 0

  const loadBrokerDetails = useCallback(async (): Promise<void> => {
    setDetailsLoading(true)
    setDetailsError(null)
    try {
      if (typeof pear.broker.listEvents === 'function') {
        pear.broker.listEvents()
          .then(hydrateBrokerEvents)
          .catch(() => undefined)
      }

      if (typeof pear.broker.listDetails === 'function') {
        const details = await pear.broker.listDetails()
        setBrokerDetails(details)
        syncBrokerDetailsStatus(details)
        return
      }

      const liveAgents = await pear.broker.listAgents()
      const details = buildAgentFallbackDetails(liveAgents, projects, brokerStatus)
      setBrokerDetails(details)
      syncBrokerDetailsStatus(details)
      setDetailsError(
        'Agent Relay status API is not loaded in this window. Restart Pear by Agent Relay for full diagnostics and connection metadata.'
      )
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetailsLoading(false)
    }
  }, [brokerStatus, hydrateBrokerEvents, projects, syncBrokerDetailsStatus])

  const handleAutoFix = useCallback(async (project: Project, entry: BrokerErrorEntry): Promise<void> => {
    const root = getDefaultProjectRoot(project)
    if (!root?.pathExists) {
      setAutoFixErrors((errors) => ({
        ...errors,
        [project.id]: `Project path no longer exists: ${root?.path || project.rootPath}`
      }))
      return
    }

    setAutoFixingProjectId(project.id)
    setAutoFixErrors((errors) => {
      const { [project.id]: _removed, ...remaining } = errors
      return remaining
    })
    try {
      await pear.broker.autoFixRuntime(
        project.id,
        root.path,
        getProjectBrokerName(project),
        project.channels,
        entry.message
      )
      await loadBrokerDetails()
    } catch (err) {
      setAutoFixErrors((errors) => ({
        ...errors,
        [project.id]: err instanceof Error ? err.message : String(err)
      }))
    } finally {
      setAutoFixingProjectId(null)
    }
  }, [loadBrokerDetails])

  useEffect(() => {
    void loadBrokerDetails()
  }, [loadBrokerDetails])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
      <div className="shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-[var(--pear-text)]">Agent Relay Status</h1>
            <p className="mt-1 text-sm text-[var(--pear-text-faint)]">
              {pageProjectId
                ? `${pageProjectName} broker activity, event feed, and compact connection metadata.`
                : 'Project broker activity, event feed, and compact connection metadata.'}
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

        <MessageThroughputPanel events={scopedBrokerEvents} />

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
          <BrokerEventFeed events={scopedBrokerEvents} projects={projects} />
          <div className="space-y-5">
            <BrokerEventErrorPanel events={scopedBrokerEvents} projects={projects} />
            {detailsLoading && !hasBrokerSections ? (
              <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-3 py-12 text-center text-sm text-[var(--pear-text-faint)]">
                Loading Agent Relay status...
              </div>
            ) : hasBrokerSections ? (
              <div className="space-y-5">
                {scopedBrokerDetails.map((broker) => (
                  <BrokerCard
                    key={broker.projectId}
                    broker={broker}
                    projectName={getProjectName(projects, broker.projectId)}
                    statusErrors={brokerErrorsByProject.get(broker.projectId) || []}
                    currentErrorId={currentErrorId}
                    project={projects.find((project) => project.id === broker.projectId)}
                    fixing={autoFixingProjectId === broker.projectId}
                    fixError={autoFixErrors[broker.projectId]}
                    onAutoFix={(project, entry) => void handleAutoFix(project, entry)}
                  />
                ))}
                {unmatchedProjectErrorGroups.map(([projectId, entries]) => (
                  <ProjectBrokerIssueSection
                    key={projectId}
                    project={projects.find((project) => project.id === projectId)}
                    projectName={getProjectName(projects, projectId)}
                    entries={entries}
                    currentErrorId={currentErrorId}
                    fixing={autoFixingProjectId === projectId}
                    fixError={autoFixErrors[projectId]}
                    onAutoFix={(project, entry) => void handleAutoFix(project, entry)}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-3 py-12 text-center text-sm text-[var(--pear-text-faint)]">
                {pageProjectId
                  ? 'No managed Agent Relay session running for this project'
                  : 'No managed Agent Relay sessions running'}
              </div>
            )}
          </div>
        </div>

        {unattributedBrokerErrors.length > 0 && (
          <div className="mt-5">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">
              Unattributed Agent Relay errors
            </p>
            <BrokerErrorRows entries={unattributedBrokerErrors} currentErrorId={currentErrorId} />
          </div>
        )}
      </div>
    </div>
  )
}
