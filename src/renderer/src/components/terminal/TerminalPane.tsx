import type React from 'react'
import { useEffect, useState } from 'react'
import { Allotment } from 'allotment'
import { Columns2, PanelTop, X, Plus } from 'lucide-react'
import { ClaudeIcon, CodexIcon } from '@/components/common/AgentIcons'
import { spawnWorkspaceAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { type Agent, useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'
import { PendingMessagesPane } from './PendingMessagesPane'
import { TerminalInstance } from './TerminalInstance'

const TERMINAL_MODES: Array<{ mode: TerminalAttachMode; label: string; title: string }> = [
  { mode: 'drive', label: 'Drive', title: 'Queue inbound relay messages' },
  { mode: 'view', label: 'View', title: 'Read-only terminal with relay auto-inject' },
  { mode: 'passthrough', label: 'Passthrough', title: 'Type directly with relay auto-inject' }
]

function getTerminalMode(agent: Agent): TerminalAttachMode {
  return agent.terminalMode || 'passthrough'
}

interface TerminalWorkspaceProps {
  agent: Agent
  visible: boolean
  active: boolean
  onActivate: () => void
}

function TerminalWorkspace({
  agent,
  visible,
  active,
  onActivate
}: TerminalWorkspaceProps): React.ReactNode {
  const terminalMode = getTerminalMode(agent)

  return (
    <div className="flex h-full min-w-0 bg-[var(--pear-bg)]">
      <div className="min-w-0 flex-1">
        <TerminalInstance
          agentName={agent.name}
          visible={visible}
          active={active}
          mode={terminalMode}
          onActivate={onActivate}
        />
      </div>
      {terminalMode === 'drive' && (
        <PendingMessagesPane
          agentName={agent.name}
          refreshToken={agent.pendingDeliveryIds.join('|')}
        />
      )}
    </div>
  )
}

export function TerminalPane(): React.ReactNode {
  const allAgents = useAgentStore((s) => s.agents)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const activeWorkspace = useWorkspaceStore((s) => s.getActiveWorkspace())
  const agents = activeWorkspaceId
    ? allAgents.filter((a) => a.workspaceId === activeWorkspaceId)
    : allAgents
  const activeAgentName = useAgentStore((s) => s.activeAgentName)
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent)
  const setAgentTerminalMode = useAgentStore((s) => s.setAgentTerminalMode)
  const openDialog = useUIStore((s) => s.openDialog)
  const terminalLayout = useUIStore((s) => s.terminalLayout)
  const setTerminalLayout = useUIStore((s) => s.setTerminalLayout)
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const splitEnabled = terminalLayout === 'horizontal-split' && agents.length > 1
  const splitButtonTitle = splitEnabled
    ? 'Move terminals back to tabs'
    : agents.length > 1
      ? 'Split terminals horizontally'
      : 'Start another agent to split terminals'
  const activeAgent = agents.find((agent) => agent.name === activeAgentName) || null

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

  const handleTerminalModeChange = async (
    agent: Agent,
    mode: TerminalAttachMode
  ): Promise<void> => {
    if (getTerminalMode(agent) === mode) return

    const previousMode = getTerminalMode(agent)
    setSpawnError(null)
    setAgentTerminalMode(agent.name, mode)

    try {
      await pear.broker.setTerminalMode(agent.name, mode)
    } catch (err) {
      setAgentTerminalMode(agent.name, previousMode)
      setSpawnError(err instanceof Error ? err.message : String(err))
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
        {activeAgent && (
          <div className="mx-1 flex shrink-0 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] p-0.5">
            {TERMINAL_MODES.map((option) => {
              const selected = getTerminalMode(activeAgent) === option.mode
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => void handleTerminalModeChange(activeAgent, option.mode)}
                  aria-pressed={selected}
                  className={`h-8 min-w-[84px] rounded-md px-2 text-xs transition-colors ${
                    selected
                      ? 'bg-[var(--pear-bg)] text-[var(--pear-text)] shadow-sm'
                      : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                  }`}
                  title={option.title}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        )}
        <button
          type="button"
          onClick={() => setTerminalLayout(splitEnabled ? 'tabs' : 'horizontal-split')}
          disabled={agents.length < 2}
          aria-pressed={splitEnabled}
          className={`rounded-xl px-3 py-2 transition-colors ${
            splitEnabled
              ? 'bg-[var(--pear-bg)] text-[var(--pear-text)] shadow-sm'
              : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
          } disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--pear-text-dim)]`}
          title={splitButtonTitle}
          aria-label={splitButtonTitle}
        >
          {splitEnabled ? <PanelTop size={14} /> : <Columns2 size={14} />}
        </button>
        <button
          type="button"
          onClick={() => openDialog('spawn-agent')}
          className="rounded-xl px-3 py-2 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          title="Spawn agent"
          aria-label="Spawn agent"
        >
          <Plus size={14} />
        </button>
      </div>
      {spawnError && (
        <div className="shrink-0 border-b border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
          {spawnError}
        </div>
      )}

      {/* Terminal instances stay mounted in tabbed mode to preserve scroll. */}
      {splitEnabled ? (
        <div className="min-h-0 flex-1">
          <Allotment
            key={agents.map((agent) => agent.name).join('|')}
            className="h-full w-full pear-terminal-split"
            minSize={220}
            separator
          >
            {agents.map((agent) => {
              const active = agent.name === activeAgentName

              return (
                <Allotment.Pane key={agent.name} minSize={220}>
                  <div
                    className="flex h-full min-w-0 flex-col bg-[var(--pear-bg)]"
                    onPointerDown={() => setActiveAgent(agent.name)}
                  >
                    <div
                      className={`flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs ${
                        active
                          ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                          : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)]'
                      }`}
                    >
                      <div
                        className={`h-2 w-2 rounded-full ${
                          agent.status === 'running'
                            ? 'bg-[var(--pear-accent-bright)]'
                            : 'bg-[var(--pear-text-faint)]'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                      {agent.pendingDeliveryIds.length > 0 && (
                        <span className="text-[10px] text-[var(--pear-text-faint)]">thinking</span>
                      )}
                      <span className="shrink-0 text-[var(--pear-text-faint)]">{getTerminalMode(agent)}</span>
                      <span className="shrink-0 text-[var(--pear-text-faint)]">{agent.cli}</span>
                    </div>
                    <div className="min-h-0 flex-1">
                      <TerminalWorkspace
                        agent={agent}
                        visible
                        active={active}
                        onActivate={() => setActiveAgent(agent.name)}
                      />
                    </div>
                  </div>
                </Allotment.Pane>
              )
            })}
          </Allotment>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {agents.map((agent) => {
            const active = agent.name === activeAgentName

            return (
              <div
                key={agent.name}
                className="absolute inset-0"
                style={{ display: active ? 'block' : 'none' }}
              >
                <TerminalWorkspace
                  agent={agent}
                  visible={active}
                  active={active}
                  onActivate={() => setActiveAgent(agent.name)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
