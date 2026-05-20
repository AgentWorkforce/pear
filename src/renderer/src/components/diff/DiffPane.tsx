import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CheckSquare2,
  FileDiff,
  Filter,
  GitBranch,
  GitCommitHorizontal,
  GripHorizontal,
  GripVertical,
  Lock,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Square,
  UserPlus,
  WandSparkles,
  X
} from 'lucide-react'
import { buildSelectedPatch, getFilePathFromLineSelectionId } from '@/lib/diff-selection'
import { pear, type GitBranchInfo, type GitBranchSyncStatus, type GitHistoryCommit } from '@/lib/ipc'
import { useProjectStore, type Project } from '@/stores/project-store'
import { useGitStore } from '@/stores/git-store'
import { useUIStore } from '@/stores/ui-store'
import {
  FileChangeStatusIcon,
  FilePathLabel,
  fileChangeKindFromStatus,
  fileChangeStatusLabel
} from './FileChangeLabel'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { DiffViewer } from './DiffViewer'
import { useAgentStore, type Agent } from '@/stores/agent-store'

type PaneTab = 'changes' | 'history'
type AuthUser = { name?: string; email?: string; organizationName?: string; projectName?: string }
type CoAuthor = { username: string; name?: string; cli?: string }

const LEFT_SIDEBAR_MIN_WIDTH = 300
const LEFT_SIDEBAR_MAX_WIDTH = 640
const HISTORY_FILES_MIN_WIDTH = 240
const HISTORY_FILES_MAX_WIDTH = 620
const HISTORY_DETAILS_MIN_HEIGHT = 88
const HISTORY_DETAILS_MAX_HEIGHT = 280
const SOURCE_HEADER_HEIGHT = 54

function projectRootPath(project: Project): string {
  return project.roots.find((root) => root.pathExists)?.path || project.roots[0]?.path || project.rootPath
}

function pathTail(path: string, depth = 1): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-depth).join('/') || path
}

function projectGroupLabel(project: Project): string {
  const rootPath = projectRootPath(project)
  const parts = rootPath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : 'Projects'
}

function groupProjects(projects: Project[]): Array<{ label: string; projects: Project[] }> {
  const grouped = new Map<string, Project[]>()
  for (const project of projects) {
    const label = projectGroupLabel(project)
    grouped.set(label, [...(grouped.get(label) || []), project])
  }
  return Array.from(grouped, ([label, groupedProjects]) => ({ label, projects: groupedProjects }))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function startPanelResize(
  event: React.PointerEvent,
  options: {
    axis: 'x' | 'y'
    startValue: number
    min: number
    max: number
    onResize: (value: number) => void
  }
): void {
  event.preventDefault()
  event.stopPropagation()

  const startPosition = options.axis === 'x' ? event.clientX : event.clientY
  const previousCursor = document.body.style.cursor
  const previousUserSelect = document.body.style.userSelect

  document.body.style.cursor = options.axis === 'x' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'

  function handlePointerMove(moveEvent: PointerEvent): void {
    const position = options.axis === 'x' ? moveEvent.clientX : moveEvent.clientY
    options.onResize(clamp(options.startValue + position - startPosition, options.min, options.max))
  }

  function handlePointerUp(): void {
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
    document.removeEventListener('pointermove', handlePointerMove)
    document.removeEventListener('pointerup', handlePointerUp)
  }

  document.addEventListener('pointermove', handlePointerMove)
  document.addEventListener('pointerup', handlePointerUp, { once: true })
}

function formatRelativeDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diffMs = Date.now() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diffMs < minute) return 'just now'
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`
  if (diffMs < 14 * day) return `${Math.floor(diffMs / day)}d ago`
  return date.toLocaleDateString()
}

function authorInitial(author: string): string {
  return author.trim().charAt(0).toUpperCase() || '?'
}

function userInitials(user: AuthUser | null): string {
  if (user?.name?.trim()) {
    return user.name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase()
  }
  return user?.email?.trim().charAt(0).toUpperCase() || '?'
}

function normalizeCoAuthorUsername(value: string): string {
  return value
    .trim()
    .replace(/^@+/, '')
    .replace(/[^\w.-]/g, '')
}

function coAuthorKey(username: string): string {
  return normalizeCoAuthorUsername(username).toLowerCase()
}

function normalizeCoAuthor(coAuthor: CoAuthor | string): CoAuthor | null {
  const nextCoAuthor = typeof coAuthor === 'string'
    ? { username: normalizeCoAuthorUsername(coAuthor) }
    : { ...coAuthor, username: normalizeCoAuthorUsername(coAuthor.username) }

  return nextCoAuthor.username ? nextCoAuthor : null
}

function mergeCoAuthors(coAuthors: CoAuthor[], coAuthor: CoAuthor | string): CoAuthor[] {
  const nextCoAuthor = normalizeCoAuthor(coAuthor)
  if (!nextCoAuthor) return coAuthors

  const nextKey = coAuthorKey(nextCoAuthor.username)
  if (coAuthors.some((existing) => coAuthorKey(existing.username) === nextKey)) {
    return coAuthors
  }

  return [...coAuthors, nextCoAuthor]
}

function formatCoAuthorTrailer(coAuthor: CoAuthor): string {
  const username = normalizeCoAuthorUsername(coAuthor.username)
  return `Co-authored-by: ${username} <${username.toLowerCase()}@users.noreply.github.com>`
}

function appendCoAuthorTrailers(body: string, coAuthors: CoAuthor[]): string {
  const trailers = coAuthors.map(formatCoAuthorTrailer)
  const trimmedBody = body.trimEnd()

  if (trailers.length === 0) return trimmedBody
  return `${trimmedBody}${trimmedBody ? '\n\n' : ''}${trailers.join('\n')}`
}

function coAuthorSearchScore(username: string, query: string): number {
  if (!query) return 0

  const lowerUsername = username.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (lowerUsername.startsWith(lowerQuery)) return 0

  const includesIndex = lowerUsername.indexOf(lowerQuery)
  return includesIndex === -1 ? Number.POSITIVE_INFINITY : includesIndex + 10
}

function agentToCoAuthor(agent: Agent): CoAuthor | null {
  const username = normalizeCoAuthorUsername(agent.name)
  if (!username) return null
  return {
    username,
    name: agent.model || agent.cli,
    cli: agent.cli
  }
}

function bodyPreview(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join('\n')
}

function selectedChangeFiles(selectedFiles: Set<string>, selectedLineIds: Set<string>): string[] {
  const partialFiles = Array.from(selectedLineIds).map(getFilePathFromLineSelectionId)
  return Array.from(new Set([...selectedFiles, ...partialFiles])).filter(Boolean)
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function nextFilePath(paths: string[], currentPath: string | null, direction: 1 | -1): string | null {
  if (paths.length === 0) return null

  const currentIndex = currentPath ? paths.indexOf(currentPath) : -1
  if (currentIndex === -1) {
    return direction === 1 ? paths[0] : paths[paths.length - 1]
  }

  const nextIndex = clamp(currentIndex + direction, 0, paths.length - 1)
  return paths[nextIndex] || null
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function shouldPublishBranch(status: GitBranchSyncStatus | null, lastFetchedAt: number | null): boolean {
  return !!status?.hasRemote && !status.upstream && !!lastFetchedAt
}

function syncActionLabel(status: GitBranchSyncStatus | null, loading: boolean, lastFetchedAt: number | null): string {
  if (loading) return 'Syncing...'
  if (!status?.hasRemote) return 'No remote'
  if (status.ahead > 0 && status.behind > 0) return 'Diverged'
  if (shouldPublishBranch(status, lastFetchedAt)) return 'Push branch'
  if (status.behind > 0) return `Pull ${pluralize(status.behind, 'commit')}`
  if (status.ahead > 0) return `Push ${pluralize(status.ahead, 'commit')}`
  return `Fetch ${status.remote || 'origin'}`
}

function syncStatusText(
  status: GitBranchSyncStatus | null,
  lastFetchedAt: number | null,
  error: string | null
): string {
  if (error) return error
  if (!status?.hasRemote) return 'No origin remote configured'
  if (status.ahead > 0 && status.behind > 0) {
    return `${pluralize(status.behind, 'incoming commit')} / ${pluralize(status.ahead, 'local commit')}`
  }
  if (shouldPublishBranch(status, lastFetchedAt)) return 'Publish current branch to remote'
  if (status.behind > 0) return `${pluralize(status.behind, 'incoming commit')} available`
  if (status.ahead > 0) return `${pluralize(status.ahead, 'local commit')} ready to push`
  if (lastFetchedAt) return `Last fetched ${formatRelativeDate(new Date(lastFetchedAt).toISOString())}`
  return 'Check remote status'
}

function CommitAvatar({ author }: { author: string }): React.ReactNode {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--pear-bg-overlay)] text-[10px] font-semibold text-[var(--pear-text)]">
      {authorInitial(author)}
    </span>
  )
}

function CommitAuthorAvatar({ user }: { user: AuthUser | null }): React.ReactNode {
  const label = user?.name || user?.email || 'Commit author'

  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--pear-accent)] text-[9px] font-semibold text-[var(--pear-bg)]"
      title={label}
      aria-label={label}
    >
      {userInitials(user)}
    </span>
  )
}

function CoAuthorPicker({
  coAuthors,
  inputRef,
  inputValue,
  suggestions,
  selectedSuggestionIndex,
  showSuggestions,
  onInputChange,
  onInputKeyDown,
  onSelectSuggestion,
  onRemoveCoAuthor
}: {
  coAuthors: CoAuthor[]
  inputRef: React.Ref<HTMLInputElement>
  inputValue: string
  suggestions: CoAuthor[]
  selectedSuggestionIndex: number
  showSuggestions: boolean
  onInputChange: (value: string) => void
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onSelectSuggestion: (coAuthor: CoAuthor) => void
  onRemoveCoAuthor: (username: string) => void
}): React.ReactNode {
  return (
    <div className="flex min-h-12 items-center gap-2 border-t border-[var(--pear-border-subtle)] px-3 py-2">
      <span className="shrink-0 text-[16px] font-medium text-[var(--pear-text-secondary)]">Co-Authors</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {coAuthors.map((coAuthor) => (
          <span
            key={coAuthorKey(coAuthor.username)}
            className="flex h-8 max-w-[180px] items-center gap-1 rounded-md border border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] px-2 text-[16px] font-semibold text-[var(--pear-text)]"
          >
            <span className="min-w-0 truncate">@{coAuthor.username}</span>
            <button
              type="button"
              onClick={() => onRemoveCoAuthor(coAuthor.username)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
              aria-label={`Remove @${coAuthor.username}`}
              title={`Remove @${coAuthor.username}`}
            >
              <X size={16} />
            </button>
          </span>
        ))}
        <div className="relative min-w-[132px] flex-1">
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="@username"
            className="h-8 w-full min-w-[132px] border-0 bg-transparent text-[16px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
            aria-label="Co-author username"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
          {showSuggestions && (
            <div className="absolute left-0 top-full z-50 mt-1 max-h-56 min-w-[320px] overflow-hidden rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] shadow-2xl">
              {suggestions.map((suggestion, index) => {
                const active = index === selectedSuggestionIndex
                return (
                  <button
                    key={coAuthorKey(suggestion.username)}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelectSuggestion(suggestion)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-[15px] ${
                      active
                        ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                        : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                    }`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]">
                      <AgentHarnessIcon cli={suggestion.cli} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="truncate font-semibold text-[var(--pear-text)]">{suggestion.username}</span>
                      {suggestion.name && (
                        <span className="ml-2 truncate text-[var(--pear-text-dim)]">{suggestion.name}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function HistoryCommit({
  commit,
  active,
  onSelect
}: {
  commit: GitHistoryCommit
  active: boolean
  onSelect: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-b border-[var(--pear-border-subtle)] px-3 py-3 text-left transition-colors ${
        active
          ? 'bg-[var(--pear-accent-dim)] text-white'
          : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)]'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{commit.subject}</span>
        {active && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[var(--pear-accent-dim)]">
            <ArrowUp size={14} strokeWidth={2.6} />
          </span>
        )}
      </div>
      <div className={`mt-1.5 flex items-center gap-2 text-xs ${active ? 'text-white/80' : 'text-[var(--pear-text-faint)]'}`}>
        <CommitAvatar author={commit.author} />
        <span className="truncate">{commit.author}</span>
        <span className="shrink-0">•</span>
        <span className="shrink-0">{formatRelativeDate(commit.date)}</span>
      </div>
    </button>
  )
}

function HistoryCommitDetails({ commit }: { commit: GitHistoryCommit }): React.ReactNode {
  const preview = bodyPreview(commit.body)

  return (
    <div className="flex h-full flex-col px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-[var(--pear-text)]">{commit.subject}</h2>
          {preview && (
            <pre className="mt-2 max-h-20 overflow-hidden whitespace-pre-wrap font-mono text-[13px] leading-5 text-[var(--pear-text-secondary)]">
              {preview}
            </pre>
          )}
        </div>
      </div>
      <div className="mt-auto flex min-w-0 items-center gap-3 pt-3 text-xs text-[var(--pear-text-dim)]">
        <CommitAvatar author={commit.author} />
        <span className="truncate">{commit.author}</span>
        <GitCommitHorizontal size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
        <span className="shrink-0 font-mono">{commit.shortHash}</span>
        <span className="min-w-0 truncate">{formatRelativeDate(commit.date)}</span>
        <span className="ml-auto shrink-0 text-[var(--pear-green)]">+{commit.additions}</span>
        <span className="shrink-0 text-[var(--pear-red)]">-{commit.deletions}</span>
      </div>
    </div>
  )
}

function CurrentProjectSelector({ width }: { width: number }): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const openTab = useUIStore((s) => s.openTab)
  const openDialog = useUIStore((s) => s.openDialog)
  const activeProject = projects.find((project) => project.id === activeProjectId) || projects[0]
  const canSwitchProjects = projects.length > 1
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return projects
    return projects.filter((project) => {
      const rootPath = projectRootPath(project)
      return [
        project.name,
        projectGroupLabel(project),
        pathTail(rootPath, 2),
        rootPath
      ].some((value) => value.toLowerCase().includes(normalizedQuery))
    })
  }, [projects, query])
  const groups = useMemo(() => groupProjects(filteredProjects), [filteredProjects])

  useEffect(() => {
    if (!canSwitchProjects) {
      setOpen(false)
      setQuery('')
    }
  }, [canSwitchProjects])

  function selectProject(project: Project): void {
    setOpen(false)
    setQuery('')
    openTab({ kind: 'source-control', projectId: project.id })
    setActiveProject(project.id).catch((error) => {
      console.error('[source-control] Failed to set active project:', error)
    })
  }

  function openAddProject(): void {
    setOpen(false)
    setQuery('')
    openDialog('add-project')
  }

  const headerContent = (
    <>
      <Lock size={14} className="shrink-0 text-[var(--pear-text-secondary)]" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[11px] font-medium leading-[14px] text-[var(--pear-text-faint)]">
          Current Project
        </span>
        <span className="block truncate text-[13px] font-semibold leading-4 text-[var(--pear-text)]">
          {activeProject?.name || 'No project'}
        </span>
      </span>
      {canSwitchProjects && (
        open
          ? <ChevronUp size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
          : <ChevronDown size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
      )}
    </>
  )

  return (
    <div
      className="relative h-full shrink-0 border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
      style={{ width }}
    >
      {canSwitchProjects ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-full w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--pear-bg-surface-hover)]"
          aria-expanded={open}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex h-full w-full items-center gap-2.5 px-3">
          {headerContent}
        </div>
      )}

      {canSwitchProjects && open && (
        <div className="absolute left-0 top-full z-50 w-full border-b border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] pb-2 shadow-xl">
          <div className="flex items-center gap-2 px-2 py-2">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--pear-accent-dim)] bg-[var(--pear-bg)] px-2.5 text-[12px] text-[var(--pear-text-secondary)] ring-1 ring-[var(--pear-accent-dim)]">
              <Search size={12} className="shrink-0 text-[var(--pear-text-faint)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter projects"
                className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                  aria-label="Clear project filter"
                >
                  <X size={12} />
                </button>
              )}
            </label>
            <button
              type="button"
              onClick={openAddProject}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--pear-border)] px-2.5 text-[12px] font-semibold text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]"
            >
              <Plus size={12} />
              Add
            </button>
          </div>

          <div className="max-h-[280px] overflow-y-auto">
            {groups.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No projects match</div>
            ) : (
              groups.map((group) => (
                <div key={group.label} className="pt-1.5 first:pt-0">
                  <div className="px-3.5 pb-1 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                    {group.label}
                  </div>
                  {group.projects.map((project) => {
                    const active = project.id === activeProjectId
                    return (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => selectProject(project)}
                        className={`flex h-8 w-full items-center gap-2.5 px-3.5 text-left text-[13px] font-semibold ${
                          active
                            ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                            : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                        }`}
                      >
                        <Lock size={13} className="shrink-0 text-[var(--pear-text-secondary)]" />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pear-accent)]" />}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

type BranchSwitchMode = 'stash' | 'carry'

function branchDisplayName(branch: GitBranchInfo): string {
  return branch.remote ? branch.name.replace(/^[^/]+\//, '') : branch.name
}

function CurrentBranchSelector({
  rootPath,
  currentBranch,
  loading,
  onBranchChanged
}: {
  rootPath: string
  currentBranch: string
  loading: boolean
  onBranchChanged: (status: GitBranchSyncStatus) => Promise<void>
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [switchingBranch, setSwitchingBranch] = useState(false)
  const [pendingBranch, setPendingBranch] = useState<GitBranchInfo | null>(null)
  const [switchMode, setSwitchMode] = useState<BranchSwitchMode>('stash')
  const [error, setError] = useState<string | null>(null)

  const filteredBranches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return branches
    return branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery))
  }, [branches, query])
  const defaultBranches = filteredBranches.filter((branch) => branch.defaultBranch && !branch.remote)
  const otherBranches = filteredBranches.filter((branch) => !branch.defaultBranch || branch.remote)

  async function loadBranches(): Promise<void> {
    setBranchesLoading(true)
    setError(null)
    try {
      const details = await pear.git.branchDetails(rootPath)
      setBranches(details)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load branches')
      setBranches([])
    } finally {
      setBranchesLoading(false)
    }
  }

  useEffect(() => {
    setOpen(false)
    setQuery('')
    setBranches([])
    setPendingBranch(null)
    setSwitchMode('stash')
  }, [rootPath])

  useEffect(() => {
    if (open) void loadBranches()
  }, [open])

  async function switchBranch(branch: GitBranchInfo, stashChanges: boolean): Promise<void> {
    setError(null)
    setSwitchingBranch(true)
    try {
      const status = await pear.git.checkoutBranch(rootPath, branch.name, { stashChanges })
      setOpen(false)
      setQuery('')
      setPendingBranch(null)
      setSwitchMode('stash')
      await onBranchChanged(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to switch branches')
    } finally {
      setSwitchingBranch(false)
    }
  }

  async function selectBranch(branch: GitBranchInfo): Promise<void> {
    if (branch.current) return
    setError(null)

    try {
      const localChanges = await pear.git.status(rootPath)
      if (localChanges.length > 0) {
        setPendingBranch(branch)
        setSwitchMode('stash')
        return
      }
      await switchBranch(branch, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to switch branches')
    }
  }

  async function confirmPendingBranchSwitch(): Promise<void> {
    if (!pendingBranch) return
    await switchBranch(pendingBranch, switchMode === 'stash')
  }

  function renderBranch(branch: GitBranchInfo): React.ReactNode {
    return (
      <button
        key={branch.name}
        type="button"
        onClick={() => void selectBranch(branch)}
        disabled={switchingBranch}
        className={`flex h-8 w-full items-center gap-2.5 px-3.5 text-left text-[13px] font-semibold ${
          branch.current
            ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
            : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-60'
        }`}
      >
        {branch.current ? (
          <Check size={13} className="shrink-0 text-[var(--pear-text)]" />
        ) : (
          <GitBranch size={13} className="shrink-0 text-[var(--pear-text-secondary)]" />
        )}
        <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        {branch.lastCommitDate && (
          <span className="shrink-0 text-[11px] font-medium text-[var(--pear-text-faint)]">
            {formatRelativeDate(branch.lastCommitDate)}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="relative h-full w-[360px] shrink-0 border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-full w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--pear-bg-surface-hover)]"
        aria-expanded={open}
      >
        <GitBranch size={14} className="shrink-0 text-[var(--pear-text-secondary)]" />
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-[11px] font-medium leading-[14px] text-[var(--pear-text-faint)]">
            Current Branch
          </span>
          <span className="block truncate text-[13px] font-semibold leading-4 text-[var(--pear-text)]">
            {loading ? 'Loading...' : currentBranch}
          </span>
        </span>
        {open
          ? <ChevronUp size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
          : <ChevronDown size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 w-[460px] border-b border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] pb-2 shadow-xl">
          <div className="grid h-8 grid-cols-2 border-b border-[var(--pear-border-subtle)]">
            <div className="flex items-center justify-center border-b-2 border-[var(--pear-accent)] text-[13px] font-semibold text-[var(--pear-text)]">
              Branches
            </div>
            <div className="flex items-center justify-center border-b-2 border-transparent text-[13px] font-semibold text-[var(--pear-text-faint)]">
              Pull Requests
              <span className="ml-1.5 rounded-full bg-[var(--pear-bg-overlay)] px-1.5 text-[10px] text-[var(--pear-text-secondary)]">
                0
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 px-2 py-2">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--pear-accent-dim)] bg-[var(--pear-bg)] px-2.5 text-[12px] text-[var(--pear-text-secondary)] ring-1 ring-[var(--pear-accent-dim)]">
              <Search size={12} className="shrink-0 text-[var(--pear-text-faint)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter"
                className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                  aria-label="Clear branch filter"
                >
                  <X size={12} />
                </button>
              )}
            </label>
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {branchesLoading ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">Loading branches...</div>
            ) : error ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-red)]">{error}</div>
            ) : filteredBranches.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No branches match</div>
            ) : (
              <>
                {defaultBranches.length > 0 && (
                  <div className="pb-1.5">
                    <div className="px-3.5 pb-1 pt-2 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                      Default Branch
                    </div>
                    {defaultBranches.map(renderBranch)}
                  </div>
                )}
                <div>
                  <div className="px-3.5 pb-1 pt-2 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                    Other Branches
                  </div>
                  {otherBranches.map(renderBranch)}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {pendingBranch && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4"
          onClick={() => {
            if (!switchingBranch) setPendingBranch(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-branch-title"
            className="w-full max-w-[640px] overflow-hidden rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex h-16 items-center justify-between border-b border-[var(--pear-border-subtle)] px-6">
              <h2 id="switch-branch-title" className="text-xl font-semibold text-[var(--pear-text)]">
                Switch Branch
              </h2>
              <button
                type="button"
                onClick={() => setPendingBranch(null)}
                disabled={switchingBranch}
                className="rounded-md p-1.5 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-50"
                aria-label="Close switch branch dialog"
              >
                <X size={22} />
              </button>
            </div>

            <div className="border-b border-[var(--pear-border-subtle)] px-6 py-8">
              <p className="mb-5 text-lg font-medium text-[var(--pear-text)]">
                You have changes on this branch. What would you like to do with them?
              </p>
              <div className="overflow-hidden rounded-lg border border-[var(--pear-border-subtle)]">
                <button
                  type="button"
                  onClick={() => setSwitchMode('stash')}
                  className={`flex w-full gap-4 px-5 py-4 text-left ${
                    switchMode === 'stash' ? 'bg-[var(--pear-bg-overlay)]' : 'bg-[var(--pear-bg-raised)] hover:bg-[var(--pear-bg-surface-hover)]'
                  }`}
                >
                  <span className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    switchMode === 'stash' ? 'border-[var(--pear-accent)]' : 'border-[var(--pear-text-faint)]'
                  }`}>
                    {switchMode === 'stash' && <span className="h-2.5 w-2.5 rounded-full bg-[var(--pear-accent)]" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[17px] font-semibold text-[var(--pear-text)]">
                      Leave my changes on {currentBranch}
                    </span>
                    <span className="mt-1 block text-[15px] leading-6 text-[var(--pear-text-secondary)]">
                      Your in-progress work will be stashed on this branch for you to return to later
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSwitchMode('carry')}
                  className={`flex w-full gap-4 border-t border-[var(--pear-border-subtle)] px-5 py-4 text-left ${
                    switchMode === 'carry' ? 'bg-[var(--pear-bg-overlay)]' : 'bg-[var(--pear-bg-raised)] hover:bg-[var(--pear-bg-surface-hover)]'
                  }`}
                >
                  <span className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    switchMode === 'carry' ? 'border-[var(--pear-accent)]' : 'border-[var(--pear-text-faint)]'
                  }`}>
                    {switchMode === 'carry' && <span className="h-2.5 w-2.5 rounded-full bg-[var(--pear-accent)]" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[17px] font-semibold text-[var(--pear-text)]">
                      Bring my changes to {branchDisplayName(pendingBranch)}
                    </span>
                    <span className="mt-1 block text-[15px] leading-6 text-[var(--pear-text-secondary)]">
                      Your in-progress work will follow you to the new branch
                    </span>
                  </span>
                </button>
              </div>
              {error && (
                <div className="mt-4 rounded-md border border-[var(--pear-red)]/30 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
                  {error}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 px-6 py-5">
              <button
                type="button"
                onClick={() => setPendingBranch(null)}
                disabled={switchingBranch}
                className="h-10 min-w-[150px] rounded-md border border-[var(--pear-border)] px-4 text-[15px] font-semibold text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPendingBranchSwitch()}
                disabled={switchingBranch}
                className="flex h-10 min-w-[170px] items-center justify-center gap-2 rounded-md bg-[var(--pear-accent)] px-4 text-[15px] font-semibold text-[var(--pear-bg)] hover:bg-[var(--pear-accent-bright)] disabled:opacity-60"
              >
                {switchingBranch && <Loader2 size={15} className="animate-spin" />}
                Switch Branch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FetchOriginButton({
  status,
  loading,
  lastFetchedAt,
  error,
  onClick
}: {
  status: GitBranchSyncStatus | null
  loading: boolean
  lastFetchedAt: number | null
  error: string | null
  onClick: () => void
}): React.ReactNode {
  const disabled = loading || status?.hasRemote === false || (!!status && status.ahead > 0 && status.behind > 0)

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-full w-[420px] shrink-0 items-center gap-2.5 border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-left hover:bg-[var(--pear-bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-70"
    >
      <RefreshCw size={14} className={`shrink-0 text-[var(--pear-text-secondary)] ${loading ? 'animate-spin' : ''}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold leading-4 text-[var(--pear-text)]">
          {syncActionLabel(status, loading, lastFetchedAt)}
        </span>
        <span className={`block truncate text-[11px] font-medium leading-[14px] ${error ? 'text-[var(--pear-red)]' : 'text-[var(--pear-text-faint)]'}`}>
          {syncStatusText(status, lastFetchedAt, error)}
        </span>
      </span>
    </button>
  )
}

export function DiffPane(): React.ReactNode {
  const [activeTab, setActiveTab] = useState<PaneTab>('changes')
  const [filter, setFilter] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [coAuthorPanelOpen, setCoAuthorPanelOpen] = useState(false)
  const [coAuthorInput, setCoAuthorInput] = useState('')
  const [coAuthors, setCoAuthors] = useState<CoAuthor[]>([])
  const [selectedCoAuthorSuggestionIndex, setSelectedCoAuthorSuggestionIndex] = useState(0)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set())
  const [selectionInitialized, setSelectionInitialized] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(420)
  const [historyFilesWidth, setHistoryFilesWidth] = useState(360)
  const [historyDetailsHeight, setHistoryDetailsHeight] = useState(136)
  const [branchSyncStatus, setBranchSyncStatus] = useState<GitBranchSyncStatus | null>(null)
  const [branchStatusLoading, setBranchStatusLoading] = useState(false)
  const [branchSyncLoading, setBranchSyncLoading] = useState(false)
  const [branchSyncError, setBranchSyncError] = useState<string | null>(null)
  const [lastFetchedByRoot, setLastFetchedByRoot] = useState<Record<string, number>>({})
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const coAuthorInputRef = useRef<HTMLInputElement>(null)
  const root = useProjectStore((s) => s.getActiveRoot())
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const agents = useAgentStore((s) => s.agents)
  const files = useGitStore((s) => s.files)
  const diff = useGitStore((s) => s.diff)
  const selectedFile = useGitStore((s) => s.selectedFile)
  const history = useGitStore((s) => s.history)
  const selectedCommit = useGitStore((s) => s.selectedCommit)
  const selectedCommitFile = useGitStore((s) => s.selectedCommitFile)
  const commitDiff = useGitStore((s) => s.commitDiff)
  const summary = useGitStore((s) => s.summary)
  const loading = useGitStore((s) => s.loading)
  const historyLoading = useGitStore((s) => s.historyLoading)
  const actionLoading = useGitStore((s) => s.actionLoading)
  const selectFile = useGitStore((s) => s.selectFile)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const selectCommitFile = useGitStore((s) => s.selectCommitFile)
  const commitSelection = useGitStore((s) => s.commitSelection)
  const generateCommitMessage = useGitStore((s) => s.generateCommitMessage)
  const fetchStatus = useGitStore((s) => s.fetchStatus)
  const fetchSummary = useGitStore((s) => s.fetchSummary)
  const fetchHistory = useGitStore((s) => s.fetchHistory)

  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return files
    return files.filter((file) => file.path.toLowerCase().includes(query))
  }, [files, filter])
  const coAuthorSuggestions = useMemo(() => {
    const selected = new Set(coAuthors.map((coAuthor) => coAuthorKey(coAuthor.username)))
    const query = normalizeCoAuthorUsername(coAuthorInput)
    const byUsername = new Map<string, CoAuthor>()

    for (const agent of agents) {
      if (agent.status !== 'running') continue
      if (activeProjectId && agent.projectId !== activeProjectId) continue

      const coAuthor = agentToCoAuthor(agent)
      if (!coAuthor) continue

      const key = coAuthorKey(coAuthor.username)
      if (selected.has(key) || byUsername.has(key)) continue
      if (coAuthorSearchScore(coAuthor.username, query) === Number.POSITIVE_INFINITY) continue

      byUsername.set(key, coAuthor)
    }

    return Array.from(byUsername.values())
      .sort((left, right) => {
        const scoreDelta =
          coAuthorSearchScore(left.username, query) - coAuthorSearchScore(right.username, query)
        if (scoreDelta !== 0) return scoreDelta
        return left.username.localeCompare(right.username)
      })
      .slice(0, 6)
  }, [activeProjectId, agents, coAuthorInput, coAuthors])
  const selectedFileList = useMemo(() => Array.from(selectedFiles), [selectedFiles])
  const selectedChangeFileList = useMemo(
    () => selectedChangeFiles(selectedFiles, selectedLineIds),
    [selectedFiles, selectedLineIds]
  )
  const toggleFile = useCallback((path: string): void => {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(Array.from(current).filter((id) => getFilePathFromLineSelectionId(id) !== path))
      return sameStringSet(current, next) ? current : next
    })
  }, [])
  const toggleLine = useCallback((filePath: string, lineId: string): void => {
    setSelectedFiles((current) => {
      if (!current.has(filePath)) return current
      const next = new Set(current)
      next.delete(filePath)
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(current)
      if (next.has(lineId)) {
        next.delete(lineId)
      } else {
        next.add(lineId)
      }
      return next
    })
  }, [])
  const setLinesSelected = useCallback((filePath: string, lineIds: string[], selected: boolean): void => {
    setSelectedFiles((current) => {
      if (!current.has(filePath)) return current
      const next = new Set(current)
      next.delete(filePath)
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(current)
      lineIds.forEach((lineId) => {
        if (selected) {
          next.add(lineId)
        } else {
          next.delete(lineId)
        }
      })
      return sameStringSet(current, next) ? current : next
    })
  }, [])

  useEffect(() => {
    setSelectedFiles(new Set())
    setSelectedLineIds(new Set())
    setSelectionInitialized(false)
    setCoAuthorPanelOpen(false)
    setCoAuthorInput('')
    setCoAuthors([])
    setSelectedCoAuthorSuggestionIndex(0)
  }, [root?.path])

  useEffect(() => {
    if (!coAuthorPanelOpen) return
    window.requestAnimationFrame(() => {
      coAuthorInputRef.current?.focus()
    })
  }, [coAuthorPanelOpen])

  useEffect(() => {
    setSelectedCoAuthorSuggestionIndex(0)
  }, [activeProjectId, coAuthorInput, coAuthors])

  useEffect(() => {
    let cancelled = false
    pear.auth.status()
      .then((status) => {
        if (!cancelled) setAuthUser(status.user || null)
      })
      .catch(() => {
        if (!cancelled) setAuthUser(null)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const currentPaths = new Set(files.map((file) => file.path))
    setSelectedFiles((current) => {
      const next = !selectionInitialized && files.length > 0
        ? new Set(files.map((file) => file.path))
        : new Set(Array.from(current).filter((path) => currentPaths.has(path)))
      return sameStringSet(current, next) ? current : next
    })
    if (!selectionInitialized && files.length > 0) {
      setSelectionInitialized(true)
    }
    setSelectedLineIds((current) => {
      const next = Array.from(current).filter((id) => currentPaths.has(getFilePathFromLineSelectionId(id)))
      const nextSet = new Set(next)
      return sameStringSet(current, nextSet) ? current : nextSet
    })
  }, [files, selectionInitialized])

  useEffect(() => {
    if (activeTab !== 'changes' || !root?.pathExists) return

    const firstFile = files[0]?.path || null
    const selectedFileStillExists = !!selectedFile && files.some((file) => file.path === selectedFile)

    if (!firstFile) {
      if (selectedFile) selectFile(null, root.path)
      return
    }

    if (!selectedFileStillExists) {
      selectFile(firstFile, root.path)
    }
  }, [activeTab, files, root?.path, root?.pathExists, selectFile, selectedFile])

  useEffect(() => {
    if (activeTab !== 'history' || !root?.pathExists) return
    void fetchHistory(root.path)
  }, [activeTab, fetchHistory, root?.path, root?.pathExists])

  useEffect(() => {
    if (!root?.pathExists) {
      setBranchSyncStatus(null)
      return
    }

    let cancelled = false
    setBranchStatusLoading(true)
    setBranchSyncError(null)
    pear.git.branchSyncStatus(root.path)
      .then((status) => {
        if (!cancelled) setBranchSyncStatus(status)
      })
      .catch((error) => {
        if (!cancelled) {
          setBranchSyncStatus(null)
          setBranchSyncError(error instanceof Error ? error.message : 'Unable to read branch status')
        }
      })
      .finally(() => {
        if (!cancelled) setBranchStatusLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [root?.path, root?.pathExists, summary?.branch])

  if (!root?.pathExists) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)] px-8">
        <p className="text-sm text-[var(--pear-text-faint)]">Select an available project root to see changes.</p>
      </div>
    )
  }

  const allVisibleSelected = filteredFiles.length > 0 &&
    filteredFiles.every((file) => selectedFiles.has(file.path))
  const selectedCommitFileCount = selectedChangeFileList.length
  const commitTarget = summary?.branch || 'HEAD'
  const canCommit = selectedChangeFileList.length > 0 && title.trim().length > 0 && !actionLoading
  const coAuthorPanelVisible = coAuthorPanelOpen || coAuthors.length > 0
  const showCoAuthorSuggestions =
    coAuthorPanelOpen &&
    coAuthorSuggestions.length > 0 &&
    (coAuthorInput.trim().length > 0 || coAuthors.length === 0)
  const selectedFileEntry = files.find((file) => file.path === selectedFile)
  const selectedCommitFileEntry = selectedCommit?.files.find((file) => file.path === selectedCommitFile)
  const filteredFilePaths = filteredFiles.map((file) => file.path)
  const selectedCommitFilePaths = selectedCommit?.files.map((file) => file.path) || []
  const lastFetchedAt = root?.path ? lastFetchedByRoot[root.path] || null : null

  function toggleAllVisible(): void {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        filteredFiles.forEach((file) => next.delete(file.path))
      } else {
        filteredFiles.forEach((file) => next.add(file.path))
      }
      return next
    })
  }

  async function refreshRepository(nextStatus?: GitBranchSyncStatus): Promise<void> {
    if (nextStatus) setBranchSyncStatus(nextStatus)
    await Promise.all([
      fetchStatus(root.path),
      fetchSummary(root.path),
      fetchHistory(root.path)
    ])
    const nextFiles = useGitStore.getState().files
    const nextSelectedFile = nextFiles.find((file) => file.path === selectedFile)?.path || nextFiles[0]?.path || null
    selectFile(nextSelectedFile, root.path)
  }

  async function handleBranchChanged(status: GitBranchSyncStatus): Promise<void> {
    setBranchSyncError(null)
    setSelectedFiles(new Set())
    setSelectedLineIds(new Set())
    setSelectionInitialized(false)
    await refreshRepository(status)
  }

  async function handleRemoteSync(): Promise<void> {
    setBranchSyncLoading(true)
    setBranchSyncError(null)
    try {
      let nextStatus: GitBranchSyncStatus
      if (branchSyncStatus && branchSyncStatus.ahead > 0 && branchSyncStatus.behind > 0) {
        throw new Error('Branch has incoming and local commits; resolve manually.')
      }
      if (shouldPublishBranch(branchSyncStatus, lastFetchedAt)) {
        nextStatus = await pear.git.pushCurrentBranch(root.path)
      } else if (branchSyncStatus && branchSyncStatus.behind > 0) {
        nextStatus = await pear.git.pullCurrentBranch(root.path)
      } else if (branchSyncStatus && branchSyncStatus.ahead > 0) {
        nextStatus = await pear.git.pushCurrentBranch(root.path)
      } else {
        nextStatus = await pear.git.fetchRemote(root.path)
      }
      setLastFetchedByRoot((current) => ({ ...current, [root.path]: Date.now() }))
      await refreshRepository(nextStatus)
    } catch (error) {
      setBranchSyncError(error instanceof Error ? error.message : 'Unable to sync with remote')
    } finally {
      setBranchSyncLoading(false)
    }
  }

  function handleChangedFilesKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const path = nextFilePath(filteredFilePaths, selectedFile, event.key === 'ArrowDown' ? 1 : -1)
    if (path) selectFile(path, root.path)
  }

  function handleHistoryFilesKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const path = nextFilePath(selectedCommitFilePaths, selectedCommitFile, event.key === 'ArrowDown' ? 1 : -1)
    if (path) {
      void selectCommitFile(root.path, path)
    }
  }

  function focusCoAuthorInput(): void {
    window.requestAnimationFrame(() => {
      coAuthorInputRef.current?.focus()
    })
  }

  function handleAddCoAuthor(): void {
    setCoAuthorPanelOpen(true)
    focusCoAuthorInput()
  }

  function selectedPatchInput(): string | undefined {
    const patch = buildSelectedPatch(diff, selectedLineIds)
    return patch || undefined
  }

  function addCoAuthor(coAuthor: CoAuthor | string): void {
    if (!normalizeCoAuthor(coAuthor)) return
    setCoAuthors((current) => mergeCoAuthors(current, coAuthor))
    setCoAuthorInput('')
    setCoAuthorPanelOpen(true)
    focusCoAuthorInput()
  }

  function removeCoAuthor(username: string): void {
    setCoAuthors((current) =>
      current.filter((coAuthor) => coAuthorKey(coAuthor.username) !== coAuthorKey(username))
    )
  }

  function handleCoAuthorInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' && coAuthorSuggestions.length > 0) {
      event.preventDefault()
      setSelectedCoAuthorSuggestionIndex((current) => (current + 1) % coAuthorSuggestions.length)
      return
    }

    if (event.key === 'ArrowUp' && coAuthorSuggestions.length > 0) {
      event.preventDefault()
      setSelectedCoAuthorSuggestionIndex((current) =>
        (current - 1 + coAuthorSuggestions.length) % coAuthorSuggestions.length
      )
      return
    }

    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      const suggestion = coAuthorSuggestions[selectedCoAuthorSuggestionIndex]
      addCoAuthor(suggestion || coAuthorInput)
      return
    }

    if (event.key === 'Backspace' && coAuthorInput.length === 0 && coAuthors.length > 0) {
      removeCoAuthor(coAuthors[coAuthors.length - 1].username)
      return
    }

    if (event.key === 'Escape') {
      if (coAuthorInput) {
        setCoAuthorInput('')
      } else if (coAuthors.length === 0) {
        setCoAuthorPanelOpen(false)
      }
    }
  }

  async function handleGenerate(): Promise<void> {
    setMessage(null)
    try {
      const draft = await generateCommitMessage(root.path, {
        wholeFiles: selectedFileList,
        patch: selectedPatchInput()
      })
      setTitle(draft.title)
      setBody(draft.body)
      setMessage('Generated commit message.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to generate commit message')
    }
  }

  async function handleCommit(): Promise<void> {
    setMessage(null)
    try {
      const commitCoAuthors = coAuthorInput.trim()
        ? mergeCoAuthors(coAuthors, coAuthorInput)
        : coAuthors
      const result = await commitSelection(root.path, {
        title,
        body: appendCoAuthorTrailers(body, commitCoAuthors),
        wholeFiles: selectedFileList,
        patch: selectedPatchInput()
      })
      setTitle('')
      setBody('')
      setCoAuthorPanelOpen(false)
      setCoAuthorInput('')
      setCoAuthors([])
      setSelectedFiles(new Set())
      setSelectedLineIds(new Set())
      setMessage(`Committed ${result.hash.slice(0, 7)}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Commit failed')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
      <div
        className="relative z-30 flex shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
        style={{ height: SOURCE_HEADER_HEIGHT }}
      >
        <CurrentProjectSelector width={leftSidebarWidth} />
        <CurrentBranchSelector
          rootPath={root.path}
          currentBranch={branchSyncStatus?.branch || summary?.branch || 'detached'}
          loading={branchStatusLoading}
          onBranchChanged={handleBranchChanged}
        />
        <FetchOriginButton
          status={branchSyncStatus}
          loading={branchSyncLoading}
          lastFetchedAt={lastFetchedAt}
          error={branchSyncError}
          onClick={() => void handleRemoteSync()}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex h-full shrink-0 flex-col border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
          style={{ width: leftSidebarWidth }}
        >
          <div className="grid h-7 shrink-0 grid-cols-2 border-b border-[var(--pear-border-subtle)]">
          <button
            type="button"
            onClick={() => setActiveTab('changes')}
            className={`flex items-center justify-center gap-1.5 border-b-2 text-[13px] font-semibold ${
              activeTab === 'changes'
                ? 'border-[var(--pear-accent)] text-[var(--pear-text)]'
                : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
            }`}
          >
            Changes
            {files.length > 0 && (
              <span className="rounded-full bg-[var(--pear-bg-overlay)] px-1.5 text-[10px] text-[var(--pear-text-secondary)]">
                {files.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center justify-center gap-1.5 border-b-2 text-[13px] font-semibold ${
              activeTab === 'history'
                ? 'border-[var(--pear-accent)] text-[var(--pear-text)]'
                : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
            }`}
          >
            History
          </button>
        </div>

        {activeTab === 'changes' ? (
          <>
            <div className="shrink-0 border-b border-[var(--pear-border-subtle)] px-1.5 py-1">
              <label className="flex h-6 items-center gap-1.5 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2 text-[12px] text-[var(--pear-text-secondary)]">
                <Filter size={12} className="text-[var(--pear-text-faint)]" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter"
                  className="min-w-0 flex-1 border-0 bg-transparent outline-none placeholder:text-[var(--pear-text-faint)]"
                />
              </label>
            </div>

            <div
              className="min-h-0 flex-1 overflow-y-auto border-b border-[var(--pear-border-subtle)] focus:outline-none"
              tabIndex={0}
              onKeyDown={handleChangedFilesKeyDown}
              aria-label="Changed files"
            >
              <button
                type="button"
                onClick={toggleAllVisible}
                className="flex h-7 w-full items-center gap-1.5 border-b border-[var(--pear-border-subtle)] px-2 text-left text-[13px] text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]"
              >
                {allVisibleSelected ? <CheckSquare2 size={13} /> : <Square size={13} />}
                <span className="flex-1">{files.length} changed file{files.length === 1 ? '' : 's'}</span>
              </button>

              {filteredFiles.length === 0 ? (
                <div className="px-3 py-8 text-sm text-[var(--pear-text-faint)]">
                  {files.length === 0 ? 'No changes detected' : 'No files match the filter'}
                </div>
              ) : (
                filteredFiles.map((file) => {
                  const selected = selectedFiles.has(file.path)
                  const active = selectedFile === file.path
                  const kind = fileChangeKindFromStatus(file.status)
                  const statusLabel = fileChangeStatusLabel(kind)
                  return (
                    <div
                      key={file.path}
                      className={`group flex h-7 items-center gap-1.5 border-b border-[var(--pear-border-subtle)] pr-2.5 ${
                        active ? 'bg-[var(--pear-bg-overlay)]' : 'hover:bg-[var(--pear-bg-surface-hover)]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleFile(file.path)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]"
                        title={selected ? 'Unselect file' : 'Select file'}
                        aria-label={selected ? `Unselect ${file.path}` : `Select ${file.path}`}
                      >
                        {selected ? <CheckSquare2 size={13} /> : <Square size={13} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => selectFile(file.path, root.path)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <FilePathLabel path={file.path} oldPath={file.oldPath} className="flex-1 text-[13px]" />
                        {file.staged && (
                          <span className="rounded bg-[var(--pear-bg-overlay)] px-1.5 py-0.5 text-[10px] text-[var(--pear-accent-bright)]">
                            staged
                          </span>
                        )}
                        <FileChangeStatusIcon kind={kind} label={statusLabel} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            <div className="shrink-0 space-y-1.5 p-1.5">
              <div className="flex items-center gap-1.5">
                <CommitAuthorAvatar user={authUser} />
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Summary (required)"
                  className="h-6 min-w-0 flex-1 rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg)] px-2 text-[12px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30"
                />
              </div>
              <div className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg)] focus-within:border-[var(--pear-accent)] focus-within:ring-1 focus-within:ring-[var(--pear-accent)]/30">
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Description"
                  rows={5}
                  className="h-28 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
                />
                <div className="flex h-7 items-center gap-1.5 px-2 pb-1.5">
                  <button
                    type="button"
                    onClick={handleAddCoAuthor}
                    className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                      coAuthorPanelVisible
                        ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)] ring-1 ring-[var(--pear-accent-dim)]'
                        : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                    }`}
                    title="Add co-author"
                    aria-label="Add co-author"
                    aria-pressed={coAuthorPanelVisible}
                  >
                    <UserPlus size={16} />
                  </button>
                  <span className="h-5 w-px bg-[var(--pear-border)]" />
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={selectedCommitFileCount === 0 || actionLoading}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-40"
                    title="Generate commit message"
                    aria-label="Generate commit message"
                  >
                    {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={16} />}
                  </button>
                </div>
                {coAuthorPanelVisible && (
                  <CoAuthorPicker
                    coAuthors={coAuthors}
                    inputRef={coAuthorInputRef}
                    inputValue={coAuthorInput}
                    suggestions={coAuthorSuggestions}
                    selectedSuggestionIndex={selectedCoAuthorSuggestionIndex}
                    showSuggestions={showCoAuthorSuggestions}
                    onInputChange={setCoAuthorInput}
                    onInputKeyDown={handleCoAuthorInputKeyDown}
                    onSelectSuggestion={addCoAuthor}
                    onRemoveCoAuthor={removeCoAuthor}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={handleCommit}
                disabled={!canCommit}
                className="flex h-6 w-full items-center justify-center rounded-md bg-[var(--pear-accent-dim)] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[var(--pear-accent)] disabled:bg-[var(--pear-bg-surface)] disabled:text-[var(--pear-text-faint)]"
              >
                {actionLoading ? (
                  <Loader2 size={14} className="mr-2 animate-spin" />
                ) : null}
                Commit {selectedCommitFileCount} file{selectedCommitFileCount === 1 ? '' : 's'} to{' '}
                <span className="ml-1 font-semibold">{commitTarget}</span>
              </button>
              {message && (
                <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-xs text-[var(--pear-text-dim)]">
                  {message}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-[var(--pear-border-subtle)] p-2">
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-left text-[13px] text-[var(--pear-text-faint)]"
              >
                <GitBranch size={14} />
                <span className="truncate">Select Branch to Compare...</span>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {historyLoading && history.length === 0 ? (
                <div className="px-3 py-6 text-sm text-[var(--pear-text-faint)]">Loading history...</div>
              ) : history.length === 0 ? (
                <div className="px-3 py-6 text-sm text-[var(--pear-text-faint)]">No commits yet</div>
              ) : (
                <div>
                  {history.map((commit) => (
                    <HistoryCommit
                      key={commit.hash}
                      commit={commit}
                      active={selectedCommit?.hash === commit.hash}
                      onSelect={() => selectCommit(root.path, commit)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </aside>

      <button
        type="button"
        aria-label="Resize source control panel"
        className="group flex h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-[var(--pear-bg)] hover:bg-[var(--pear-bg-surface-hover)]"
        onPointerDown={(event) =>
          startPanelResize(event, {
            axis: 'x',
            startValue: leftSidebarWidth,
            min: LEFT_SIDEBAR_MIN_WIDTH,
            max: LEFT_SIDEBAR_MAX_WIDTH,
            onResize: setLeftSidebarWidth
          })
        }
      >
        <GripVertical size={12} className="opacity-0 text-[var(--pear-text-faint)] group-hover:opacity-100" />
      </button>

      {activeTab === 'changes' ? (
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-[12px] text-[var(--pear-text-secondary)]">
            <FileDiff size={13} className="text-[var(--pear-text-faint)]" />
            {selectedFileEntry ? (
              <FilePathLabel
                path={selectedFileEntry.path}
                oldPath={selectedFileEntry.oldPath}
                className="flex-1 text-[13px]"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">Select a file</span>
            )}
            {loading && <Loader2 size={14} className="ml-auto animate-spin text-[var(--pear-text-faint)]" />}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {diff ? (
              <DiffViewer
                diff={diff}
                rootPath={root.path}
                focusedFilePath={selectedFileEntry?.path || selectedFile}
                selectable
                selectedFiles={selectedFiles}
                selectedLineIds={selectedLineIds}
                onToggleLine={toggleLine}
                onSetLines={setLinesSelected}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-sm text-[var(--pear-text-faint)]">
                {files.length === 0 ? 'No changes detected' : 'Select a file to view its diff'}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="flex min-w-0 flex-1 flex-col">
          <div
            className="shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)]"
            style={{ height: historyDetailsHeight }}
          >
            {selectedCommit ? (
              <HistoryCommitDetails commit={selectedCommit} />
            ) : (
              <div className="flex h-full items-center px-4 text-sm text-[var(--pear-text-faint)]">
                Select a commit to see its files and diff
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Resize commit details panel"
            className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-[var(--pear-bg)] hover:bg-[var(--pear-bg-surface-hover)]"
            onPointerDown={(event) =>
              startPanelResize(event, {
                axis: 'y',
                startValue: historyDetailsHeight,
                min: HISTORY_DETAILS_MIN_HEIGHT,
                max: HISTORY_DETAILS_MAX_HEIGHT,
                onResize: setHistoryDetailsHeight
              })
            }
          >
            <GripHorizontal size={13} className="opacity-0 text-[var(--pear-text-faint)] group-hover:opacity-100" />
          </button>

          <div className="flex min-h-0 flex-1">
            <aside
              className="flex h-full shrink-0 flex-col border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
              style={{ width: historyFilesWidth }}
            >
              <div className="flex h-7 shrink-0 items-center justify-center border-b border-[var(--pear-border-subtle)] text-[13px] font-semibold text-[var(--pear-text)]">
                {selectedCommit?.files.length || 0} changed file{selectedCommit?.files.length === 1 ? '' : 's'}
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
                tabIndex={0}
                onKeyDown={handleHistoryFilesKeyDown}
                aria-label="Commit files"
              >
                {selectedCommit ? (
                  selectedCommit.files.map((file) => {
                    const active = selectedCommitFile === file.path
                    const kind = fileChangeKindFromStatus(file.status)
                    const statusLabel = fileChangeStatusLabel(kind)
                    return (
                      <button
                        key={`${selectedCommit.hash}:${file.oldPath || ''}:${file.path}`}
                        type="button"
                        onClick={() => selectCommitFile(root.path, file.path)}
                        className={`flex h-7 w-full min-w-0 items-center gap-2 border-b border-[var(--pear-border-subtle)] px-2.5 text-left ${
                          active
                            ? 'bg-[var(--pear-bg-overlay)]'
                            : 'hover:bg-[var(--pear-bg-surface-hover)]'
                        }`}
                      >
                        <FilePathLabel path={file.path} oldPath={file.oldPath} className="flex-1 text-[13px]" />
                        <FileChangeStatusIcon kind={kind} label={statusLabel} />
                      </button>
                    )
                  })
                ) : (
                  <div className="px-3 py-6 text-sm text-[var(--pear-text-faint)]">No commit selected</div>
                )}
              </div>
            </aside>
            <button
              type="button"
              aria-label="Resize history files panel"
              className="group flex h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-[var(--pear-bg)] hover:bg-[var(--pear-bg-surface-hover)]"
              onPointerDown={(event) =>
                startPanelResize(event, {
                  axis: 'x',
                  startValue: historyFilesWidth,
                  min: HISTORY_FILES_MIN_WIDTH,
                  max: HISTORY_FILES_MAX_WIDTH,
                  onResize: setHistoryFilesWidth
                })
              }
            >
              <GripVertical size={12} className="opacity-0 text-[var(--pear-text-faint)] group-hover:opacity-100" />
            </button>

            <section className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-[12px] text-[var(--pear-text-secondary)]">
                {selectedCommitFileEntry ? (
                  <FilePathLabel
                    path={selectedCommitFileEntry.path}
                    oldPath={selectedCommitFileEntry.oldPath}
                    className="flex-1 text-[13px]"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">Commit diff</span>
                )}
                {loading && <Loader2 size={14} className="ml-auto animate-spin text-[var(--pear-text-faint)]" />}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {commitDiff ? (
                  <DiffViewer diff={commitDiff} focusedFilePath={selectedCommitFile} />
                ) : (
                  <div className="flex h-full items-center justify-center px-4 text-sm text-[var(--pear-text-faint)]">
                    Select a commit file to see its diff
                  </div>
                )}
              </div>
            </section>
          </div>
        </section>
      )}
      </div>
    </div>
  )
}
