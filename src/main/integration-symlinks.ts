import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { integrationMountRootForWorkspace } from './integration-mounts'

const execFileAsync = promisify(execFile)
const gitDirCache = new Map<string, Promise<string | null>>()

// Project-relative entry point for the workspace's mirrored integration data.
// A symlink (never a real directory) so agents in the project can read
// integration files with relative paths while the actual mirror lives under
// ~/.agentworkforce/pear — and so it can be removed without touching data.
export const PROJECT_INTEGRATIONS_LINK_NAME = '.integrations'

const GIT_EXCLUDE_MARKER = '# pear: integration mount symlink (auto-managed)'

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'EEXIST'
}

async function resolveGitDir(projectRoot: string): Promise<string | null> {
  const cacheKey = resolve(projectRoot)
  const cached = gitDirCache.get(cacheKey)
  if (cached) return cached

  const pending = (async (): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--absolute-git-dir'],
        { cwd: projectRoot }
      )
      const gitDir = stdout.trim()
      return gitDir && isAbsolute(gitDir) ? gitDir : null
    } catch {
      return null
    }
  })()
  gitDirCache.set(cacheKey, pending)

  const gitDir = await pending
  if (!gitDir) gitDirCache.delete(cacheKey)
  return gitDir
}

/**
 * Ignore the symlink via `.git/info/exclude` — per-clone ignore rules that
 * git never commits, so the link can't leak into the repo even if an agent
 * runs `git add -A`. The entry is idempotent and intentionally left in place
 * across sessions: it is invisible to the repo and keeps a stale link
 * ignored if the app exits uncleanly before unlinking.
 */
async function ensureGitExclude(projectRoot: string): Promise<void> {
  const gitDir = await resolveGitDir(projectRoot)
  if (!gitDir) return

  const excludePath = join(gitDir, 'info', 'exclude')
  const entry = `/${PROJECT_INTEGRATIONS_LINK_NAME}`
  let current = ''
  try {
    current = await readFile(excludePath, 'utf8')
  } catch {
    // Missing info/exclude — create it below.
  }

  const lines = current.split('\n')
  if (lines.some((line) => line.trim() === entry)) return

  await mkdir(dirname(excludePath), { recursive: true })
  const suffix = current.endsWith('\n') || current === '' ? '' : '\n'
  await writeFile(excludePath, `${current}${suffix}${GIT_EXCLUDE_MARKER}\n${entry}\n`)
}

function linkPathFor(projectRoot: string): string {
  return join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
}

async function currentLinkTarget(linkPath: string): Promise<string | null | 'not-a-symlink'> {
  try {
    const stats = await lstat(linkPath)
    if (!stats.isSymbolicLink()) return 'not-a-symlink'
    return await readlink(linkPath)
  } catch {
    return null
  }
}

async function pointsAtTarget(linkPath: string, target: string): Promise<boolean> {
  const existing = await currentLinkTarget(linkPath)
  if (!existing || existing === 'not-a-symlink') return false
  return resolve(dirname(linkPath), existing) === resolve(target)
}

/**
 * Symlink `<projectRoot>/.integrations` → the workspace's local integration
 * mirror, and git-ignore it via info/exclude. Existing non-symlink entries
 * (a user's real `.integrations` directory) are left untouched.
 */
export async function ensureProjectIntegrationsLink(
  projectRoot: string,
  workspaceId: string
): Promise<void> {
  const target = integrationMountRootForWorkspace(workspaceId)
  const linkPath = linkPathFor(projectRoot)

  const existing = await currentLinkTarget(linkPath)
  if (existing === 'not-a-symlink') {
    console.warn(
      `[integration-symlinks] ${linkPath} exists and is not a symlink; leaving it untouched`
    )
    return
  }

  await ensureGitExclude(projectRoot).catch((error) => {
    console.warn(
      `[integration-symlinks] Failed to update git exclude for ${projectRoot}:`,
      toErrorMessage(error)
    )
  })

  if (existing !== null && existing !== 'not-a-symlink' && await pointsAtTarget(linkPath, target)) return
  if (existing !== null) {
    await rm(linkPath, { force: true })
  }
  try {
    await symlink(target, linkPath, 'dir')
  } catch (error) {
    if (isFileAlreadyExistsError(error) && await pointsAtTarget(linkPath, target)) {
      return
    }
    console.warn(
      `[integration-symlinks] Failed to link ${linkPath} -> ${target}:`,
      toErrorMessage(error)
    )
  }
}

/**
 * Remove the managed symlink. Only ever unlinks a symlink that points into
 * pear's own mount tree — a real directory or a foreign link stays put.
 */
export async function removeProjectIntegrationsLink(projectRoot: string): Promise<void> {
  const linkPath = linkPathFor(projectRoot)
  const existing = await currentLinkTarget(linkPath)
  if (existing === null || existing === 'not-a-symlink') return
  if (!resolve(existing).includes(join('.agentworkforce', 'pear', 'relayfile'))) return
  await rm(linkPath, { force: true }).catch((error) => {
    console.warn(
      `[integration-symlinks] Failed to remove ${linkPath}:`,
      toErrorMessage(error)
    )
  })
}
