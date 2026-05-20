import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Columns2,
  FolderPlus,
  Monitor,
  MoonStar,
  Search,
  Server,
  Settings
} from 'lucide-react'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

interface CommandAction {
  id: string
  label: string
  description: string
  keywords: string[]
  Icon: React.ComponentType<{ size?: number; className?: string }>
  run: () => void
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function matchesAction(action: CommandAction, query: string): boolean {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return true

  const tokens = normalizedQuery.split(/\s+/)
  const searchable = normalize([
    action.label,
    action.description,
    ...action.keywords
  ].join(' '))

  return tokens.every((token) => searchable.includes(token))
}

export function CommandMenu(): React.ReactNode {
  const activeDialog = useUIStore((s) => s.activeDialog)
  const openDialog = useUIStore((s) => s.openDialog)
  const closeDialog = useUIStore((s) => s.closeDialog)
  const openTab = useUIStore((s) => s.openTab)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const toggleTerminalLayout = useUIStore((s) => s.toggleTerminalLayout)
  const activeProject = useProjectStore((s) => s.getActiveProject())
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const actions = useMemo<CommandAction[]>(() => [
    {
      id: 'add-project',
      label: 'Add project',
      description: 'Create a project and choose its root directory',
      keywords: ['new project', 'create project'],
      Icon: FolderPlus,
      run: () => openDialog('add-project')
    },
    {
      id: 'spawn-agent',
      label: 'Add agent',
      description: activeProject
        ? 'Start a Claude or Codex agent in the active project'
        : 'Start a Claude or Codex agent after adding a project',
      keywords: ['spawn agent', 'new agent', 'claude', 'codex'],
      Icon: Bot,
      run: () => openDialog('spawn-agent')
    },
    {
      id: 'broker-details',
      label: 'Agent Relay Status',
      description: 'Open Agent Relay health, connection details, and CLI commands',
      keywords: ['broker', 'agent relay', 'status', 'connection', 'port', 'api key', 'cli'],
      Icon: Server,
      run: () => {
        openTab({ kind: 'broker-details' })
        closeDialog()
      }
    },
    {
      id: 'project-settings',
      label: 'Project settings',
      description: activeProject
        ? 'Edit roots, channels, agents, and integrations'
        : 'Open project settings',
      keywords: ['settings', 'roots', 'channels', 'integrations'],
      Icon: Settings,
      run: () => {
        openTab({ kind: 'project-settings', projectId: activeProject?.id })
        closeDialog()
      }
    },
    {
      id: 'terminal',
      label: 'Show agents',
      description: 'Open the agent quadrants tab',
      keywords: ['terminal', 'agents'],
      Icon: Monitor,
      run: () => {
        openTab({ kind: 'agents', projectId: activeProject?.id })
        closeDialog()
      }
    },
    {
      id: 'toggle-layout',
      label: 'Toggle terminal layout',
      description: 'Switch between tabs and split terminals',
      keywords: ['split', 'tabs', 'layout'],
      Icon: Columns2,
      run: () => {
        toggleTerminalLayout()
        closeDialog()
      }
    },
    {
      id: 'toggle-theme',
      label: 'Toggle theme',
      description: 'Switch between dark and light mode',
      keywords: ['dark', 'light', 'appearance'],
      Icon: MoonStar,
      run: () => {
        toggleTheme()
        closeDialog()
      }
    }
  ], [activeProject, closeDialog, openDialog, openTab, toggleTerminalLayout, toggleTheme])

  const filteredActions = useMemo(
    () => actions.filter((action) => matchesAction(action, query)),
    [actions, query]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return
      if (event.key.toLowerCase() !== 'k') return
      if (activeDialog && activeDialog !== 'command-menu') return

      event.preventDefault()
      if (activeDialog === 'command-menu') {
        closeDialog()
      } else {
        openDialog('command-menu')
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [activeDialog, closeDialog, openDialog])

  useEffect(() => {
    if (activeDialog !== 'command-menu') return

    setQuery('')
    setSelectedIndex(0)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [activeDialog])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    if (selectedIndex < filteredActions.length) return
    setSelectedIndex(Math.max(0, filteredActions.length - 1))
  }, [filteredActions.length, selectedIndex])

  const runAction = useCallback((action: CommandAction): void => {
    action.run()
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDialog()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((current) =>
        filteredActions.length === 0 ? 0 : (current + 1) % filteredActions.length
      )
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((current) =>
        filteredActions.length === 0
          ? 0
          : (current - 1 + filteredActions.length) % filteredActions.length
      )
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const selectedAction = filteredActions[selectedIndex]
      if (selectedAction) runAction(selectedAction)
    }
  }, [closeDialog, filteredActions, runAction, selectedIndex])

  if (activeDialog !== 'command-menu') return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[18vh]"
      onClick={closeDialog}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Action menu"
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--pear-border-subtle)] px-4 py-3">
          <Search size={16} className="shrink-0 text-[var(--pear-text-faint)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command..."
            className="h-9 min-w-0 flex-1 bg-transparent text-[15px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
          />
        </div>

        <div className="max-h-[360px] overflow-y-auto p-2">
          {filteredActions.length > 0 ? (
            filteredActions.map((action, index) => {
              const selected = index === selectedIndex
              const Icon = action.Icon

              return (
                <button
                  key={action.id}
                  type="button"
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => runAction(action)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ${
                    selected
                      ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                      : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                  }`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35">
                    <Icon size={15} className="text-[var(--pear-accent)]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{action.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-[var(--pear-text-faint)]">
                      {action.description}
                    </span>
                  </span>
                </button>
              )
            })
          ) : (
            <div className="px-3 py-8 text-center text-sm text-[var(--pear-text-faint)]">
              No commands found
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
