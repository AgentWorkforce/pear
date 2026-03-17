import { create } from 'zustand'

export type ViewMode = 'terminal' | 'chat' | 'graph'
export type DialogType = 'add-workspace' | 'add-worktree' | 'spawn-agent' | null
export type Theme = 'dark' | 'light'

interface UIState {
  viewMode: ViewMode
  activeDialog: DialogType
  sidebarCollapsed: boolean
  theme: Theme

  setViewMode: (mode: ViewMode) => void
  openDialog: (dialog: DialogType) => void
  closeDialog: () => void
  toggleSidebar: () => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('pear-theme', theme)
}

const savedTheme = (typeof localStorage !== 'undefined'
  ? localStorage.getItem('pear-theme')
  : null) as Theme | null

const initialTheme: Theme = savedTheme || 'dark'

// Apply on load
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', initialTheme)
}

export const useUIStore = create<UIState>((set, get) => ({
  viewMode: 'terminal',
  activeDialog: null,
  sidebarCollapsed: false,
  theme: initialTheme,

  setViewMode: (mode) => set({ viewMode: mode }),
  openDialog: (dialog) => set({ activeDialog: dialog }),
  closeDialog: () => set({ activeDialog: null }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
  },
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    set({ theme: next })
  }
}))
