import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  GitFork,
  GitPullRequest,
  Inbox,
  MessageSquare,
  RefreshCw,
  Reply,
  ThumbsUp,
  X
} from 'lucide-react'
import { detectRepo } from '@/lib/issue-scoping'
import { jumpToIssueWork } from '@/lib/issue-navigation'
import { spawnTeamForIssue, type TeamComposition } from '@/lib/spawn-agent'
import { useAgentStore, type ChatMessage } from '@/stores/agent-store'
import { useIssuesStore, type IssueBand, type IssueGithubLink, type IssueViewModel } from '@/stores/issues-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

const isWebMock = import.meta.env.VITE_PEAR_MOCK_IPC === 'true'

const BAND_TITLES: Record<IssueBand, string> = {
  'needs-you': 'Needs you',
  'ready-for-agent': 'Ready for agent',
  'in-motion': 'In motion',
  settled: 'Settled'
}

const BAND_SUBTITLES: Record<IssueBand, string> = {
  'needs-you': 'Only humans can clear these',
  'ready-for-agent': 'Waiting for automated agent pickup',
  'in-motion': 'Ambient live agent work',
  settled: 'Recently merged or done'
}

// Display order for the status filter; stages not listed here sort after, alphabetically.
const STAGE_FILTER_ORDER = ['Backlog', 'Planning', 'To do', 'In Progress', 'In review', 'Merged', 'Done']

function orderStages(stages: string[]): string[] {
  return [...stages].sort((left, right) => {
    const leftRank = STAGE_FILTER_ORDER.indexOf(left)
    const rightRank = STAGE_FILTER_ORDER.indexOf(right)
    if (leftRank !== rightRank) return (leftRank === -1 ? 99 : leftRank) - (rightRank === -1 ? 99 : rightRank)
    return left.localeCompare(right)
  })
}

function bandIcon(band: IssueBand): React.ReactNode {
  if (band === 'needs-you') return <AlertTriangle size={15} className="text-[var(--pear-red)]" />
  if (band === 'ready-for-agent') return <Bot size={15} className="text-[var(--pear-purple)]" />
  if (band === 'in-motion') return <CircleDot size={15} className="text-[var(--pear-teal)]" />
  return <CheckCircle2 size={15} className="text-[var(--pear-green)]" />
}

function actorClass(actor: IssueViewModel['actor']): string {
  if (actor === 'human') return 'border-[var(--pear-red)]/35 bg-[var(--pear-red)]/10 text-[var(--pear-red)]'
  if (actor === 'pairing') return 'border-[var(--pear-purple)]/35 bg-[var(--pear-purple)]/10 text-[var(--pear-purple)]'
  if (actor === 'agent') return 'border-[var(--pear-teal)]/35 bg-[var(--pear-teal)]/10 text-[var(--pear-teal)]'
  return 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] text-[var(--pear-text-faint)]'
}

function stageClass(stage: string): string {
  if (stage === 'In review') return 'border-[var(--pear-yellow)]/35 bg-[var(--pear-yellow)]/10 text-[var(--pear-yellow)]'
  if (stage === 'Merged' || stage === 'Done') return 'border-[var(--pear-green)]/35 bg-[var(--pear-green)]/10 text-[var(--pear-green)]'
  if (stage === 'In Progress') return 'border-[var(--pear-teal)]/35 bg-[var(--pear-teal)]/10 text-[var(--pear-teal)]'
  return 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] text-[var(--pear-text-secondary)]'
}

function shortRelativeTime(iso?: string): string {
  if (!iso) return 'now'
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'now'
  const diffMs = Date.now() - timestamp
  if (diffMs < 60_000) return 'now'
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function liveNarration(issue: IssueViewModel, messages: ChatMessage[]): string {
  const agentName = issue.assignedAgentName
  if (agentName) {
    const message = [...messages]
      .reverse()
      .find((candidate) =>
        candidate.from === agentName &&
        candidate.projectId &&
        candidate.body.trim()
      )
    if (message) return message.body.trim()
  }

  return issue.agentNarration || 'Agent activity will appear here when work starts.'
}

function githubLabel(link: IssueGithubLink): string {
  const prefix = link.type === 'pull_request' ? 'PR' : 'Issue'
  return `${link.owner}/${link.repo} ${prefix} #${link.number}`
}

function ActionButton({
  label,
  icon: Icon
}: {
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}): React.ReactNode {
  return (
    <button
      type="button"
      disabled
      title={`${label} (Phase 2)`}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] text-[var(--pear-text-faint)] opacity-70"
      aria-label={`${label} unavailable in Phase 1`}
    >
      <Icon size={13} />
    </button>
  )
}

function StatusFilterChip({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
          : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] text-[var(--pear-text-faint)] hover:border-[var(--pear-border)] hover:text-[var(--pear-text)]'
      }`}
    >
      {label}
    </button>
  )
}

function IssueOverviewCard({
  issue,
  active,
  expandedChat,
  narration,
  onOpen,
  onToggleChat,
  onSpawnTeam
}: {
  issue: IssueViewModel
  active: boolean
  expandedChat: boolean
  narration: string
  onOpen: () => void
  onToggleChat: () => void
  onSpawnTeam?: () => void
}): React.ReactNode {
  const detectedRepo = issue.band === 'ready-for-agent' ? detectRepo(issue.title, issue.description) : null

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpen()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className={`group w-full rounded-lg border px-3 py-3 text-left transition-colors ${
        active
          ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)]'
          : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)]/72 hover:border-[var(--pear-border)] hover:bg-[var(--pear-bg-surface)]'
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--pear-text-faint)]">
              {issue.identifier}
            </span>
            {detectedRepo && (
              <span className="shrink-0 rounded-full border border-[var(--pear-purple)]/35 bg-[var(--pear-purple)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--pear-purple)]">
                {detectedRepo}
              </span>
            )}
            <span className="min-w-[180px] flex-1 truncate text-[13px] font-semibold text-[var(--pear-text)]">
              {issue.title}
            </span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${stageClass(issue.stage)}`}>
              {issue.stage}
            </span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${actorClass(issue.actor)}`}>
              {issue.actor === 'unknown' ? 'unassigned' : issue.actor}
            </span>
          </div>

          <div className="mt-2 flex min-w-0 items-center gap-2 text-[12px] text-[var(--pear-text-secondary)]">
            <Bot size={13} className="shrink-0 text-[var(--pear-text-faint)]" />
            <span className="shrink-0 font-medium text-[var(--pear-text-dim)]">
              {issue.assignedAgentName || issue.assigneeName || 'unassigned'}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onToggleChat()
              }}
              className="min-w-0 flex-1 truncate rounded text-left text-[var(--pear-text-secondary)] hover:text-[var(--pear-text)]"
              title="Show recent agent chat"
            >
              {narration}
            </button>
          </div>

          {expandedChat && (
            <div className="mt-3 space-y-1.5 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/55 p-2">
              {(issue.recentAgentMessages.length > 0 ? issue.recentAgentMessages : [narration]).slice(0, 3).map((message, index) => (
                <div key={`${issue.id}:chat:${index}`} className="flex gap-2 text-[12px] leading-5 text-[var(--pear-text-dim)]">
                  <MessageSquare size={12} className="mt-1 shrink-0 text-[var(--pear-text-faint)]" />
                  <span className="min-w-0 flex-1">{message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {issue.band === 'needs-you' && (
          <div className="flex shrink-0 items-center gap-1">
            <ActionButton label="Approve" icon={ThumbsUp} />
            <ActionButton label="Reject" icon={X} />
            <ActionButton label="Reply" icon={Reply} />
            <ActionButton label="Fork" icon={GitFork} />
          </div>
        )}
        {issue.band === 'ready-for-agent' && onSpawnTeam && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onSpawnTeam()
              }}
              title="Spawn impl + review team"
              className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--pear-purple)]/35 bg-[var(--pear-purple)]/10 px-2 text-[11px] font-semibold text-[var(--pear-purple)] hover:bg-[var(--pear-purple)]/20"
              aria-label="Spawn Team"
            >
              <Bot size={13} />
              Spawn Team
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function BandSection({
  band,
  issues,
  selectedIssueId,
  expanded,
  expandedChatIds,
  narrations,
  onToggleExpanded,
  onSelectIssue,
  onToggleChat,
  onSpawnTeam
}: {
  band: IssueBand
  issues: IssueViewModel[]
  selectedIssueId: string | null
  expanded: boolean
  expandedChatIds: Set<string>
  narrations: Map<string, string>
  onToggleExpanded: () => void
  onSelectIssue: (issueId: string) => void
  onToggleChat: (issueId: string) => void
  onSpawnTeam?: (issue: IssueViewModel) => void
}): React.ReactNode {
  const title = BAND_TITLES[band]
  const subtitle = BAND_SUBTITLES[band]
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <section className="border-b border-[var(--pear-border-subtle)] py-4 last:border-b-0">
      <button
        type="button"
        onClick={onToggleExpanded}
        className="flex w-full items-center gap-3 px-1 text-left"
        aria-expanded={expanded}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--pear-bg)]">
          {bandIcon(band)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--pear-text)]">
              {title}
            </span>
            <span className="rounded-full bg-[var(--pear-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--pear-text-faint)]">
              {issues.length}
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] text-[var(--pear-text-faint)]">{subtitle}</span>
        </span>
        <Chevron size={15} className="shrink-0 text-[var(--pear-text-faint)]" />
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {issues.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--pear-border-subtle)] px-4 py-6 text-center text-[12px] text-[var(--pear-text-faint)]">
              {band === 'needs-you' ? 'All clear.' : band === 'ready-for-agent' ? 'No issues queued for agents.' : 'Nothing here.'}
            </div>
          ) : (
            issues.map((issue) => (
              <IssueOverviewCard
                key={issue.id}
                issue={issue}
                active={selectedIssueId === issue.id}
                expandedChat={expandedChatIds.has(issue.id)}
                narration={narrations.get(issue.id) || issue.agentNarration || ''}
                onOpen={() => onSelectIssue(issue.id)}
                onToggleChat={() => onToggleChat(issue.id)}
                onSpawnTeam={onSpawnTeam ? () => onSpawnTeam(issue) : undefined}
              />
            ))
          )}
        </div>
      )}
    </section>
  )
}

function DetailPanel({
  issue,
  narration,
  onOpenLiveProject
}: {
  issue: IssueViewModel | null
  narration: string
  onOpenLiveProject: () => void
}): React.ReactNode {
  if (!issue) {
    return (
      <aside className="hidden w-[360px] shrink-0 border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]/80 p-5 lg:flex lg:flex-col lg:items-center lg:justify-center">
        <Inbox size={28} className="mb-3 text-[var(--pear-text-faint)]" />
        <div className="text-sm font-semibold text-[var(--pear-text)]">No issue selected</div>
        <div className="mt-1 text-center text-xs text-[var(--pear-text-faint)]">Open an overview card to inspect status detail.</div>
      </aside>
    )
  }

  return (
    <aside className="hidden w-[380px] shrink-0 overflow-y-auto border-l border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]/86 p-5 lg:block">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-[var(--pear-text-faint)]">{issue.identifier}</span>
            {issue.url && (
              <a
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]"
                title="Open in Linear"
              >
                Linear
                <ExternalLink size={10} />
              </a>
            )}
          </div>
          <h2 className="mt-1 text-lg font-semibold leading-6 text-[var(--pear-text)]">{issue.title}</h2>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${stageClass(issue.stage)}`}>
          {issue.stage}
        </span>
      </div>

      <div className="mt-5 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/45 p-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">
          <Bot size={13} />
          Live agent note
        </div>
        <p className="mt-2 text-sm leading-6 text-[var(--pear-text)]">{narration}</p>
        <button
          type="button"
          onClick={onOpenLiveProject}
          className="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] px-3 text-[12px] font-semibold text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]"
        >
          <ExternalLink size={13} />
          Open live project
        </button>
      </div>

      <div className="mt-5">
        <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">Status detail</div>
        <dl className="mt-2 grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-[var(--pear-text-faint)]">Owner</dt>
          <dd className="text-[var(--pear-text)]">{issue.assignedAgentName || issue.assigneeName || 'Unassigned'}</dd>
          <dt className="text-[var(--pear-text-faint)]">Actor</dt>
          <dd className="capitalize text-[var(--pear-text)]">{issue.actor}</dd>
          <dt className="text-[var(--pear-text-faint)]">Team</dt>
          <dd className="text-[var(--pear-text)]">{issue.teamName || 'Unknown'}</dd>
          <dt className="text-[var(--pear-text-faint)]">Updated</dt>
          <dd className="text-[var(--pear-text)]">{shortRelativeTime(issue.updatedAt)} ago</dd>
        </dl>
      </div>

      <div className="mt-5">
        <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">Description</div>
        <p className="mt-2 text-sm leading-6 text-[var(--pear-text-secondary)]">{issue.description || 'No description.'}</p>
      </div>

      <div className="mt-5">
        <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">GitHub</div>
        <div className="mt-2 space-y-2">
          {issue.githubLinks.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--pear-border-subtle)] px-3 py-3 text-xs text-[var(--pear-text-faint)]">
              No linked GitHub record.
            </div>
          ) : issue.githubLinks.map((link) => (
            <div key={`${link.owner}/${link.repo}#${link.number}`} className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/45 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--pear-text)]">
                <GitPullRequest size={14} className="text-[var(--pear-text-faint)]" />
                <span className="min-w-0 flex-1 truncate">{githubLabel(link)}</span>
              </div>
              <div className="mt-1 truncate text-xs text-[var(--pear-text-dim)]">{link.title || 'Linked record'}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {link.state && (
                  <span className="rounded-full bg-[var(--pear-bg-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--pear-text-faint)]">
                    {link.state}
                  </span>
                )}
                {link.checkSummary && (
                  <span className="rounded-full bg-[var(--pear-bg-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--pear-text-faint)]">
                    {link.checkSummary}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">Trajectory</div>
        <div className="mt-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/45 p-3 text-sm text-[var(--pear-text-secondary)]">
          {issue.trajectoryId ? (
            <div className="flex items-center gap-2">
              <GitFork size={14} className="text-[var(--pear-text-faint)]" />
              <span className="min-w-0 flex-1 truncate">{issue.trajectoryId}</span>
            </div>
          ) : 'No trajectory linked yet.'}
        </div>
      </div>
    </aside>
  )
}

function issuesByBand(issues: IssueViewModel[], band: IssueBand): IssueViewModel[] {
  return issues.filter((issue) => issue.band === band)
}

interface AttentionInboxProps {
  projectId?: string
  projectName?: string
}

export function AttentionInbox({
  projectId,
  projectName
}: AttentionInboxProps): React.ReactNode {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProjectName = useProjectStore((s) =>
    s.projects.find((project) => project.id === s.activeProjectId)?.name
  )
  const messages = useAgentStore((s) => s.messages)
  const issues = useIssuesStore((s) => s.issues)
  const loading = useIssuesStore((s) => s.loading)
  const error = useIssuesStore((s) => s.error)
  const lastLoadedAt = useIssuesStore((s) => s.lastLoadedAt)
  const load = useIssuesStore((s) => s.load)
  const subscribe = useIssuesStore((s) => s.subscribe)
  const [expandedBands, setExpandedBands] = useState<Record<IssueBand, boolean>>({
    'needs-you': true,
    'ready-for-agent': true,
    'in-motion': false,
    settled: false
  })
  const [expandedChatIds, setExpandedChatIds] = useState<Set<string>>(() => new Set())
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const selectedIssueId = useUIStore((s) => s.selectedIssueId)
  const setSelectedIssueId = useUIStore((s) => s.setSelectedIssueId)
  const [navNotice, setNavNotice] = useState<string | null>(null)
  const resolvedProjectId = projectId || (isWebMock ? 'mock-project' : activeProjectId)
  const resolvedProjectName = projectName || (isWebMock ? 'mock' : activeProjectName || 'project')

  useEffect(() => {
    if (!resolvedProjectId) return
    void load(resolvedProjectId)
    return subscribe(resolvedProjectId)
  }, [load, resolvedProjectId, subscribe])

  useEffect(() => {
    if (issues.length === 0) return
    if (selectedIssueId && issues.some((issue) => issue.id === selectedIssueId)) return
    setSelectedIssueId(issues.find((issue) => issue.band === 'needs-you')?.id || issues[0]?.id || null)
  }, [issues, selectedIssueId, setSelectedIssueId])

  useEffect(() => {
    if (!navNotice) return
    const timer = setTimeout(() => setNavNotice(null), 3200)
    return () => clearTimeout(timer)
  }, [navNotice])

  const narrations = useMemo(() => {
    return new Map(issues.map((issue) => [issue.id, liveNarration(issue, messages)]))
  }, [issues, messages])

  const availableStages = useMemo(
    () => orderStages(Array.from(new Set(issues.map((issue) => issue.stage)))),
    [issues]
  )
  const activeStatusFilter = statusFilter && availableStages.includes(statusFilter) ? statusFilter : null
  const visibleIssues = activeStatusFilter
    ? issues.filter((issue) => issue.stage === activeStatusFilter)
    : issues

  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId) || null
  const needsYou = issuesByBand(visibleIssues, 'needs-you')
  const readyForAgent = issuesByBand(visibleIssues, 'ready-for-agent')
  const inMotion = issuesByBand(visibleIssues, 'in-motion')
  const settled = issuesByBand(visibleIssues, 'settled')

  function toggleBand(band: IssueBand): void {
    setExpandedBands((current) => ({ ...current, [band]: !current[band] }))
  }

  function toggleChat(issueId: string): void {
    setExpandedChatIds((current) => {
      const next = new Set(current)
      if (next.has(issueId)) next.delete(issueId)
      else next.add(issueId)
      return next
    })
  }

  async function openLiveProject(issue: IssueViewModel): Promise<void> {
    const result = await jumpToIssueWork(issue)
    setNavNotice(result.message)
  }

  async function handleSpawnTeam(issue: IssueViewModel): Promise<void> {
    const project = resolvedProjectId ? useProjectStore.getState().projects.find((candidate) => candidate.id === resolvedProjectId) : undefined
    if (!project) {
      setNavNotice('Project not found for issue dispatch')
      return
    }
    try {
      const repo = detectRepo(issue.title, issue.description) ?? undefined
      const composition: TeamComposition = {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        issueDescription: issue.description,
        repo
      }
      const { implName, reviewName } = await spawnTeamForIssue(project, composition)
      setNavNotice(`Spawned ${implName} + ${reviewName}`)
    } catch {
      setNavNotice('Failed to spawn team')
    }
  }

  return (
    <div className="relative flex h-full min-h-0 bg-[var(--pear-bg)]/52">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--pear-border-subtle)] px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--pear-text-faint)]">
                <Inbox size={14} />
                Inbox · {resolvedProjectName}
              </div>
              <h1 className="mt-1 text-xl font-semibold leading-7 text-[var(--pear-text)]">Attention Inbox</h1>
            </div>
            <button
              type="button"
              onClick={() => resolvedProjectId && void load(resolvedProjectId, { force: true })}
              disabled={!resolvedProjectId}
              className="flex h-8 items-center gap-2 rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] px-3 text-[12px] font-semibold text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[var(--pear-text-faint)]">
            <span>{needsYou.length} need you</span>
            <span>·</span>
            <span>{readyForAgent.length} ready for agent</span>
            <span>·</span>
            <span>{inMotion.length} in motion</span>
            <span>·</span>
            <span>{settled.length} settled</span>
            {lastLoadedAt && (
              <>
                <span>·</span>
                <span>loaded {shortRelativeTime(new Date(lastLoadedAt).toISOString())} ago</span>
              </>
            )}
          </div>
          {availableStages.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">Status</span>
              <StatusFilterChip label="All" active={activeStatusFilter === null} onClick={() => setStatusFilter(null)} />
              {availableStages.map((stage) => (
                <StatusFilterChip
                  key={stage}
                  label={stage}
                  active={activeStatusFilter === stage}
                  onClick={() => setStatusFilter(activeStatusFilter === stage ? null : stage)}
                />
              ))}
            </div>
          )}
          {error && (
            <div className="mt-3 rounded-md border border-[var(--pear-red)]/30 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
              {error}
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          {loading && issues.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--pear-text-faint)]">Loading issues...</div>
          ) : (
            <>
              <BandSection
                band="needs-you"
                issues={needsYou}
                selectedIssueId={selectedIssueId}
                expanded={expandedBands['needs-you']}
                expandedChatIds={expandedChatIds}
                narrations={narrations}
                onToggleExpanded={() => toggleBand('needs-you')}
                onSelectIssue={setSelectedIssueId}
                onToggleChat={toggleChat}
              />
              <BandSection
                band="ready-for-agent"
                issues={readyForAgent}
                selectedIssueId={selectedIssueId}
                expanded={expandedBands['ready-for-agent']}
                expandedChatIds={expandedChatIds}
                narrations={narrations}
                onToggleExpanded={() => toggleBand('ready-for-agent')}
                onSelectIssue={setSelectedIssueId}
                onToggleChat={toggleChat}
                onSpawnTeam={handleSpawnTeam}
              />
              <BandSection
                band="in-motion"
                issues={inMotion}
                selectedIssueId={selectedIssueId}
                expanded={expandedBands['in-motion']}
                expandedChatIds={expandedChatIds}
                narrations={narrations}
                onToggleExpanded={() => toggleBand('in-motion')}
                onSelectIssue={setSelectedIssueId}
                onToggleChat={toggleChat}
              />
              <BandSection
                band="settled"
                issues={settled}
                selectedIssueId={selectedIssueId}
                expanded={expandedBands.settled}
                expandedChatIds={expandedChatIds}
                narrations={narrations}
                onToggleExpanded={() => toggleBand('settled')}
                onSelectIssue={setSelectedIssueId}
                onToggleChat={toggleChat}
              />
            </>
          )}
        </div>
      </main>

      <DetailPanel
        issue={selectedIssue}
        narration={selectedIssue ? narrations.get(selectedIssue.id) || selectedIssue.agentNarration || '' : ''}
        onOpenLiveProject={() => selectedIssue && void openLiveProject(selectedIssue)}
      />

      {navNotice && (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] px-3 py-2 text-sm text-[var(--pear-text)] shadow-xl">
          <Check size={14} className="text-[var(--pear-green)]" />
          <span>{navNotice}</span>
        </div>
      )}
    </div>
  )
}

export default AttentionInbox
