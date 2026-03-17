import type React from 'react'
import { Settings } from 'lucide-react'
import { useUIStore } from '@/stores/ui-store'

const AGENTS = [
  { cli: 'claude', label: 'claude', icon: '✳️' },
  { cli: 'codex', label: 'codex', icon: '§' },
  { cli: 'copilot', label: 'copilot', icon: '🤖' },
  { cli: 'opencode', label: 'opencode', icon: '▪' },
  { cli: 'gemini', label: 'gemini', icon: '✦' }
]

export function AgentToolbar(): React.ReactNode {
  const openDialog = useUIStore((s) => s.openDialog)

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-1.5">
      <button
        className="rounded p-1.5 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
        title="Settings"
        aria-label="Agent settings"
      >
        <Settings size={14} />
      </button>

      <div className="mx-1 h-4 w-px bg-[var(--pear-border-subtle)]" />

      {AGENTS.map((agent) => (
        <button
          key={agent.cli}
          onClick={() => openDialog('spawn-agent')}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
          title={`Spawn ${agent.label} agent`}
        >
          <span className="text-sm">{agent.icon}</span>
          <span>{agent.label}</span>
        </button>
      ))}
    </div>
  )
}
