import { create } from 'zustand'
import {
  getDirectMessageRoomId,
  getDirectMessageRoomTitle,
  sortDirectMessageParticipants
} from '@/lib/direct-messages'

export type ViewMode = 'terminal' | 'chat' | 'graph' | 'project-settings' | 'broker-details' | 'source-control'
export type DialogType = 'add-project' | 'spawn-agent' | 'command-menu' | null
export type Theme = 'dark' | 'light'
export type TerminalLayout = 'tabs' | 'horizontal-split'
export type AppTabKind = 'agents' | 'channel' | 'dm' | 'project-settings' | 'broker-details' | 'source-control'

export interface AppTab {
  id: string
  kind: AppTabKind
  title: string
  projectId?: string
  channelName?: string
  dmParticipants?: string[]
}

export type AppTabInput = Omit<AppTab, 'id' | 'title'> & {
  title?: string
}

export interface RecentTab extends AppTab {
  viewedAt: number
}

interface UIState {
  viewMode: ViewMode
  tabs: AppTab[]
  activeTabId: string
  history: string[]
  historyIndex: number
  recentTabs: RecentTab[]
  activeDialog: DialogType
  sidebarCollapsed: boolean
  theme: Theme
  terminalLayout: TerminalLayout

  setViewMode: (mode: ViewMode) => void
  openTab: (tab: AppTabInput) => void
  activateTab: (id: string) => void
  closeTab: (id: string) => void
  closeActiveTab: () => void
  navigateBack: () => void
  navigateForward: () => void
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
  savedTerminalLayout === 'tabs' ? savedTerminalLayout : 'horizontal-split'

// Apply on load
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', initialTheme)
}

function normalizeChannelForTab(channelName: string | undefined): string | undefined {
  const normalized = channelName?.trim().replace(/^#/, '')
  return normalized || undefined
}

function getTabId(tab: AppTabInput): string {
  switch (tab.kind) {
    case 'agents':
      return 'agents'
    case 'channel':
      return `channel:${tab.projectId || 'all'}:${normalizeChannelForTab(tab.channelName) || 'messages'}`
    case 'dm': {
      const roomId = getDirectMessageRoomId(tab.dmParticipants || [])
      return `dm:${tab.projectId || 'all'}:${roomId || 'messages'}`
    }
    case 'project-settings':
      return `project-settings:${tab.projectId || 'global'}`
    case 'broker-details':
      return 'broker-details'
    case 'source-control':
      return `source-control:${tab.projectId || 'global'}`
  }
}

function getTabTitle(tab: AppTabInput): string {
  if (tab.title?.trim()) return tab.title.trim()

  switch (tab.kind) {
    case 'agents':
      return 'Agents'
    case 'channel':
      return normalizeChannelForTab(tab.channelName)
        ? `#${normalizeChannelForTab(tab.channelName)}`
        : 'Messages'
    case 'dm':
      return getDirectMessageRoomTitle(tab.dmParticipants || [])
    case 'project-settings':
      return 'Settings'
    case 'broker-details':
      return 'Agent Relay Status'
    case 'source-control':
      return 'Source Control'
  }
}

function createTab(input: AppTabInput): AppTab {
  return {
    id: getTabId(input),
    kind: input.kind,
    title: getTabTitle(input),
    projectId: input.projectId,
    channelName: normalizeChannelForTab(input.channelName),
    dmParticipants: input.kind === 'dm'
      ? sortDirectMessageParticipants(input.dmParticipants || [])
      : undefined
  }
}

function viewModeForTab(tab: AppTab): ViewMode {
  switch (tab.kind) {
    case 'agents':
      return 'terminal'
    case 'channel':
    case 'dm':
      return 'chat'
    case 'project-settings':
      return 'project-settings'
    case 'broker-details':
      return 'broker-details'
    case 'source-control':
      return 'source-control'
  }
}

function tabInputForViewMode(mode: ViewMode): AppTabInput {
  switch (mode) {
    case 'chat':
      return { kind: 'channel' }
    case 'project-settings':
      return { kind: 'project-settings' }
    case 'broker-details':
      return { kind: 'broker-details' }
    case 'source-control':
      return { kind: 'source-control' }
    case 'graph':
    case 'terminal':
      return { kind: 'agents' }
  }
}

const initialTab = createTab({ kind: 'agents' })

export const useUIStore = create<UIState>((set, get) => ({
  viewMode: 'terminal',
  tabs: [initialTab],
  activeTabId: initialTab.id,
  history: [initialTab.id],
  historyIndex: 0,
  recentTabs: [{ ...initialTab, viewedAt: Date.now() }],
  activeDialog: null,
  sidebarCollapsed: false,
  theme: initialTheme,
  terminalLayout: initialTerminalLayout,

  setViewMode: (mode) => {
    get().openTab(tabInputForViewMode(mode))
  },
  openTab: (tabInput) => {
    const tab = createTab(tabInput)
    set((state) => {
      const existingIndex = state.tabs.findIndex((candidate) => candidate.id === tab.id)
      const tabs = existingIndex === -1
        ? [...state.tabs, tab]
        : state.tabs.map((candidate) => candidate.id === tab.id ? { ...candidate, ...tab } : candidate)
      const history = state.history[state.historyIndex] === tab.id
        ? state.history
        : [...state.history.slice(0, state.historyIndex + 1), tab.id]
      const recentTabs = [
        { ...tab, viewedAt: Date.now() },
        ...state.recentTabs.filter((candidate) => candidate.id !== tab.id)
      ].slice(0, 12)

      return {
        tabs,
        activeTabId: tab.id,
        viewMode: viewModeForTab(tab),
        history,
        historyIndex: history.length - 1,
        recentTabs
      }
    })
  },
  activateTab: (id) => {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === id)
      if (!tab) return state

      const history = state.history[state.historyIndex] === id
        ? state.history
        : [...state.history.slice(0, state.historyIndex + 1), id]
      const recentTabs = [
        { ...tab, viewedAt: Date.now() },
        ...state.recentTabs.filter((candidate) => candidate.id !== tab.id)
      ].slice(0, 12)

      return {
        activeTabId: id,
        viewMode: viewModeForTab(tab),
        history,
        historyIndex: history.length - 1,
        recentTabs
      }
    })
  },
  closeTab: (id) => {
    set((state) => {
      const closingIndex = state.tabs.findIndex((candidate) => candidate.id === id)
      if (closingIndex === -1) return state

      let tabs = state.tabs.filter((candidate) => candidate.id !== id)
      if (tabs.length === 0) {
        tabs = [initialTab]
      }

      const wasActive = state.activeTabId === id
      const nextTab = wasActive
        ? tabs[Math.min(closingIndex, tabs.length - 1)] || tabs[0]
        : state.tabs.find((candidate) => candidate.id === state.activeTabId) || tabs[0]
      const history = wasActive && state.history[state.historyIndex] !== nextTab.id
        ? [...state.history.slice(0, state.historyIndex + 1), nextTab.id]
        : state.history
      const recentTabs = wasActive
        ? [
            { ...nextTab, viewedAt: Date.now() },
            ...state.recentTabs.filter((candidate) => candidate.id !== nextTab.id)
          ].slice(0, 12)
        : state.recentTabs

      return {
        tabs,
        activeTabId: nextTab.id,
        viewMode: viewModeForTab(nextTab),
        history,
        historyIndex: wasActive ? history.length - 1 : state.historyIndex,
        recentTabs
      }
    })
  },
  closeActiveTab: () => {
    get().closeTab(get().activeTabId)
  },
  navigateBack: () => {
    set((state) => {
      if (state.historyIndex <= 0) return state

      const nextIndex = state.historyIndex - 1
      const targetId = state.history[nextIndex]
      const targetTab = state.tabs.find((tab) => tab.id === targetId) ||
        state.recentTabs.find((tab) => tab.id === targetId)
      if (!targetTab) return { historyIndex: nextIndex }

      const tabs = state.tabs.some((tab) => tab.id === targetTab.id)
        ? state.tabs
        : [...state.tabs, targetTab]
      const recentTabs = [
        { ...targetTab, viewedAt: Date.now() },
        ...state.recentTabs.filter((candidate) => candidate.id !== targetTab.id)
      ].slice(0, 12)

      return {
        tabs,
        activeTabId: targetTab.id,
        viewMode: viewModeForTab(targetTab),
        historyIndex: nextIndex,
        recentTabs
      }
    })
  },
  navigateForward: () => {
    set((state) => {
      if (state.historyIndex >= state.history.length - 1) return state

      const nextIndex = state.historyIndex + 1
      const targetId = state.history[nextIndex]
      const targetTab = state.tabs.find((tab) => tab.id === targetId) ||
        state.recentTabs.find((tab) => tab.id === targetId)
      if (!targetTab) return { historyIndex: nextIndex }

      const tabs = state.tabs.some((tab) => tab.id === targetTab.id)
        ? state.tabs
        : [...state.tabs, targetTab]
      const recentTabs = [
        { ...targetTab, viewedAt: Date.now() },
        ...state.recentTabs.filter((candidate) => candidate.id !== targetTab.id)
      ].slice(0, 12)

      return {
        tabs,
        activeTabId: targetTab.id,
        viewMode: viewModeForTab(targetTab),
        historyIndex: nextIndex,
        recentTabs
      }
    })
  },
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
