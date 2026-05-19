import type React from 'react'
import { useEffect, useState } from 'react'
import { X, Plus } from 'lucide-react'
import { ClaudeIcon, CodexIcon } from '@/components/common/AgentIcons'
import { spawnWorkspaceAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'
import { pear } from '@/lib/ipc'
import { TerminalInstance } from './TerminalInstance'

export function TerminalPane(): React.ReactNode {
  const allAgents = useAgentStore((s) => s.agents)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const activeWorkspace = useWorkspaceStore((s) => s.getActiveWorkspace())
  const agents = activeWorkspaceId
    ? allAgents.filter((a) => a.workspaceId === activeWorkspaceId)
    : allAgents
  const activeAgentName = useAgentStore((s) => s.activeAgentName)
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent)
  const openDialog = useUIStore((s) => s.openDialog)
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [spawnError, setSpawnError] = useState<string | null>(null)

  const handleSpawn = async (cli: SpawnAgentCli): Promise<void> => {
    if (!activeWorkspace) {
      openDialog('add-workspace')
      return
    }

    setSpawnError(null)
    setSpawningCli(cli)
    try {
      await spawnWorkspaceAgent(activeWorkspace, cli)
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpawningCli(null)
    }
  }

  useEffect(() => {
    if (agents.length === 0) {
      if (activeAgentName) {
        setActiveAgent(null)
      }
      return
    }

    if (!activeAgentName || !agents.some((agent) => agent.name === activeAgentName)) {
      setActiveAgent(agents[0].name)
    }
  }, [activeAgentName, agents, setActiveAgent])

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--pear-bg)] px-8 text-[var(--pear-text-faint)]">
        <p className="text-sm text-[var(--pear-text-dim)]">
          {activeWorkspace ? 'No agents running' : 'No workspace selected'}
        </p>
        {activeWorkspace ? (
          <div className="mt-4 grid w-full max-w-[340px] grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handleSpawn('claude')}
              disabled={!activeWorkspace.rootPathExists || spawningCli !== null}
              className="flex items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
              title={activeWorkspace.rootPathExists ? 'Spawn Claude' : `Path not found: ${activeWorkspace.rootPath}`}
            >
              <ClaudeIcon className="h-4 w-4" />
              <span>{spawningCli === 'claude' ? 'Starting' : 'Claude'}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSpawn('codex')}
              disabled={!activeWorkspace.rootPathExists || spawningCli !== null}
              className="flex items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
              title={activeWorkspace.rootPathExists ? 'Spawn Codex' : `Path not found: ${activeWorkspace.rootPath}`}
            >
              <CodexIcon className="h-4 w-4" />
              <span>{spawningCli === 'codex' ? 'Starting' : 'Codex'}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openDialog('add-workspace')}
            className="mt-4 rounded-lg border border-dashed border-[var(--pear-border)] px-6 py-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
          >
            + Add workspace
          </button>
        )}
        {spawnError && (
          <p className="mt-3 max-w-[420px] rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
            {spawnError}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg)]">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center gap-0 border-b border-[var(--pear-bg-surface)] bg-[var(--pear-bg-raised)] px-1.5 py-1">
        <div className="flex flex-1 overflow-x-auto">
          {agents.map((agent) => (
            <div
              key={agent.name}
              role="tab"
              tabIndex={0}
              aria-selected={activeAgentName === agent.name}
              onClick={() => setActiveAgent(agent.name)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveAgent(agent.name) } }}
              className={`group my-1 flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-4 py-3 text-sm transition-colors ${
                activeAgentName === agent.name
                  ? 'bg-[var(--pear-bg)] text-[var(--pear-text)] shadow-sm'
                  : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]'
              }`}
            >
              <div
                className={`h-2 w-2 rounded-full ${
                  agent.status === 'running' ? 'bg-[var(--pear-accent-bright)]' : 'bg-[var(--pear-text-faint)]'
                }`}
              />
              <div className="flex items-center gap-2">
                <span className="max-w-[120px] truncate">{agent.name}</span>
                {agent.pendingDeliveryIds.length > 0 && (
                  <span className="text-[10px] text-[var(--pear-text-faint)]">thinking</span>
                )}
              </div>
              <span className="text-xs text-[var(--pear-text-faint)]">{agent.cli}</span>
              {agent.status === 'running' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    pear.broker.releaseAgent(agent.name)
                  }}
                  className="ml-1 rounded-md p-1 opacity-0 hover:bg-[var(--pear-bg-overlay)] group-hover:opacity-100"
                  title="Release agent"
                  aria-label={`Release agent ${agent.name}`}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => openDialog('spawn-agent')}
          className="rounded-xl px-3 py-2 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title="Spawn agent"
          aria-label="Spawn agent"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Terminal instances — hidden but not unmounted to preserve scroll */}
      <div className="relative min-h-0 flex-1">
        {agents.map((agent) => (
          <div
            key={agent.name}
            className="absolute inset-0"
            style={{ display: agent.name === activeAgentName ? 'block' : 'none' }}
          >
            <TerminalInstance
              agentName={agent.name}
              visible={agent.name === activeAgentName}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
