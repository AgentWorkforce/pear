import { create } from 'zustand'
import { pear, type FsDirEntry, type IntegrationsEvent } from '@/lib/ipc'

export type IssueBand = 'needs-you' | 'ready-for-agent' | 'in-motion' | 'settled'

export interface IssueGithubLink {
  owner: string
  repo: string
  number: number
  type: 'issue' | 'pull_request'
  title?: string
  url?: string
  state?: string
  checkSummary?: string
  checkConclusion?: string
}

export interface IssueViewModel {
  id: string
  identifier: string
  title: string
  description: string
  stage: string
  stageType?: string
  stateId?: string
  /** Canonical mount path of the issue file, used for writeback (state changes, comments). */
  issueRemotePath?: string
  actor: 'agent' | 'pairing' | 'human' | 'unknown'
  labels: string[]
  assigneeName?: string
  assignedAgentName?: string
  teamId?: string
  teamKey?: string
  teamName?: string
  projectName?: string
  priority?: number
  updatedAt?: string
  url?: string
  band: IssueBand
  attentionLabel?: string
  attentionAction?: string
  agentNarration?: string
  recentAgentMessages: string[]
  trajectoryId?: string
  githubLinks: IssueGithubLink[]
}

export interface IssueWorkflowState {
  id: string
  name: string
  type?: string
}

interface IssuesState {
  issues: IssueViewModel[]
  loading: boolean
  error: string | null
  loadedProjectId: string | null
  lastLoadedAt: number | null
  load: (projectId: string, options?: { force?: boolean }) => Promise<void>
  subscribe: (projectId: string) => () => void
  /**
   * Change an issue's Linear workflow state via writeback. Writes the target
   * `stateId` to the canonical issue file path and optimistically updates the
   * local view model; the resulting `relayfile-change` event reconciles it.
   */
  setIssueState: (projectId: string, issueId: string, state: IssueWorkflowState) => Promise<void>
}

const STAGE_ORDER = ['Backlog', 'Planning', 'To do', 'In Progress', 'In review', 'Merged', 'Done']
const BAND_ORDER: Record<IssueBand, number> = {
  'needs-you': 0,
  'ready-for-agent': 1,
  'in-motion': 2,
  settled: 3
}
const INTEGRATION_REFRESH_DEBOUNCE_MS = 250

let subscription: (() => void) | null = null
let subscriptionProjectId: string | null = null
let subscriptionGeneration = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const loadPromises = new Map<string, Promise<void>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseJsonPreview(content: string, path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown
    return isRecord(parsed) ? parsed : null
  } catch (error) {
    console.warn(`[issues] Failed to parse ${path}:`, error)
    return null
  }
}

function labelNames(issue: Record<string, unknown>): string[] {
  return readArray(issue.labels)
    .map((label) => readString(readRecord(label).name))
    .filter((label): label is string => !!label)
}

function payloadRecord(record: Record<string, unknown>): Record<string, unknown> {
  const payload = readRecord(record.payload)
  return Object.keys(payload).length > 0 ? payload : record
}

function actorFromLabels(labels: string[]): IssueViewModel['actor'] {
  const normalized = labels.map((label) => label.toLowerCase())
  if (normalized.includes('human')) return 'human'
  if (normalized.includes('pairing')) return 'pairing'
  if (normalized.includes('agent')) return 'agent'
  return 'unknown'
}

// Actor labels (agent/pairing/human) are authoritative when codified in Linear,
// but real boards usually lack them. Fall back to the signal Linear always has:
// an assigned issue is owned by a human; an unassigned one is unknown.
function resolveActor(labels: string[], hasAssignee: boolean): IssueViewModel['actor'] {
  const fromLabel = actorFromLabels(labels)
  if (fromLabel !== 'unknown') return fromLabel
  return hasAssignee ? 'human' : 'unknown'
}

function classifyIssue(
  stage: string,
  stageType: string | undefined,
  labels: string[],
  attention: Record<string, unknown>
): IssueBand {
  if (stage === 'Merged' || stage === 'Done' || stageType === 'completed' || stageType === 'canceled') {
    return 'settled'
  }

  const normalizedLabels = labels.map((label) => label.toLowerCase())

  if (
    stage.toLowerCase() === 'ready for agent' ||
    stage.toLowerCase() === 'ready-for-agent' ||
    normalizedLabels.includes('ready-for-agent') ||
    normalizedLabels.includes('ready for agent')
  ) {
    return 'ready-for-agent'
  }

  if (
    readString(attention.kind) ||
    normalizedLabels.includes('human') ||
    normalizedLabels.includes('agent question') ||
    normalizedLabels.includes('blocked') ||
    normalizedLabels.includes('review gate') ||
    stage.toLowerCase().includes('review')
  ) {
    return 'needs-you'
  }

  return 'in-motion'
}

function stageRank(issue: IssueViewModel): number {
  const index = STAGE_ORDER.indexOf(issue.stage)
  return index === -1 ? STAGE_ORDER.length : index
}

function sortIssues(issues: IssueViewModel[]): IssueViewModel[] {
  return [...issues].sort((left, right) => {
    if (left.band !== right.band) return BAND_ORDER[left.band] - BAND_ORDER[right.band]
    if (left.band === 'needs-you') {
      const priority = (left.priority ?? 99) - (right.priority ?? 99)
      if (priority !== 0) return priority
    }
    const stage = stageRank(left) - stageRank(right)
    if (stage !== 0) return stage
    return Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '')
  })
}

function githubPathForSyncedRecord(sync: Record<string, unknown>): string | null {
  if (readString(sync.service)?.toLowerCase() !== 'github') return null
  const metadata = readRecord(sync.metadata)
  const owner = readString(metadata.owner)
  const repo = readString(metadata.repo)
  const number = readNumber(metadata.number)
  if (!owner || !repo || typeof number !== 'number') return null
  return `/github/repos/${owner}/${repo}/issues/${number}.json`
}

async function readGithubLink(projectId: string, sync: Record<string, unknown>): Promise<IssueGithubLink | null> {
  const metadata = readRecord(sync.metadata)
  const owner = readString(metadata.owner)
  const repo = readString(metadata.repo)
  const number = readNumber(metadata.number)
  if (!owner || !repo || typeof number !== 'number') return null

  const fallbackType = readString(metadata.type) === 'pull_request' ? 'pull_request' : 'issue'
  const path = githubPathForSyncedRecord(sync)
  if (!path) return { owner, repo, number, type: fallbackType }

  // Best-effort enrichment: if the remote file can't be read we fall back to
  // the derived type below. null is also the "not text" path, so a read error
  // needs no separate handling here.
  const preview = await pear.integrations.readRemoteFile(projectId, path).catch(() => null)
  if (!preview || preview.kind !== 'text') return { owner, repo, number, type: fallbackType }
  const parsed = parseJsonPreview(preview.content, path)
  const record = parsed ? payloadRecord(parsed) : null
  if (!record) return { owner, repo, number, type: fallbackType }

  const checks = readRecord(record.checks)
  const isPullRequest = isRecord(record.pull_request) || fallbackType === 'pull_request'
  return {
    owner,
    repo,
    number,
    type: isPullRequest ? 'pull_request' : 'issue',
    title: readString(record.title),
    url: readString(record.html_url),
    state: readString(record.state),
    checkSummary: readString(checks.summary),
    checkConclusion: readString(checks.conclusion)
  }
}

async function normalizeIssue(
  projectId: string,
  raw: Record<string, unknown>,
  remotePath?: string
): Promise<IssueViewModel> {
  const issue = payloadRecord(raw)
  const state = readRecord(issue.state)
  const attention = readRecord(issue.attention)
  const assignee = readRecord(issue.assignee)
  const team = readRecord(issue.team)
  const project = readRecord(issue.project)
  const agentSession = readRecord(issue.agentSession)
  const labels = labelNames(issue)
  const stage = readString(state.name) || readString(issue.state_name) || 'Backlog'
  const assigneeName = readString(assignee.name) || readString(issue.assignee_name)
  const assignedAgentName = readString(agentSession.agentName) || assigneeName
  const recentAgentMessages = readArray(agentSession.recentMessages)
    .map(readString)
    .filter((message): message is string => !!message)
  const githubLinks = (await Promise.all(
    readArray(issue.syncedWith).map((sync) => readGithubLink(projectId, readRecord(sync)))
  )).filter((link): link is IssueGithubLink => !!link)

  return {
    id: readString(issue.id) || readString(raw.objectId) || readString(issue.identifier) || crypto.randomUUID(),
    identifier: readString(issue.identifier) || 'ISSUE',
    title: readString(issue.title) || 'Untitled issue',
    description: readString(issue.description) || '',
    stage,
    stageType: readString(state.type),
    stateId: readString(state.id) || readString(issue.stateId) || readString(issue.state_id),
    issueRemotePath: remotePath,
    actor: resolveActor(labels, !!assigneeName),
    labels,
    assigneeName,
    assignedAgentName,
    teamId: readString(team.id) || readString(issue.teamId) || readString(issue.team_id),
    teamKey: readString(team.key),
    teamName: readString(team.name) || readString(team.key),
    projectName: readString(project.name),
    priority: readNumber(issue.priority),
    updatedAt:
      readString(issue.updatedAt) ||
      readString(issue.updated_at) ||
      readString(issue.createdAt) ||
      readString(issue.created_at),
    url: readString(issue.url),
    band: classifyIssue(stage, readString(state.type), labels, attention),
    attentionLabel: readString(attention.label),
    attentionAction: readString(attention.action),
    agentNarration: readString(agentSession.latestMessage),
    recentAgentMessages,
    trajectoryId: readString(agentSession.trajectoryId),
    githubLinks
  }
}

/**
 * Build the writeback payload for an issue state change. Written to the
 * canonical issue file path; the Linear adapter interprets `stateId` as a
 * workflow-state transition. Only identity + the changed state are included —
 * read-only fields (url, timestamps, actor) are deliberately omitted so the
 * adapter derives them, mirroring the comment-writeback contract.
 */
function buildStateWritebackPayload(issue: IssueViewModel, state: IssueWorkflowState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: issue.id,
    identifier: issue.identifier,
    stateId: state.id,
    state: state.type ? { id: state.id, name: state.name, type: state.type } : { id: state.id, name: state.name }
  }
  if (issue.teamId) payload.teamId = issue.teamId
  if (issue.teamId || issue.teamKey || issue.teamName) {
    const team: Record<string, string> = {}
    if (issue.teamId) team.id = issue.teamId
    if (issue.teamKey) team.key = issue.teamKey
    if (issue.teamName) team.name = issue.teamName
    payload.team = team
  }
  return payload
}

function isIssueFile(entry: FsDirEntry): boolean {
  return entry.type === 'file' && entry.path.endsWith('.json') && !entry.path.endsWith('/_index.json')
}

function shouldRefreshForIntegrationEvent(event: IntegrationsEvent): boolean {
  if (event.type === 'integration-added' || event.type === 'integration-removed' || event.type === 'integration-error') {
    return true
  }

  const record = event as unknown as Record<string, unknown>
  if (record.type !== 'relayfile-change') return false
  const path = readString(record.path) || readString(record.remotePath)
  return !!path && (path.startsWith('/linear/') || path.startsWith('/github/'))
}

function scheduleRefresh(projectId: string, generation: number, load: IssuesState['load']): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    if (subscriptionGeneration !== generation || subscriptionProjectId !== projectId) return
    void load(projectId, { force: true })
  }, INTEGRATION_REFRESH_DEBOUNCE_MS)
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: [],
  loading: false,
  error: null,
  loadedProjectId: null,
  lastLoadedAt: null,

  load: async (projectId, options = {}) => {
    const key = `${projectId}:${options.force === true ? 'force' : 'normal'}`
    const existing = loadPromises.get(key)
    if (existing) return existing

    const promise = (async () => {
      set({ loading: true, error: null })
      try {
        const entries = await pear.integrations.listRemoteDir(projectId, '/linear/issues')
        const records = await Promise.all(
          entries.filter(isIssueFile).map(async (entry) => {
            const preview = await pear.integrations.readRemoteFile(projectId, entry.path)
            const record = preview.kind === 'text' ? parseJsonPreview(preview.content, entry.path) : null
            return record ? { path: entry.path, record } : null
          })
        )
        const issues = await Promise.all(
          records
            .filter((entry): entry is { path: string; record: Record<string, unknown> } => !!entry)
            .map(({ path, record }) => normalizeIssue(projectId, record, path))
        )

        set({
          issues: sortIssues(issues),
          loading: false,
          error: null,
          loadedProjectId: projectId,
          lastLoadedAt: Date.now()
        })
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          loadedProjectId: projectId
        })
      }
    })().finally(() => {
      loadPromises.delete(key)
    })

    loadPromises.set(key, promise)
    return promise
  },

  subscribe: (projectId) => {
    subscription?.()
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }

    subscriptionProjectId = projectId
    const generation = ++subscriptionGeneration
    subscription = pear.integrations.onEvent((event) => {
      if (subscriptionGeneration !== generation || subscriptionProjectId !== projectId) return
      if (!shouldRefreshForIntegrationEvent(event)) return
      scheduleRefresh(projectId, generation, get().load)
    })

    return () => {
      if (subscriptionGeneration !== generation) return
      subscription?.()
      subscription = null
      subscriptionProjectId = null
      subscriptionGeneration += 1
      if (refreshTimer) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
    }
  },

  setIssueState: async (projectId, issueId, state) => {
    const issue = get().issues.find((candidate) => candidate.id === issueId)
    if (!issue) throw new Error(`Issue ${issueId} not found`)
    if (!issue.issueRemotePath) throw new Error('Issue is missing its mount path; cannot change status')
    if (!state.id) throw new Error('Target workflow state id is required')
    if (state.id === issue.stateId) return

    const payload = buildStateWritebackPayload(issue, state)
    await pear.integrations.writeRemoteFile(projectId, issue.issueRemotePath, JSON.stringify(payload, null, 2))

    // Optimistic update; the resulting relayfile-change event reconciles via load().
    set((current) => ({
      issues: sortIssues(
        current.issues.map((candidate) =>
          candidate.id === issueId
            ? {
                ...candidate,
                stage: state.name,
                stageType: state.type ?? candidate.stageType,
                stateId: state.id,
                band: classifyIssue(state.name, state.type, candidate.labels, {})
              }
            : candidate
        )
      )
    }))
  }
}))

export function agentForIssue(issueId: string): string | undefined {
  const issue = useIssuesStore.getState().issues.find((candidate) => candidate.id === issueId)
  return issue?.assignedAgentName || issue?.assigneeName
}

export function issueForAgent(agentName: string): IssueViewModel | undefined {
  const normalized = agentName.trim().toLowerCase()
  if (!normalized) return undefined
  return useIssuesStore.getState().issues.find((issue) =>
    issue.assignedAgentName?.toLowerCase() === normalized ||
    issue.assigneeName?.toLowerCase() === normalized
  )
}
