import type React from 'react'
import { useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Flame,
  GitPullRequest,
  Hash,
  LayoutGrid,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  X
} from 'lucide-react'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore, type AppTab } from '@/stores/ui-store'

function TabIcon({ tab, className = '' }: { tab: AppTab; className?: string }): React.ReactNode {
  const iconClassName = `shrink-0 ${className}`

  switch (tab.kind) {
    case 'channel':
      return <Hash size={14} className={iconClassName} />
    case 'dm':
      return <MessageCircle size={14} className={iconClassName} />
    case 'project-settings':
      return <Settings size={14} className={iconClassName} />
    case 'broker-details':
      return <Server size={14} className={iconClassName} />
    case 'source-control':
      return <GitPullRequest size={14} className={iconClassName} />
    case 'ai-hist':
      return <Clock3 size={14} className={iconClassName} />
    case 'burn-session':
      return <Flame size={14} className={iconClassName} />
    case 'agents':
      return <LayoutGrid size={14} className={iconClassName} />
  }
}

function tabSubtitle(tab: AppTab, projectNameById: Map<string, string>): string {
  const projectName = tab.projectId ? projectNameById.get(tab.projectId) : null

  switch (tab.kind) {
    case 'channel':
      return projectName ? `${projectName} channel` : 'Channel'
    case 'dm':
      return projectName ? `${projectName} DM` : 'Direct message'
    case 'project-settings':
      return projectName ? `${projectName} settings` : 'Settings'
    case 'broker-details':
      return projectName ? `${projectName} relay` : 'Connection status'
    case 'source-control':
      return projectName ? `${projectName} changes` : 'File changes'
    case 'ai-hist':
      return projectName ? `${projectName} history` : 'Conversation history'
    case 'burn-session':
      return projectName ? `${projectName} burn` : 'Burn breakdown'
    case 'agents':
      return projectName ? `${projectName} agents` : 'Agent quadrants'
  }
  return ''
}

export function AppTopBar(): React.ReactNode {
  const [historyOpen, setHistoryOpen] = useState(false)
  const projects = useProjectStore((s) => s.projects)
  const tabs = useUIStore((s) => s.tabs)
  const activeTabId = useUIStore((s) => s.activeTabId)
  const history = useUIStore((s) => s.history)
  const historyIndex = useUIStore((s) => s.historyIndex)
  const recentTabs = useUIStore((s) => s.recentTabs)
  const openTab = useUIStore((s) => s.openTab)
  const activateTab = useUIStore((s) => s.activateTab)
  const closeTab = useUIStore((s) => s.closeTab)
  const navigateBack = useUIStore((s) => s.navigateBack)
  const navigateForward = useUIStore((s) => s.navigateForward)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1
  const SidebarIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose
  const sidebarLabel = sidebarCollapsed ? 'Expand menu' : 'Collapse menu'
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )

  return (
    <div className="titlebar-drag relative z-40 flex h-11 shrink-0 items-center border-b border-[var(--pear-border-subtle)] bg-[#11121a]/95 pl-[138px] pr-3 text-[var(--pear-text)]">
      <button
        type="button"
        onClick={toggleSidebar}
        className="titlebar-nodrag absolute left-[96px] top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[var(--pear-text-faint)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
        title={sidebarLabel}
        aria-label={sidebarLabel}
      >
        <SidebarIcon size={17} strokeWidth={2.4} />
      </button>

      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className={`titlebar-nodrag flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              historyOpen
                ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                : 'text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]'
            }`}
            title="Recent history"
            aria-label="Recent history"
            aria-expanded={historyOpen}
          >
            <Clock3 size={16} />
          </button>

          {historyOpen && (
            <>
              <div className="titlebar-nodrag fixed inset-0 z-20" onClick={() => setHistoryOpen(false)} />
              <div className="titlebar-nodrag absolute left-0 top-10 z-30 w-[520px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[#272833] py-4 shadow-2xl">
                <div className="px-5 pb-3 text-[15px] font-medium text-[var(--pear-text-faint)]">
                  Recently viewed
                </div>
                <div className="max-h-[360px] overflow-y-auto px-2">
                  {recentTabs.length === 0 ? (
                    <div className="px-3 py-6 text-sm text-[var(--pear-text-faint)]">No recent tabs</div>
                  ) : (
                    recentTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          openTab(tab)
                          setHistoryOpen(false)
                        }}
                        className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[var(--pear-text)] hover:bg-white/[0.07]"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--pear-text-faint)]">
                          <TabIcon tab={tab} className="text-[var(--pear-text-faint)]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium">{tab.title}</span>
                          <span className="mt-0.5 block truncate text-xs text-[var(--pear-text-faint)]">
                            {tabSubtitle(tab, projectNameById)}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={navigateBack}
          disabled={!canGoBack}
          className="titlebar-nodrag flex h-8 w-8 items-center justify-center rounded-full text-[var(--pear-text-faint)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)] disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--pear-text-faint)]"
          title="Back"
          aria-label="Back"
        >
          <ChevronLeft size={17} />
        </button>
        <button
          type="button"
          onClick={navigateForward}
          disabled={!canGoForward}
          className="titlebar-nodrag flex h-8 w-8 items-center justify-center rounded-full text-[var(--pear-text-faint)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)] disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--pear-text-faint)]"
          title="Forward"
          aria-label="Forward"
        >
          <ChevronRight size={17} />
        </button>
      </div>

      <div className="ml-4 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const canClose = tabs.length > 1

          return (
            <div
              key={tab.id}
              className={`app-tab titlebar-nodrag group flex h-9 min-w-[136px] max-w-[280px] shrink-0 items-center overflow-hidden rounded-lg transition-colors ${
                active
                  ? 'bg-[#2a2b38] text-white'
                  : 'text-[var(--pear-text-faint)] hover:bg-white/[0.06] hover:text-[var(--pear-text)]'
              }`}
            >
              <button
                type="button"
                data-focus-ring="none"
                onClick={() => activateTab(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                title={tab.title}
              >
                <TabIcon
                  tab={tab}
                  className={active ? 'text-[var(--pear-accent-bright)]' : 'text-[var(--pear-text-faint)]'}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{tab.title}</span>
              </button>
              {canClose && (
                <button
                  type="button"
                  data-focus-ring="none"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-opacity hover:bg-white/10 hover:text-white ${
                    active ? 'opacity-75' : 'opacity-0 group-hover:opacity-75'
                  }`}
                  title={`Close ${tab.title}`}
                  aria-label={`Close ${tab.title}`}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
