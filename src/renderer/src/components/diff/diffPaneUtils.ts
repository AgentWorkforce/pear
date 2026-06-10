import type React from 'react'
import { useEffect, useState } from 'react'
import { getFilePathFromLineSelectionId } from '@/lib/diff-selection'
import type {
  AuthUser,
  GitBranchInfo,
  GitBranchSyncStatus,
  GitHistoryCoAuthor,
  GitHistoryCommit
} from '@/lib/ipc'
import { normalizeChannelName, type ProjectRoot } from '@/stores/project-store'
import type { Agent } from '@/stores/agent-store'
import { type FilePathLabelTone } from './FileChangeLabel'

export type PaneTab = 'changes' | 'history'
export type CoAuthor = { username: string; name?: string; cli?: string }

export const LEFT_SIDEBAR_MIN_WIDTH = 300
export const LEFT_SIDEBAR_MAX_WIDTH = 640
export const HISTORY_FILES_MIN_WIDTH = 240
export const HISTORY_FILES_MAX_WIDTH = 620
export const SOURCE_HEADER_HEIGHT = 54
export const FILE_CONTEXT_MENU_WIDTH = 360
export const FILE_CONTEXT_MENU_MAX_HEIGHT = 430
export const REVIEW_DIFF_MAX_CHARS = 24_000

export type FileContextMenuState = {
  x: number
  y: number
  paths: string[]
}
export type EmptyFileProbe = { rootPath: string; path: string; empty: boolean }

export type BranchSwitchMode = 'stash' | 'carry'
export type BranchSelectorTab = 'branches' | 'worktrees'
export type RootGitState = 'checking' | 'git' | 'not-git'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function useWindowFocused(): boolean {
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

export function selectedFileRowClass(active: boolean, _windowFocused: boolean): string {
  if (active) return 'bg-[#46515c] text-[var(--pear-text)]'
  return 'text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]'
}

export function selectedFilePathTone(active: boolean, _windowFocused: boolean): FilePathLabelTone {
  if (!active) return 'default'
  return 'selectedActive'
}

export function startPanelResize(
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

export function scrollFileRowIntoView(container: HTMLElement | null, path: string | null): void {
  if (!container || !path) return

  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-file-list-path]'))
    .find((element) => element.dataset.fileListPath === path)

  row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export function scrollCommitRowIntoView(container: HTMLElement | null, hash: string | null): void {
  if (!container || !hash) return

  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-commit-list-hash]'))
    .find((element) => element.dataset.commitListHash === hash)

  row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export function formatRelativeDate(value: string): string {
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

export function authorInitial(author: string): string {
  return author.trim().charAt(0).toUpperCase() || '?'
}

export function userInitials(user: AuthUser | null): string {
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

export function isRemoteAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

export function providedAvatarUrl(user: AuthUser | null): string | null {
  const avatarUrl = user?.avatarUrl?.trim()
  return avatarUrl && isRemoteAvatarUrl(avatarUrl) ? avatarUrl : null
}

export function uniqueAvatarUrls(urls: Array<string | null | undefined>): string[] {
  return Array.from(new Set(urls.map((url) => url?.trim()).filter((url): url is string => !!url)))
}

export function userAvatarUrls(user: AuthUser | null): string[] {
  return uniqueAvatarUrls([
    user?.cachedAvatarUrl,
    providedAvatarUrl(user)
  ])
}

export function normalizeCoAuthorUsername(value: string): string {
  return value
    .trim()
    .replace(/^@+/, '')
    .replace(/[^\w.-]/g, '')
}

export function coAuthorKey(username: string): string {
  return normalizeCoAuthorUsername(username).toLowerCase()
}

export function normalizeCoAuthor(coAuthor: CoAuthor | string): CoAuthor | null {
  const nextCoAuthor = typeof coAuthor === 'string'
    ? { username: normalizeCoAuthorUsername(coAuthor) }
    : { ...coAuthor, username: normalizeCoAuthorUsername(coAuthor.username) }

  return nextCoAuthor.username ? nextCoAuthor : null
}

export function mergeCoAuthors(coAuthors: CoAuthor[], coAuthor: CoAuthor | string): CoAuthor[] {
  const nextCoAuthor = normalizeCoAuthor(coAuthor)
  if (!nextCoAuthor) return coAuthors

  const nextKey = coAuthorKey(nextCoAuthor.username)
  if (coAuthors.some((existing) => coAuthorKey(existing.username) === nextKey)) {
    return coAuthors
  }

  return [...coAuthors, nextCoAuthor]
}

export function formatCoAuthorTrailer(coAuthor: CoAuthor): string {
  const username = normalizeCoAuthorUsername(coAuthor.username)
  return `Co-authored-by: ${username} <${username.toLowerCase()}@users.noreply.github.com>`
}

export function appendCoAuthorTrailers(body: string, coAuthors: CoAuthor[]): string {
  const trailers = coAuthors.map(formatCoAuthorTrailer)
  const trimmedBody = body.trimEnd()

  if (trailers.length === 0) return trimmedBody
  return `${trimmedBody}${trimmedBody ? '\n\n' : ''}${trailers.join('\n')}`
}

export function coAuthorSearchScore(username: string, query: string): number {
  if (!query) return 0

  const lowerUsername = username.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (lowerUsername.startsWith(lowerQuery)) return 0

  const includesIndex = lowerUsername.indexOf(lowerQuery)
  return includesIndex === -1 ? Number.POSITIVE_INFINITY : includesIndex + 10
}

export function agentToCoAuthor(agent: Agent): CoAuthor | null {
  const username = normalizeCoAuthorUsername(agent.name)
  if (!username) return null
  return {
    username,
    name: agent.model || agent.cli,
    cli: agent.cli
  }
}

export function commitMessagePreview(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
}

export function selectedChangeFiles(selectedFiles: Set<string>, selectedLineIds: Set<string>): string[] {
  const partialFiles = Array.from(selectedLineIds).map(getFilePathFromLineSelectionId)
  return Array.from(new Set([...selectedFiles, ...partialFiles])).filter(Boolean)
}

export function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

export function nextFilePath(paths: string[], currentPath: string | null, direction: 1 | -1): string | null {
  if (paths.length === 0) return null

  const currentIndex = currentPath ? paths.indexOf(currentPath) : -1
  if (currentIndex === -1) {
    return direction === 1 ? paths[0] : paths[paths.length - 1]
  }

  const nextIndex = (currentIndex + direction + paths.length) % paths.length
  return paths[nextIndex] || null
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}

export function absoluteFilePath(rootPath: string, filePath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${filePath.replace(/^[\\/]+/, '')}`
}

export function fileNameFromPath(path: string): string {
  const parts = normalizePathSeparators(path).split('/')
  return parts[parts.length - 1] || path
}

export function pathTail(path: string, depth = 2): string {
  const normalized = normalizePathSeparators(path).replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return path
  return parts.slice(-depth).join('/')
}

export function fileExtension(path: string): string | null {
  const fileName = fileNameFromPath(path)
  const index = fileName.lastIndexOf('.')
  if (index <= 0 || index === fileName.length - 1) return null
  return fileName.slice(index)
}

export function commonFileExtension(paths: string[]): string | null {
  const extensions = paths.map(fileExtension)
  const first = extensions[0]
  if (!first || extensions.some((extension) => extension !== first)) return null
  return first
}

export function containingFolder(path: string): string | null {
  const normalized = normalizePathSeparators(path).replace(/\/+$/, '')
  const separatorIndex = normalized.lastIndexOf('/')
  if (separatorIndex <= 0) return null
  return normalized.slice(0, separatorIndex)
}

export function escapeGitignorePattern(value: string): string {
  const escaped = normalizePathSeparators(value).replace(/[\\#*?\[\]]/g, '\\$&')
  return escaped.startsWith('!') ? `\\${escaped}` : escaped
}

export function gitignoreFilePattern(path: string): string {
  return `/${escapeGitignorePattern(path.replace(/^[\\/]+/, ''))}`
}

export function gitignoreFolderPattern(path: string): string {
  return `/${escapeGitignorePattern(path.replace(/^[\\/]+|[\\/]+$/g, ''))}/`
}

export function gitignoreExtensionPattern(extension: string): string {
  return `*${extension}`
}

export function compactReviewDiff(diff: string): string {
  if (diff.length <= REVIEW_DIFF_MAX_CHARS) return diff
  return `${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}\n\n[diff truncated at ${REVIEW_DIFF_MAX_CHARS} characters]`
}

export function fileRange(paths: string[], startPath: string, endPath: string): string[] {
  const startIndex = paths.indexOf(startPath)
  const endIndex = paths.indexOf(endPath)
  if (startIndex === -1 || endIndex === -1) return [endPath]

  const [start, end] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
  return paths.slice(start, end + 1)
}

export function orderedSelectedPaths(paths: string[], selectedPaths: Set<string>): string[] {
  return paths.filter((path) => selectedPaths.has(path))
}

export function contextMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const x = Math.min(clientX, Math.max(8, window.innerWidth - FILE_CONTEXT_MENU_WIDTH - 8))
  const y = Math.min(clientY, Math.max(8, window.innerHeight - FILE_CONTEXT_MENU_MAX_HEIGHT - 8))
  return { x, y }
}

export async function writeClipboardText(text: string): Promise<void> {
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

export function nextReviewChannelName(existingNames: Iterable<string>): string {
  const existing = new Set(Array.from(existingNames).map(normalizeChannelName).filter(Boolean))
  let index = 1
  while (existing.has(`review-files-${index}`)) {
    index += 1
  }
  return `review-files-${index}`
}

export function shouldPublishBranch(status: GitBranchSyncStatus | null, lastFetchedAt: number | null): boolean {
  return !!status?.hasRemote && !status.upstream && !!lastFetchedAt
}

export function syncActionLabel(status: GitBranchSyncStatus | null, loading: boolean, lastFetchedAt: number | null): string {
  if (loading) return 'Syncing...'
  if (!status?.hasRemote) return 'No remote'
  if (status.ahead > 0 && status.behind > 0) return 'Diverged'
  if (shouldPublishBranch(status, lastFetchedAt)) return 'Push branch'
  if (status.behind > 0) return `Pull ${pluralize(status.behind, 'commit')}`
  if (status.ahead > 0) return `Push ${pluralize(status.ahead, 'commit')}`
  return `Fetch ${status.remote || 'origin'}`
}

export function syncStatusText(
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

export function avatarUrlsForCommit(commit: GitHistoryCommit, authUser: AuthUser | null): string[] {
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

export function coAuthorCli(coAuthor: GitHistoryCoAuthor): string | undefined {
  const identity = `${coAuthor.name} ${coAuthor.email}`.toLowerCase()
  if (identity.includes('claude') || identity.includes('anthropic')) return 'claude'
  if (identity.includes('codex') || identity.includes('openai') || identity.includes('chatgpt')) return 'codex'
  if (identity.includes('gemini') || identity.includes('google')) return 'gemini'
  if (identity.includes('copilot')) return 'copilot'
  if (identity.includes('opencode')) return 'opencode'
  return undefined
}

export function commitCoAuthors(commit: GitHistoryCommit): GitHistoryCoAuthor[] {
  return commit.coAuthors || []
}

export function commitAuthorLabel(commit: GitHistoryCommit): string {
  return [commit.author, ...commitCoAuthors(commit).map((coAuthor) => coAuthor.name)]
    .map((name) => name.trim())
    .filter(Boolean)
    .join(', ')
}

export function gitStateForRoot(root: ProjectRoot, states: Record<string, RootGitState>): RootGitState {
  if (!root.pathExists) return 'not-git'
  return states[root.id] || 'checking'
}

export function rootStatusLabel(root: ProjectRoot, state: RootGitState): string {
  if (!root.pathExists) return 'Path missing'
  if (state === 'checking') return 'Checking git'
  if (state === 'not-git') return 'No git repo'
  return pathTail(root.path)
}

export function branchDisplayName(branch: GitBranchInfo): string {
  return branch.remote ? branch.name.replace(/^[^/]+\//, '') : branch.name
}
