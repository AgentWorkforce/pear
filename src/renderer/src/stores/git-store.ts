import { create } from 'zustand'
import { pear, type GitSummary as IpcGitSummary } from '@/lib/ipc'

export interface FileStatus {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

export interface GitSummary extends IpcGitSummary {
  rootPath: string
}

interface GitState {
  files: FileStatus[]
  selectedFile: string | null
  diff: string
  summary: GitSummary | null
  loading: boolean
  pollInterval: ReturnType<typeof setInterval> | null

  fetchStatus: (path: string) => Promise<void>
  fetchSummary: (path: string) => Promise<void>
  fetchDiff: (rootPath: string, file?: string) => Promise<void>
  selectFile: (file: string | null, rootPath: string) => void
  startPolling: (rootPath: string) => void
  stopPolling: () => void
}

export const useGitStore = create<GitState>((set, get) => ({
  files: [],
  selectedFile: null,
  diff: '',
  summary: null,
  loading: false,
  pollInterval: null,

  fetchStatus: async (path) => {
    try {
      const files = (await pear.git.status(path)) as FileStatus[]
      set({ files })
    } catch {
      set({ files: [] })
    }
  },

  fetchSummary: async (path) => {
    try {
      const summary = await pear.git.summary(path)
      set({ summary: summary ? { ...summary, rootPath: path } : null })
    } catch {
      set({ summary: null })
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

  selectFile: (file, rootPath) => {
    set({ selectedFile: file })
    if (file) {
      get().fetchDiff(rootPath, file)
    } else {
      get().fetchDiff(rootPath)
    }
  },

  startPolling: (rootPath) => {
    get().stopPolling()
    get().fetchStatus(rootPath)
    get().fetchSummary(rootPath)
    get().fetchDiff(rootPath)
    const interval = setInterval(() => {
      get().fetchStatus(rootPath)
      get().fetchSummary(rootPath)
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
