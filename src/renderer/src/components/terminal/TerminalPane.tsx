import type React from 'react'
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Columns2, Network, PanelTop, X } from 'lucide-react'
import { AgentHarnessIcon, ClaudeIcon, CodexIcon } from '@/components/common/AgentIcons'
import { GraphView } from '@/components/graph/GraphView'
import { spawnProjectAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { pear, type TerminalAttachMode } from '@/lib/ipc'
import { getAgentKeyForAgent, isAgentTyping, type Agent, useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { PendingMessagesMenu, type QueueDeliveryMode } from './PendingMessagesPane'
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

function TypingDots({ className = '' }: { className?: string }): React.ReactNode {
  return (
    <span
      className={`flex h-4 w-6 shrink-0 items-center justify-center gap-0.5 rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 opacity-70 ${className}`}
      title="Thinking"
      aria-label="Thinking"
    >
      <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse" />
      <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse [animation-delay:120ms]" />
      <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse [animation-delay:240ms]" />
    </span>
  )
}

interface TerminalProjectProps {
  agent: Agent
  visible: boolean
  active: boolean
  onActivate: () => void
}

function TerminalProject({
  agent,
  visible,
  active,
  onActivate
}: TerminalProjectProps): React.ReactNode {
  const terminalMode = getTerminalMode(agent)

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 bg-[var(--pear-bg)]">
      <div className="min-h-0 min-w-0 flex-1">
        <TerminalInstance
          agentName={agent.name}
          projectId={agent.projectId}
          visible={visible}
          active={active}
          mode={terminalMode}
          onActivate={onActivate}
        />
      </div>
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
        className={`relative flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs ${
          active
            ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
            : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)]'
        }`}
      >
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          title={agent.cli}
          aria-label={agent.cli}
        >
          <AgentHarnessIcon
            cli={agent.cli}
            className={`h-4 w-4 ${
              agent.status === 'running' ? 'text-[var(--pear-text-dim)]' : 'text-[var(--pear-text-faint)]'
            }`}
          />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate font-medium">{agent.name}</span>
        </div>
        {isAgentTyping(agent) && <TypingDots />}
        {visible && (
          <PendingMessagesMenu
            projectId={agent.projectId}
            agentName={agent.name}
            deliveryMode={getQueueDeliveryMode(agent)}
            refreshToken={agent.pendingDeliveryIds.join('|')}
            onDeliveryModeChange={(mode) => onDeliveryModeChange(agent, mode)}
          />
        )}
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <TerminalProject
          agent={agent}
          visible={visible}
          active={active}
          onActivate={onActivate}
        />
      </div>
    </div>
  )
}

interface SplitTerminalPageProps {
  agents: Agent[]
  visible: boolean
  activeAgentKey: string | null
  onActivateAgent: (key: string) => void
  onDeliveryModeChange: (agent: Agent, mode: QueueDeliveryMode) => void
}

function SplitTerminalPage({
  agents,
  visible,
  activeAgentKey,
  onActivateAgent,
  onDeliveryModeChange
}: SplitTerminalPageProps): React.ReactNode {
  return (
    <div className={`grid h-full gap-1 p-1 ${getSplitPageGridClass(agents.length)}`}>
      {agents.map((agent, index) => {
        const agentKey = getAgentKeyForAgent(agent)
        const active = visible && agentKey === activeAgentKey
        return (
          <SplitTerminalTile
            key={agentKey}
            agent={agent}
            visible={visible}
            active={active}
            className={getSplitTileClass(agents.length, index)}
            onActivate={() => onActivateAgent(agentKey)}
            onDeliveryModeChange={onDeliveryModeChange}
          />
        )
      })}
    </div>
  )
}

export function TerminalPane(): React.ReactNode {
  const allAgents = useAgentStore((s) => s.agents)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = useProjectStore((s) => s.getActiveProject())
  const activeRoot = useProjectStore((s) => s.getActiveRoot())
  const agents = activeProjectId
    ? allAgents.filter((a) => a.projectId === activeProjectId)
    : allAgents
  const activeAgentKey = useAgentStore((s) => s.activeAgentKey)
  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)
  const setAgentTerminalMode = useAgentStore((s) => s.setAgentTerminalMode)
  const openDialog = useUIStore((s) => s.openDialog)
  const terminalLayout = useUIStore((s) => s.terminalLayout)
  const setTerminalLayout = useUIStore((s) => s.setTerminalLayout)
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [splitPage, setSplitPage] = useState(0)
  const graphEnabled = terminalLayout === 'graph'
  const splitEnabled = terminalLayout === 'horizontal-split' && agents.length > 1
  const splitPages = splitEnabled ? chunkAgents(agents) : []
  const splitPageCount = splitPages.length
  const activeAgent = agents.find((agent) => getAgentKeyForAgent(agent) === activeAgentKey)
  const splitButtonTitle = splitEnabled
    ? 'Move terminals back to tabs'
    : agents.length > 1
      ? 'Show split terminal pages'
      : 'Start another agent to split terminals'
  const graphButtonTitle = graphEnabled ? 'Show terminal tabs' : 'Show agent graph'

  const handleSpawn = async (cli: SpawnAgentCli): Promise<void> => {
    if (!activeProject) {
      openDialog('add-project')
      return
    }

    setSpawnError(null)
    setSpawningCli(cli)
    try {
      await spawnProjectAgent(activeProject, cli)
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
    setAgentTerminalMode(agent.projectId, agent.name, terminalMode)

    try {
      await pear.broker.setTerminalMode(agent.projectId, agent.name, terminalMode)
    } catch (err) {
      setAgentTerminalMode(agent.projectId, agent.name, previousMode)
      setSpawnError(err instanceof Error ? err.message : String(err))
    }
  }

  const goToSplitPage = (page: number): void => {
    const clampedPage = Math.max(0, Math.min(page, splitPageCount - 1))
    setSplitPage(clampedPage)

    const nextAgent = splitPages[clampedPage]?.[0]
    if (nextAgent) {
      setActiveAgentKey(getAgentKeyForAgent(nextAgent))
    }
  }

  useEffect(() => {
    if (agents.length === 0) {
      if (activeAgentKey) {
        setActiveAgentKey(null)
      }
      return
    }

    if (!activeAgentKey || !agents.some((agent) => getAgentKeyForAgent(agent) === activeAgentKey)) {
      setActiveAgentKey(getAgentKeyForAgent(agents[0]))
    }
  }, [activeAgentKey, agents, setActiveAgentKey])

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
    if (!splitEnabled || !activeAgentKey) return

    const activeIndex = agents.findIndex((agent) => getAgentKeyForAgent(agent) === activeAgentKey)
    if (activeIndex >= 0) {
      setSplitPage(Math.floor(activeIndex / SPLIT_PAGE_SIZE))
    }
  }, [activeAgentKey, agents, splitEnabled])

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--pear-bg)] px-8 text-[var(--pear-text-faint)]">
        <p className="text-sm text-[var(--pear-text-dim)]">
          {activeProject ? 'No agents running' : 'No project selected'}
        </p>
        {activeProject ? (
          <div className="mt-4 grid w-full max-w-[340px] grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handleSpawn('claude')}
              disabled={!activeRoot?.pathExists || spawningCli !== null}
              className="flex items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
              title={activeRoot?.pathExists ? 'Spawn Claude' : `Path not found: ${activeRoot?.path || activeProject.rootPath}`}
            >
              <ClaudeIcon className="h-4 w-4" />
              <span>{spawningCli === 'claude' ? 'Starting' : 'Claude'}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSpawn('codex')}
              disabled={!activeRoot?.pathExists || spawningCli !== null}
              className="flex items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
              title={activeRoot?.pathExists ? 'Spawn Codex' : `Path not found: ${activeRoot?.path || activeProject.rootPath}`}
            >
              <CodexIcon className="h-4 w-4" />
              <span>{spawningCli === 'codex' ? 'Starting' : 'Codex'}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openDialog('add-project')}
            className="mt-4 rounded-lg border border-dashed border-[var(--pear-border)] px-6 py-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
          >
            + Add project
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
          {splitEnabled ? (
            splitPages.map((pageAgents, pageIndex) => {
              const active = pageIndex === splitPage
              const title = `Page ${pageIndex + 1}: ${pageAgents.map((agent) => agent.name).join(', ')}`
              const agentCount = pageAgents.length === 1 ? '1 agent' : `${pageAgents.length} agents`

              return (
                <div
                  key={pageAgents.map(getAgentKeyForAgent).join('|')}
                  role="tab"
                  tabIndex={0}
                  aria-selected={active}
                  onClick={() => goToSplitPage(pageIndex)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      goToSplitPage(pageIndex)
                    }
                  }}
                  className={`my-1 flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-4 py-3 text-sm transition-colors ${
                    active
                      ? 'bg-[var(--pear-bg)] text-[var(--pear-text)] shadow-sm'
                      : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]'
                  }`}
                  title={title}
                  aria-label={`Show terminal page ${pageIndex + 1}`}
                >
                  <span className="font-medium">Page {pageIndex + 1}</span>
                  <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-[var(--pear-text-faint)]">
                    {agentCount}
                  </span>
                </div>
              )
            })
          ) : (
            agents.map((agent) => (
              <div
                key={getAgentKeyForAgent(agent)}
                role="tab"
                tabIndex={0}
                aria-selected={activeAgentKey === getAgentKeyForAgent(agent)}
                onClick={() => setActiveAgentKey(getAgentKeyForAgent(agent))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActiveAgentKey(getAgentKeyForAgent(agent))
                  }
                }}
                className={`group my-1 flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-4 py-3 text-sm transition-colors ${
                  activeAgentKey === getAgentKeyForAgent(agent)
                    ? 'bg-[var(--pear-bg)] text-[var(--pear-text)] shadow-sm'
                    : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]'
                }`}
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center"
                  title={agent.cli}
                  aria-label={agent.cli}
                >
                  <AgentHarnessIcon
                    cli={agent.cli}
                    className={`h-4 w-4 ${
                      agent.status === 'running' ? 'text-[var(--pear-text-dim)]' : 'text-[var(--pear-text-faint)]'
                    }`}
                  />
                </span>
                <div className="flex items-center gap-2">
                  <span className="max-w-[120px] truncate">{agent.name}</span>
                  {isAgentTyping(agent) && <TypingDots />}
                </div>
                {agent.status === 'running' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      pear.broker.releaseAgent(agent.projectId, agent.name)
                    }}
                    className="ml-1 rounded-md p-1 opacity-0 hover:bg-[var(--pear-bg-overlay)] group-hover:opacity-100"
                    title="Release agent"
                    aria-label={`Release agent ${agent.name}`}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
        {!splitEnabled && activeAgent && (
          <PendingMessagesMenu
            projectId={activeAgent.projectId}
            agentName={activeAgent.name}
            deliveryMode={getQueueDeliveryMode(activeAgent)}
            refreshToken={activeAgent.pendingDeliveryIds.join('|')}
            onDeliveryModeChange={(mode) => void handleDeliveryModeChange(activeAgent, mode)}
          />
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
          onClick={() => setTerminalLayout(graphEnabled ? 'tabs' : 'graph')}
          aria-pressed={graphEnabled}
          className={`rounded-xl px-3 py-2 transition-colors ${
            graphEnabled
              ? 'bg-[var(--pear-bg)] text-[var(--pear-text)] shadow-sm'
              : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
          }`}
          title={graphButtonTitle}
          aria-label={graphButtonTitle}
        >
          <Network size={14} />
        </button>
      </div>
      {spawnError && (
        <div className="shrink-0 border-b border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
          {spawnError}
        </div>
      )}

      {/* Terminal instances stay mounted in tabbed mode to preserve scroll. */}
      {graphEnabled ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-[var(--pear-bg)]">
          <GraphView />
        </div>
      ) : splitEnabled ? (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--pear-bg)]">
          {splitPages.map((pageAgents, pageIndex) => {
            const visible = pageIndex === splitPage
            return (
              <div
                key={pageAgents.map(getAgentKeyForAgent).join('|')}
                className="absolute inset-0 transition-transform duration-300 ease-out"
                style={{ transform: `translateX(${(pageIndex - splitPage) * 100}%)` }}
                aria-hidden={!visible}
              >
                <SplitTerminalPage
                  agents={pageAgents}
                  visible={visible}
                  activeAgentKey={activeAgentKey}
                  onActivateAgent={setActiveAgentKey}
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
                  key={pageAgents.map(getAgentKeyForAgent).join('|')}
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
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {agents.map((agent) => {
            const agentKey = getAgentKeyForAgent(agent)
            const active = agentKey === activeAgentKey

            return (
              <div
                key={agentKey}
                className="absolute inset-0"
                style={{ display: active ? 'block' : 'none' }}
              >
                <TerminalProject
                  agent={agent}
                  visible={active}
                  active={active}
                  onActivate={() => setActiveAgentKey(agentKey)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
