import type React from 'react'
import { GitBranch, Bot, BotMessageSquare, Plus, Hash, Trash2, Terminal } from 'lucide-react'
import { useWorkspaceStore, type Worktree } from '@/stores/workspace-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'

interface Props {
  worktree: Worktree
}

export function WorktreeItem({ worktree }: Props): React.ReactNode {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree)
  const activeChannelName = useWorkspaceStore((s) => s.activeChannelName)
  const setActiveChannel = useWorkspaceStore((s) => s.setActiveChannel)
  const addChannel = useWorkspaceStore((s) => s.addChannel)
  const removeChannel = useWorkspaceStore((s) => s.removeChannel)
  const allAgents = useAgentStore((s) => s.agents)
  const agents = allAgents.filter((a) => a.worktreeId === worktree.id)
  const activeAgentName = useAgentStore((s) => s.activeAgentName)
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent)
  const openDialog = useUIStore((s) => s.openDialog)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const isActive = activeWorktreeId === worktree.id

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
          isActive
            ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
            : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]'
        }`}
        onClick={() => setActiveWorktree(worktree.id)}
      >
        <GitBranch size={12} className="text-[var(--pear-accent-bright)]" />
        <span className="flex-1 truncate">{worktree.branch}</span>
        {agents.length > 0 && (
          <span className="flex items-center gap-0.5 text-xs text-[var(--pear-text-dim)]">
            <Bot size={10} />
            {agents.length}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setActiveWorktree(worktree.id)
            openDialog('spawn-agent')
          }}
          className="rounded p-0.5 opacity-0 hover:bg-[var(--pear-border)] group-hover:opacity-100"
          title="Spawn agent"
          aria-label="Spawn agent"
        >
          <BotMessageSquare size={12} />
        </button>
      </div>

      {isActive && (
        <div className="ml-4 mt-1">
          {/* Agents */}
          <div className="group flex items-center gap-1 px-2 py-1">
            <span className="text-xs font-medium text-[var(--pear-text-faint)]">Agents</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                openDialog('spawn-agent')
              }}
              className="ml-auto rounded p-0.5 opacity-0 hover:bg-[var(--pear-bg-overlay)] group-hover:opacity-100"
              title="Spawn agent"
              aria-label="Spawn agent"
            >
              <BotMessageSquare size={12} />
            </button>
          </div>
          {agents.length === 0 ? (
            <div className="px-2 py-1 text-xs text-[var(--pear-text-faint)]">No agents</div>
          ) : (
            agents.map((agent) => (
              <div
                key={agent.name}
                className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
                  activeAgentName === agent.name
                    ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                    : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]/50'
                }`}
                onClick={() => {
                  setActiveAgent(agent.name)
                  setViewMode('terminal')
                }}
              >
                <Terminal size={12} className="shrink-0 text-[var(--pear-text-faint)]" />
                <span className="flex-1 truncate">{agent.name}</span>
                <div
                  className={`h-1.5 w-1.5 rounded-full ${
                    agent.status === 'running' ? 'bg-[var(--pear-accent)]' : 'bg-[var(--pear-text-faint)]'
                  }`}
                />
              </div>
            ))
          )}

          {/* Channels */}
          <div className="group mt-2 flex items-center gap-1 px-2 py-1">
            <span className="text-xs font-medium text-[var(--pear-text-faint)]">Channels</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                const name = window.prompt('Channel name:')
                if (name?.trim()) addChannel(name.trim())
              }}
              className="ml-auto rounded p-0.5 opacity-0 hover:bg-[var(--pear-bg-overlay)] group-hover:opacity-100"
              title="Add channel"
              aria-label="Add channel"
            >
              <Plus size={12} />
            </button>
          </div>
          {(worktree.channels || []).map((ch) => (
            <div
              key={ch}
              className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
                activeChannelName === ch
                  ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                  : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]/50'
              }`}
              onClick={() => {
                setActiveChannel(ch)
                setViewMode('chat')
              }}
            >
              <Hash size={12} className="shrink-0 text-[var(--pear-text-faint)]" />
              <span className="flex-1 truncate">{ch}</span>
              {ch !== 'general' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeChannel(ch)
                  }}
                  className="rounded p-0.5 text-[var(--pear-red)] opacity-0 hover:bg-[var(--pear-bg-overlay)] group-hover:opacity-100"
                  title="Remove channel"
                  aria-label={`Remove channel ${ch}`}
                >
                  <Trash2 size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
