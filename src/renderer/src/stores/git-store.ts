import { create } from 'zustand'
import { pear } from '@/lib/ipc'

export interface FileStatus {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

interface GitState {
  files: FileStatus[]
  selectedFile: string | null
  diff: string
  loading: boolean
  pollInterval: ReturnType<typeof setInterval> | null

  fetchStatus: (path: string) => Promise<void>
  fetchDiff: (worktreePath: string, file?: string) => Promise<void>
  selectFile: (file: string | null, worktreePath: string) => void
  startPolling: (worktreePath: string) => void
  stopPolling: () => void
}

export const useGitStore = create<GitState>((set, get) => ({
  files: [],
  selectedFile: null,
  diff: '',
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

  fetchDiff: async (worktreePath, file?) => {
    set({ loading: true })
    try {
      const diff = await pear.git.diff(worktreePath, file)
      set({ diff, loading: false })
    } catch {
      set({ diff: '', loading: false })
    }
  },

  selectFile: (file, worktreePath) => {
    set({ selectedFile: file })
    if (file) {
      get().fetchDiff(worktreePath, file)
    } else {
      get().fetchDiff(worktreePath)
    }
  },

  startPolling: (worktreePath) => {
    get().stopPolling()
    get().fetchStatus(worktreePath)
    get().fetchDiff(worktreePath)
    const interval = setInterval(() => {
      get().fetchStatus(worktreePath)
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
