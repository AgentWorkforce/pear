import { create } from 'zustand'
import { z } from 'zod'
import {
  getDirectMessageRoomId,
  getDirectMessageRoomTitle,
  sortDirectMessageParticipants
} from '@/lib/direct-messages'
import type { BurnAgentInput } from '@/lib/ipc'

export type ViewMode = 'terminal' | 'chat' | 'project-settings' | 'account-settings' | 'broker-details' | 'source-control' | 'issues' | 'ai-hist' | 'burn-session' | 'burn-project' | 'burn-session-detail' | 'factory'
export type DialogType = 'add-project' | 'spawn-agent' | 'spawn-local-agent' | 'cloud-agent' | 'add-channel' | 'command-menu' | null
const ThemeSchema = z.enum(['dark', 'light'])
const TerminalLayoutSchema = z.enum(['tabs', 'horizontal-split'])
const BooleanPreferenceSchema = z.enum(['true', 'false']).transform((value) => value === 'true')
export type Theme = z.infer<typeof ThemeSchema>
export type TerminalLayout = z.infer<typeof TerminalLayoutSchema>
export type AppTabKind = 'agents' | 'channel' | 'dm' | 'project-settings' | 'account-settings' | 'broker-details' | 'source-control' | 'issues' | 'ai-hist' | 'burn-session' | 'burn-project' | 'burn-session-detail' | 'factory'

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
  // Issue Control Center navigation. selectedIssueId persists the focused
  // card on the (global) issues tab so a forward L3 jump + return restores
  // your place. agentJumpIssueId is the transient breadcrumb origin set when
  // you jump from a card into an agent's live workspace, surfaced as the
  // `↩ PEAR-X` chip in the agent view header and cleared on any non-agents nav.
  selectedIssueId: string | null
  agentJumpIssueId: string | null

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
  setSelectedIssueId: (issueId: string | null) => void
  setAgentJumpIssueId: (issueId: string | null) => void
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
const initialSelectedIssueId = typeof localStorage !== 'undefined'
  ? localStorage.getItem('pear-selected-issue')
  : null

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
    case 'issues':
      return `issues:${tab.projectId || 'global'}`
    case 'ai-hist':
      return `ai-hist:${tab.projectId || 'global'}`
    case 'factory':
      return `factory:${tab.projectId || 'global'}`
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
    case 'issues':
      return 'Issues'
    case 'ai-hist':
      return 'Conversations'
    case 'factory':
      return 'Factory'
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
    burnAgent: input.kind === 'burn-session' || input.kind === 'burn-session-detail'
      ? input.burnAgent
      : undefined,
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
    case 'issues':
      return 'issues'
    case 'ai-hist':
      return 'ai-hist'
    case 'factory':
      return 'factory'
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
    case 'issues':
      return { kind: 'issues' }
    case 'ai-hist':
      return { kind: 'ai-hist' }
    case 'factory':
      return { kind: 'factory' }
    case 'burn-session':
      return { kind: 'agents' }
    case 'burn-project':
      return { kind: 'agents' }
    case 'burn-session-detail':
      return { kind: 'agents' }
    case 'terminal':
      return { kind: 'agents' }
  }
}

// The browser demo build has no real projects, so default straight to the
// Attention Inbox (the web-first surface) instead of the empty Agents view.
// The Playwright rendering harnesses (fidelity/redraw/stress) need the
// Agents view to mount terminals — they opt in via this localStorage key in
// an init script, the same way they seed pear-terminal-layout.
const isWebMock = import.meta.env.VITE_PEAR_MOCK_IPC === 'true'
const webMockInitialTab = readStored(
  'pear-web-initial-tab',
  z.enum(['agents', 'issues']),
  'issues'
)
const initialTab = createTab({ kind: isWebMock ? webMockInitialTab : 'agents' })

export const useUIStore = create<UIState>((set, get) => ({
  viewMode: viewModeForTab(initialTab),
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
  selectedIssueId: initialSelectedIssueId,
  agentJumpIssueId: null,

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
        recentTabs,
        agentJumpIssueId: null
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
        recentTabs,
        agentJumpIssueId: null
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
        recentTabs,
        agentJumpIssueId: null
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
        recentTabs,
        agentJumpIssueId: null
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
    const next = current === 'tabs' ? 'horizontal-split' : 'tabs'
    localStorage.setItem('pear-terminal-layout', next)
    set({ terminalLayout: next })
  },
  setSelectedIssueId: (issueId) => {
    if (typeof localStorage !== 'undefined') {
      if (issueId) localStorage.setItem('pear-selected-issue', issueId)
      else localStorage.removeItem('pear-selected-issue')
    }
    set({ selectedIssueId: issueId })
  },
  setAgentJumpIssueId: (issueId) => set({ agentJumpIssueId: issueId })
}))
