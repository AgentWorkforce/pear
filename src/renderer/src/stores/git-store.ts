import { create } from 'zustand'
import {
  pear,
  type GitCommitDraft,
  type GitCommitSelectionInput,
  type GitHistoryCommit,
  type GitSummary as IpcGitSummary
} from '@/lib/ipc'

export interface FileStatus {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

export interface ProjectFileStatus extends FileStatus {
  rootPath: string
}

export interface GitSummary extends IpcGitSummary {
  rootPath: string
}

export interface ProjectGitSummary {
  additions: number
  deletions: number
  rootCount: number
  rootPathKey: string
}

interface GitState {
  files: FileStatus[]
  projectFiles: ProjectFileStatus[]
  selectedFile: string | null
  diff: string
  summary: GitSummary | null
  projectSummary: ProjectGitSummary | null
  history: GitHistoryCommit[]
  selectedCommit: GitHistoryCommit | null
  selectedCommitFile: string | null
  commitDiff: string
  loading: boolean
  historyLoading: boolean
  actionLoading: boolean
  pollInterval: ReturnType<typeof setInterval> | null

  fetchStatus: (path: string) => Promise<void>
  fetchSummary: (path: string) => Promise<void>
  fetchProjectStatus: (paths: string[]) => Promise<void>
  fetchDiff: (rootPath: string, file?: string) => Promise<void>
  fetchHistory: (rootPath: string) => Promise<void>
  selectCommit: (rootPath: string, commit: GitHistoryCommit | null) => Promise<void>
  selectCommitFile: (rootPath: string, file: string | null) => Promise<void>
  commitSelection: (rootPath: string, input: GitCommitSelectionInput) => Promise<{ hash: string }>
  generateCommitMessage: (
    rootPath: string,
    input: { wholeFiles: string[]; patch?: string }
  ) => Promise<GitCommitDraft>
  selectFile: (file: string | null, rootPath: string) => void
  startPolling: (rootPath: string | null, projectRootPaths?: string[]) => void
  stopPolling: () => void
}

function sameFileStatuses(left: FileStatus[], right: FileStatus[]): boolean {
  if (left.length !== right.length) return false
  return left.every((file, index) => {
    const other = right[index]
    return !!other &&
      file.path === other.path &&
      file.oldPath === other.oldPath &&
      file.status === other.status &&
      file.staged === other.staged
  })
}

function sameProjectFileStatuses(left: ProjectFileStatus[], right: ProjectFileStatus[]): boolean {
  if (left.length !== right.length) return false
  return left.every((file, index) => {
    const other = right[index]
    return !!other &&
      file.rootPath === other.rootPath &&
      file.path === other.path &&
      file.oldPath === other.oldPath &&
      file.status === other.status &&
      file.staged === other.staged
  })
}

function sameGitSummary(left: GitSummary | null, right: GitSummary | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.rootPath === right.rootPath &&
    left.branch === right.branch &&
    left.additions === right.additions &&
    left.deletions === right.deletions
}

function sameProjectGitSummary(left: ProjectGitSummary | null, right: ProjectGitSummary | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.rootPathKey === right.rootPathKey &&
    left.rootCount === right.rootCount &&
    left.additions === right.additions &&
    left.deletions === right.deletions
}

function normalizeRootPaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0))
  )
}

export const useGitStore = create<GitState>((set, get) => ({
  files: [],
  projectFiles: [],
  selectedFile: null,
  diff: '',
  summary: null,
  projectSummary: null,
  history: [],
  selectedCommit: null,
  selectedCommitFile: null,
  commitDiff: '',
  loading: false,
  historyLoading: false,
  actionLoading: false,
  pollInterval: null,

  fetchStatus: async (path) => {
    try {
      const files = (await pear.git.status(path)) as FileStatus[]
      if (!sameFileStatuses(get().files, files)) set({ files })
    } catch {
      if (get().files.length > 0) set({ files: [] })
    }
  },

  fetchSummary: async (path) => {
    try {
      const summary = await pear.git.summary(path)
      const nextSummary = summary ? { ...summary, rootPath: path } : null
      if (!sameGitSummary(get().summary, nextSummary)) set({ summary: nextSummary })
    } catch {
      if (get().summary !== null) set({ summary: null })
    }
  },

  fetchProjectStatus: async (paths) => {
    const rootPaths = normalizeRootPaths(paths)
    const rootPathKey = rootPaths.join('\0')
    if (rootPaths.length === 0) {
      if (get().projectFiles.length > 0 || get().projectSummary !== null) {
        set({ projectFiles: [], projectSummary: null })
      }
      return
    }

    const entries = await Promise.all(rootPaths.map(async (rootPath) => {
      const [files, summary] = await Promise.all([
        pear.git.status(rootPath).catch(() => [] as FileStatus[]),
        pear.git.summary(rootPath).catch(() => null)
      ])
      return { rootPath, files, summary }
    }))
    const summaries = entries
      .map((entry) => entry.summary)
      .filter((summary): summary is IpcGitSummary => summary !== null)
    const projectFiles = entries.flatMap((entry) =>
      entry.files.map((file) => ({ ...file, rootPath: entry.rootPath }))
    )
    const projectSummary = summaries.length > 0
      ? {
          rootPathKey,
          rootCount: summaries.length,
          additions: summaries.reduce((total, summary) => total + summary.additions, 0),
          deletions: summaries.reduce((total, summary) => total + summary.deletions, 0)
        }
      : null

    if (
      !sameProjectFileStatuses(get().projectFiles, projectFiles) ||
      !sameProjectGitSummary(get().projectSummary, projectSummary)
    ) {
      set({ projectFiles, projectSummary })
    }
  },

  fetchDiff: async (rootPath, file?) => {
    set({ loading: true })
    try {
      const diff = await pear.git.diff(rootPath, file)
      set({ diff, loading: false })
    } catch {
      set({ diff: '', loading: false })
    }
  },

  fetchHistory: async (rootPath) => {
    set({ historyLoading: true })
    try {
      const history = await pear.git.history(rootPath, 30)
      set((state) => {
        const selectedCommit = state.selectedCommit
          ? history.find((commit) => commit.hash === state.selectedCommit?.hash) || history[0] || null
          : history[0] || null
        const selectedCommitFile = selectedCommit?.files.some((file) => file.path === state.selectedCommitFile)
          ? state.selectedCommitFile
          : selectedCommit?.files[0]?.path || null

        return {
          history,
          historyLoading: false,
          selectedCommit,
          selectedCommitFile
        }
      })
      const selectedCommit = get().selectedCommit || history[0] || null
      if (selectedCommit && get().commitDiff === '') {
        await get().selectCommit(rootPath, selectedCommit)
      }
    } catch {
      set({ history: [], selectedCommit: null, selectedCommitFile: null, commitDiff: '', historyLoading: false })
    }
  },

  selectCommit: async (rootPath, commit) => {
    const selectedCommitFile = commit?.files[0]?.path || null
    set({ selectedCommit: commit, selectedCommitFile, commitDiff: '', loading: true })
    if (!commit) {
      set({ loading: false })
      return
    }

    try {
      const commitDiff = await pear.git.show(rootPath, commit.hash, selectedCommitFile || undefined)
      set({ commitDiff, loading: false })
    } catch {
      set({ commitDiff: '', loading: false })
    }
  },

  selectCommitFile: async (rootPath, file) => {
    const commit = get().selectedCommit
    set({ selectedCommitFile: file, commitDiff: '', loading: true })
    if (!commit) {
      set({ loading: false })
      return
    }

    try {
      const commitDiff = await pear.git.show(rootPath, commit.hash, file || undefined)
      set({ commitDiff, loading: false })
    } catch {
      set({ commitDiff: '', loading: false })
    }
  },

  commitSelection: async (rootPath, input) => {
    set({ actionLoading: true })
    try {
      const result = await pear.git.commitSelection(rootPath, input)
      await get().fetchStatus(rootPath)
      await get().fetchSummary(rootPath)
      await get().fetchDiff(rootPath, get().selectedFile || undefined)
      await get().fetchHistory(rootPath)
      set({ actionLoading: false })
      return result
    } catch (error) {
      set({ actionLoading: false })
      throw error
    }
  },

  generateCommitMessage: async (rootPath, input) => {
    set({ actionLoading: true })
    try {
      const result = await pear.git.generateCommitMessage(rootPath, input)
      set({ actionLoading: false })
      return result
    } catch (error) {
      set({ actionLoading: false })
      throw error
    }
  },

  selectFile: (file, rootPath) => {
    set({ selectedFile: file, diff: '' })
    if (file) {
      get().fetchDiff(rootPath, file)
    } else {
      get().fetchDiff(rootPath)
    }
  },

  startPolling: (rootPath, projectRootPaths = rootPath ? [rootPath] : []) => {
    get().stopPolling()
    const normalizedProjectRootPaths = normalizeRootPaths(
      projectRootPaths.length > 0 ? projectRootPaths : [rootPath]
    )

    if (rootPath) {
      get().fetchStatus(rootPath)
      get().fetchSummary(rootPath)
      const selectedFile = get().selectedFile
      if (selectedFile) get().fetchDiff(rootPath, selectedFile)
    }

    if (normalizedProjectRootPaths.length > 0) {
      get().fetchProjectStatus(normalizedProjectRootPaths)
    } else {
      get().fetchProjectStatus([])
      return
    }

    const interval = setInterval(() => {
      if (rootPath) {
        get().fetchStatus(rootPath)
        get().fetchSummary(rootPath)
      }
      get().fetchProjectStatus(normalizedProjectRootPaths)
    }, 3000)
    set({ pollInterval: interval })
  },

  stopPolling: () => {
    const { pollInterval } = get()
    if (pollInterval) {
      clearInterval(pollInterval)
      set({ pollInterval: null })
    }
  }
}))
