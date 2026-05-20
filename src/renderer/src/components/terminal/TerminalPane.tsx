import type React from 'react'
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Columns2, PanelTop, X, Plus } from 'lucide-react'
import { ClaudeIcon, CodexIcon } from '@/components/common/AgentIcons'
import { spawnWorkspaceAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { type Agent, useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'
import { PendingMessagesPane, type QueueDeliveryMode } from './PendingMessagesPane'
import { TerminalInstance } from './TerminalInstance'

const SPLIT_PAGE_SIZE = 4

function getTerminalMode(agent: Agent): TerminalAttachMode {
  return agent.terminalMode === 'passthrough' || agent.terminalMode === 'view'
    ? 'passthrough'
    : 'drive'
}

function getQueueDeliveryMode(agent: Agent): QueueDeliveryMode {
  return getTerminalMode(agent) === 'drive' ? 'drive' : 'auto'
}

function toTerminalMode(mode: QueueDeliveryMode): TerminalAttachMode {
  return mode === 'drive' ? 'drive' : 'passthrough'
}

function chunkAgents(agents: Agent[]): Agent[][] {
  const pages: Agent[][] = []
  for (let index = 0; index < agents.length; index += SPLIT_PAGE_SIZE) {
    pages.push(agents.slice(index, index + SPLIT_PAGE_SIZE))
  }
  return pages
}

function getSplitPageGridClass(count: number): string {
  if (count === 1) return 'grid-cols-1 grid-rows-1'
  if (count === 2) return 'grid-cols-2 grid-rows-1'
  return 'grid-cols-2 grid-rows-2'
}

function getSplitTileClass(count: number, index: number): string {
  if (count === 3 && index === 0) return 'row-span-2'
  return ''
}

interface TerminalWorkspaceProps {
  agent: Agent
  visible: boolean
  active: boolean
  onActivate: () => void
  onDeliveryModeChange: (agent: Agent, mode: QueueDeliveryMode) => void
}

function TerminalWorkspace({
  agent,
  visible,
  active,
  onActivate,
  onDeliveryModeChange
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
      {visible && (
        <PendingMessagesPane
          agentName={agent.name}
          deliveryMode={getQueueDeliveryMode(agent)}
          refreshToken={agent.pendingDeliveryIds.join('|')}
          onDeliveryModeChange={(mode) => onDeliveryModeChange(agent, mode)}
        />
      )}
    </div>
  )
}

interface SplitTerminalTileProps {
  agent: Agent
  visible: boolean
  active: boolean
  className?: string
  onActivate: () => void
  onDeliveryModeChange: (agent: Agent, mode: QueueDeliveryMode) => void
}

function SplitTerminalTile({
  agent,
  visible,
  active,
  className = '',
  onActivate,
  onDeliveryModeChange
}: SplitTerminalTileProps): React.ReactNode {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden border bg-[var(--pear-bg)] ${
        active
          ? 'border-[var(--pear-accent-dim)]'
          : 'border-[var(--pear-border-subtle)]'
      } ${className}`}
      onPointerDown={onActivate}
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
          <span className="shrink-0 text-[10px] text-[var(--pear-text-faint)]">thinking</span>
        )}
        <span className="shrink-0 text-[var(--pear-text-faint)]">{agent.cli}</span>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalWorkspace
          agent={agent}
          visible={visible}
          active={active}
          onActivate={onActivate}
          onDeliveryModeChange={onDeliveryModeChange}
        />
      </div>
    </div>
  )
}

interface SplitTerminalPageProps {
  agents: Agent[]
  visible: boolean
  activeAgentName: string | null
  onActivateAgent: (name: string) => void
  onDeliveryModeChange: (agent: Agent, mode: QueueDeliveryMode) => void
}

function SplitTerminalPage({
  agents,
  visible,
  activeAgentName,
  onActivateAgent,
  onDeliveryModeChange
}: SplitTerminalPageProps): React.ReactNode {
  return (
    <div className={`grid h-full gap-1 p-1 ${getSplitPageGridClass(agents.length)}`}>
      {agents.map((agent, index) => {
        const active = visible && agent.name === activeAgentName
        return (
          <SplitTerminalTile
            key={agent.name}
            agent={agent}
            visible={visible}
            active={active}
            className={getSplitTileClass(agents.length, index)}
            onActivate={() => onActivateAgent(agent.name)}
            onDeliveryModeChange={onDeliveryModeChange}
          />
        )
      })}
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
  const [splitPage, setSplitPage] = useState(0)
  const splitEnabled = terminalLayout === 'horizontal-split' && agents.length > 1
  const splitPages = splitEnabled ? chunkAgents(agents) : []
  const splitPageCount = splitPages.length
  const splitButtonTitle = splitEnabled
    ? 'Move terminals back to tabs'
    : agents.length > 1
      ? 'Show split terminal pages'
      : 'Start another agent to split terminals'

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

  const handleDeliveryModeChange = async (
    agent: Agent,
    mode: QueueDeliveryMode
  ): Promise<void> => {
    const terminalMode = toTerminalMode(mode)
    if (getTerminalMode(agent) === terminalMode) return

    const previousMode = getTerminalMode(agent)
    setSpawnError(null)
    setAgentTerminalMode(agent.name, terminalMode)

    try {
      await pear.broker.setTerminalMode(agent.name, terminalMode)
    } catch (err) {
      setAgentTerminalMode(agent.name, previousMode)
      setSpawnError(err instanceof Error ? err.message : String(err))
    }
  }

  const goToSplitPage = (page: number): void => {
    const clampedPage = Math.max(0, Math.min(page, splitPageCount - 1))
    setSplitPage(clampedPage)

    const nextAgent = splitPages[clampedPage]?.[0]
    if (nextAgent) {
      setActiveAgent(nextAgent.name)
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

  useEffect(() => {
    if (!splitEnabled) {
      setSplitPage(0)
      return
    }

    setSplitPage((currentPage) =>
      Math.min(currentPage, Math.max(0, splitPageCount - 1))
    )
  }, [splitEnabled, splitPageCount])

  useEffect(() => {
    if (!splitEnabled || !activeAgentName) return

    const activeIndex = agents.findIndex((agent) => agent.name === activeAgentName)
    if (activeIndex >= 0) {
      setSplitPage(Math.floor(activeIndex / SPLIT_PAGE_SIZE))
    }
  }, [activeAgentName, agents, splitEnabled])

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
        <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--pear-bg)]">
          {splitPages.map((pageAgents, pageIndex) => {
            const visible = pageIndex === splitPage
            return (
              <div
                key={pageAgents.map((agent) => agent.name).join('|')}
                className="absolute inset-0 transition-transform duration-300 ease-out"
                style={{ transform: `translateX(${(pageIndex - splitPage) * 100}%)` }}
                aria-hidden={!visible}
              >
                <SplitTerminalPage
                  agents={pageAgents}
                  visible={visible}
                  activeAgentName={activeAgentName}
                  onActivateAgent={setActiveAgent}
                  onDeliveryModeChange={(agent, mode) => void handleDeliveryModeChange(agent, mode)}
                />
              </div>
            )
          })}

          {splitPageCount > 1 && splitPage > 0 && (
            <button
              type="button"
              onClick={() => goToSplitPage(splitPage - 1)}
              className="absolute left-2 top-1/2 z-10 flex h-12 w-9 -translate-y-1/2 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)] shadow-lg hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
              title="Previous terminal page"
              aria-label="Previous terminal page"
            >
              <ChevronLeft size={18} />
            </button>
          )}

          {splitPageCount > 1 && splitPage < splitPageCount - 1 && (
            <button
              type="button"
              onClick={() => goToSplitPage(splitPage + 1)}
              className="absolute right-2 top-1/2 z-10 flex h-12 w-9 -translate-y-1/2 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)] shadow-lg hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
              title="Next terminal page"
              aria-label="Next terminal page"
            >
              <ChevronRight size={18} />
            </button>
          )}

          {splitPageCount > 1 && (
            <div className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-2 py-1">
              {splitPages.map((pageAgents, pageIndex) => (
                <button
                  key={pageAgents.map((agent) => agent.name).join('|')}
                  type="button"
                  onClick={() => goToSplitPage(pageIndex)}
                  className={`h-1.5 rounded-full transition-all ${
                    pageIndex === splitPage
                      ? 'w-5 bg-[var(--pear-accent-bright)]'
                      : 'w-1.5 bg-[var(--pear-text-faint)] hover:bg-[var(--pear-text-dim)]'
                  }`}
                  title={`Show terminal page ${pageIndex + 1}`}
                  aria-label={`Show terminal page ${pageIndex + 1}`}
                />
              ))}
            </div>
          )}
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
                <SplitTerminalTile
                  agent={agent}
                  visible={active}
                  active={active}
                  onActivate={() => setActiveAgent(agent.name)}
                  onDeliveryModeChange={(targetAgent, mode) => void handleDeliveryModeChange(targetAgent, mode)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
