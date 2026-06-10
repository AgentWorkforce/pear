import { create } from 'zustand'
import {
  pear,
  type GitCommitDraft,
  type GitCommitSelectionInput,
  type GitFileStatus,
  type GitHistoryCommit,
  type GitSummary as IpcGitSummary
} from '@/lib/ipc'

export type FileStatus = GitFileStatus

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

export type CommitDraftStatus = 'idle' | 'generating' | 'ready' | 'error'

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

  // Commit-draft generation state, keyed by rootPath, so a draft kicked off
  // from the file-changes tab still lands here if the user navigates away
  // before the agent submits its result.
  commitDraftByRoot: Record<string, GitCommitDraft | undefined>
  commitDraftStatusByRoot: Record<string, CommitDraftStatus | undefined>
  commitDraftErrorByRoot: Record<string, string | undefined>

  fetchStatus: (path: string) => Promise<void>
  fetchSummary: (path: string) => Promise<void>
  fetchProjectStatus: (paths: string[]) => Promise<void>
  fetchDiff: (rootPath: string, file?: string) => Promise<void>
  fetchHistory: (rootPath: string) => Promise<void>
  selectCommit: (rootPath: string, commit: GitHistoryCommit | null) => Promise<void>
  selectCommitFile: (rootPath: string, file: string | null) => Promise<void>
  commitSelection: (rootPath: string, input: GitCommitSelectionInput) => Promise<{ hash: string }>
  generateCommitMessage: (
    projectId: string,
    rootPath: string,
    input: { wholeFiles: string[]; patch?: string }
  ) => Promise<GitCommitDraft>
  consumeCommitDraft: (rootPath: string) => GitCommitDraft | null
  clearCommitDraftError: (rootPath: string) => void
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
      file.staged === other.staged &&
      file.conflicted === other.conflicted
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
      file.staged === other.staged &&
      file.conflicted === other.conflicted
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

const statusRequests = new Set<string>()
const summaryRequests = new Set<string>()
const projectStatusRequests = new Set<string>()
const diffRequests = new Set<string>()

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
  commitDraftByRoot: {},
  commitDraftStatusByRoot: {},
  commitDraftErrorByRoot: {},

  fetchStatus: async (path) => {
    if (statusRequests.has(path)) return
    statusRequests.add(path)
    try {
      const files = await pear.git.status(path)
      if (!sameFileStatuses(get().files, files)) set({ files })
    } catch {
      if (get().files.length > 0) set({ files: [] })
    } finally {
      statusRequests.delete(path)
    }
  },

  fetchSummary: async (path) => {
    if (summaryRequests.has(path)) return
    summaryRequests.add(path)
    try {
      const summary = await pear.git.summary(path)
      const nextSummary = summary ? { ...summary, rootPath: path } : null
      if (!sameGitSummary(get().summary, nextSummary)) set({ summary: nextSummary })
    } catch {
      if (get().summary !== null) set({ summary: null })
    } finally {
      summaryRequests.delete(path)
    }
  },

  fetchProjectStatus: async (paths) => {
    const rootPaths = normalizeRootPaths(paths)
    const rootPathKey = rootPaths.join('\0')
    if (projectStatusRequests.has(rootPathKey)) return
    if (rootPaths.length === 0) {
      if (get().projectFiles.length > 0 || get().projectSummary !== null) {
        set({ projectFiles: [], projectSummary: null })
      }
      return
    }

    projectStatusRequests.add(rootPathKey)
    try {
      const entries = await Promise.all(rootPaths.map(async (rootPath) => {
        // Per-root git reads degrade independently: a non-repo or transiently
        // locked root falls back to empty/null so one bad root can't blank the
        // whole multi-root status sweep. The main process logs the real git error.
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
    } finally {
      projectStatusRequests.delete(rootPathKey)
    }
  },

  fetchDiff: async (rootPath, file?) => {
    const key = `${rootPath}:${file || ''}`
    if (diffRequests.has(key)) return
    diffRequests.add(key)
    set({ loading: true })
    try {
      const diff = await pear.git.diff(rootPath, file)
      set({ diff, loading: false })
    } catch {
      set({ diff: '', loading: false })
    } finally {
      diffRequests.delete(key)
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

  generateCommitMessage: async (projectId, rootPath, input) => {
    set((state) => ({
      actionLoading: true,
      commitDraftStatusByRoot: { ...state.commitDraftStatusByRoot, [rootPath]: 'generating' },
      commitDraftErrorByRoot: { ...state.commitDraftErrorByRoot, [rootPath]: undefined }
    }))
    try {
      const result = await pear.git.generateCommitMessage(projectId, rootPath, input)
      set((state) => ({
        actionLoading: false,
        commitDraftByRoot: { ...state.commitDraftByRoot, [rootPath]: result },
        commitDraftStatusByRoot: { ...state.commitDraftStatusByRoot, [rootPath]: 'ready' }
      }))
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to generate commit message'
      set((state) => ({
        actionLoading: false,
        commitDraftStatusByRoot: { ...state.commitDraftStatusByRoot, [rootPath]: 'error' },
        commitDraftErrorByRoot: { ...state.commitDraftErrorByRoot, [rootPath]: message }
      }))
      throw error
    }
  },

  consumeCommitDraft: (rootPath) => {
    const draft = get().commitDraftByRoot[rootPath]
    if (!draft) return null
    set((state) => {
      const nextDrafts = { ...state.commitDraftByRoot }
      delete nextDrafts[rootPath]
      const nextStatus = { ...state.commitDraftStatusByRoot }
      delete nextStatus[rootPath]
      return { commitDraftByRoot: nextDrafts, commitDraftStatusByRoot: nextStatus }
    })
    return draft
  },

  clearCommitDraftError: (rootPath) => {
    set((state) => {
      const nextErrors = { ...state.commitDraftErrorByRoot }
      delete nextErrors[rootPath]
      const nextStatus = { ...state.commitDraftStatusByRoot }
      if (nextStatus[rootPath] === 'error') delete nextStatus[rootPath]
      return { commitDraftErrorByRoot: nextErrors, commitDraftStatusByRoot: nextStatus }
    })
  },

  selectFile: (file, rootPath) => {
    set({ selectedFile: file, diff: '' })
    if (file) {
      get().fetchDiff(rootPath, file)
    } else {
      set({ diff: '', loading: false })
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
