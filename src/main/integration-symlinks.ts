import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { integrationMountRootForWorkspace } from './integration-mounts'
import { toErrorMessage } from './errors'

const execFileAsync = promisify(execFile)
const gitDirCache = new Map<string, Promise<string | null>>()

// Project-relative entry point for the workspace's mirrored integration data.
// A symlink (never a real directory) so agents in the project can read
// integration files with relative paths while the actual mirror lives under
// ~/.agentworkforce/pear — and so it can be removed without touching data.
export const PROJECT_INTEGRATIONS_LINK_NAME = '.integrations'

const GIT_EXCLUDE_MARKER = '# pear: integration mount symlink (auto-managed)'

const INTEGRATION_MIRROR_TOP_LEVELS = new Set([
  'airtable',
  'asana',
  'azure-blob',
  'box',
  'calendly',
  'clickup',
  'confluence',
  'discovery',
  'docker-hub',
  'dropbox',
  'fathom',
  'gcs',
  'github',
  'gitlab',
  'gmail',
  'google-calendar',
  'google-drive',
  'google-mail',
  'granola',
  'hubspot',
  'intercom',
  'jira',
  'linear',
  'mailgun',
  'mixpanel',
  'neon',
  'notion',
  'onedrive',
  'pipedrive',
  'postgres',
  'recall',
  'redis',
  's3',
  'salesforce',
  'segment',
  'sendgrid',
  'sharepoint',
  'shopify',
  'slack',
  'stripe',
  'teams',
  'x',
  'zendesk'
])


function isFileAlreadyExistsError(error: unknown): boolean {
  return !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'EEXIST'
}

function isCrossDeviceError(error: unknown): boolean {
  return !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'EXDEV'
}

/**
 * Move a directory, falling back to copy+remove when `rename` fails with
 * EXDEV (source and destination on different filesystems/mounts — e.g. the
 * project lives on an external volume while the archive root is under the
 * user's home directory).
 */
async function safeMove(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error
    try {
      await cp(src, dest, { recursive: true })
    } catch (cpError) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined)
      throw cpError
    }
    await rm(src, { recursive: true, force: true })
  }
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

async function isGitIgnored(projectRoot: string, projectRelativePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', projectRelativePath], { cwd: projectRoot })
    return true
  } catch {
    return false
  }
}

function sanitizeArchiveSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-120) || 'project'
}

function staleIntegrationsArchiveRoot(projectRoot: string): string {
  return join(
    process.env.PEAR_INTEGRATIONS_STALE_ARCHIVE_ROOT ||
      join(homedir(), '.agentworkforce', 'pear', 'stale-project-integrations'),
    sanitizeArchiveSegment(resolve(projectRoot))
  )
}

async function looksLikeIntegrationMirrorDirectory(linkPath: string): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(linkPath)
  } catch {
    return false
  }
  if (!stats.isDirectory()) return false

  let entries: Dirent[]
  try {
    entries = await readdir(linkPath, { withFileTypes: true })
  } catch (error) {
    // An unreadable directory's contents can't be verified as mirror-shaped —
    // treating that like "empty" would risk archiving unknown user content.
    console.warn(
      `[integration-symlinks] Failed to inspect ${linkPath}; leaving it untouched:`,
      toErrorMessage(error)
    )
    return false
  }
  // Empty gitignored `.integrations` directories carry no user data and block
  // the managed symlink just like stale mirrors, so they are safe to archive.
  if (entries.length === 0) return true
  return entries.every((entry) =>
    entry.name.startsWith('.') || (entry.isDirectory() && INTEGRATION_MIRROR_TOP_LEVELS.has(entry.name))
  )
}

async function archiveStaleIntegrationMirror(projectRoot: string, linkPath: string): Promise<string | null> {
  if (!await isGitIgnored(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)) return null
  if (!await looksLikeIntegrationMirrorDirectory(linkPath)) {
    console.warn(
      `[integration-symlinks] ${linkPath} is gitignored but not shaped like an integration mirror; leaving it untouched`
    )
    return null
  }

  const archiveRoot = staleIntegrationsArchiveRoot(projectRoot)
  await mkdir(archiveRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let archivePath = join(archiveRoot, `${PROJECT_INTEGRATIONS_LINK_NAME}.stale-bak.${stamp}`)
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await safeMove(linkPath, archivePath)
      console.warn(
        `[integration-symlinks] Archived gitignored integration-shaped directory ${linkPath} -> ${archivePath}`
      )
      return archivePath
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) {
        console.warn(
          `[integration-symlinks] Failed to archive stale integration directory ${linkPath}:`,
          toErrorMessage(error)
        )
        return null
      }
      archivePath = join(archiveRoot, `${PROJECT_INTEGRATIONS_LINK_NAME}.stale-bak.${stamp}.${attempt}`)
    }
  }
  return null
}

async function verifyProjectIntegrationsLink(linkPath: string, target: string): Promise<boolean> {
  try {
    return await realpath(linkPath) === await realpath(target)
  } catch {
    return false
  }
}

async function rollbackArchivedIntegrationMirror(linkPath: string, archivePath: string): Promise<void> {
  try {
    const existing = await currentLinkTarget(linkPath)
    if (existing !== null && existing !== 'not-a-symlink') {
      await rm(linkPath, { force: true })
    }
    await safeMove(archivePath, linkPath)
    console.warn(
      `[integration-symlinks] Restored archived integration directory ${archivePath} -> ${linkPath}`
    )
  } catch (error) {
    console.warn(
      `[integration-symlinks] Failed to restore archived integration directory ${archivePath}:`,
      toErrorMessage(error)
    )
  }
}

async function createVerifiedLink(linkPath: string, target: string): Promise<boolean> {
  let createdLink = false
  try {
    await symlink(target, linkPath, 'dir')
    createdLink = true
  } catch (error) {
    if (!(isFileAlreadyExistsError(error) && await pointsAtTarget(linkPath, target))) {
      console.warn(
        `[integration-symlinks] Failed to link ${linkPath} -> ${target}:`,
        toErrorMessage(error)
      )
      return false
    }
  }
  if (await verifyProjectIntegrationsLink(linkPath, target)) return true
  if (createdLink) {
    await rm(linkPath, { force: true }).catch(() => undefined)
  }
  console.warn(
    `[integration-symlinks] Refusing integration link ${linkPath}; it does not resolve to ${target}`
  )
  return false
}

/**
 * Symlink `<projectRoot>/.integrations` → the workspace's local integration
 * mirror, and git-ignore it via info/exclude. Existing non-symlink entries
 * are left untouched unless they are ignored, integration-shaped legacy mirrors;
 * those are archived before linking so stale local data cannot shadow live
 * integration mounts.
 */
export async function ensureProjectIntegrationsLink(
  projectRoot: string,
  workspaceId: string
): Promise<void> {
  const target = integrationMountRootForWorkspace(workspaceId)
  const linkPath = linkPathFor(projectRoot)

  const existing = await currentLinkTarget(linkPath)
  if (existing === 'not-a-symlink') {
    const archivePath = await archiveStaleIntegrationMirror(projectRoot, linkPath)
    if (archivePath) {
      await ensureGitExclude(projectRoot).catch((error) => {
        console.warn(
          `[integration-symlinks] Failed to update git exclude for ${projectRoot}:`,
          toErrorMessage(error)
        )
      })
      if (await createVerifiedLink(linkPath, target)) {
        return
      }
      await rollbackArchivedIntegrationMirror(linkPath, archivePath)
      return
    }
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
  await createVerifiedLink(linkPath, target)
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
