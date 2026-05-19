import { create } from 'zustand'

export type ViewMode = 'terminal' | 'chat' | 'graph'
export type DialogType = 'add-workspace' | 'add-worktree' | 'spawn-agent' | null
export type Theme = 'dark' | 'light'
export type TerminalLayout = 'tabs' | 'horizontal-split'

interface UIState {
  viewMode: ViewMode
  activeDialog: DialogType
  sidebarCollapsed: boolean
  theme: Theme
  terminalLayout: TerminalLayout

  setViewMode: (mode: ViewMode) => void
  openDialog: (dialog: DialogType) => void
  closeDialog: () => void
  toggleSidebar: () => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setTerminalLayout: (layout: TerminalLayout) => void
  toggleTerminalLayout: () => void
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('pear-theme', theme)
}

const savedTheme = (typeof localStorage !== 'undefined'
  ? localStorage.getItem('pear-theme')
  : null) as Theme | null

const initialTheme: Theme = savedTheme || 'dark'

const savedTerminalLayout = (typeof localStorage !== 'undefined'
  ? localStorage.getItem('pear-terminal-layout')
  : null) as TerminalLayout | null

const initialTerminalLayout: TerminalLayout =
  savedTerminalLayout === 'horizontal-split' ? savedTerminalLayout : 'tabs'

// Apply on load
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', initialTheme)
}

export const useUIStore = create<UIState>((set, get) => ({
  viewMode: 'terminal',
  activeDialog: null,
  sidebarCollapsed: false,
  theme: initialTheme,
  terminalLayout: initialTerminalLayout,

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
  },
  setTerminalLayout: (layout) => {
    localStorage.setItem('pear-terminal-layout', layout)
    set({ terminalLayout: layout })
  },
  toggleTerminalLayout: () => {
    const next = get().terminalLayout === 'horizontal-split' ? 'tabs' : 'horizontal-split'
    localStorage.setItem('pear-terminal-layout', next)
    set({ terminalLayout: next })
  }
}))
