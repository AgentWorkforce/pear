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
  fetchDiff: (rootPath: string, file?: string) => Promise<void>
  selectFile: (file: string | null, rootPath: string) => void
  startPolling: (rootPath: string) => void
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
    get().fetchDiff(rootPath)
    const interval = setInterval(() => {
      get().fetchStatus(rootPath)
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
