import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { appendFile, mkdtemp, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { assertDirectory } from './path-utils'
import { cacheAvatarFromUrl, cachedAvatarUrl } from './avatar-cache'

class GitCommandError extends Error {
  code?: number | string | null
  stdout: string
  stderr: string

  constructor(message: string, options: { code?: number | string | null; stdout?: string; stderr?: string } = {}) {
    super(message)
    this.name = 'GitCommandError'
    this.code = options.code
    this.stdout = options.stdout || ''
    this.stderr = options.stderr || ''
  }
}

export interface FileStatus {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

export interface GitSummary {
  branch: string
  additions: number
  deletions: number
}

export interface GitHistoryFile {
  path: string
  oldPath?: string
  status: string
}

export interface GitHistoryCoAuthor {
  name: string
  email: string
  avatarUrl?: string
  cachedAvatarUrl?: string
}

export interface GitHistoryCommit {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  authorAvatarUrl?: string
  authorCachedAvatarUrl?: string
  coAuthors: GitHistoryCoAuthor[]
  date: string
  subject: string
  body: string
  tags: string[]
  additions: number
  deletions: number
  files: GitHistoryFile[]
}

type GitHubRepo = {
  owner: string
  repo: string
}

type GitHubPullRequestLookup = {
  baseRepo: GitHubRepo
  head: {
    owner: string
    branch: string
  }
}

type GitHubCommitAvatar = {
  authorAvatarUrl?: string
}

type GitHubPullRequestCacheEntry = {
  expiresAt: number
  pullRequests: GitPullRequest[]
}

const gitHubCommitAvatarCache = new Map<string, GitHubCommitAvatar>()
const gitHubPullRequestCache = new Map<string, GitHubPullRequestCacheEntry>()
// Git suppresses merge file details unless a merge diff strategy is requested.
const mergeDiffArgs = ['--diff-merges=first-parent']
const MAX_UNTRACKED_SUMMARY_FILES = 500
const MAX_UNTRACKED_SUMMARY_FILE_BYTES = 1024 * 1024
const GITHUB_PULL_REQUEST_CACHE_MS = 90_000
const GITHUB_CLI_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']

export interface GitCommitSelectionInput {
  title: string
  body?: string
  wholeFiles: string[]
  patch?: string
}

export interface GitBranchInfo {
  name: string
  current: boolean
  remote: boolean
  lastCommitDate: string
  defaultBranch: boolean
}

export interface GitBranchSyncStatus {
  branch: string
  remote: string | null
  upstream: string | null
  ahead: number
  behind: number
  hasRemote: boolean
}

export interface GitCheckoutBranchOptions {
  stashChanges?: boolean
}

export interface GitPullRequest {
  rootPath: string
  branch: string
  owner: string
  repo: string
  number: number
  url: string
  mergeState: 'mergeable' | 'blocked' | 'unknown'
  ciState: 'passing' | 'failing' | 'pending' | 'unknown'
  title?: string
}

function runGit(
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<string> {
  assertDirectory(cwd, 'Git working directory')

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, {
        cwd,
        env: options.env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 10 * 1024 * 1024) {
        child.kill()
        rejectOnce(new GitCommandError(`git ${args.join(' ')} exceeded output buffer`, { stdout, stderr }))
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', rejectOnce)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new GitCommandError(stderr || `git ${args.join(' ')} exited with code ${code}`, {
        code,
        stdout,
        stderr
      }))
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  assertDirectory(cwd, 'Command working directory')

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${command} ${args.join(' ')} timed out`))
    }, timeoutMs)

    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 1024 * 1024) {
        child.kill()
        rejectOnce(new Error(`${command} ${args.join(' ')} exceeded output buffer`))
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', rejectOnce)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr || `${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

async function runFirstAvailableCommand(
  commands: string[],
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  let lastError: unknown
  for (const command of commands) {
    try {
      return await runCommand(command, args, cwd, timeoutMs)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Command unavailable')
}

async function git(args: string[], cwd: string): Promise<string> {
  return runGit(args, cwd)
}

async function gitWithEnv(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return runGit(args, cwd, { env })
}

async function gitWithInput(
  args: string[],
  cwd: string,
  input: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return runGit(args, cwd, { env, input })
}

async function gitAllowNonZeroExit(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd)
  } catch (error) {
    const stdout = error instanceof Error && 'stdout' in error
      ? (error as { stdout?: unknown }).stdout
      : undefined
    if (typeof stdout === 'string') return stdout
    throw error
  }
}

function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0
  let lines = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 10) lines += 1
  }
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1
}

async function getUntrackedAdditions(path: string, files: FileStatus[]): Promise<number> {
  const untracked = files
    .filter((entry) => entry.status === 'untracked')
    .slice(0, MAX_UNTRACKED_SUMMARY_FILES)

  const counts = await Promise.all(untracked.map(async (entry) => {
    const fullPath = join(path, entry.path)
    try {
      const info = await stat(fullPath)
      if (!info.isFile() || info.size > MAX_UNTRACKED_SUMMARY_FILE_BYTES) return 0
      return countLines(await readFile(fullPath))
    } catch {
      return 0
    }
  }))

  return counts.reduce((sum, count) => sum + count, 0)
}

export async function getStatus(path: string): Promise<FileStatus[]> {
  const output = await git(['status', '--porcelain=v2', '--untracked-files'], path)
  const files: FileStatus[] = []

  for (const line of output.split('\n')) {
    if (!line) continue

    if (line.startsWith('1 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const filePath = parts.slice(8).join(' ')
      const staged = xy[0] !== '.'
      const statusChar = staged ? xy[0] : xy[1]
      files.push({
        path: filePath,
        status: statusChar === 'A' ? 'added' : statusChar === 'D' ? 'deleted' : 'modified',
        staged
      })
    } else if (line.startsWith('2 ')) {
      const [metadata, oldPath] = line.split('\t')
      const parts = metadata.split(' ')
      const xy = parts[1]
      const filePath = parts.slice(9).join(' ')
      files.push({
        path: filePath,
        oldPath,
        status: 'renamed',
        staged: xy[0] !== '.'
      })
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), status: 'untracked', staged: false })
    }
  }
  return files
}

function normalizeRelativeFilePath(file: string): string | null {
  const normalized = file.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('\0')) return null
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null
  return normalized
}

function normalizeRelativeFilePaths(files: string[]): string[] {
  return Array.from(
    new Set(files.map(normalizeRelativeFilePath).filter((file): file is string => file !== null))
  )
}

export async function discardFiles(path: string, files: string[]): Promise<void> {
  const targets = normalizeRelativeFilePaths(files)
  if (targets.length === 0) return

  const currentStatus = await getStatus(path)
  const statusByPath = new Map(currentStatus.map((file) => [file.path, file]))
  const trackedTargets = new Set<string>()
  const untrackedTargets = new Set<string>()

  for (const target of targets) {
    const status = statusByPath.get(target)
    if (status?.status === 'untracked') {
      untrackedTargets.add(target)
      continue
    }

    trackedTargets.add(target)
    if (status?.oldPath) {
      trackedTargets.add(status.oldPath)
    }
  }

  if (trackedTargets.size > 0) {
    const tracked = Array.from(trackedTargets)
    if (await hasHead(path)) {
      await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], path)
    } else {
      await gitAllowNonZeroExit(['rm', '--cached', '-r', '--', ...tracked], path).catch(() => '')
      trackedTargets.forEach((target) => untrackedTargets.add(target))
    }
  }

  if (untrackedTargets.size > 0) {
    await git(['clean', '-f', '-d', '--', ...Array.from(untrackedTargets)], path)
  }
}

function normalizeGitignorePatterns(patterns: string[]): string[] {
  return Array.from(
    new Set(
      patterns
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern && !pattern.includes('\0'))
    )
  )
}

export async function addGitignorePatterns(path: string, patterns: string[]): Promise<void> {
  const nextPatterns = normalizeGitignorePatterns(patterns)
  if (nextPatterns.length === 0) return

  const gitignorePath = join(path, '.gitignore')
  let current = ''
  try {
    current = await readFile(gitignorePath, 'utf8')
  } catch {
    current = ''
  }

  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  const missing = nextPatterns.filter((pattern) => !existing.has(pattern))
  if (missing.length === 0) return

  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  await appendFile(gitignorePath, `${prefix}${missing.join('\n')}\n`, 'utf8')
}

export async function getDiff(path: string, file?: string): Promise<string> {
  if (file) {
    try {
      const diff = await git(['diff', 'HEAD', '--', file], path)
      if (diff) return diff
    } catch {
      const stagedDiff = await gitAllowNonZeroExit(['diff', '--cached', '--', file], path)
      if (stagedDiff) return stagedDiff
    }

    if (existsSync(`${path}/${file}`)) {
      return await gitAllowNonZeroExit(['diff', '--no-index', '--', '/dev/null', file], path)
    }

    return ''
  }

  let diff = ''

  try {
    diff = await git(['diff', 'HEAD'], path)
  } catch {
    // No HEAD yet (fresh repo), include staged changes if present.
    diff = await gitAllowNonZeroExit(['diff', '--cached'], path)
  }

  return diff
}

export async function getFileContent(path: string, file: string, revision = 'HEAD'): Promise<string> {
  const normalizedFile = file.trim()
  const normalizedRevision = revision.trim() || 'HEAD'
  if (!normalizedFile) return ''

  return gitAllowNonZeroExit(['show', `${normalizedRevision}:${normalizedFile}`], path)
}

function parseNumstat(output: string): Pick<GitSummary, 'additions' | 'deletions'> {
  let additions = 0
  let deletions = 0

  for (const line of output.split('\n')) {
    if (!line) continue
    const [added, deleted] = line.split('\t')
    const addedCount = Number(added)
    const deletedCount = Number(deleted)
    if (Number.isFinite(addedCount)) additions += addedCount
    if (Number.isFinite(deletedCount)) deletions += deletedCount
  }

  return { additions, deletions }
}

async function getBranchName(path: string): Promise<string> {
  try {
    const branch = (await git(['branch', '--show-current'], path)).trim()
    if (branch) return branch
  } catch {
    // Fall back to a detached/headless label below.
  }

  try {
    const shortHash = (await git(['rev-parse', '--short', 'HEAD'], path)).trim()
    if (shortHash) return `@${shortHash}`
  } catch {
    // New repositories can be inside a work tree before HEAD exists.
  }

  return 'detached'
}

async function getTrackedNumstat(path: string): Promise<string> {
  try {
    return await git(['diff', '--numstat', 'HEAD'], path)
  } catch {
    const [unstaged, staged] = await Promise.all([
      gitAllowNonZeroExit(['diff', '--numstat'], path),
      gitAllowNonZeroExit(['diff', '--cached', '--numstat'], path)
    ])
    return [unstaged, staged].filter(Boolean).join('\n')
  }
}

export async function getSummary(path: string): Promise<GitSummary | null> {
  try {
    const insideWorkTree = (await git(['rev-parse', '--is-inside-work-tree'], path)).trim()
    if (insideWorkTree !== 'true') return null
  } catch {
    return null
  }

  const [branch, trackedNumstat, status] = await Promise.all([
    getBranchName(path),
    getTrackedNumstat(path),
    getStatus(path)
  ])
  const totals = parseNumstat(trackedNumstat)
  totals.additions += await getUntrackedAdditions(path, status)

  return {
    branch,
    additions: totals.additions,
    deletions: totals.deletions
  }
}

export async function listBranches(root: string): Promise<string[]> {
  const output = await git(['branch', '--list', '--format=%(refname:short)'], root)
  return output.split('\n').filter(Boolean)
}

async function getRemotes(path: string): Promise<string[]> {
  try {
    return (await git(['remote'], path)).split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function getPreferredRemote(path: string): Promise<string | null> {
  const remotes = await getRemotes(path)
  return remotes.includes('origin') ? 'origin' : remotes[0] || null
}

async function getDefaultRemoteBranch(path: string, remote: string | null): Promise<string | null> {
  if (!remote) return null
  try {
    const ref = (await git(['symbolic-ref', `refs/remotes/${remote}/HEAD`], path)).trim()
    const prefix = `refs/remotes/${remote}/`
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  } catch {
    // Some remotes do not have an origin/HEAD symbolic ref.
  }
  return null
}

async function getCurrentBranch(path: string): Promise<string | null> {
  const branch = (await getBranchName(path)).trim()
  return branch && !branch.startsWith('@') && branch !== 'detached' ? branch : null
}

async function getUpstreamBranch(path: string): Promise<string | null> {
  try {
    const upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], path)).trim()
    return upstream || null
  } catch {
    return null
  }
}

async function remoteRefExists(path: string, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], path)
    return true
  } catch {
    return false
  }
}

export async function listBranchDetails(path: string): Promise<GitBranchInfo[]> {
  const remote = await getPreferredRemote(path)
  const defaultRemoteBranch = await getDefaultRemoteBranch(path, remote)
  const output = await git([
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%00%(refname:short)%00%(committerdate:iso-strict)%00%(HEAD)',
    'refs/heads',
    'refs/remotes'
  ], path)

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [fullName, name, lastCommitDate = '', head = ''] = line.split('\0')
      const remotePrefix = remote ? `${remote}/` : ''
      const isRemote = !!remotePrefix && name.startsWith(remotePrefix)
      const comparableName = isRemote ? name.slice(remotePrefix.length) : name
      return {
        fullName,
        name,
        current: head === '*',
        remote: isRemote,
        lastCommitDate,
        defaultBranch: !!defaultRemoteBranch && comparableName === defaultRemoteBranch
      }
    })
    .filter((branch) => !branch.fullName.startsWith('refs/remotes/') || !branch.fullName.endsWith('/HEAD'))
    .map(({ fullName: _fullName, ...branch }) => branch)
}

export async function checkoutBranch(
  path: string,
  branch: string,
  options: GitCheckoutBranchOptions = {}
): Promise<GitBranchSyncStatus> {
  const branchName = branch.trim()
  if (!branchName || branchName.startsWith('-') || branchName.includes('..') || branchName.includes('\0')) {
    throw new Error('Invalid branch name')
  }

  const remote = await getPreferredRemote(path)
  const remotePrefix = remote ? `${remote}/` : ''

  if (options.stashChanges && (await getStatus(path)).length > 0) {
    const currentBranch = await getBranchName(path)
    await git(['stash', 'push', '-u', '-m', `Pear by Agent Relay: changes on ${currentBranch} before switching to ${branchName}`], path)
  }

  if (remotePrefix && branchName.startsWith(remotePrefix)) {
    const localBranchName = branchName.slice(remotePrefix.length)
    const localBranches = await listBranches(path)
    if (localBranches.includes(localBranchName)) {
      await git(['switch', localBranchName], path)
    } else {
      await git(['switch', '--track', branchName], path)
    }
  } else {
    await git(['switch', branchName], path)
  }

  return getBranchSyncStatus(path)
}

export async function getBranchSyncStatus(path: string): Promise<GitBranchSyncStatus> {
  const [branch, remote] = await Promise.all([
    getCurrentBranch(path),
    getPreferredRemote(path)
  ])

  if (!branch || !remote) {
    return {
      branch: branch || (await getBranchName(path)),
      remote,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: !!remote
    }
  }

  const upstream = await getUpstreamBranch(path)
  const fallbackUpstream = `${remote}/${branch}`
  const compareRef = upstream || (await remoteRefExists(path, fallbackUpstream) ? fallbackUpstream : null)

  if (!compareRef) {
    return {
      branch,
      remote,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: true
    }
  }

  const output = (await git(['rev-list', '--left-right', '--count', `HEAD...${compareRef}`], path)).trim()
  const [aheadText, behindText] = output.split(/\s+/)
  const ahead = Number.parseInt(aheadText || '0', 10)
  const behind = Number.parseInt(behindText || '0', 10)

  return {
    branch,
    remote,
    upstream: compareRef,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    hasRemote: true
  }
}

export async function fetchRemote(path: string): Promise<GitBranchSyncStatus> {
  const remote = await getPreferredRemote(path)
  if (!remote) throw new Error('No Git remote is configured')
  await git(['fetch', remote, '--prune'], path)
  return getBranchSyncStatus(path)
}

export async function pullCurrentBranch(path: string): Promise<GitBranchSyncStatus> {
  const status = await getBranchSyncStatus(path)
  if (!status.branch || status.branch === 'detached' || status.branch.startsWith('@')) {
    throw new Error('Cannot pull while detached from a branch')
  }
  if (!status.remote) throw new Error('No Git remote is configured')

  if (status.upstream) {
    await git(['pull', '--ff-only'], path)
  } else {
    await git(['pull', '--ff-only', status.remote, status.branch], path)
  }

  return getBranchSyncStatus(path)
}

export async function pushCurrentBranch(path: string): Promise<GitBranchSyncStatus> {
  const status = await getBranchSyncStatus(path)
  if (!status.branch || status.branch === 'detached' || status.branch.startsWith('@')) {
    throw new Error('Cannot push while detached from a branch')
  }
  if (!status.remote) throw new Error('No Git remote is configured')

  if (status.upstream) {
    await git(['push'], path)
  } else {
    await git(['push', '-u', status.remote, status.branch], path)
  }

  return getBranchSyncStatus(path)
}

export async function getHistory(path: string, limit = 30): Promise<GitHistoryCommit[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const [output, statsOutput] = await Promise.all([
    git([
      'log',
      `--max-count=${boundedLimit}`,
      '--date=iso-strict',
      '--decorate=full',
      '--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f%D%x1c',
      ...mergeDiffArgs,
      '--name-status'
    ], path),
    git([
      'log',
      `--max-count=${boundedLimit}`,
      '--format=%x1e%H%x1c',
      ...mergeDiffArgs,
      '--numstat'
    ], path)
  ])
  const statsByHash = parseHistoryStats(statsOutput)

  const commits = output
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [header, fileBlock = ''] = entry.split('\x1c')
      const [hash, shortHash, author, authorEmail = '', date, subject, body = '', decorations = ''] = header.split('\x1f')
      const files = fileBlock
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [status, ...paths] = line.split('\t')
          return {
            status,
            path: paths[paths.length - 1] || '',
            oldPath: paths.length > 1 ? paths[0] : undefined
          }
        })
        .filter((file) => file.path)
      const stats = statsByHash.get(hash) || { additions: 0, deletions: 0 }

      return {
        hash,
        shortHash,
        author,
        authorEmail,
        authorAvatarUrl: avatarUrlForAuthorEmail(authorEmail),
        coAuthors: parseCoAuthorTrailers(body),
        date,
        subject,
        body: body.trim(),
        tags: parseTagDecorations(decorations),
        additions: stats.additions,
        deletions: stats.deletions,
        files
      }
    })

  const githubAvatarsByHash = await fetchGitHubCommitAvatars(path, commits.map((commit) => commit.hash))
  const commitsWithGithubAvatars = commits.map((commit) => {
    const githubAvatar = githubAvatarsByHash.get(commit.hash)?.authorAvatarUrl
    return githubAvatar ? { ...commit, authorAvatarUrl: githubAvatar } : commit
  })

  return withCachedCommitAvatars(commitsWithGithubAvatars)
}

function githubUsernameFromEmail(email: string): string | null {
  const match = email.trim().match(/^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i)
  const username = match?.[1]
  return username && !username.includes('/') ? username : null
}

function avatarUrlForAuthorEmail(email: string): string | undefined {
  const githubUsername = githubUsernameFromEmail(email)
  if (githubUsername) {
    return `https://github.com/${encodeURIComponent(githubUsername)}.png?size=96`
  }

  return gravatarUrlForEmail(email)
}

function gravatarUrlForEmail(email: string): string | undefined {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return undefined

  const hash = createHash('md5').update(normalized).digest('hex')
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=96`
}

function authorAvatarCacheIdentity(name: string, email: string, sourceUrl?: string): {
  sourceUrl?: string
  githubUsername?: string
  email?: string
  name?: string
} {
  return {
    sourceUrl,
    githubUsername: githubUsernameFromEmail(email) || undefined,
    email,
    name
  }
}

async function withCachedCommitAvatars(commits: GitHistoryCommit[]): Promise<GitHistoryCommit[]> {
  return Promise.all(commits.map(async (commit) => {
    const authorIdentity = authorAvatarCacheIdentity(commit.author, commit.authorEmail, commit.authorAvatarUrl)
    const authorCachedAvatarUrl = commit.authorAvatarUrl
      ? await cacheAvatarFromUrl(commit.authorAvatarUrl, authorIdentity)
      : cachedAvatarUrl(authorIdentity)

    const coAuthors = await Promise.all(commit.coAuthors.map(async (coAuthor) => {
      const coAuthorIdentity = authorAvatarCacheIdentity(coAuthor.name, coAuthor.email, coAuthor.avatarUrl)
      const coAuthorCachedAvatarUrl = coAuthor.avatarUrl
        ? await cacheAvatarFromUrl(coAuthor.avatarUrl, coAuthorIdentity)
        : cachedAvatarUrl(coAuthorIdentity)

      return coAuthorCachedAvatarUrl
        ? { ...coAuthor, cachedAvatarUrl: coAuthorCachedAvatarUrl }
        : coAuthor
    }))

    return authorCachedAvatarUrl
      ? { ...commit, authorCachedAvatarUrl, coAuthors }
      : { ...commit, coAuthors }
  }))
}

function parseTagDecorations(decorations: string): string[] {
  return decorations
    .split(',')
    .map((decoration) => decoration.trim())
    .filter((decoration) => decoration.startsWith('tag: '))
    .map((decoration) => decoration.replace(/^tag:\s+/, '').replace(/^refs\/tags\//, ''))
    .filter(Boolean)
}

function parseCoAuthorTrailers(body: string): GitHistoryCoAuthor[] {
  const coAuthors = new Map<string, GitHistoryCoAuthor>()
  const trailerPattern = /^Co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim
  let match: RegExpExecArray | null

  while ((match = trailerPattern.exec(body)) !== null) {
    const name = match[1]?.trim()
    const email = match[2]?.trim()
    if (!name || !email) continue

    const key = email.toLowerCase()
    if (coAuthors.has(key)) continue

    const avatarUrl = avatarUrlForAuthorEmail(email)
    coAuthors.set(key, {
      name,
      email,
      ...(avatarUrl ? { avatarUrl } : {})
    })
  }

  return Array.from(coAuthors.values())
}

function parseGitHubRemoteUrl(value: string): GitHubRepo | null {
  const remoteUrl = value.trim()
  const sshMatch = remoteUrl.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i)
  if (sshMatch?.[1] && sshMatch[2]) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, '')
    }
  }

  try {
    const url = new URL(remoteUrl)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const [owner, repo] = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (!owner || !repo) return null
    return {
      owner,
      repo: repo.replace(/\.git$/i, '')
    }
  } catch {
    return null
  }
}

async function getGitHubRepo(path: string): Promise<GitHubRepo | null> {
  const remote = await getPreferredRemote(path)
  if (!remote) return null

  try {
    return parseGitHubRemoteUrl(await git(['remote', 'get-url', remote], path))
  } catch {
    return null
  }
}

async function getGitHubRepoForRemote(path: string, remote: string): Promise<GitHubRepo | null> {
  try {
    return parseGitHubRemoteUrl(await git(['remote', 'get-url', remote], path))
  } catch {
    return null
  }
}

function getRemoteFromUpstream(upstream: string, remotes: string[]): string | null {
  return remotes
    .filter((remote) => upstream.startsWith(`${remote}/`))
    .sort((left, right) => right.length - left.length)[0] || null
}

async function getGitHubPullRequestLookup(
  path: string,
  localBranch: string
): Promise<GitHubPullRequestLookup | null> {
  const remotes = await getRemotes(path)
  const preferredRemote = remotes.includes('origin') ? 'origin' : remotes[0] || null
  if (!preferredRemote) return null

  const headRepo = await getGitHubRepoForRemote(path, preferredRemote)
  if (!headRepo) return null

  let baseRepo = headRepo
  const upstreamRemote = remotes.includes('upstream')
    ? 'upstream'
    : getRemoteFromUpstream(await getUpstreamBranch(path) || '', remotes)

  if (upstreamRemote) {
    const upstreamRepo = await getGitHubRepoForRemote(path, upstreamRemote)
    if (upstreamRepo) baseRepo = upstreamRepo
  }

  return {
    baseRepo,
    head: {
      owner: headRepo.owner,
      branch: localBranch
    }
  }
}

function isGitHubPullRequestUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && /\/pull\/\d+\/?$/.test(url.pathname)
  } catch {
    return false
  }
}

function normalizePullRequestMergeState(
  value: unknown,
  draft: unknown
): GitPullRequest['mergeState'] {
  if (draft === true) return 'blocked'
  if (typeof value === 'boolean') return value ? 'mergeable' : 'blocked'
  if (typeof value !== 'string') return 'unknown'

  const normalized = value.trim().toUpperCase().replace(/-/g, '_')
  if (!normalized || normalized === 'UNKNOWN') return 'unknown'
  if (normalized === 'CLEAN' || normalized === 'HAS_HOOKS' || normalized === 'MERGEABLE') {
    return 'mergeable'
  }
  if (
    normalized === 'BLOCKED' ||
    normalized === 'BEHIND' ||
    normalized === 'DIRTY' ||
    normalized === 'DRAFT' ||
    normalized === 'UNSTABLE' ||
    normalized === 'CONFLICTING'
  ) {
    return 'blocked'
  }

  return 'unknown'
}

function collectPullRequestCiSignals(value: unknown, signals: string[] = []): string[] {
  if (value === null || value === undefined) return signals

  if (typeof value === 'string') {
    signals.push(value)
    return signals
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectPullRequestCiSignals(entry, signals))
    return signals
  }

  if (typeof value !== 'object') return signals

  const record = value as Record<string, unknown>
  for (const key of ['conclusion', 'state', 'status']) {
    const signal = record[key]
    if (typeof signal === 'string') signals.push(signal)
  }

  for (const key of ['nodes', 'checkRuns', 'check_runs', 'checkSuites', 'check_suites', 'contexts', 'statuses']) {
    collectPullRequestCiSignals(record[key], signals)
  }

  return signals
}

function normalizePullRequestCiState(value: unknown): GitPullRequest['ciState'] {
  const signals = collectPullRequestCiSignals(value)
    .map((signal) => signal.trim().toUpperCase().replace(/-/g, '_'))
    .filter(Boolean)

  if (signals.length === 0) return 'unknown'

  if (signals.some((signal) =>
    signal === 'FAILURE' ||
    signal === 'FAILED' ||
    signal === 'ERROR' ||
    signal === 'TIMED_OUT' ||
    signal === 'CANCELLED' ||
    signal === 'CANCELED' ||
    signal === 'ACTION_REQUIRED' ||
    signal === 'STARTUP_FAILURE'
  )) {
    return 'failing'
  }

  if (signals.some((signal) =>
    signal === 'PENDING' ||
    signal === 'QUEUED' ||
    signal === 'IN_PROGRESS' ||
    signal === 'REQUESTED' ||
    signal === 'WAITING' ||
    signal === 'EXPECTED'
  )) {
    return 'pending'
  }

  if (signals.some((signal) =>
    signal === 'SUCCESS' ||
    signal === 'SUCCESSFUL' ||
    signal === 'PASSED' ||
    signal === 'COMPLETED' ||
    signal === 'SKIPPED' ||
    signal === 'NEUTRAL'
  )) {
    return 'passing'
  }

  return 'unknown'
}

function normalizePullRequestPayload(
  path: string,
  branch: string,
  repo: GitHubRepo,
  value: unknown
): GitPullRequest | null {
  if (!value || typeof value !== 'object') return null

  const record = value as {
    number?: unknown
    html_url?: unknown
    url?: unknown
    title?: unknown
    state?: unknown
    draft?: unknown
    isDraft?: unknown
    mergeable?: unknown
    mergeable_state?: unknown
    mergeStateStatus?: unknown
    statusCheckRollup?: unknown
    head?: unknown
  }
  const state = typeof record.state === 'string' ? record.state.trim().toLowerCase() : ''
  if (state && state !== 'open') return null

  const number = typeof record.number === 'number' ? record.number : Number(record.number)
  if (!Number.isInteger(number) || number <= 0) return null

  const fallbackUrl = `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pull/${number}`
  const apiUrl = record.html_url || record.url
  const url = isGitHubPullRequestUrl(apiUrl) ? apiUrl : fallbackUrl
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined
  const draft = record.isDraft ?? record.draft
  const mergeState = normalizePullRequestMergeState(
    record.mergeStateStatus ?? record.mergeable_state ?? record.mergeable,
    draft
  )
  const ciState = normalizePullRequestCiState(record.statusCheckRollup)

  return {
    rootPath: path,
    branch,
    owner: repo.owner,
    repo: repo.repo,
    number,
    url,
    mergeState,
    ciState,
    ...(title ? { title } : {})
  }
}

async function fetchOpenPullRequestsWithGitHubCli(
  path: string,
  branch: string,
  repo: GitHubRepo,
  head: { branch: string }
): Promise<GitPullRequest[] | null> {
  try {
    const output = await runFirstAvailableCommand(GITHUB_CLI_CANDIDATES, [
      'pr',
      'list',
      '--state',
      'open',
      '--head',
      head.branch,
      '--repo',
      `${repo.owner}/${repo.repo}`,
      '--json',
      'number,url,title,isDraft,mergeStateStatus,statusCheckRollup',
      '--limit',
      '10'
    ], path, 2500)
    const payload = JSON.parse(output)
    if (!Array.isArray(payload)) return null

    return payload
      .map((entry) => normalizePullRequestPayload(path, branch, repo, entry))
      .filter((entry): entry is GitPullRequest => entry !== null)
  } catch {
    return null
  }
}

function githubApiHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pear-git-pull-requests'
  }
}

async function fetchGitHubJson(url: URL, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: githubApiHeaders()
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchPullRequestDetailsFromGitHubApi(
  repo: GitHubRepo,
  number: number
): Promise<unknown | null> {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${number}`
  )
  return fetchGitHubJson(url, 2500)
}

function getPullRequestHeadSha(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const head = (value as { head?: unknown }).head
  if (!head || typeof head !== 'object') return null
  const sha = (head as { sha?: unknown }).sha
  return typeof sha === 'string' && sha.trim() ? sha.trim() : null
}

async function fetchPullRequestCheckStateFromGitHubApi(
  repo: GitHubRepo,
  sha: string
): Promise<unknown[]> {
  const statusUrl = new URL(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${encodeURIComponent(sha)}/status`
  )
  const checksUrl = new URL(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${encodeURIComponent(sha)}/check-runs`
  )
  checksUrl.searchParams.set('per_page', '100')

  const [status, checks] = await Promise.all([
    fetchGitHubJson(statusUrl, 2000),
    fetchGitHubJson(checksUrl, 2000)
  ])

  return [status, checks].filter((entry) => entry !== null)
}

async function hydratePullRequestsFromGitHubApi(
  path: string,
  branch: string,
  repo: GitHubRepo,
  entries: unknown[]
): Promise<GitPullRequest[]> {
  const basePullRequests = entries
    .map((entry) => normalizePullRequestPayload(path, branch, repo, entry))
    .filter((entry): entry is GitPullRequest => entry !== null)

  const hydrated = await Promise.all(basePullRequests.map(async (pullRequest) => {
    if (pullRequest.mergeState !== 'unknown' && pullRequest.ciState !== 'unknown') return pullRequest

    const details = await fetchPullRequestDetailsFromGitHubApi(repo, pullRequest.number)
    if (!details) return pullRequest
    const headSha = getPullRequestHeadSha(details)
    const statusCheckRollup = pullRequest.ciState === 'unknown' && headSha
      ? await fetchPullRequestCheckStateFromGitHubApi(repo, headSha)
      : undefined

    const merged = normalizePullRequestPayload(path, branch, repo, {
      ...(details as Record<string, unknown>),
      number: pullRequest.number,
      html_url: pullRequest.url,
      title: pullRequest.title,
      ...(statusCheckRollup ? { statusCheckRollup } : {})
    })

    return merged || pullRequest
  }))

  return hydrated
}

async function fetchOpenPullRequestsForBranch(
  path: string,
  branch: string,
  repo: GitHubRepo,
  head: { owner: string; branch: string }
): Promise<GitPullRequest[]> {
  const cacheKey = `${repo.owner}/${repo.repo}:${head.owner}:${head.branch}`.toLowerCase()
  const cached = gitHubPullRequestCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.pullRequests.map((pullRequest) => ({
      ...pullRequest,
      rootPath: path,
      branch
    }))
  }

  const ghPullRequests = await fetchOpenPullRequestsWithGitHubCli(path, branch, repo, head)
  if (ghPullRequests !== null) {
    gitHubPullRequestCache.set(cacheKey, {
      expiresAt: Date.now() + GITHUB_PULL_REQUEST_CACHE_MS,
      pullRequests: ghPullRequests
    })
    return ghPullRequests
  }

  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`)
  url.searchParams.set('state', 'open')
  url.searchParams.set('head', `${head.owner}:${head.branch}`)
  url.searchParams.set('per_page', '10')

  const payload = await fetchGitHubJson(url, 2500)
  const pullRequests = Array.isArray(payload)
    ? await hydratePullRequestsFromGitHubApi(path, branch, repo, payload)
    : []

  gitHubPullRequestCache.set(cacheKey, {
    expiresAt: Date.now() + GITHUB_PULL_REQUEST_CACHE_MS,
    pullRequests
  })
  return pullRequests
}

async function getActivePullRequestsForRoot(path: string): Promise<GitPullRequest[]> {
  const branch = await getCurrentBranch(path)
  if (!branch) return []

  const lookup = await getGitHubPullRequestLookup(path, branch)
  if (!lookup) return []

  return fetchOpenPullRequestsForBranch(path, branch, lookup.baseRepo, lookup.head)
}

export async function getActivePullRequests(paths: string[]): Promise<GitPullRequest[]> {
  const uniquePaths = Array.from(new Set(paths.filter((path) => path.trim()))).slice(0, 20)
  if (uniquePaths.length === 0) return []

  const pullRequestGroups = await Promise.all(
    uniquePaths.map(async (path) => {
      try {
        return await getActivePullRequestsForRoot(path)
      } catch {
        return []
      }
    })
  )

  const seen = new Set<string>()
  const pullRequests: GitPullRequest[] = []
  for (const pullRequest of pullRequestGroups.flat()) {
    const key = pullRequest.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    pullRequests.push(pullRequest)
  }
  return pullRequests
}

function isGitHubAvatarUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com'
  } catch {
    return false
  }
}

async function fetchGitHubCommitAvatars(path: string, hashes: string[]): Promise<Map<string, GitHubCommitAvatar>> {
  const avatarsByHash = new Map<string, GitHubCommitAvatar>()
  const repo = await getGitHubRepo(path)
  const uniqueHashes = Array.from(new Set(hashes.filter(Boolean))).slice(0, 60)
  if (!repo || uniqueHashes.length === 0) return avatarsByHash

  const repoKey = `${repo.owner}/${repo.repo}`.toLowerCase()
  const missingHashes = uniqueHashes.filter((hash) => {
    const cached = gitHubCommitAvatarCache.get(`${repoKey}:${hash}`)
    if (cached) {
      avatarsByHash.set(hash, cached)
      return false
    }
    return true
  })
  if (missingHashes.length === 0) return avatarsByHash

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1800)

  try {
    let nextIndex = 0
    const workers = Array.from({ length: Math.min(6, missingHashes.length) }, async () => {
      while (nextIndex < missingHashes.length) {
        const hash = missingHashes[nextIndex]
        nextIndex += 1

        try {
          const response = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${encodeURIComponent(hash)}`,
            {
              signal: controller.signal,
              headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'pear-git-history'
              }
            }
          )
          if (!response.ok) continue

          const payload = await response.json() as {
            author?: {
              avatar_url?: unknown
            } | null
          }
          const avatarUrl = payload.author?.avatar_url
          if (isGitHubAvatarUrl(avatarUrl)) {
            const avatar = { authorAvatarUrl: avatarUrl }
            gitHubCommitAvatarCache.set(`${repoKey}:${hash}`, avatar)
            avatarsByHash.set(hash, avatar)
          }
        } catch {
          // Avatar enrichment is best-effort; history should still render without network access.
        }
      }
    })

    await Promise.all(workers)
  } finally {
    clearTimeout(timeout)
  }

  return avatarsByHash
}

function parseHistoryStats(output: string): Map<string, Pick<GitHistoryCommit, 'additions' | 'deletions'>> {
  const statsByHash = new Map<string, Pick<GitHistoryCommit, 'additions' | 'deletions'>>()

  for (const entry of output.split('\x1e')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const [hash, statBlock = ''] = trimmed.split('\x1c')
    const stats = parseNumstat(statBlock)
    statsByHash.set(hash.trim(), stats)
  }

  return statsByHash
}

export async function getCommitDiff(path: string, hash: string, file?: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    throw new Error('Invalid commit hash')
  }
  const args = [
    'show',
    '--format=',
    '--find-renames',
    '--find-copies',
    '--unified=3',
    ...mergeDiffArgs,
    hash
  ]
  if (file?.trim()) {
    args.push('--', file.trim())
  }
  return git(args, path)
}

async function hasHead(path: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', 'HEAD'], path)
    return true
  } catch {
    return false
  }
}

async function hasStagedChanges(path: string): Promise<boolean> {
  const status = await getStatus(path)
  return status.some((file) => file.staged)
}

function normalizeCommitMessage(input: GitCommitSelectionInput): { title: string; body: string } {
  const title = input.title.trim()
  if (!title) throw new Error('Commit summary is required')

  return {
    title,
    body: input.body?.trim() || ''
  }
}

function createCommitArgs(message: { title: string; body: string }, parentHash: string | null, treeHash: string): string[] {
  const args = ['commit-tree', treeHash]
  if (parentHash) args.push('-p', parentHash)
  args.push('-m', message.title)
  if (message.body) args.push('-m', message.body)
  return args
}

export async function commitSelection(path: string, input: GitCommitSelectionInput): Promise<{ hash: string }> {
  const message = normalizeCommitMessage(input)
  const wholeFiles = Array.from(new Set(input.wholeFiles.map((file) => file.trim()).filter(Boolean)))
  const patch = input.patch?.trim() ? `${input.patch.trimEnd()}\n` : ''

  if (wholeFiles.length === 0 && !patch) {
    throw new Error('Select at least one file or changed line to commit')
  }

  if (await hasStagedChanges(path)) {
    throw new Error('Unstage existing changes before committing a line selection')
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'pear-git-index-'))
  const tempIndex = join(tempDir, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex }

  try {
    const parentExists = await hasHead(path)
    const parentHash = parentExists ? (await git(['rev-parse', 'HEAD'], path)).trim() : null

    if (parentExists) {
      await gitWithEnv(['read-tree', 'HEAD'], path, env)
    } else {
      await gitWithEnv(['read-tree', '--empty'], path, env)
    }

    if (wholeFiles.length > 0) {
      await gitWithEnv(['add', '-A', '--', ...wholeFiles], path, env)
    }

    if (patch) {
      await gitWithInput(
        ['apply', '--cached', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'],
        path,
        patch,
        env
      )
    }

    const stagedFiles = (await gitWithEnv(['diff', '--cached', '--name-only'], path, env))
      .split('\n')
      .filter(Boolean)

    if (stagedFiles.length === 0) {
      throw new Error('Selected changes are already committed')
    }

    const treeHash = (await gitWithEnv(['write-tree'], path, env)).trim()
    const commitHash = (await gitWithEnv(createCommitArgs(message, parentHash, treeHash), path, env)).trim()
    await git(['update-ref', 'HEAD', commitHash], path)
    await git(['reset', '--mixed', '--quiet', 'HEAD'], path)

    return { hash: commitHash }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function getSelectedDiff(path: string, input: { wholeFiles: string[]; patch?: string }): Promise<string> {
  const diffs = await Promise.all(
    Array.from(new Set(input.wholeFiles.map((file) => file.trim()).filter(Boolean)))
      .map((file) => getDiff(path, file).catch(() => ''))
  )
  const patch = input.patch?.trim() ? input.patch.trim() : ''
  return [...diffs, patch].filter(Boolean).join('\n')
}
