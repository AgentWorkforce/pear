import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import { assertDirectory } from './path-utils'

const exec = promisify(execFile)

export interface FileStatus {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

async function git(args: string[], cwd: string): Promise<string> {
  assertDirectory(cwd, 'Git working directory')
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return stdout
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
      const parts = line.split('\t')
      files.push({ path: parts[parts.length - 1], status: 'renamed', staged: true })
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), status: 'untracked', staged: false })
    }
  }
  return files
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

  const status = await getStatus(path)
  const untrackedDiffs = await Promise.all(
    status
      .filter((entry) => entry.status === 'untracked')
      .map((entry) => gitAllowNonZeroExit(['diff', '--no-index', '--', '/dev/null', entry.path], path))
  )

  return [diff, ...untrackedDiffs].filter(Boolean).join('\n')
}

export async function listBranches(root: string): Promise<string[]> {
  const output = await git(['branch', '--list', '--format=%(refname:short)'], root)
  return output.split('\n').filter(Boolean)
}
