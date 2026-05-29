import { create } from 'zustand'
import { z } from 'zod'
import {
  getDirectMessageRoomId,
  getDirectMessageRoomTitle,
  sortDirectMessageParticipants
} from '@/lib/direct-messages'
import type { BurnAgentInput } from '@/lib/ipc'

export type ViewMode = 'terminal' | 'chat' | 'graph' | 'project-settings' | 'account-settings' | 'broker-details' | 'source-control' | 'ai-hist' | 'burn-session' | 'burn-project' | 'burn-session-detail'
export type DialogType = 'add-project' | 'spawn-agent' | 'spawn-local-agent' | 'cloud-agent' | 'add-channel' | 'command-menu' | null
const ThemeSchema = z.enum(['dark', 'light'])
const TerminalLayoutSchema = z.enum(['tabs', 'horizontal-split', 'graph'])
const BooleanPreferenceSchema = z.enum(['true', 'false']).transform((value) => value === 'true')
export type Theme = z.infer<typeof ThemeSchema>
export type TerminalLayout = z.infer<typeof TerminalLayoutSchema>
export type AppTabKind = 'agents' | 'channel' | 'dm' | 'project-settings' | 'account-settings' | 'broker-details' | 'source-control' | 'ai-hist' | 'burn-session' | 'burn-project' | 'burn-session-detail'

export interface AppTab {
  id: string
  kind: AppTabKind
  title: string
  projectId?: string
  channelName?: string
  dmParticipants?: string[]
  burnAgent?: BurnAgentInput
  burnSessionId?: string
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
  projectSwitcherExpanded: boolean
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
  setProjectSwitcherExpanded: (expanded: boolean) => void
  toggleProjectSwitcher: () => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setTerminalLayout: (layout: TerminalLayout) => void
  toggleTerminalLayout: () => void
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('pear-theme', theme)
}

function readStored<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  const parsed = schema.safeParse(localStorage.getItem(key))
  return parsed.success ? parsed.data : fallback
}

const initialTheme = readStored('pear-theme', ThemeSchema, 'dark')
const initialTerminalLayout = readStored('pear-terminal-layout', TerminalLayoutSchema, 'horizontal-split')
const initialProjectSwitcherExpanded = readStored('pear-project-switcher-expanded', BooleanPreferenceSchema, false)

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
    case 'account-settings':
      return 'account-settings'
    case 'broker-details':
      return `broker-details:${tab.projectId || 'global'}`
    case 'source-control':
      return `source-control:${tab.projectId || 'global'}`
    case 'ai-hist':
      return `ai-hist:${tab.projectId || 'global'}`
    case 'burn-session':
      return `burn-session:${tab.burnAgent?.projectId || tab.projectId || 'unknown'}:${tab.burnAgent?.name || 'agent'}`
    case 'burn-project':
      return `burn-project:${tab.projectId || 'unknown'}`
    case 'burn-session-detail':
      return `burn-session-detail:${tab.burnSessionId || 'unknown'}`
  }
}

function getTabTitle(tab: AppTabInput): string {
  if (tab.title?.trim()) return tab.title.trim()

  switch (tab.kind) {
    case 'agents':
      return 'Agents'
    case 'channel':
      return normalizeChannelForTab(tab.channelName) || 'Messages'
    case 'dm':
      return getDirectMessageRoomTitle(tab.dmParticipants || [])
    case 'project-settings':
      return 'Settings'
    case 'account-settings':
      return 'Account settings'
    case 'broker-details':
      return 'Agent Relay Status'
    case 'source-control':
      return 'File Changes'
    case 'ai-hist':
      return 'Conversations'
    case 'burn-session':
      return tab.burnAgent?.name ? `${tab.burnAgent.name} burn` : 'Burn'
    case 'burn-project':
      return 'Project burn'
    case 'burn-session-detail':
      return 'Session burn'
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
      : undefined,
    burnAgent: input.kind === 'burn-session' ? input.burnAgent : undefined,
    burnSessionId: input.kind === 'burn-session-detail' ? input.burnSessionId : undefined
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
    case 'account-settings':
      return 'account-settings'
    case 'broker-details':
      return 'broker-details'
    case 'source-control':
      return 'source-control'
    case 'ai-hist':
      return 'ai-hist'
    case 'burn-session':
      return 'burn-session'
    case 'burn-project':
      return 'burn-project'
    case 'burn-session-detail':
      return 'burn-session-detail'
  }
}

function tabInputForViewMode(mode: ViewMode): AppTabInput {
  switch (mode) {
    case 'chat':
      return { kind: 'channel' }
    case 'project-settings':
      return { kind: 'project-settings' }
    case 'account-settings':
      return { kind: 'account-settings' }
    case 'broker-details':
      return { kind: 'broker-details' }
    case 'source-control':
      return { kind: 'source-control' }
    case 'ai-hist':
      return { kind: 'ai-hist' }
    case 'burn-session':
      return { kind: 'agents' }
    case 'burn-project':
      return { kind: 'agents' }
    case 'burn-session-detail':
      return { kind: 'agents' }
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
  projectSwitcherExpanded: initialProjectSwitcherExpanded,
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
  setProjectSwitcherExpanded: (expanded) => {
    localStorage.setItem('pear-project-switcher-expanded', String(expanded))
    set({ projectSwitcherExpanded: expanded })
  },
  toggleProjectSwitcher: () => {
    const next = !get().projectSwitcherExpanded
    localStorage.setItem('pear-project-switcher-expanded', String(next))
    set({ projectSwitcherExpanded: next })
  },
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
    const current = get().terminalLayout
    const next = current === 'tabs'
      ? 'horizontal-split'
      : current === 'horizontal-split'
        ? 'graph'
        : 'tabs'
    localStorage.setItem('pear-terminal-layout', next)
    set({ terminalLayout: next })
  }
}))
