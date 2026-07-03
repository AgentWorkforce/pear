import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

const mock = vi.hoisted(() => ({
  mountRoot: ''
}))

vi.mock('./integration-mounts', () => ({
  integrationMountRootForWorkspace: vi.fn(() => mock.mountRoot)
}))

import {
  ensureProjectIntegrationsLink,
  removeProjectIntegrationsLink,
  PROJECT_INTEGRATIONS_LINK_NAME
} from './integration-symlinks'

describe('integration symlinks', () => {
  let projectRoot: string
  let mountRoot: string
  let archiveRoot: string
  let previousArchiveRoot: string | undefined

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'pear-project-'))
    archiveRoot = await mkdtemp(join(tmpdir(), 'pear-stale-integrations-'))
    previousArchiveRoot = process.env.PEAR_INTEGRATIONS_STALE_ARCHIVE_ROOT
    process.env.PEAR_INTEGRATIONS_STALE_ARCHIVE_ROOT = archiveRoot
    // Mirror pear's real layout so the safety check in remove() passes.
    mountRoot = join(
      await mkdtemp(join(tmpdir(), 'pear-home-')),
      '.agentworkforce', 'pear', 'relayfile', 'workspaces', 'ws-1', 'integrations'
    )
    await mkdir(mountRoot, { recursive: true })
    mock.mountRoot = mountRoot
  })

  afterEach(async () => {
    if (previousArchiveRoot === undefined) {
      delete process.env.PEAR_INTEGRATIONS_STALE_ARCHIVE_ROOT
    } else {
      process.env.PEAR_INTEGRATIONS_STALE_ARCHIVE_ROOT = previousArchiveRoot
    }
    await rm(projectRoot, { recursive: true, force: true })
    await rm(mountRoot, { recursive: true, force: true })
    await rm(archiveRoot, { recursive: true, force: true })
  })

  it('creates the symlink and excludes it from git', async () => {
    await execFileAsync('git', ['init'], { cwd: projectRoot })
    await writeFile(join(mountRoot, 'probe.txt'), 'data')

    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')

    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    expect(await readlink(linkPath)).toBe(mountRoot)
    expect(await readFile(join(linkPath, 'probe.txt'), 'utf8')).toBe('data')

    const exclude = await readFile(join(projectRoot, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain(`/${PROJECT_INTEGRATIONS_LINK_NAME}`)

    // git must not see the link as untracked.
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(stdout).not.toContain(PROJECT_INTEGRATIONS_LINK_NAME)

    // Idempotent — re-running keeps a single exclude entry.
    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')
    const excludeAfter = await readFile(join(projectRoot, '.git', 'info', 'exclude'), 'utf8')
    expect(excludeAfter.match(new RegExp(`/${PROJECT_INTEGRATIONS_LINK_NAME}`, 'g'))).toHaveLength(1)
  })

  it('treats concurrent creation of the desired link as success', async () => {
    await Promise.all(Array.from({ length: 5 }, () =>
      ensureProjectIntegrationsLink(projectRoot, 'ws-1')
    ))

    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    expect(await readlink(linkPath)).toBe(mountRoot)
  })

  it('works without a git repo and removes the link on shutdown', async () => {
    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')
    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)

    await removeProjectIntegrationsLink(projectRoot)
    await expect(lstat(linkPath)).rejects.toThrow()
  })

  it('never replaces or removes a real directory', async () => {
    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    await mkdir(linkPath)
    await writeFile(join(linkPath, 'user-file.txt'), 'keep me')

    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')
    expect((await lstat(linkPath)).isDirectory()).toBe(true)

    await removeProjectIntegrationsLink(projectRoot)
    expect(await readFile(join(linkPath, 'user-file.txt'), 'utf8')).toBe('keep me')
  })

  it('archives an ignored stale integration mirror before linking live mounts', async () => {
    await execFileAsync('git', ['init'], { cwd: projectRoot })
    await writeFile(join(projectRoot, '.git', 'info', 'exclude'), `/${PROJECT_INTEGRATIONS_LINK_NAME}\n`)
    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    await mkdir(join(linkPath, 'slack', 'channels'), { recursive: true })
    await writeFile(join(linkPath, 'slack', 'channels', 'old-message.json'), 'stale')
    await writeFile(join(mountRoot, 'probe.txt'), 'live')

    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')

    expect(await readlink(linkPath)).toBe(mountRoot)
    expect(await readFile(join(linkPath, 'probe.txt'), 'utf8')).toBe('live')

    const archiveProjects = await readdir(archiveRoot)
    expect(archiveProjects).toHaveLength(1)
    const archivedEntries = await readdir(join(archiveRoot, archiveProjects[0]))
    expect(archivedEntries).toHaveLength(1)
    expect(
      await readFile(join(archiveRoot, archiveProjects[0], archivedEntries[0], 'slack', 'channels', 'old-message.json'), 'utf8')
    ).toBe('stale')
  })

  it('does not archive an ignored real directory with non-integration content', async () => {
    await execFileAsync('git', ['init'], { cwd: projectRoot })
    await writeFile(join(projectRoot, '.git', 'info', 'exclude'), `/${PROJECT_INTEGRATIONS_LINK_NAME}\n`)
    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    await mkdir(join(linkPath, 'custom'), { recursive: true })
    await writeFile(join(linkPath, 'custom', 'user-file.txt'), 'keep me')

    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')

    expect((await lstat(linkPath)).isDirectory()).toBe(true)
    expect(await readFile(join(linkPath, 'custom', 'user-file.txt'), 'utf8')).toBe('keep me')
    expect(await readdir(archiveRoot)).toHaveLength(0)
  })

  it('rolls back the archive when the live symlink cannot be verified', async () => {
    await execFileAsync('git', ['init'], { cwd: projectRoot })
    await writeFile(join(projectRoot, '.git', 'info', 'exclude'), `/${PROJECT_INTEGRATIONS_LINK_NAME}\n`)
    mock.mountRoot = join(archiveRoot, 'missing-live-target')
    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    await mkdir(join(linkPath, 'linear', 'teams'), { recursive: true })
    await writeFile(join(linkPath, 'linear', 'teams', 'old-team.json'), 'stale')

    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')

    expect((await lstat(linkPath)).isDirectory()).toBe(true)
    expect(await readFile(join(linkPath, 'linear', 'teams', 'old-team.json'), 'utf8')).toBe('stale')
  })

  it('removes a newly-created symlink when the live target cannot be verified', async () => {
    mock.mountRoot = join(archiveRoot, 'missing-live-target')
    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)

    await ensureProjectIntegrationsLink(projectRoot, 'ws-1')

    await expect(lstat(linkPath)).rejects.toThrow()
  })

  it('leaves foreign symlinks alone on removal', async () => {
    const foreignTarget = join(projectRoot, 'foreign')
    await mkdir(foreignTarget)
    const linkPath = join(projectRoot, PROJECT_INTEGRATIONS_LINK_NAME)
    const { symlink } = await import('node:fs/promises')
    await symlink(foreignTarget, linkPath, 'dir')

    await removeProjectIntegrationsLink(projectRoot)
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })
})
