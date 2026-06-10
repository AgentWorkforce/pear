import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./avatar-cache', () => ({
  cacheAvatarFromUrl: vi.fn(async () => undefined),
  cachedAvatarUrl: vi.fn(() => undefined)
}))

import {
  addGitignorePatterns,
  checkoutBranch,
  commitSelection,
  createWorktree,
  discardFiles,
  fetchRemote,
  getActivePullRequests,
  getBranchSyncStatus,
  getCommitDiff,
  getDiff,
  getFileContent,
  getGitRoot,
  getHistory,
  getSelectedDiff,
  getStatus,
  getSummary,
  listBranchDetails,
  listBranches,
  pullCurrentBranch,
  pushCurrentBranch,
  worktreeExists
} from './git'

vi.setConfig({ testTimeout: 30_000 })

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const gitEnvKeys = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_INDEX_FILE'
] as const
const originalGitEnv = new Map<string, string | undefined>()

function gitEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Pear Test',
    GIT_AUTHOR_EMAIL: 'pear@example.test',
    GIT_COMMITTER_NAME: 'Pear Test',
    GIT_COMMITTER_EMAIL: 'pear@example.test'
  }
  delete env.GIT_INDEX_FILE
  return env
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: gitEnv(),
    maxBuffer: 10 * 1024 * 1024
  })
  return String(stdout)
}

async function makeTempDir(prefix = 'pear-git-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function configureGit(repo: string): Promise<void> {
  await git(repo, ['config', 'user.name', 'Pear Test'])
  await git(repo, ['config', 'user.email', 'pear@example.test'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  await git(repo, ['config', 'tag.gpgSign', 'false'])
}

async function createRepo(): Promise<string> {
  const repo = await makeTempDir()
  await git(repo, ['init', '-b', 'main'])
  await configureGit(repo)
  return repo
}

async function write(repo: string, relativePath: string, contents: string): Promise<void> {
  const fullPath = join(repo, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, contents, 'utf8')
}

async function read(repo: string, relativePath: string): Promise<string> {
  return readFile(join(repo, relativePath), 'utf8')
}

async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--no-gpg-sign', '-m', message])
  return (await git(repo, ['rev-parse', 'HEAD'])).trim()
}

async function createRepoWithInitialCommit(): Promise<string> {
  const repo = await createRepo()
  await write(repo, 'README.md', 'initial\n')
  await commitAll(repo, 'Initial commit')
  return repo
}

async function createRepoWithRemote(): Promise<{ repo: string; remote: string }> {
  const remote = await makeTempDir('pear-git-remote-')
  await git(remote, ['init', '--bare', '-b', 'main'])

  const repo = await createRepoWithInitialCommit()
  await git(repo, ['remote', 'add', 'origin', remote])
  await git(repo, ['push', '-u', 'origin', 'main'])
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  return { repo, remote }
}

beforeEach(() => {
  for (const key of gitEnvKeys) {
    originalGitEnv.set(key, process.env[key])
  }
  process.env.GIT_AUTHOR_NAME = 'Pear Test'
  process.env.GIT_AUTHOR_EMAIL = 'pear@example.test'
  process.env.GIT_COMMITTER_NAME = 'Pear Test'
  process.env.GIT_COMMITTER_EMAIL = 'pear@example.test'
  delete process.env.GIT_INDEX_FILE
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  for (const key of gitEnvKeys) {
    const value = originalGitEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  originalGitEnv.clear()
})

describe('git status and summaries', () => {
  it('parses staged, unstaged, untracked, deleted, and renamed porcelain entries', async () => {
    const repo = await createRepo()
    await write(repo, 'tracked.txt', 'old\n')
    await write(repo, 'rename-source.txt', 'rename me\n')
    await write(repo, 'delete-staged.txt', 'remove from index\n')
    await write(repo, 'delete-worktree.txt', 'remove from worktree\n')
    await commitAll(repo, 'Seed files')

    await write(repo, 'tracked.txt', 'new\n')
    await write(repo, 'staged-new.txt', 'staged\n')
    await git(repo, ['add', 'staged-new.txt'])
    await git(repo, ['mv', 'rename-source.txt', 'renamed.txt'])
    await git(repo, ['rm', 'delete-staged.txt'])
    await rm(join(repo, 'delete-worktree.txt'))
    await write(repo, 'untracked.txt', 'loose\n')

    await expect(getStatus(repo)).resolves.toEqual(expect.arrayContaining([
      { path: 'tracked.txt', status: 'modified', staged: false },
      { path: 'staged-new.txt', status: 'added', staged: true },
      { path: 'renamed.txt', oldPath: 'rename-source.txt', status: 'renamed', staged: true },
      { path: 'delete-staged.txt', status: 'deleted', staged: true },
      { path: 'delete-worktree.txt', status: 'deleted', staged: false },
      { path: 'untracked.txt', status: 'untracked', staged: false }
    ]))
  })

  it('currently drops conflicted porcelain entries', async () => {
    const repo = await createRepo()
    await write(repo, 'conflict.txt', 'base\n')
    await commitAll(repo, 'Base')

    await git(repo, ['switch', '-c', 'feature'])
    await write(repo, 'conflict.txt', 'feature\n')
    await commitAll(repo, 'Feature change')

    await git(repo, ['switch', 'main'])
    await write(repo, 'conflict.txt', 'main\n')
    await commitAll(repo, 'Main change')

    await expect(git(repo, ['merge', 'feature'])).rejects.toMatchObject({ code: 1 })
    await expect(git(repo, ['status', '--porcelain=v2'])).resolves.toContain('u UU')

    // Current behavior: `u` records from porcelain v2 are ignored, so the UI
    // receives no entry for an unmerged file. This pins the behavior without
    // fixing it.
    expect(await getStatus(repo)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'conflict.txt' })
    ]))
  })

  it('summarizes tracked numstat and untracked file lines on the current branch', async () => {
    const repo = await createRepo()
    await write(repo, 'tracked.txt', 'one\nold\n')
    await commitAll(repo, 'Seed summary')

    await write(repo, 'tracked.txt', 'one\nnew\nextra\n')
    await write(repo, 'untracked.txt', 'loose one\nloose two\n')

    await expect(getSummary(repo)).resolves.toEqual({
      branch: 'main',
      additions: 4,
      deletions: 1
    })
  })
})

describe('git diff and content helpers', () => {
  it('generates whole-repo, per-file, staged, and untracked diffs', async () => {
    const repo = await createRepo()
    await write(repo, 'tracked.txt', 'one\nold\nthree\n')
    await commitAll(repo, 'Seed diff')

    await write(repo, 'tracked.txt', 'one\nnew\nthree\n')
    await write(repo, 'staged.txt', 'staged\n')
    await git(repo, ['add', 'staged.txt'])
    await write(repo, 'untracked.txt', 'loose\n')

    expect(await getDiff(repo)).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(await getDiff(repo, 'tracked.txt')).toContain('+new')
    expect(await getDiff(repo, 'staged.txt')).toContain('new file mode')
    expect(await getDiff(repo, 'untracked.txt')).toContain('diff --git a/untracked.txt b/untracked.txt')
  })

  it('returns empty strings for missing files instead of throwing', async () => {
    const repo = await createRepoWithInitialCommit()

    await expect(getDiff(repo, 'missing.txt')).resolves.toBe('')
    await expect(getFileContent(repo, 'missing.txt')).resolves.toBe('')
  })

  it('reads file content at explicit revisions', async () => {
    const repo = await createRepo()
    await write(repo, 'story.txt', 'first\n')
    const firstCommit = await commitAll(repo, 'First')
    await write(repo, 'story.txt', 'second\n')
    await commitAll(repo, 'Second')

    await expect(getFileContent(repo, 'story.txt', firstCommit)).resolves.toBe('first\n')
    await expect(getFileContent(repo, 'story.txt')).resolves.toBe('second\n')
  })
})

describe('selection and commit flows', () => {
  it('returns selected whole-file diffs once and appends raw patch selections', async () => {
    const repo = await createRepo()
    await write(repo, 'whole.txt', 'before\n')
    await commitAll(repo, 'Seed selected diff')
    await write(repo, 'whole.txt', 'after\n')

    const patch = [
      'diff --git a/patch.txt b/patch.txt',
      '--- a/patch.txt',
      '+++ b/patch.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after'
    ].join('\n')

    const selected = await getSelectedDiff(repo, {
      wholeFiles: [' whole.txt ', 'whole.txt'],
      patch
    })

    expect(selected.match(/diff --git a\/whole\.txt b\/whole\.txt/g)).toHaveLength(1)
    expect(selected).toContain(patch)
  })

  it('commits selected whole files and leaves unselected worktree changes behind', async () => {
    const repo = await createRepo()
    await write(repo, 'selected.txt', 'old selected\n')
    await write(repo, 'unselected.txt', 'old unselected\n')
    await commitAll(repo, 'Seed whole-file selection')

    await write(repo, 'selected.txt', 'new selected\n')
    await write(repo, 'unselected.txt', 'new unselected\n')

    const result = await commitSelection(repo, {
      title: 'Commit selected file',
      body: 'Body text',
      wholeFiles: ['selected.txt']
    })

    expect(result.hash).toMatch(/^[0-9a-f]{40}$/)
    await expect(getFileContent(repo, 'selected.txt')).resolves.toBe('new selected\n')
    expect(await read(repo, 'unselected.txt')).toBe('new unselected\n')
    expect(await getStatus(repo)).toEqual([
      { path: 'unselected.txt', status: 'modified', staged: false }
    ])
  })

  it('commits a zero-context patch hunk while preserving unselected edits in the worktree', async () => {
    const repo = await createRepo()
    await write(repo, 'patch.txt', 'line 1\nline 2\nline 3\n')
    await commitAll(repo, 'Seed patch selection')
    await write(repo, 'patch.txt', 'line 1 changed\nline 2 changed\nline 3\n')

    const patch = [
      'diff --git a/patch.txt b/patch.txt',
      '--- a/patch.txt',
      '+++ b/patch.txt',
      '@@ -1 +1 @@',
      '-line 1',
      '+line 1 changed'
    ].join('\n')

    await commitSelection(repo, {
      title: 'Commit one hunk',
      wholeFiles: [],
      patch
    })

    await expect(getFileContent(repo, 'patch.txt')).resolves.toBe('line 1 changed\nline 2\nline 3\n')
    expect(await read(repo, 'patch.txt')).toBe('line 1 changed\nline 2 changed\nline 3\n')
    expect(await getDiff(repo, 'patch.txt')).toContain('+line 2 changed')
  })

  it('rejects empty selections and pre-existing staged changes', async () => {
    const repo = await createRepo()
    await write(repo, 'file.txt', 'old\n')
    await commitAll(repo, 'Seed selection errors')

    await expect(commitSelection(repo, {
      title: 'Nothing selected',
      wholeFiles: []
    })).rejects.toThrow('Select at least one file or changed line to commit')

    await write(repo, 'file.txt', 'staged\n')
    await git(repo, ['add', 'file.txt'])
    await expect(commitSelection(repo, {
      title: 'Cannot commit with staged changes',
      wholeFiles: ['file.txt']
    })).rejects.toThrow('Unstage existing changes before committing a line selection')
  })
})

describe('branch, remote, and worktree operations', () => {
  it('lists branches, checks out local and remote-tracking branches, and reports branch details', async () => {
    const { repo } = await createRepoWithRemote()

    await git(repo, ['switch', '-c', 'feature'])
    expect(await listBranches(repo)).toEqual(expect.arrayContaining(['main', 'feature']))
    await expect(getBranchSyncStatus(repo)).resolves.toMatchObject({
      branch: 'feature',
      remote: 'origin',
      upstream: null,
      hasRemote: true
    })

    await expect(checkoutBranch(repo, 'main')).resolves.toMatchObject({
      branch: 'main',
      remote: 'origin',
      upstream: 'origin/main'
    })

    await git(repo, ['branch', 'remote-only', 'main'])
    await git(repo, ['push', 'origin', 'remote-only'])
    await git(repo, ['branch', '-D', 'remote-only'])
    await fetchRemote(repo)

    await expect(checkoutBranch(repo, 'origin/remote-only')).resolves.toMatchObject({
      branch: 'remote-only',
      remote: 'origin',
      upstream: 'origin/remote-only'
    })

    const details = await listBranchDetails(repo)
    expect(details).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'remote-only', current: true, remote: false }),
      expect.objectContaining({ name: 'origin/main', remote: true, defaultBranch: true })
    ]))
  })

  it('pushes a new branch and pulls fetched remote changes with a local bare remote', async () => {
    const { repo, remote } = await createRepoWithRemote()

    await git(repo, ['switch', '-c', 'publish-me'])
    await write(repo, 'publish.txt', 'published\n')
    await commitAll(repo, 'Publish branch')
    await expect(pushCurrentBranch(repo)).resolves.toMatchObject({
      branch: 'publish-me',
      remote: 'origin',
      upstream: 'origin/publish-me',
      ahead: 0,
      behind: 0
    })

    await git(repo, ['switch', 'main'])
    const cloneParent = await makeTempDir('pear-git-clone-')
    const clone = join(cloneParent, 'clone')
    await git(cloneParent, ['clone', remote, clone])
    await configureGit(clone)
    await write(clone, 'remote.txt', 'from remote\n')
    await commitAll(clone, 'Remote change')
    await git(clone, ['push'])

    await expect(fetchRemote(repo)).resolves.toMatchObject({
      branch: 'main',
      remote: 'origin',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1
    })
    await expect(pullCurrentBranch(repo)).resolves.toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0
    })
    await expect(read(repo, 'remote.txt')).resolves.toBe('from remote\n')
  })

  it('creates a named git worktree and detects its .git marker', async () => {
    const repo = await createRepoWithInitialCommit()
    const worktreeParent = await makeTempDir('pear-git-worktree-')
    const worktreePath = join(worktreeParent, 'feature-worktree')

    await createWorktree(repo, worktreePath, 'worktree-branch')

    expect(worktreeExists(worktreePath)).toBe(true)
    await expect(getGitRoot(worktreePath)).resolves.toBe(await realpath(worktreePath))
    await expect(listBranches(repo)).resolves.toEqual(expect.arrayContaining(['main', 'worktree-branch']))
  })
})

describe('history and commit diffs', () => {
  it('parses history metadata, tags, file stats, and commit diffs', async () => {
    const repo = await createRepo()
    await write(repo, 'history.txt', 'old\n')
    await commitAll(repo, 'Seed history')
    await write(repo, 'history.txt', 'new\nextra\n')
    await git(repo, ['add', '-A'])
    await git(repo, [
      'commit',
      '--no-gpg-sign',
      '-m',
      'Update history',
      '-m',
      'History body\n\nCo-authored-by: Ada Lovelace <ada@example.test>'
    ])
    const hash = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['tag', 'v1.0.0'])

    const [commit] = await getHistory(repo, 0)
    expect(commit).toMatchObject({
      hash,
      shortHash: hash.slice(0, 7),
      author: 'Pear Test',
      authorEmail: 'pear@example.test',
      subject: 'Update history',
      body: 'History body\n\nCo-authored-by: Ada Lovelace <ada@example.test>',
      tags: ['v1.0.0'],
      additions: 2,
      deletions: 1,
      coAuthors: [
        expect.objectContaining({
          name: 'Ada Lovelace',
          email: 'ada@example.test'
        })
      ],
      files: [
        { status: 'M', path: 'history.txt', oldPath: undefined }
      ]
    })

    await expect(getCommitDiff(repo, hash, 'history.txt')).resolves.toContain('+extra')
    await expect(getCommitDiff(repo, 'not-a-hash')).rejects.toThrow('Invalid commit hash')
  })
})

describe('cleanup helpers and error paths', () => {
  it('discards tracked, renamed, and untracked selections', async () => {
    const repo = await createRepo()
    await write(repo, 'tracked.txt', 'old\n')
    await write(repo, 'rename-source.txt', 'rename me\n')
    await commitAll(repo, 'Seed discard')

    await write(repo, 'tracked.txt', 'new\n')
    await git(repo, ['mv', 'rename-source.txt', 'renamed.txt'])
    await write(repo, 'untracked-dir/file.txt', 'loose\n')

    await discardFiles(repo, ['tracked.txt', 'renamed.txt', 'untracked-dir/file.txt'])

    await expect(read(repo, 'tracked.txt')).resolves.toBe('old\n')
    await expect(read(repo, 'rename-source.txt')).resolves.toBe('rename me\n')
    await expect(read(repo, 'renamed.txt')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(read(repo, 'untracked-dir/file.txt')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(getStatus(repo)).resolves.toEqual([])
  })

  it('adds missing gitignore patterns once and preserves existing entries', async () => {
    const repo = await createRepo()
    await write(repo, '.gitignore', 'node_modules\n')

    await addGitignorePatterns(repo, [' dist/ ', 'node_modules', '', 'coverage', 'dist/'])
    await addGitignorePatterns(repo, ['coverage', 'node_modules'])

    await expect(read(repo, '.gitignore')).resolves.toBe('node_modules\ndist/\ncoverage\n')
  })

  it('returns nullish repository metadata for non-repo directories and rejects status reads', async () => {
    const dir = await makeTempDir('pear-not-a-repo-')

    await expect(getGitRoot(dir)).resolves.toBeNull()
    await expect(getSummary(dir)).resolves.toBeNull()
    await expect(getStatus(dir)).rejects.toThrow()
  })

  it('returns no active pull requests when roots have no GitHub remote', async () => {
    const repo = await createRepoWithInitialCommit()

    await expect(getActivePullRequests([repo, repo, '   '])).resolves.toEqual([])
  })
})
