import type React from 'react'
import { Settings } from 'lucide-react'
import { ClaudeIcon, CodexIcon, CopilotIcon, GeminiIcon, GrokIcon, OpenCodeIcon } from '@/components/common/AgentIcons'
import { useUIStore } from '@/stores/ui-store'

const AGENTS = [
  { cli: 'claude', label: 'claude', Icon: ClaudeIcon },
  { cli: 'codex', label: 'codex', Icon: CodexIcon },
  { cli: 'copilot', label: 'copilot', Icon: CopilotIcon },
  { cli: 'opencode', label: 'opencode', Icon: OpenCodeIcon },
  { cli: 'gemini', label: 'gemini', Icon: GeminiIcon },
  { cli: 'grok', label: 'grok', Icon: GrokIcon }
]

export function AgentToolbar(): React.ReactNode {
  const openDialog = useUIStore((s) => s.openDialog)

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-4 py-2.5">
      <button
        className="rounded-lg p-2 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
        title="Settings"
        aria-label="Agent settings"
      >
        <Settings size={14} />
      </button>

      <div className="mx-1 h-5 w-px bg-[var(--pear-border-subtle)]" />

      {AGENTS.map((agent) => (
        <button
          key={agent.cli}
          onClick={() => openDialog('spawn-agent')}
          className="flex items-center gap-2.5 rounded-xl px-4 py-2 text-sm font-medium tracking-[0.01em] text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
          title={`Spawn ${agent.label} agent`}
        >
          <agent.Icon className="h-4.5 w-4.5 shrink-0" />
          <span>{agent.label}</span>
        </button>
      ))}
    </div>
  )
}
