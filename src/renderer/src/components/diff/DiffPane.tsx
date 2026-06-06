import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Expand,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GripVertical,
  Loader2,
  Minimize2,
  RefreshCw,
  Search,
  UserPlus,
  WandSparkles,
  X
} from 'lucide-react'
import { buildSelectedPatch, getFilePathFromLineSelectionId, getSelectableLineIds } from '@/lib/diff-selection'
import {
  pear,
  type AuthUser,
  type GitBranchInfo,
  type GitBranchSyncStatus,
  type GitHistoryCoAuthor,
  type GitHistoryCommit
} from '@/lib/ipc'
import { normalizeChannelName, useProjectStore, type Project, type ProjectRoot } from '@/stores/project-store'
import { useGitStore } from '@/stores/git-store'
import { useUIStore } from '@/stores/ui-store'
import {
  FileChangeStatusIcon,
  FilePathLabel,
  type FilePathLabelTone,
  fileChangeKindFromStatus,
  fileChangeStatusLabel
} from './FileChangeLabel'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { FilterInput, PaneSidebar } from '@/components/common/PaneShell'
import { DiffViewer } from './DiffViewer'
import { getAgentKey, useAgentStore, type Agent } from '@/stores/agent-store'
import { formatGitDiffLineCount } from '@/lib/format'

type PaneTab = 'changes' | 'history'
type CoAuthor = { username: string; name?: string; cli?: string }

const LEFT_SIDEBAR_MIN_WIDTH = 300
const LEFT_SIDEBAR_MAX_WIDTH = 640
const HISTORY_FILES_MIN_WIDTH = 240
const HISTORY_FILES_MAX_WIDTH = 620
const SOURCE_HEADER_HEIGHT = 54
const FILE_CONTEXT_MENU_WIDTH = 360
const FILE_CONTEXT_MENU_MAX_HEIGHT = 430
const REVIEW_DIFF_MAX_CHARS = 24_000

type FileContextMenuState = {
  x: number
  y: number
  paths: string[]
}
type EmptyFileProbe = { rootPath: string; path: string; empty: boolean }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => {
    if (typeof document === 'undefined') return true
    return document.hasFocus()
  })

  useEffect(() => {
    function handleFocus(): void {
      setFocused(true)
    }

    function handleBlur(): void {
      setFocused(false)
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])

  return focused
}

function selectedFileRowClass(active: boolean, _windowFocused: boolean): string {
  if (active) return 'bg-[#46515c] text-[var(--pear-text)]'
  return 'text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]'
}

function selectedFilePathTone(active: boolean, _windowFocused: boolean): FilePathLabelTone {
  if (!active) return 'default'
  return 'selectedActive'
}

function selectionCheckboxClass(
  state: 'checked' | 'mixed' | 'unchecked',
  active = false,
  windowFocused = false
): string {
  const base = 'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] border transition-colors'

  if (state === 'checked') {
    return `${base} ${
      active && windowFocused
        ? 'border-[#9bd4ff] bg-[#9bd4ff] text-[#05345f]'
        : 'border-[#1683e8] bg-[#1683e8] text-white'
    }`
  }

  if (state === 'mixed') {
    return `${base} border-[#b8c7d8] bg-[#b8c7d8] text-[#263443]`
  }

  return `${base} border-[var(--pear-text-faint)] bg-transparent text-transparent group-hover:border-[var(--pear-text)]`
}

function SelectionCheckbox({
  state,
  active = false,
  windowFocused = false
}: {
  state: 'checked' | 'mixed' | 'unchecked'
  active?: boolean
  windowFocused?: boolean
}): React.ReactNode {
  return (
    <span className={selectionCheckboxClass(state, active, windowFocused)} aria-hidden="true">
      {state === 'checked' ? (
        <Check size={11} strokeWidth={3} />
      ) : state === 'mixed' ? (
        <span className="h-[2px] w-[8px] rounded-full bg-current" />
      ) : null}
    </span>
  )
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

function scrollFileRowIntoView(container: HTMLElement | null, path: string | null): void {
  if (!container || !path) return

  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-file-list-path]'))
    .find((element) => element.dataset.fileListPath === path)

  row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function scrollCommitRowIntoView(container: HTMLElement | null, hash: string | null): void {
  if (!container || !hash) return

  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-commit-list-hash]'))
    .find((element) => element.dataset.commitListHash === hash)

  row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
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

function isRemoteAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

function providedAvatarUrl(user: AuthUser | null): string | null {
  const avatarUrl = user?.avatarUrl?.trim()
  return avatarUrl && isRemoteAvatarUrl(avatarUrl) ? avatarUrl : null
}

function uniqueAvatarUrls(urls: Array<string | null | undefined>): string[] {
  return Array.from(new Set(urls.map((url) => url?.trim()).filter((url): url is string => !!url)))
}

function userAvatarUrls(user: AuthUser | null): string[] {
  return uniqueAvatarUrls([
    user?.cachedAvatarUrl,
    providedAvatarUrl(user)
  ])
}

function useAvatarUrl(urls: string[]): { src: string | undefined; onError: () => void } {
  const key = urls.join('\0')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
  }, [key])

  return {
    src: urls[index],
    onError: () => setIndex((current) => current + 1)
  }
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

function commitMessagePreview(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
}

function selectedChangeFiles(selectedFiles: Set<string>, selectedLineIds: Set<string>): string[] {
  const partialFiles = Array.from(selectedLineIds).map(getFilePathFromLineSelectionId)
  return Array.from(new Set([...selectedFiles, ...partialFiles])).filter(Boolean)
}

function EmptyFileState(): React.ReactNode {
  return (
    <div className="flex h-full items-center justify-center px-4 text-[13px] font-medium text-[var(--pear-text)]">
      The file is empty
    </div>
  )
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

  const nextIndex = (currentIndex + direction + paths.length) % paths.length
  return paths[nextIndex] || null
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}

function absoluteFilePath(rootPath: string, filePath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${filePath.replace(/^[\\/]+/, '')}`
}

function fileNameFromPath(path: string): string {
  const parts = normalizePathSeparators(path).split('/')
  return parts[parts.length - 1] || path
}

function pathTail(path: string, depth = 2): string {
  const normalized = normalizePathSeparators(path).replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return path
  return parts.slice(-depth).join('/')
}

function fileExtension(path: string): string | null {
  const fileName = fileNameFromPath(path)
  const index = fileName.lastIndexOf('.')
  if (index <= 0 || index === fileName.length - 1) return null
  return fileName.slice(index)
}

function commonFileExtension(paths: string[]): string | null {
  const extensions = paths.map(fileExtension)
  const first = extensions[0]
  if (!first || extensions.some((extension) => extension !== first)) return null
  return first
}

function containingFolder(path: string): string | null {
  const normalized = normalizePathSeparators(path).replace(/\/+$/, '')
  const separatorIndex = normalized.lastIndexOf('/')
  if (separatorIndex <= 0) return null
  return normalized.slice(0, separatorIndex)
}

function escapeGitignorePattern(value: string): string {
  const escaped = normalizePathSeparators(value).replace(/[\\#*?\[\]]/g, '\\$&')
  return escaped.startsWith('!') ? `\\${escaped}` : escaped
}

function gitignoreFilePattern(path: string): string {
  return `/${escapeGitignorePattern(path.replace(/^[\\/]+/, ''))}`
}

function gitignoreFolderPattern(path: string): string {
  return `/${escapeGitignorePattern(path.replace(/^[\\/]+|[\\/]+$/g, ''))}/`
}

function gitignoreExtensionPattern(extension: string): string {
  return `*${extension}`
}

function compactReviewDiff(diff: string): string {
  if (diff.length <= REVIEW_DIFF_MAX_CHARS) return diff
  return `${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}\n\n[diff truncated at ${REVIEW_DIFF_MAX_CHARS} characters]`
}

function fileRange(paths: string[], startPath: string, endPath: string): string[] {
  const startIndex = paths.indexOf(startPath)
  const endIndex = paths.indexOf(endPath)
  if (startIndex === -1 || endIndex === -1) return [endPath]

  const [start, end] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
  return paths.slice(start, end + 1)
}

function orderedSelectedPaths(paths: string[], selectedPaths: Set<string>): string[] {
  return paths.filter((path) => selectedPaths.has(path))
}

function contextMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const x = Math.min(clientX, Math.max(8, window.innerWidth - FILE_CONTEXT_MENU_WIDTH - 8))
  const y = Math.min(clientY, Math.max(8, window.innerHeight - FILE_CONTEXT_MENU_MAX_HEIGHT - 8))
  return { x, y }
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function nextReviewChannelName(existingNames: Iterable<string>): string {
  const existing = new Set(Array.from(existingNames).map(normalizeChannelName).filter(Boolean))
  let index = 1
  while (existing.has(`review-files-${index}`)) {
    index += 1
  }
  return `review-files-${index}`
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

function CommitAuthorTooltip({
  anchorRef,
  visible,
  name,
  email
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  visible: boolean
  name: string
  email?: string
}): React.ReactNode {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!visible) {
      setPosition(null)
      return
    }

    function updatePosition(): void {
      const anchor = anchorRef.current
      if (!anchor) {
        setPosition(null)
        return
      }

      const rect = anchor.getBoundingClientRect()
      const tooltipWidth = 260
      const tooltipHeight = email ? 64 : 44
      const gutter = 8
      const left = clamp(
        rect.left + rect.width / 2 - tooltipWidth / 2,
        gutter,
        window.innerWidth - tooltipWidth - gutter
      )
      let top = rect.top - tooltipHeight - gutter
      if (top < gutter) {
        top = rect.bottom + gutter
      }

      setPosition({
        left,
        top: clamp(top, gutter, window.innerHeight - tooltipHeight - gutter)
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef, email, visible])

  if (!visible || !position || typeof document === 'undefined') return null

  return createPortal(
    <span
      className="commit-author-tooltip-panel"
      role="tooltip"
      style={{ left: position.left, top: position.top }}
    >
      <span className="truncate font-semibold text-[var(--pear-text)]">{name}</span>
      {email && <span className="truncate text-[var(--pear-text-secondary)]">{email}</span>}
    </span>,
    document.body
  )
}

function CommitAuthorTooltipTrigger({
  name,
  email,
  className,
  children
}: {
  name: string
  email?: string
  className: string
  children: React.ReactNode
}): React.ReactNode {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const label = email ? `${name} <${email}>` : name

  return (
    <span
      ref={anchorRef}
      className={className}
      aria-label={label}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      <CommitAuthorTooltip anchorRef={anchorRef} visible={visible} name={name} email={email} />
    </span>
  )
}

function CommitAvatar({
  author,
  email,
  avatarUrls,
  active = false
}: {
  author: string
  email?: string
  avatarUrls: string[]
  active?: boolean
}): React.ReactNode {
  const avatar = useAvatarUrl(avatarUrls)

  if (avatar.src) {
    return (
      <CommitAuthorTooltipTrigger name={author} email={email} className="commit-primary-author-wrap">
        <img
          src={avatar.src}
          alt={author}
          className="h-[18px] w-[18px] shrink-0 rounded-full bg-[var(--pear-bg-overlay)] object-cover"
          referrerPolicy="no-referrer"
          onError={avatar.onError}
        />
      </CommitAuthorTooltipTrigger>
    )
  }

  return (
    <CommitAuthorTooltipTrigger name={author} email={email} className="commit-primary-author-wrap">
      <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--pear-bg-overlay)] text-[9px] font-semibold ${
        active ? 'text-white' : 'text-[var(--pear-text)]'
      }`}>
        {authorInitial(author)}
      </span>
    </CommitAuthorTooltipTrigger>
  )
}

function avatarUrlsForCommit(commit: GitHistoryCommit, authUser: AuthUser | null): string[] {
  const authAvatarUrls = userAvatarUrls(authUser)
  const commitEmail = commit.authorEmail.trim().toLowerCase()
  const authEmail = authUser?.email?.trim().toLowerCase()
  const commitAuthor = commit.author.trim().toLowerCase()
  const authName = authUser?.name?.trim().toLowerCase()
  const authUsername = (authUser?.githubUsername || authUser?.username)?.trim().toLowerCase()

  if (
    authAvatarUrls.length > 0 &&
    ((commitEmail && authEmail && commitEmail === authEmail) ||
      (commitAuthor && authName && commitAuthor === authName) ||
      (commitAuthor && authUsername && commitAuthor === authUsername))
  ) {
    return authAvatarUrls
  }

  return uniqueAvatarUrls([commit.authorAvatarUrl, commit.authorCachedAvatarUrl])
}

function coAuthorCli(coAuthor: GitHistoryCoAuthor): string | undefined {
  const identity = `${coAuthor.name} ${coAuthor.email}`.toLowerCase()
  if (identity.includes('claude') || identity.includes('anthropic')) return 'claude'
  if (identity.includes('codex') || identity.includes('openai') || identity.includes('chatgpt')) return 'codex'
  if (identity.includes('gemini') || identity.includes('google')) return 'gemini'
  if (identity.includes('copilot')) return 'copilot'
  if (identity.includes('opencode')) return 'opencode'
  return undefined
}

function commitCoAuthors(commit: GitHistoryCommit): GitHistoryCoAuthor[] {
  return commit.coAuthors || []
}

function commitAuthorLabel(commit: GitHistoryCommit): string {
  return [commit.author, ...commitCoAuthors(commit).map((coAuthor) => coAuthor.name)]
    .map((name) => name.trim())
    .filter(Boolean)
    .join(', ')
}

function CommitCoAuthorBadge({
  coAuthor,
  active
}: {
  coAuthor: GitHistoryCoAuthor
  active: boolean
}): React.ReactNode {
  const cli = coAuthorCli(coAuthor)
  const avatar = useAvatarUrl(uniqueAvatarUrls([coAuthor.avatarUrl, coAuthor.cachedAvatarUrl]))

  return (
    <CommitAuthorTooltipTrigger
      name={coAuthor.name}
      email={coAuthor.email}
      className="commit-author-avatar-wrap"
    >
      {avatar.src && !cli ? (
        <img
          src={avatar.src}
          alt={coAuthor.name}
          className="commit-co-author-avatar object-cover"
          referrerPolicy="no-referrer"
          onError={avatar.onError}
        />
      ) : cli ? (
        <span className="commit-co-author-avatar bg-[#b45f43] text-white">
          <AgentHarnessIcon cli={cli} className="h-[13px] w-[13px]" />
        </span>
      ) : (
        <span className={`commit-co-author-avatar bg-[var(--pear-bg-overlay)] text-[9px] font-semibold ${
          active ? 'text-white' : 'text-[var(--pear-text)]'
        }`}>
          {authorInitial(coAuthor.name)}
        </span>
      )}
    </CommitAuthorTooltipTrigger>
  )
}

function CommitAuthorStack({
  commit,
  authorAvatarUrls,
  active
}: {
  commit: GitHistoryCommit
  authorAvatarUrls: string[]
  active: boolean
}): React.ReactNode {
  const coAuthors = commitCoAuthors(commit)

  return (
    <span className={`commit-author-stack ${coAuthors.length > 0 ? 'has-co-authors' : ''}`}>
      <CommitAvatar
        author={commit.author}
        email={commit.authorEmail}
        avatarUrls={authorAvatarUrls}
        active={active}
      />
      {coAuthors.map((coAuthor) => (
        <CommitCoAuthorBadge key={`${coAuthor.email}:${coAuthor.name}`} coAuthor={coAuthor} active={active} />
      ))}
    </span>
  )
}

function CommitAuthorAvatar({ user }: { user: AuthUser | null }): React.ReactNode {
  const label = user?.name || user?.email || 'Commit author'
  const avatar = useAvatarUrl(userAvatarUrls(user))

  if (avatar.src) {
    return (
      <img
        src={avatar.src}
        alt={label}
        title={label}
        className="h-9 w-9 shrink-0 rounded-full border border-[var(--pear-border)] bg-[var(--pear-bg-overlay)] object-cover"
        referrerPolicy="no-referrer"
        onError={avatar.onError}
      />
    )
  }

  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--pear-border)] bg-[var(--pear-accent)] text-[13px] font-semibold text-[var(--pear-bg)]"
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
  panelRef,
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
  panelRef: React.Ref<HTMLDivElement>
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
    <div ref={panelRef} className="flex min-h-10 items-center gap-2 border-t border-[var(--pear-border-subtle)] px-2.5 py-2">
      <span className="shrink-0 text-[13px] font-medium text-[var(--pear-text-secondary)]">Co-Authors</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {coAuthors.map((coAuthor) => (
          <span
            key={coAuthorKey(coAuthor.username)}
            className="flex h-7 max-w-[180px] items-center gap-1 rounded-md border border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] px-2 text-[13px] font-semibold text-[var(--pear-text)]"
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
            className="h-7 w-full min-w-[132px] border-0 bg-transparent text-[13px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
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
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] ${
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
  authorAvatarUrls,
  onSelect
}: {
  commit: GitHistoryCommit
  active: boolean
  authorAvatarUrls: string[]
  onSelect: () => void
}): React.ReactNode {
  const tags = commit.tags.slice(0, 2)

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onSelect}
      data-commit-list-hash={commit.hash}
      className={`commit-history-row w-full border-b border-[var(--pear-border-subtle)] px-2.5 py-2 text-left transition-colors ${
        active
          ? 'bg-[var(--pear-selection-blue)] text-white'
          : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)]'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5">{commit.subject}</span>
        {tags.map((tag) => (
          <span
            key={tag}
            className={`max-w-[104px] shrink-0 truncate rounded-full px-2 py-0.5 text-[12px] font-semibold leading-4 ${
              active ? 'bg-white/20 text-white' : 'bg-[#5c6672] text-white'
            }`}
            title={tag}
          >
            {tag}
          </span>
        ))}
      </div>
      <div className={`mt-1 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 ${active ? 'text-white/90' : 'text-[var(--pear-text-faint)]'}`}>
        <CommitAuthorStack commit={commit} authorAvatarUrls={authorAvatarUrls} active={active} />
        <span className="min-w-0 truncate">{commitAuthorLabel(commit)}</span>
        <span className="shrink-0">•</span>
        <span className="shrink-0">{formatRelativeDate(commit.date)}</span>
      </div>
    </button>
  )
}

function HistoryCommitDetails({
  commit,
  authorAvatarUrls,
  expanded,
  onCopyHash,
  onToggleExpanded
}: {
  commit: GitHistoryCommit
  authorAvatarUrls: string[]
  expanded: boolean
  onCopyHash: () => void
  onToggleExpanded: () => void
}): React.ReactNode {
  const message = commit.body.trim()
  const preview = commitMessagePreview(message)
  const coAuthors = commitCoAuthors(commit)
  const authorLabel = expanded
    ? [
        commit.authorEmail ? `${commit.author} <${commit.authorEmail}>` : commit.author,
        ...coAuthors.map((coAuthor) =>
          coAuthor.email ? `${coAuthor.name} <${coAuthor.email}>` : coAuthor.name
        )
      ].filter(Boolean).join(', ')
    : commitAuthorLabel(commit)
  const hashLabel = expanded ? commit.hash : commit.shortHash
  const additionsLabel = expanded
    ? `${formatGitDiffLineCount(commit.additions)} added ${commit.additions === 1 ? 'line' : 'lines'}`
    : `+${formatGitDiffLineCount(commit.additions)}`
  const deletionsLabel = expanded
    ? `${formatGitDiffLineCount(commit.deletions)} removed ${commit.deletions === 1 ? 'line' : 'lines'}`
    : `-${formatGitDiffLineCount(commit.deletions)}`

  return (
    <div className={`flex flex-col bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(116,184,226,0.035)_44%,rgba(255,255,255,0.015))] px-4 backdrop-blur-md ${
      expanded ? 'min-h-[180px] py-3' : 'min-h-[76px] justify-center py-2'
    }`}>
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 truncate text-[17px] font-semibold leading-5 text-[var(--pear-text)]">
          {commit.subject}
        </h2>
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] transition-colors hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title={expanded ? 'Collapse commit details' : 'Expand commit details'}
          aria-label={expanded ? 'Collapse commit details' : 'Expand commit details'}
          aria-expanded={expanded}
        >
          {expanded ? <Minimize2 size={15} /> : <Expand size={15} />}
        </button>
      </div>
      {message && (
        <pre
          className={expanded
            ? 'mt-2 max-h-[260px] overflow-y-auto whitespace-pre-wrap rounded bg-black/10 px-2.5 py-2 font-mono text-[13px] leading-5 text-[var(--pear-text-secondary)]'
            : 'mt-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] leading-4 text-[var(--pear-text-secondary)]'
          }
        >
          {expanded ? message : preview}
        </pre>
      )}
      <div className={`${expanded && message ? 'mt-2' : 'mt-1'} flex min-w-0 items-center gap-2.5 text-[13px] leading-5 text-[var(--pear-text-dim)]`}>
        <CommitAuthorStack commit={commit} authorAvatarUrls={authorAvatarUrls} active={false} />
        <span className="min-w-0 truncate font-semibold text-[var(--pear-text-secondary)]">
          {authorLabel}
        </span>
        <GitCommitHorizontal size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
        <span className={`${expanded ? 'max-w-[42ch]' : 'shrink-0'} min-w-0 truncate font-mono text-[var(--pear-text-secondary)]`}>
          {hashLabel}
        </span>
        <button
          type="button"
          onClick={onCopyHash}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--pear-text-faint)] transition-colors hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title="Copy commit hash"
          aria-label="Copy commit hash"
        >
          <Copy size={14} />
        </button>
        <span className="min-w-0 truncate">{formatRelativeDate(commit.date)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3 font-semibold">
          <span className="text-[var(--pear-green)]">{additionsLabel}</span>
          <span className="text-[var(--pear-red)]">{deletionsLabel}</span>
        </div>
      </div>
    </div>
  )
}

type BranchSwitchMode = 'stash' | 'carry'
type BranchSelectorTab = 'branches' | 'worktrees'
type RootGitState = 'checking' | 'git' | 'not-git'

function gitStateForRoot(root: ProjectRoot, states: Record<string, RootGitState>): RootGitState {
  if (!root.pathExists) return 'not-git'
  return states[root.id] || 'checking'
}

function rootStatusLabel(root: ProjectRoot, state: RootGitState): string {
  if (!root.pathExists) return 'Path missing'
  if (state === 'checking') return 'Checking git'
  if (state === 'not-git') return 'No git repo'
  return pathTail(root.path)
}

function CurrentRootSelector({
  project,
  activeRoot,
  gitStates,
  width,
  onSelect
}: {
  project: Project | undefined
  activeRoot: ProjectRoot | undefined
  gitStates: Record<string, RootGitState>
  width: number
  onSelect: (id: string) => void
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const roots = project?.roots || []
  const activeRootState = activeRoot ? gitStateForRoot(activeRoot, gitStates) : 'not-git'
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRoots = normalizedQuery
    ? roots.filter((root) =>
        `${root.name} ${root.path}`.toLowerCase().includes(normalizedQuery)
      )
    : roots

  useEffect(() => {
    setOpen(false)
    setQuery('')
  }, [project?.id])

  function selectRoot(root: ProjectRoot): void {
    if (gitStateForRoot(root, gitStates) !== 'git') return
    onSelect(root.id)
    setOpen(false)
    setQuery('')
  }

  function renderRoot(root: ProjectRoot): React.ReactNode {
    const state = gitStateForRoot(root, gitStates)
    const selected = root.id === activeRoot?.id
    const disabled = state !== 'git'

    return (
      <button
        key={root.id}
        type="button"
        onClick={() => selectRoot(root)}
        disabled={disabled}
        title={disabled ? rootStatusLabel(root, state) : root.path}
        className={`flex h-10 w-full items-center gap-2.5 px-3.5 text-left ${
          selected && !disabled
            ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
            : disabled
              ? 'cursor-not-allowed text-[var(--pear-text-faint)] opacity-50'
              : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
        }`}
      >
        {selected && !disabled ? (
          <Check size={13} className="shrink-0 text-[var(--pear-text)]" />
        ) : state === 'checking' ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--pear-text-faint)]" />
        ) : (
          <FolderGit2 size={13} className="shrink-0 text-[var(--pear-text-secondary)]" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{root.name}</span>
          <span className="block truncate text-[11px] font-medium text-[var(--pear-text-faint)]">
            {rootStatusLabel(root, state)}
          </span>
        </span>
      </button>
    )
  }

  return (
    <div
      className="relative h-full shrink-0 border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
      style={{ width }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-full w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--pear-bg-surface-hover)]"
        aria-expanded={open}
        aria-label="Select repository root"
        title={activeRoot?.path}
      >
        <FolderGit2
          size={14}
          className={`shrink-0 ${
            activeRootState === 'git'
              ? 'text-[var(--pear-text-secondary)]'
              : 'text-[var(--pear-text-faint)]'
          }`}
        />
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-[11px] font-medium leading-[14px] text-[var(--pear-text-faint)]">
            Repository Root
          </span>
          <span
            className={`block truncate text-[13px] font-semibold leading-4 ${
              activeRootState === 'git'
                ? 'text-[var(--pear-text)]'
                : 'text-[var(--pear-text-faint)]'
            }`}
          >
            {activeRoot?.name || 'No root selected'}
          </span>
        </span>
        {activeRootState === 'checking' ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-[var(--pear-text-secondary)]" />
        ) : open ? (
          <ChevronUp size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
        )}
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 overflow-hidden bg-[var(--pear-bg)] pb-2 shadow-2xl"
          style={{ width: Math.max(width, 420) }}
        >
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
                  aria-label="Clear root filter"
                >
                  <X size={12} />
                </button>
              )}
            </label>
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {roots.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No roots configured</div>
            ) : filteredRoots.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No roots match</div>
            ) : (
              <div className="pb-1.5">
                <div className="px-3.5 pb-1 pt-2 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                  Project Roots
                </div>
                {filteredRoots.map(renderRoot)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

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
  const [activeBranchTab, setActiveBranchTab] = useState<BranchSelectorTab>('branches')
  const [error, setError] = useState<string | null>(null)

  const filteredBranches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return branches
    return branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery))
  }, [branches, query])
  const defaultBranches = useMemo(() => {
    const localDefaults = filteredBranches.filter((branch) => branch.defaultBranch && !branch.remote)
    return localDefaults.length > 0 ? localDefaults : filteredBranches.filter((branch) => branch.defaultBranch)
  }, [filteredBranches])
  const otherBranches = filteredBranches.filter((branch) => !branch.defaultBranch)

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
    setActiveBranchTab('branches')
  }, [rootPath])

  useEffect(() => {
    if (open && activeBranchTab === 'branches') void loadBranches()
  }, [open, activeBranchTab])

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
        <div className="absolute left-0 top-full z-50 w-[460px] overflow-hidden bg-[var(--pear-bg)] pb-2 shadow-2xl">
          <div className="grid h-9 grid-cols-2 bg-[var(--pear-bg-surface-hover)]">
            <button
              type="button"
              data-focus-ring="none"
              onClick={() => setActiveBranchTab('branches')}
              className={`flex items-center justify-center border-b-2 text-[13px] font-semibold ${
                activeBranchTab === 'branches'
                  ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
                  : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]'
              }`}
            >
              Branches
            </button>
            <button
              type="button"
              data-focus-ring="none"
              onClick={() => setActiveBranchTab('worktrees')}
              className={`flex items-center justify-center border-b-2 text-[13px] font-semibold ${
                activeBranchTab === 'worktrees'
                  ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
                  : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]'
              }`}
            >
              Worktrees
            </button>
          </div>

          {activeBranchTab === 'branches' ? (
            <>
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
                      {defaultBranches.length > 0 && (
                        <div className="px-3.5 pb-1 pt-2 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                          Other Branches
                        </div>
                      )}
                      {otherBranches.map(renderBranch)}
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-[220px] items-center justify-center px-4 text-[13px] font-medium text-[var(--pear-text-faint)]">
              Coming soon
            </div>
          )}
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

function ContextMenuDivider(): React.ReactNode {
  return <div className="my-1 h-px bg-white/12" />
}

function ContextMenuItem({
  label,
  onClick,
  disabled = false
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] font-medium text-[var(--pear-text)] outline-none hover:bg-[var(--pear-selection-blue)] hover:text-white disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[var(--pear-text)]"
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function FileContextMenu({
  menu,
  onClose,
  onDiscard,
  onIgnorePatterns,
  onInclude,
  onExclude,
  onCopyPaths,
  onReveal,
  onExplain
}: {
  menu: FileContextMenuState
  onClose: () => void
  onDiscard: (paths: string[]) => Promise<void>
  onIgnorePatterns: (patterns: string[]) => Promise<void>
  onInclude: (paths: string[]) => void
  onExclude: (paths: string[]) => void
  onCopyPaths: (paths: string[], relative: boolean) => Promise<void>
  onReveal: (paths: string[]) => Promise<void>
  onExplain: (paths: string[]) => Promise<void>
}): React.ReactNode {
  const { paths } = menu
  const multi = paths.length > 1
  const extension = commonFileExtension(paths)
  const folder = !multi ? containingFolder(paths[0]) : null
  const selectedChangeLabel = `${paths.length} Selected Change${paths.length === 1 ? '' : 's'}`

  function run(action: () => void): void {
    onClose()
    action()
  }

  return (
    <div
      className="fixed inset-0 z-[95]"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        role="menu"
        className="fixed max-h-[430px] overflow-y-auto rounded-xl border border-white/15 bg-[rgba(24,31,40,0.98)] p-1.5 shadow-2xl backdrop-blur"
        style={{ left: menu.x, top: menu.y, width: FILE_CONTEXT_MENU_WIDTH }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <ContextMenuItem
          label={multi ? `Discard ${selectedChangeLabel}` : 'Discard Changes'}
          onClick={() => run(() => void onDiscard(paths))}
        />
        <ContextMenuDivider />
        <ContextMenuItem
          label={multi
            ? `Ignore ${paths.length} Selected Files (Add to .gitignore)`
            : 'Ignore File (Add to .gitignore)'}
          onClick={() => run(() => void onIgnorePatterns(paths.map(gitignoreFilePattern)))}
        />
        {folder && (
          <ContextMenuItem
            label="Ignore Folder (Add to .gitignore)"
            onClick={() => run(() => void onIgnorePatterns([gitignoreFolderPattern(folder)]))}
          />
        )}
        {extension && (
          <ContextMenuItem
            label={`Ignore All ${extension} Files (Add to .gitignore)`}
            onClick={() => run(() => void onIgnorePatterns([gitignoreExtensionPattern(extension)]))}
          />
        )}
        {multi && (
          <>
            <ContextMenuDivider />
            <ContextMenuItem label="Include Selected Files" onClick={() => run(() => onInclude(paths))} />
            <ContextMenuItem label="Exclude Selected Files" onClick={() => run(() => onExclude(paths))} />
          </>
        )}
        <ContextMenuDivider />
        <ContextMenuItem
          label={multi ? 'Copy Paths' : 'Copy File Path'}
          onClick={() => run(() => void onCopyPaths(paths, false))}
        />
        <ContextMenuItem
          label={multi ? 'Copy Relative Paths' : 'Copy Relative File Path'}
          onClick={() => run(() => void onCopyPaths(paths, true))}
        />
        <ContextMenuDivider />
        <ContextMenuItem label="Reveal in Finder" onClick={() => run(() => void onReveal(paths))} />
        <ContextMenuItem
          label="Have agent explain these changes"
          onClick={() => run(() => void onExplain(paths))}
        />
      </div>
    </div>
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
  const [emptyFileProbe, setEmptyFileProbe] = useState<EmptyFileProbe | null>(null)
  const [selectionInitialized, setSelectionInitialized] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(420)
  const [historyFilesWidth, setHistoryFilesWidth] = useState(360)
  const [commitDetailsExpanded, setCommitDetailsExpanded] = useState(false)
  const [branchSyncStatus, setBranchSyncStatus] = useState<GitBranchSyncStatus | null>(null)
  const [branchStatusLoading, setBranchStatusLoading] = useState(false)
  const [branchSyncLoading, setBranchSyncLoading] = useState(false)
  const [branchSyncError, setBranchSyncError] = useState<string | null>(null)
  const [lastFetchedByRoot, setLastFetchedByRoot] = useState<Record<string, number>>({})
  const [rootGitStates, setRootGitStates] = useState<Record<string, RootGitState>>({})
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null)
  const [fileRowSelection, setFileRowSelection] = useState<Set<string>>(new Set())
  const [fileRowSelectionAnchor, setFileRowSelectionAnchor] = useState<string | null>(null)
  const coAuthorTriggerRef = useRef<HTMLButtonElement>(null)
  const coAuthorPanelRef = useRef<HTMLDivElement>(null)
  const coAuthorInputRef = useRef<HTMLInputElement>(null)
  const changedFilesListRef = useRef<HTMLDivElement>(null)
  const historyCommitListRef = useRef<HTMLDivElement>(null)
  const historyFilesListRef = useRef<HTMLDivElement>(null)
  const windowFocused = useWindowFocused()
  const activeProject = useProjectStore((s) => s.getActiveProject())
  const root = useProjectStore((s) => s.getActiveRoot())
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveRoot = useProjectStore((s) => s.setActiveRoot)
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
  const commitDraftStatus = useGitStore((s) => (root ? s.commitDraftStatusByRoot[root.path] : undefined))
  const commitDraftError = useGitStore((s) => (root ? s.commitDraftErrorByRoot[root.path] : undefined))
  const pendingCommitDraft = useGitStore((s) => (root ? s.commitDraftByRoot[root.path] : undefined))
  const consumeCommitDraft = useGitStore((s) => s.consumeCommitDraft)
  const clearCommitDraftError = useGitStore((s) => s.clearCommitDraftError)
  const fetchStatus = useGitStore((s) => s.fetchStatus)
  const fetchSummary = useGitStore((s) => s.fetchSummary)
  const fetchHistory = useGitStore((s) => s.fetchHistory)
  const selectedFileEntry = files.find((file) => file.path === selectedFile)
  const activeRootGitState = root ? gitStateForRoot(root, rootGitStates) : 'not-git'
  const hasActiveGitRoot = !!root?.pathExists && activeRootGitState === 'git'
  const rootProbeKey = useMemo(
    () => activeProject?.roots
      .map((projectRoot) => `${projectRoot.id}:${projectRoot.path}:${projectRoot.pathExists ? '1' : '0'}`)
      .join('\n') || '',
    [activeProject?.roots]
  )

  useEffect(() => {
    const roots = activeProject?.roots || []
    if (roots.length === 0) {
      setRootGitStates({})
      return
    }

    let cancelled = false
    const initialStates: Record<string, RootGitState> = {}
    roots.forEach((projectRoot) => {
      initialStates[projectRoot.id] = projectRoot.pathExists ? 'checking' : 'not-git'
    })
    setRootGitStates(initialStates)

    roots.forEach((projectRoot) => {
      if (!projectRoot.pathExists) return

      pear.git.summary(projectRoot.path)
        .then((summary) => {
          if (cancelled) return
          setRootGitStates((current) => ({
            ...current,
            [projectRoot.id]: summary ? 'git' : 'not-git'
          }))
        })
        .catch(() => {
          if (cancelled) return
          setRootGitStates((current) => ({ ...current, [projectRoot.id]: 'not-git' }))
        })
    })

    return () => {
      cancelled = true
    }
  }, [activeProject?.id, rootProbeKey])

  useEffect(() => {
    if (!activeProject || activeProject.roots.length === 0) return
    if (root?.pathExists && activeRootGitState !== 'not-git') return

    const firstGitRoot = activeProject.roots.find((projectRoot) => rootGitStates[projectRoot.id] === 'git')
    if (firstGitRoot && firstGitRoot.id !== root?.id) {
      setActiveRoot(firstGitRoot.id)
    }
  }, [activeProject, activeRootGitState, root?.id, root?.pathExists, rootGitStates, setActiveRoot])

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
  const filteredFilePaths = useMemo(() => filteredFiles.map((file) => file.path), [filteredFiles])
  const historyCommitHashes = useMemo(() => history.map((commit) => commit.hash), [history])
  const selectedCommitFilePaths = useMemo(
    () => selectedCommit?.files.map((file) => file.path) || [],
    [selectedCommit]
  )
  const selectableLineIdsByFilePath = useMemo(() => {
    const lineIdsByFilePath = new Map<string, string[]>()

    getSelectableLineIds(diff).forEach((lineId) => {
      const filePath = getFilePathFromLineSelectionId(lineId)
      if (!filePath) return
      lineIdsByFilePath.set(filePath, [...(lineIdsByFilePath.get(filePath) || []), lineId])
    })

    return lineIdsByFilePath
  }, [diff])
  const fullySelectedLineFilePaths = useMemo(() => {
    const filePaths = new Set<string>()

    selectableLineIdsByFilePath.forEach((lineIds, filePath) => {
      if (lineIds.length > 0 && lineIds.every((lineId) => selectedLineIds.has(lineId))) {
        filePaths.add(filePath)
      }
    })

    return filePaths
  }, [selectableLineIdsByFilePath, selectedLineIds])
  const partiallySelectedFilePaths = useMemo(
    () => new Set(Array.from(selectedLineIds).map(getFilePathFromLineSelectionId).filter(Boolean)),
    [selectedLineIds]
  )
  const toggleFile = useCallback((path: string, currentlySelected = false): void => {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (currentlySelected || next.has(path)) {
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
    setFileContextMenu(null)
    setFileRowSelection(new Set())
    setFileRowSelectionAnchor(null)
  }, [root?.path])

  useEffect(() => {
    setCommitDetailsExpanded(false)
  }, [selectedCommit?.hash])

  useEffect(() => {
    if (!coAuthorPanelOpen) return
    window.requestAnimationFrame(() => {
      coAuthorInputRef.current?.focus()
    })
  }, [coAuthorPanelOpen])

  useEffect(() => {
    if (!coAuthorPanelOpen) return

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target
      if (!(target instanceof Node)) return
      if (coAuthorTriggerRef.current?.contains(target)) return
      if (coAuthorPanelRef.current?.contains(target)) return

      setCoAuthorPanelOpen(false)
      setCoAuthorInput('')
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
    }
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
    const currentPaths = new Set(files.map((file) => file.path))
    setFileRowSelection((current) => {
      const next = new Set(Array.from(current).filter((path) => currentPaths.has(path)))
      return sameStringSet(current, next) ? current : next
    })
    setFileRowSelectionAnchor((current) => current && currentPaths.has(current) ? current : null)
    setFileContextMenu((current) => {
      if (!current) return current
      const nextPaths = current.paths.filter((path) => currentPaths.has(path))
      return nextPaths.length === current.paths.length ? current : null
    })
  }, [files])

  useEffect(() => {
    if (!fileContextMenu) return

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setFileContextMenu(null)
      }
    }

    function closeMenu(): void {
      setFileContextMenu(null)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [fileContextMenu])

  useEffect(() => {
    if (activeTab !== 'changes' || !root || !hasActiveGitRoot) return

    const firstFile = files[0]?.path || null
    const selectedFileStillExists = !!selectedFile && files.some((file) => file.path === selectedFile)

    if (!firstFile) {
      if (selectedFile) selectFile(null, root.path)
      return
    }

    if (!selectedFileStillExists) {
      selectFile(firstFile, root.path)
    }
  }, [activeTab, files, hasActiveGitRoot, root, selectFile, selectedFile])

  useEffect(() => {
    if (activeTab !== 'changes' || !hasActiveGitRoot) return

    window.requestAnimationFrame(() => {
      changedFilesListRef.current?.focus({ preventScroll: true })
    })
  }, [activeTab, hasActiveGitRoot, root?.path])

  // Drain any commit draft that arrived while DiffPane was unmounted (e.g.
  // user clicked Generate, switched tabs, then came back). The store holds
  // the draft until it's consumed here.
  useEffect(() => {
    if (!root || !pendingCommitDraft) return
    const draft = consumeCommitDraft(root.path)
    if (!draft) return
    setTitle(draft.title)
    setBody(draft.body)
    setMessage('Generated commit message.')
  }, [root, pendingCommitDraft, consumeCommitDraft])

  useEffect(() => {
    if (!root || !commitDraftError) return
    setMessage(commitDraftError)
    clearCommitDraftError(root.path)
  }, [root, commitDraftError, clearCommitDraftError])

  useEffect(() => {
    if (activeTab !== 'history' || !hasActiveGitRoot) return

    window.requestAnimationFrame(() => {
      historyCommitListRef.current?.focus({ preventScroll: true })
    })
  }, [activeTab, hasActiveGitRoot, root?.path])

  useEffect(() => {
    if (!root || !hasActiveGitRoot || !selectedFileEntry || loading || diff.trim()) {
      setEmptyFileProbe(null)
      return
    }

    let cancelled = false
    const rootPath = root.path
    const filePath = selectedFileEntry.path

    setEmptyFileProbe((current) =>
      current?.rootPath === rootPath && current.path === filePath ? current : null
    )

    pear.fs.readPreview(absoluteFilePath(rootPath, filePath))
      .then((preview) => {
        if (cancelled) return
        setEmptyFileProbe({
          rootPath,
          path: filePath,
          empty: preview.kind !== 'missing' && preview.size === 0
        })
      })
      .catch(() => {
        if (!cancelled) setEmptyFileProbe({ rootPath, path: filePath, empty: false })
      })

    return () => {
      cancelled = true
    }
  }, [diff, hasActiveGitRoot, loading, root, selectedFileEntry?.path])

  useEffect(() => {
    if (activeTab !== 'changes') return
    scrollFileRowIntoView(changedFilesListRef.current, selectedFile)
  }, [activeTab, filteredFilePaths, selectedFile])

  useEffect(() => {
    if (activeTab !== 'history') return
    scrollCommitRowIntoView(historyCommitListRef.current, selectedCommit?.hash || null)
  }, [activeTab, historyCommitHashes, selectedCommit?.hash])

  useEffect(() => {
    if (activeTab !== 'history') return
    scrollFileRowIntoView(historyFilesListRef.current, selectedCommitFile)
  }, [activeTab, selectedCommitFile, selectedCommitFilePaths])

  useEffect(() => {
    if (activeTab !== 'history' || !root || !hasActiveGitRoot) return
    void fetchHistory(root.path)
  }, [activeTab, fetchHistory, hasActiveGitRoot, root])

  useEffect(() => {
    if (!root || !hasActiveGitRoot) {
      setBranchSyncStatus(null)
      setBranchStatusLoading(false)
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
  }, [hasActiveGitRoot, root, summary?.branch])

  if (!root || !root.pathExists || activeRootGitState !== 'git') {
    const rootMessage = !root
      ? 'Select a project root to see changes.'
      : !root.pathExists
        ? 'Select an available project root to see changes.'
        : activeRootGitState === 'checking'
          ? 'Checking this root for git.'
          : 'Select a git repository root to see changes.'

    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
        <div
          className="relative z-30 flex shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
          style={{ height: SOURCE_HEADER_HEIGHT }}
        >
          <CurrentRootSelector
            project={activeProject}
            activeRoot={root}
            gitStates={rootGitStates}
            width={leftSidebarWidth}
            onSelect={setActiveRoot}
          />
          <div className="flex min-w-0 flex-1 items-center px-4 text-[13px] font-medium text-[var(--pear-text-faint)]">
            {rootMessage}
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center px-8">
          <p className="text-[13px] text-[var(--pear-text-faint)]">{rootMessage}</p>
        </div>
      </div>
    )
  }

  const allVisibleSelected = filteredFiles.length > 0 &&
    filteredFiles.every((file) => selectedFiles.has(file.path) || fullySelectedLineFilePaths.has(file.path))
  const someVisibleSelected = filteredFiles.some((file) =>
    selectedFiles.has(file.path) ||
    partiallySelectedFilePaths.has(file.path) ||
    fullySelectedLineFilePaths.has(file.path)
  ) && !allVisibleSelected
  const selectedCommitFileCount = selectedChangeFileList.length
  const commitTarget = summary?.branch || 'HEAD'
  const canCommit = selectedChangeFileList.length > 0 && title.trim().length > 0 && !actionLoading
  const coAuthorPanelVisible = coAuthorPanelOpen || coAuthors.length > 0
  const showCoAuthorSuggestions =
    coAuthorPanelOpen &&
    coAuthorSuggestions.length > 0 &&
    (coAuthorInput.trim().length > 0 || coAuthors.length === 0)
  const selectedCommitFileEntry = selectedCommit?.files.find((file) => file.path === selectedCommitFile)
  const lastFetchedAt = root?.path ? lastFetchedByRoot[root.path] || null : null
  const selectedFileIsEmpty = !!selectedFileEntry &&
    emptyFileProbe?.rootPath === root.path &&
    emptyFileProbe.path === selectedFileEntry.path &&
    emptyFileProbe.empty
  const selectedFileProbePending = !!selectedFileEntry &&
    !loading &&
    !diff.trim() &&
    (
      !emptyFileProbe ||
      emptyFileProbe.rootPath !== root.path ||
      emptyFileProbe.path !== selectedFileEntry.path
    )

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

  function selectChangedFileRow(path: string, event?: React.MouseEvent): void {
    selectFile(path, root.path)

    if (event?.shiftKey && fileRowSelectionAnchor) {
      setFileRowSelection(new Set(fileRange(filteredFilePaths, fileRowSelectionAnchor, path)))
      return
    }

    if (event?.metaKey || event?.ctrlKey) {
      setFileRowSelection((current) => {
        const next = new Set(current)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next.size > 0 ? next : new Set([path])
      })
      setFileRowSelectionAnchor(path)
      return
    }

    setFileRowSelection(new Set([path]))
    setFileRowSelectionAnchor(path)
  }

  function selectChangedFilePath(path: string, extendRange = false): void {
    selectFile(path, root.path)
    if (extendRange && fileRowSelectionAnchor) {
      setFileRowSelection(new Set(fileRange(filteredFilePaths, fileRowSelectionAnchor, path)))
      return
    }
    setFileRowSelection(new Set([path]))
    setFileRowSelectionAnchor(path)
  }

  function handleChangedFileContextMenu(event: React.MouseEvent, path: string): void {
    event.preventDefault()
    event.stopPropagation()

    const selectedPaths = fileRowSelection.has(path)
      ? orderedSelectedPaths(filteredFilePaths, fileRowSelection)
      : [path]
    if (!fileRowSelection.has(path)) {
      setFileRowSelection(new Set([path]))
      setFileRowSelectionAnchor(path)
      selectFile(path, root.path)
    }

    setFileContextMenu({
      ...contextMenuPosition(event.clientX, event.clientY),
      paths: selectedPaths
    })
  }

  function handleChangedFilesKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const path = nextFilePath(filteredFilePaths, selectedFile, event.key === 'ArrowDown' ? 1 : -1)
      if (path) selectChangedFilePath(path, event.shiftKey)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (selectedFile && filteredFilePaths.includes(selectedFile)) {
        selectFile(selectedFile, root.path)
      }
      return
    }

    if (event.key === ' ') {
      event.preventDefault()
      if (selectedFile && filteredFilePaths.includes(selectedFile)) {
        const selected = selectedFiles.has(selectedFile) || fullySelectedLineFilePaths.has(selectedFile)
        toggleFile(selectedFile, selected)
      }
    }
  }

  function handleHistoryCommitsKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const hash = nextFilePath(historyCommitHashes, selectedCommit?.hash || null, event.key === 'ArrowDown' ? 1 : -1)
      const commit = hash ? history.find((entry) => entry.hash === hash) || null : null
      if (commit) void selectCommit(root.path, commit)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (selectedCommit) void selectCommit(root.path, selectedCommit)
    }
  }

  function handleHistoryFilesKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const path = nextFilePath(selectedCommitFilePaths, selectedCommitFile, event.key === 'ArrowDown' ? 1 : -1)
      if (path) {
        void selectCommitFile(root.path, path)
      }
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (selectedCommitFile && selectedCommitFilePaths.includes(selectedCommitFile)) {
        void selectCommitFile(root.path, selectedCommitFile)
      }
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
      await generateCommitMessage(root.path, {
        wholeFiles: selectedFileList,
        patch: selectedPatchInput()
      })
      // The draft is consumed by the useEffect below — works even if the
      // user navigated away from this tab while the agent was running, since
      // the draft sits in the store until DiffPane mounts and drains it.
    } catch {
      // Error is surfaced via the store; the effect below shows it.
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

  async function copySelectedCommitHash(): Promise<void> {
    if (!selectedCommit) return
    try {
      await writeClipboardText(selectedCommit.hash)
      setMessage(`Copied ${selectedCommit.shortHash}.`)
    } catch {
      setMessage('Unable to copy commit hash')
    }
  }

  function includeContextFiles(paths: string[]): void {
    setSelectedFiles((current) => new Set([...current, ...paths]))
    setSelectedLineIds((current) => {
      const next = new Set(Array.from(current).filter((id) => !paths.includes(getFilePathFromLineSelectionId(id))))
      return sameStringSet(current, next) ? current : next
    })
    setMessage(`Included ${pluralize(paths.length, 'file')}.`)
  }

  function excludeContextFiles(paths: string[]): void {
    setSelectedFiles((current) => {
      const next = new Set(current)
      paths.forEach((path) => next.delete(path))
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(Array.from(current).filter((id) => !paths.includes(getFilePathFromLineSelectionId(id))))
      return sameStringSet(current, next) ? current : next
    })
    setMessage(`Excluded ${pluralize(paths.length, 'file')}.`)
  }

  async function discardContextFiles(paths: string[]): Promise<void> {
    const confirmed = window.confirm(
      paths.length === 1
        ? `Discard changes in ${paths[0]}? This cannot be undone.`
        : `Discard changes in ${paths.length} selected files? This cannot be undone.`
    )
    if (!confirmed) return

    setMessage(null)
    try {
      await pear.git.discardFiles(root.path, paths)
      setFileRowSelection(new Set())
      setFileRowSelectionAnchor(null)
      await refreshRepository()
      setMessage(`Discarded ${pluralize(paths.length, 'change')}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to discard changes')
    }
  }

  async function ignoreContextPatterns(patterns: string[]): Promise<void> {
    setMessage(null)
    try {
      await pear.git.addGitignorePatterns(root.path, patterns)
      await refreshRepository()
      setMessage(`Updated .gitignore with ${pluralize(patterns.length, 'pattern')}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update .gitignore')
    }
  }

  async function copyContextPaths(paths: string[], relative: boolean): Promise<void> {
    try {
      const text = paths
        .map((path) => relative ? path : absoluteFilePath(root.path, path))
        .join('\n')
      await writeClipboardText(text)
      setMessage(`Copied ${relative ? 'relative ' : ''}${pluralize(paths.length, 'path')}.`)
    } catch {
      setMessage('Unable to copy paths')
    }
  }

  async function revealContextPath(paths: string[]): Promise<void> {
    const firstPath = paths[0]
    if (!firstPath) return
    try {
      await pear.fs.revealPath(absoluteFilePath(root.path, firstPath))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to reveal file')
    }
  }

  async function explainContextFiles(paths: string[]): Promise<void> {
    setMessage(null)
    try {
      if (!activeProjectId) throw new Error('No project selected')

      const projectStore = useProjectStore.getState()
      const project = projectStore.getActiveProject()
      if (!project) throw new Error('No project selected')

      await projectStore.ensureBroker()
      const liveAgents = await pear.broker.listAgents(activeProjectId)
      const existingChannels = [
        ...project.channels,
        ...liveAgents.map((agent) => agent.name),
        ...agents.flatMap((agent) => agent.channels || []),
        ...liveAgents.flatMap((agent) => agent.channels || [])
      ]
      const channelName = nextReviewChannelName(existingChannels)
      const requestedName = channelName
      const diffs = await Promise.all(paths.map((path) => pear.git.diff(root.path, path).catch(() => '')))
      const selectedDiff = compactReviewDiff(diffs.filter(Boolean).join('\n'))
      if (!selectedDiff.trim()) throw new Error('No diff available for selected files')

      const reviewRequest = [
        'Please explain these selected git changes.',
        '',
        'Focus on what changed, why it matters, and any risks or follow-up checks.',
        '',
        'Files:',
        ...paths.map((path) => `- ${path}`),
        '',
        'Diff:',
        '```diff',
        selectedDiff,
        '```'
      ].join('\n')
      const spawned = await pear.broker.spawnAgent(activeProjectId, {
        name: requestedName,
        cli: 'codex',
        cwd: root.path,
        channels: [channelName],
        task: `You are subscribed to #${channelName}. Respond in that channel to the human review request with a concise explanation of the selected git changes.`
      })
      const agentName = spawned.name || requestedName

      await pear.broker.attachTerminal({
        projectId: activeProjectId,
        name: agentName,
        mode: 'passthrough'
      }).catch(() => undefined)

      useAgentStore.getState().trackSpawnedAgent(agentName, activeProjectId, root.id, 'codex', root.path, {
        channels: [channelName],
        terminalMode: 'passthrough'
      })
      useAgentStore.getState().setActiveAgentKey(getAgentKey(activeProjectId, agentName))
      useUIStore.getState().openTab({ kind: 'channel', projectId: activeProjectId, channelName })

      await pear.broker.sendMessage(activeProjectId, {
        to: `#${channelName}`,
        text: reviewRequest,
        from: 'human'
      })
      useAgentStore.getState().addHumanMessage(`#${channelName}`, reviewRequest, activeProjectId)
      setMessage(`Spawned ${agentName} in #${channelName}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to spawn review agent')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
      <div
        className="relative z-30 flex shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
        style={{ height: SOURCE_HEADER_HEIGHT }}
      >
        <CurrentRootSelector
          project={activeProject}
          activeRoot={root}
          gitStates={rootGitStates}
          width={leftSidebarWidth}
          onSelect={setActiveRoot}
        />
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
        <PaneSidebar width={leftSidebarWidth}>
          <div className="grid h-11 shrink-0 grid-cols-2 border-b border-[var(--pear-border-subtle)]">
            <button
              type="button"
              onClick={() => setActiveTab('changes')}
              className={`flex items-center justify-center gap-2 border-b-2 px-4 text-[14px] font-semibold transition-colors hover:bg-[var(--pear-bg-surface-hover)] ${
                activeTab === 'changes'
                  ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
                  : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
              }`}
            >
              Changes
              {files.length > 0 && (
                <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[11px] leading-none text-[var(--pear-text-secondary)]">
                  {files.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`flex items-center justify-center gap-2 border-b-2 px-4 text-[14px] font-semibold transition-colors hover:bg-[var(--pear-bg-surface-hover)] ${
                activeTab === 'history'
                  ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
                  : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text-secondary)]'
              }`}
            >
              History
            </button>
          </div>

          {activeTab === 'changes' ? (
            <>
              <div className="shrink-0 border-b border-[var(--pear-border-subtle)] px-2 py-2">
                <FilterInput value={filter} onChange={setFilter} ariaLabel="Filter changed files" />
              </div>

            <div
              ref={changedFilesListRef}
              data-focus-ring="none"
              className="min-h-0 flex-1 overflow-y-auto border-b border-[var(--pear-border-subtle)]"
              tabIndex={0}
              onKeyDown={handleChangedFilesKeyDown}
              aria-label="Changed files"
            >
              <button
                type="button"
                tabIndex={-1}
                onClick={toggleAllVisible}
                role="checkbox"
                aria-checked={someVisibleSelected ? 'mixed' : allVisibleSelected}
                className="group flex h-8 w-full items-center gap-2 border-b border-[var(--pear-border-subtle)] px-2.5 text-left text-[13px] text-[var(--pear-text)] outline-none hover:bg-[var(--pear-bg-surface-hover)] focus:outline-none focus-visible:outline-none"
              >
                <SelectionCheckbox
                  state={allVisibleSelected ? 'checked' : someVisibleSelected ? 'mixed' : 'unchecked'}
                />
                <span className="flex-1">{files.length} changed file{files.length === 1 ? '' : 's'}</span>
              </button>

              {filteredFiles.length === 0 ? (
                <div className="px-3 py-8 text-[13px] text-[var(--pear-text-faint)]">
                  {files.length === 0 ? 'No changes detected' : 'No files match the filter'}
                </div>
              ) : (
                filteredFiles.map((file) => {
                  const wholeFileSelected = selectedFiles.has(file.path)
                  const fullySelectedByLines = !wholeFileSelected && fullySelectedLineFilePaths.has(file.path)
                  const selected = wholeFileSelected || fullySelectedByLines
                  const partiallySelected = !selected && partiallySelectedFilePaths.has(file.path)
                  const active = selectedFile === file.path
                  const rowActive = fileRowSelection.size > 0 ? fileRowSelection.has(file.path) : active
                  const kind = fileChangeKindFromStatus(file.status)
                  const statusLabel = fileChangeStatusLabel(kind)
                  return (
                    <div
                      key={file.path}
                      data-file-list-path={file.path}
                      onContextMenu={(event) => handleChangedFileContextMenu(event, file.path)}
                      className={`group flex h-8 items-center gap-2 border-b border-[var(--pear-border-subtle)] pr-2.5 ${
                        selectedFileRowClass(rowActive, windowFocused)
                      }`}
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => toggleFile(file.path, selected)}
                        role="checkbox"
                        aria-checked={partiallySelected ? 'mixed' : selected}
                        className="group flex h-8 w-9 shrink-0 items-center justify-center outline-none transition-colors focus:outline-none focus-visible:outline-none"
                        title={selected ? 'Unselect file' : 'Select entire file'}
                        aria-label={selected ? `Unselect ${file.path}` : `Select entire ${file.path}`}
                      >
                        <SelectionCheckbox
                          state={selected ? 'checked' : partiallySelected ? 'mixed' : 'unchecked'}
                          active={rowActive}
                          windowFocused={windowFocused}
                        />
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={(event) => selectChangedFileRow(file.path, event)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus:outline-none focus-visible:outline-none"
                      >
                        <FilePathLabel
                          path={file.path}
                          oldPath={file.oldPath}
                          className="flex-1 text-[13px]"
                          tone={selectedFilePathTone(rowActive, windowFocused)}
                        />
                        {file.staged && (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] ${
                              rowActive && windowFocused
                                ? 'bg-white/20 text-white'
                                : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)]'
                            }`}
                          >
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

            <div className="shrink-0 space-y-2.5 p-3">
              <div className="flex items-center gap-2.5">
                <CommitAuthorAvatar user={authUser} />
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Summary (required)"
                  className="h-9 min-w-0 flex-1 rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg)] px-2.5 text-[13px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30"
                />
              </div>
              <div className="rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg)] focus-within:border-[var(--pear-accent)] focus-within:ring-1 focus-within:ring-[var(--pear-accent)]/30">
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Description"
                  rows={5}
                  className="h-28 w-full resize-none border-0 bg-transparent px-2.5 py-2 text-[13px] leading-5 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
                />
                <div className="flex h-8 items-center gap-2 px-2.5 pb-2">
                  <button
                    ref={coAuthorTriggerRef}
                    type="button"
                    onClick={handleAddCoAuthor}
                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
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
                  <span className="h-6 w-px bg-[var(--pear-border)]" />
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={selectedCommitFileCount === 0 || commitDraftStatus === 'generating'}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-40"
                    title="Generate commit message"
                    aria-label="Generate commit message"
                  >
                    {commitDraftStatus === 'generating' ? <Loader2 size={15} className="animate-spin" /> : <WandSparkles size={16} />}
                  </button>
                </div>
                {coAuthorPanelVisible && (
                  <CoAuthorPicker
                    coAuthors={coAuthors}
                    inputRef={coAuthorInputRef}
                    panelRef={coAuthorPanelRef}
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
                className="flex h-9 w-full items-center justify-center rounded-md bg-[var(--pear-accent-dim)] px-3 text-[13px] font-medium text-white transition-colors hover:bg-[var(--pear-accent)] disabled:bg-[var(--pear-bg-surface)] disabled:text-[var(--pear-text-faint)]"
              >
                {actionLoading ? (
                  <Loader2 size={15} className="mr-2 animate-spin" />
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
          <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleHistoryCommitsKeyDown}>
            <div className="shrink-0 border-b border-[var(--pear-border-subtle)] p-2">
              <button
                type="button"
                tabIndex={-1}
                className="flex h-9 w-full items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-left text-[13px] text-[var(--pear-text-faint)]"
              >
                <GitBranch size={14} />
                <span className="truncate">Select Branch to Compare...</span>
              </button>
            </div>
            <div
              ref={historyCommitListRef}
              data-focus-ring="none"
              className="min-h-0 flex-1 overflow-y-auto"
              tabIndex={0}
              aria-label="Commit history"
            >
              {historyLoading && history.length === 0 ? (
                <div className="px-3 py-6 text-[13px] text-[var(--pear-text-faint)]">Loading history...</div>
              ) : history.length === 0 ? (
                <div className="px-3 py-6 text-[13px] text-[var(--pear-text-faint)]">No commits yet</div>
              ) : (
                <div>
                  {history.map((commit) => (
                    <HistoryCommit
                      key={commit.hash}
                      commit={commit}
                      active={selectedCommit?.hash === commit.hash}
                      authorAvatarUrls={avatarUrlsForCommit(commit, authUser)}
                      onSelect={() => selectCommit(root.path, commit)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </PaneSidebar>

      <button
        type="button"
        tabIndex={-1}
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
            ) : selectedFileIsEmpty ? (
              <EmptyFileState />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-[13px] text-[var(--pear-text-faint)]">
                {loading || selectedFileProbePending
                  ? 'Loading diff...'
                  : files.length === 0
                    ? 'No changes detected'
                    : selectedFileEntry
                      ? 'No diff available'
                      : 'Select a file to view its diff'}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
            {selectedCommit ? (
              <HistoryCommitDetails
                commit={selectedCommit}
                authorAvatarUrls={avatarUrlsForCommit(selectedCommit, authUser)}
                expanded={commitDetailsExpanded}
                onCopyHash={() => void copySelectedCommitHash()}
                onToggleExpanded={() => setCommitDetailsExpanded((expanded) => !expanded)}
              />
            ) : (
              <div className="flex min-h-[88px] items-center px-4 text-[13px] text-[var(--pear-text-faint)]">
                Select a commit to see its files and diff
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1">
            <PaneSidebar width={historyFilesWidth}>
              <div className="flex h-8 shrink-0 items-center justify-center border-b border-[var(--pear-border-subtle)] text-[13px] font-semibold text-[var(--pear-text)]">
                {selectedCommit?.files.length || 0} changed file{selectedCommit?.files.length === 1 ? '' : 's'}
              </div>
              <div
                ref={historyFilesListRef}
                data-focus-ring="none"
                className="min-h-0 flex-1 overflow-y-auto"
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
                        data-file-list-path={file.path}
                        onClick={() => selectCommitFile(root.path, file.path)}
                        className={`flex h-8 w-full min-w-0 items-center gap-2 border-b border-[var(--pear-border-subtle)] px-2.5 text-left outline-none focus:outline-none focus-visible:outline-none ${
                          selectedFileRowClass(active, windowFocused)
                        }`}
                      >
                        <FilePathLabel
                          path={file.path}
                          oldPath={file.oldPath}
                          className="flex-1 text-[13px]"
                          tone={selectedFilePathTone(active, windowFocused)}
                        />
                        <FileChangeStatusIcon kind={kind} label={statusLabel} />
                      </button>
                    )
                  })
                ) : (
                  <div className="px-3 py-6 text-[13px] text-[var(--pear-text-faint)]">No commit selected</div>
                )}
              </div>
            </PaneSidebar>
            <button
              type="button"
              tabIndex={-1}
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
                  <div className="flex h-full items-center justify-center px-4 text-[13px] text-[var(--pear-text-faint)]">
                    Select a commit file to see its diff
                  </div>
                )}
              </div>
            </section>
          </div>
        </section>
      )}
      </div>
      {fileContextMenu && (
        <FileContextMenu
          menu={fileContextMenu}
          onClose={() => setFileContextMenu(null)}
          onDiscard={discardContextFiles}
          onIgnorePatterns={ignoreContextPatterns}
          onInclude={includeContextFiles}
          onExclude={excludeContextFiles}
          onCopyPaths={copyContextPaths}
          onReveal={revealContextPath}
          onExplain={explainContextFiles}
        />
      )}
    </div>
  )
}
