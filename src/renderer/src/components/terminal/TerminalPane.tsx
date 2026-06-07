import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Columns2, Loader2, Network, PanelTop, X } from 'lucide-react'
import { AgentHarnessIcon, ClaudeIcon, CodexIcon, OpenCodeIcon } from '@/components/common/AgentIcons'
import { GraphView } from '@/components/graph/GraphView'
import { ChatComposerInput } from '@/components/chat/ChatComposerInput'
import { spawnProjectAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { formatTokenCount } from '@/lib/format'
import { pear, type BurnAgentInput, type BurnAgentSummary, type TerminalAttachMode } from '@/lib/ipc'
import { getAgentKeyForAgent, type Agent, useAgentStore } from '@/stores/agent-store'
import { useCloudAgentStore, type CloudAgentAttachProgress } from '@/stores/cloud-agent-store'
import { useIsAgentTyping } from '@/stores/typing-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { PendingMessagesMenu, type QueueDeliveryMode } from './PendingMessagesPane'
import { TerminalInstance } from './TerminalInstance'

const SPLIT_PAGE_SIZE = 4

function isPreparingCloudAgent(progress: CloudAgentAttachProgress | undefined): boolean {
  return Boolean(progress && progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error')
}

function cloudAgentErrorMessage(progress: CloudAgentAttachProgress | undefined): string | null {
  return progress?.phase === 'error'
    ? progress.message || 'Cloud agent attach failed'
    : null
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function preparingLabel(progress: CloudAgentAttachProgress | undefined): string {
  if (!progress) return 'Preparing cloud agent'
  if (progress.message && !progress.sandboxPhase) return progress.message
  switch (progress.sandboxPhase) {
    case 'queued':
      return 'Queued for sandbox capacity'
    case 'pulling-image':
      return 'Preparing sandbox image'
    case 'starting':
      return 'Starting sandbox'
    case 'cloning':
      return 'Cloning workspace'
    case 'mounting':
      return 'Mounting workspace'
    case 'ready':
      return 'Finalizing connection'
  }
  switch (progress.phase) {
    case 'mounting':
      return 'Mounting workspace'
    case 'connecting-broker':
      return 'Connecting broker'
    default:
      return 'Warming sandbox'
  }
}

function progressPercent(progress: CloudAgentAttachProgress | undefined, elapsedMs: number): number | null {
  if (!progress?.sandboxPhase && progress?.etaMs === undefined) return null
  const baseByPhase: Partial<Record<NonNullable<CloudAgentAttachProgress['sandboxPhase']>, number>> = {
    queued: 8,
    'pulling-image': 24,
    starting: 42,
    cloning: 60,
    mounting: 78,
    ready: 100
  }
  const base = progress.sandboxPhase ? baseByPhase[progress.sandboxPhase] ?? 12 : 12
  if (progress.sandboxPhase === 'ready' || progress.phase === 'done') return 100
  if (typeof progress.etaMs !== 'number' || progress.etaMs <= 0) return base
  const fraction = elapsedMs / Math.max(1, elapsedMs + progress.etaMs)
  return Math.max(base, Math.min(96, Math.round(base + fraction * (96 - base))))
}

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

function getBurnInputForAgent(agent: Agent): BurnAgentInput {
  return {
    name: agent.name,
    projectId: agent.projectId,
    cwd: agent.rootPath,
    cli: agent.cli
  }
}

function BurnTokenBadge({
  summary,
  onClick,
  compact = false
}: {
  summary?: BurnAgentSummary
  onClick: () => void
  compact?: boolean
}): React.ReactNode {
  const tokens = formatTokenCount(summary?.totalTokens ?? 0)
  const title = summary?.status === 'unavailable' && summary.error
    ? `Burn unavailable: ${summary.error}`
    : 'Open burn breakdown'

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`shrink-0 rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)] transition-colors hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)] ${
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'
      }`}
      title={title}
      aria-label="Open burn breakdown"
    >
      {tokens} tokens
    </button>
  )
}

interface TerminalProjectProps {
  agent: Agent
  visible: boolean
  active: boolean
  onActivate: () => void
  autoHold?: boolean
  onAutoHoldStart?: () => Promise<void> | void
  onAutoHoldRelease?: (flush: boolean) => Promise<void> | void
}

function TerminalProject({
  agent,
  visible,
  active,
  onActivate,
  autoHold,
  onAutoHoldStart,
  onAutoHoldRelease
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
          autoHold={autoHold}
          onAutoHoldStart={onAutoHoldStart}
          onAutoHoldRelease={onAutoHoldRelease}
        />
      </div>
    </div>
  )
}

interface SplitTerminalTileProps {
  agent: Agent
  burnSummary?: BurnAgentSummary
  visible: boolean
  active: boolean
  className?: string
  onActivate: () => void
  onDeliveryModeChange: (agent: Agent, mode: QueueDeliveryMode) => void
  onOpenBurn: (agent: Agent) => void
  autoHold?: boolean
  onAutoHoldStart?: () => Promise<void> | void
  onAutoHoldRelease?: (flush: boolean) => Promise<void> | void
}

function SplitTerminalTile({
  agent,
  burnSummary,
  visible,
  active,
  className = '',
  onActivate,
  onDeliveryModeChange,
  onOpenBurn,
  autoHold,
  onAutoHoldStart,
  onAutoHoldRelease
}: SplitTerminalTileProps): React.ReactNode {
  const typing = useIsAgentTyping(agent)
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
          <BurnTokenBadge summary={burnSummary} compact onClick={() => onOpenBurn(agent)} />
        </div>
        {typing && <TypingDots />}
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
          autoHold={autoHold}
          onAutoHoldStart={onAutoHoldStart}
          onAutoHoldRelease={onAutoHoldRelease}
        />
      </div>
    </div>
  )
}

interface AgentTabProps {
  agent: Agent
  burnSummary?: BurnAgentSummary
  active: boolean
  onActivate: () => void
  onOpenBurn: (agent: Agent) => void
}

function AgentTab({ agent, burnSummary, active, onActivate, onOpenBurn }: AgentTabProps): React.ReactNode {
  const typing = useIsAgentTyping(agent)
  return (
    <div
      key={getAgentKeyForAgent(agent)}
      role="tab"
      tabIndex={0}
      aria-selected={active}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate()
        }
      }}
      className={`group my-1 flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-4 py-3 text-sm transition-colors ${
        active
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
        <BurnTokenBadge summary={burnSummary} onClick={() => onOpenBurn(agent)} />
        {typing && <TypingDots />}
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
  )
}

interface SplitTerminalPageProps {
  agents: Agent[]
  burnSummariesByAgentKey: Record<string, BurnAgentSummary>
  visible: boolean
  activeAgentKey: string | null
  onActivateAgent: (key: string) => void
  onDeliveryModeChange: (agent: Agent, mode: QueueDeliveryMode) => void
  onOpenBurn: (agent: Agent) => void
  autoHold: boolean
  makeAutoHoldHandlers: (agent: Agent) => {
    onAutoHoldStart: () => Promise<void>
    onAutoHoldRelease: (flush: boolean) => Promise<void>
  }
}

function SplitTerminalPage({
  agents,
  burnSummariesByAgentKey,
  visible,
  activeAgentKey,
  onActivateAgent,
  onDeliveryModeChange,
  onOpenBurn,
  autoHold,
  makeAutoHoldHandlers
}: SplitTerminalPageProps): React.ReactNode {
  return (
    <div className={`grid h-full gap-1 p-1 ${getSplitPageGridClass(agents.length)}`}>
      {agents.map((agent, index) => {
        const agentKey = getAgentKeyForAgent(agent)
        const active = visible && agentKey === activeAgentKey
        const { onAutoHoldStart, onAutoHoldRelease } = makeAutoHoldHandlers(agent)
        return (
          <SplitTerminalTile
            key={agentKey}
            agent={agent}
            burnSummary={burnSummariesByAgentKey[agentKey]}
            visible={visible}
            active={active}
            className={getSplitTileClass(agents.length, index)}
            onActivate={() => onActivateAgent(agentKey)}
            onDeliveryModeChange={onDeliveryModeChange}
            onOpenBurn={onOpenBurn}
            autoHold={autoHold}
            onAutoHoldStart={onAutoHoldStart}
            onAutoHoldRelease={onAutoHoldRelease}
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
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const addHumanMessage = useAgentStore((s) => s.addHumanMessage)
  const cloudAttachProgress = useCloudAgentStore((s) => activeProjectId ? s.attachProgress[activeProjectId] : undefined)
  const queuedFirstPrompt = useCloudAgentStore((s) => activeProjectId ? s.queuedFirstPrompts[activeProjectId] : undefined)
  const setCloudAttachProgress = useCloudAgentStore((s) => s.setAttachProgress)
  const queueFirstPrompt = useCloudAgentStore((s) => s.queueFirstPrompt)
  const openDialog = useUIStore((s) => s.openDialog)
  const openTab = useUIStore((s) => s.openTab)
  const terminalLayout = useUIStore((s) => s.terminalLayout)
  const setTerminalLayout = useUIStore((s) => s.setTerminalLayout)
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const spawnRequestRef = useRef(false)
  const [burnSummariesByAgentKey, setBurnSummariesByAgentKey] = useState<Record<string, BurnAgentSummary>>({})
  const [splitPage, setSplitPage] = useState(0)
  const [firstPromptText, setFirstPromptText] = useState('')
  const [queuedPromptError, setQueuedPromptError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const flushingPromptRef = useRef<string | null>(null)
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
  const burnInputs = useMemo(() => agents.map(getBurnInputForAgent), [agents])
  const burnInputsKey = useMemo(
    () => burnInputs.map((agent) => `${agent.projectId || 'unknown'}:${agent.name}:${agent.cwd || ''}:${agent.cli || ''}`).join('|'),
    [burnInputs]
  )
  const preparingCloudAgent = isPreparingCloudAgent(cloudAttachProgress)
  const cloudAttachError = cloudAgentErrorMessage(cloudAttachProgress)
  const preparingElapsedMs = cloudAttachProgress ? Math.max(0, nowMs - cloudAttachProgress.startedAt) : 0
  const preparingProgressPercent = progressPercent(cloudAttachProgress, preparingElapsedMs)

  const handleSpawn = async (cli: SpawnAgentCli): Promise<void> => {
    if (spawnRequestRef.current) return
    if (!activeProject) {
      openDialog('add-project')
      return
    }

    spawnRequestRef.current = true
    setSpawnError(null)
    setSpawningCli(cli)
    try {
      await spawnProjectAgent(activeProject, cli)
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpawningCli(null)
      spawnRequestRef.current = false
    }
  }

  const queuePreparingPrompt = (): void => {
    if (!activeProjectId || !firstPromptText.trim()) return
    const text = firstPromptText.trim()
    queueFirstPrompt(activeProjectId, {
      text,
      targetName: cloudAttachProgress?.cloudAgentName,
      queuedAt: Date.now()
    })
    setFirstPromptText('')
    setQueuedPromptError(null)
  }

  const cancelPreparingCloudAgent = async (): Promise<void> => {
    if (!activeProjectId) return
    setQueuedPromptError(null)
    queueFirstPrompt(activeProjectId, null)
    setCloudAttachProgress(activeProjectId, null)
    try {
      await pear.cloudAgent.cancelPrewarm(activeProjectId, cloudAttachProgress?.cloudAgentId)
      await pear.cloudAgent.detach(activeProjectId)
    } catch (err) {
      setQueuedPromptError(err instanceof Error ? err.message : String(err))
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

  const makeAutoHoldHandlers = (agent: Agent): {
    onAutoHoldStart: () => Promise<void>
    onAutoHoldRelease: (flush: boolean) => Promise<void>
  } => ({
    onAutoHoldStart: async () => {
      await handleDeliveryModeChange(agent, 'drive')
    },
    onAutoHoldRelease: async (flush: boolean) => {
      let flushError: unknown
      if (flush) {
        try {
          await pear.broker.flushPending(agent.projectId, agent.name)
        } catch (err) {
          flushError = err
          setSpawnError(err instanceof Error ? err.message : String(err))
        }
      }
      await handleDeliveryModeChange(agent, 'auto')
      if (flushError) throw flushError
    }
  })

  const runningAgentCount = agents.filter((a) => a.status === 'running').length
  const autoHold = runningAgentCount > 1

  const goToSplitPage = (page: number): void => {
    const clampedPage = Math.max(0, Math.min(page, splitPageCount - 1))
    setSplitPage(clampedPage)

    const nextAgent = splitPages[clampedPage]?.[0]
    if (nextAgent) {
      setActiveAgentKey(getAgentKeyForAgent(nextAgent))
    }
  }

  const openBurnDetails = (agent: Agent): void => {
    openTab({
      kind: 'burn-session',
      projectId: agent.projectId,
      burnAgent: getBurnInputForAgent(agent)
    })
  }

  useEffect(() => {
    let cancelled = false

    const loadBurnSummaries = async (): Promise<void> => {
      if (burnInputs.length === 0) {
        setBurnSummariesByAgentKey({})
        return
      }

      try {
        const summaries = await pear.burn.listAgentSummaries(burnInputs)
        if (cancelled) return
        setBurnSummariesByAgentKey(Object.fromEntries(
          summaries.map((summary) => [summary.agentKey, summary])
        ))
      } catch {
        if (!cancelled) setBurnSummariesByAgentKey({})
      }
    }

    void loadBurnSummaries()
    const interval = window.setInterval(() => {
      void loadBurnSummaries()
    }, 30_000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [burnInputsKey])

  useEffect(() => {
    if (!preparingCloudAgent) return
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [preparingCloudAgent])

  useEffect(() => {
    if (!activeProjectId || !queuedFirstPrompt || queuedPromptError || brokerStatus !== 'connected') return
    const target = agents.find((agent) => agent.name === queuedFirstPrompt.targetName) || agents[0]
    if (!target) return

    const flushKey = `${activeProjectId}\0${queuedFirstPrompt.queuedAt}\0${target.name}`
    if (flushingPromptRef.current === flushKey) return
    flushingPromptRef.current = flushKey

    pear.broker.sendMessage(activeProjectId, {
      to: target.name,
      text: queuedFirstPrompt.text,
      from: 'human'
    }).then(() => {
      addHumanMessage(target.name, queuedFirstPrompt.text, activeProjectId)
      queueFirstPrompt(activeProjectId, null)
      if (cloudAttachProgress?.phase === 'done') {
        setCloudAttachProgress(activeProjectId, null)
      }
      setQueuedPromptError(null)
    }).catch((err) => {
      setQueuedPromptError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (flushingPromptRef.current === flushKey) {
        flushingPromptRef.current = null
      }
    })
  }, [
    activeProjectId,
    addHumanMessage,
    agents,
    brokerStatus,
    cloudAttachProgress?.phase,
    queuedFirstPrompt,
    queuedPromptError,
    queueFirstPrompt,
    setCloudAttachProgress
  ])

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
    if (activeProject && cloudAttachError) {
      return (
        <div className="flex h-full flex-col bg-[var(--pear-bg)]">
          <div className="mx-auto flex h-full w-full max-w-[620px] flex-col justify-center px-6 py-8">
            <div className="rounded-lg border border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--pear-red)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--pear-text)]">Cloud agent attach failed</div>
                  <div className="mt-1 text-xs leading-5 text-[var(--pear-red)]">{cloudAttachError}</div>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => activeProjectId && setCloudAttachProgress(activeProjectId, null)}
                  className="rounded-md border border-[var(--pear-border-subtle)] px-3 py-1.5 text-xs text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )
    }

    if (activeProject && preparingCloudAgent) {
      return (
        <div className="flex h-full flex-col bg-[var(--pear-bg)]">
          <div className="mx-auto flex h-full w-full max-w-[760px] flex-col justify-center px-6 py-8">
            <div className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-raised)] p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-[var(--pear-text)]">
                    <Loader2 size={15} className="animate-spin text-[var(--pear-accent)]" />
                    <span className="truncate">{cloudAttachProgress?.cloudAgentName || 'Cloud agent'}</span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--pear-text-faint)]">
                    {preparingLabel(cloudAttachProgress)} · elapsed {formatDuration(preparingElapsedMs)}
                    {cloudAttachProgress?.etaMs !== undefined && (
                      <span> · ETA {formatDuration(cloudAttachProgress.etaMs)}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void cancelPreparingCloudAgent()}
                  className="shrink-0 rounded-md border border-[var(--pear-border-subtle)] px-3 py-1.5 text-xs text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                >
                  Cancel
                </button>
              </div>

              {preparingProgressPercent === null ? (
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--pear-bg-overlay)]">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--pear-accent)]/70" />
                </div>
              ) : (
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--pear-bg-overlay)]">
                  <div
                    className="h-full rounded-full bg-[var(--pear-accent)] transition-[width] duration-500"
                    style={{ width: `${preparingProgressPercent}%` }}
                  />
                </div>
              )}

              <div className="mt-5">
                <ChatComposerInput
                  value={firstPromptText}
                  placeholder={queuedFirstPrompt ? 'First prompt queued' : 'Queue the first prompt'}
                  sendLabel="Queue first prompt"
                  runningAgents={[]}
                  activeProjectId={activeProjectId}
                  disabled={Boolean(queuedFirstPrompt)}
                  canSend={Boolean(firstPromptText.trim()) && !queuedFirstPrompt}
                  onChange={setFirstPromptText}
                  onSubmit={queuePreparingPrompt}
                />
              </div>

              {queuedFirstPrompt && (
                <div className="mt-3 rounded-md border border-[var(--pear-accent-dim)]/25 bg-[var(--pear-accent)]/10 px-3 py-2 text-xs text-[var(--pear-text-dim)]">
                  Queued: {queuedFirstPrompt.text}
                </div>
              )}

              {queuedPromptError && (
                <div className="mt-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
                  {queuedPromptError}
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--pear-bg)] px-8 text-[var(--pear-text-faint)]">
        <p className="text-sm text-[var(--pear-text-dim)]">
          {activeProject ? 'No agents running' : 'No project selected'}
        </p>
        {activeProject ? (
          <div className="mt-4 grid w-full max-w-[420px] grid-cols-3 gap-3">
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
            <button
              type="button"
              onClick={() => handleSpawn('opencode')}
              disabled={!activeRoot?.pathExists || spawningCli !== null}
              className="flex items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
              title={activeRoot?.pathExists ? 'Spawn OpenCode' : `Path not found: ${activeRoot?.path || activeProject.rootPath}`}
            >
              <OpenCodeIcon className="h-4 w-4" />
              <span>{spawningCli === 'opencode' ? 'Starting' : 'OpenCode'}</span>
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
            agents.map((agent) => {
              const agentKey = getAgentKeyForAgent(agent)
              return (
                <AgentTab
                  key={agentKey}
                  agent={agent}
                  burnSummary={burnSummariesByAgentKey[agentKey]}
                  active={activeAgentKey === agentKey}
                  onActivate={() => setActiveAgentKey(agentKey)}
                  onOpenBurn={openBurnDetails}
                />
              )
            })
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
      {cloudAttachError && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{cloudAttachError}</span>
          <button
            type="button"
            onClick={() => activeProjectId && setCloudAttachProgress(activeProjectId, null)}
            className="shrink-0 text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]"
          >
            Dismiss
          </button>
        </div>
      )}
      {preparingCloudAgent && (
        <div className="shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-[220px] flex-1">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-[var(--pear-text)]">
                    <Loader2 size={13} className="animate-spin text-[var(--pear-accent)]" />
                    <span className="truncate">{cloudAttachProgress?.cloudAgentName || 'Cloud agent'}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--pear-text-faint)]">
                    {preparingLabel(cloudAttachProgress)} · elapsed {formatDuration(preparingElapsedMs)}
                    {cloudAttachProgress?.etaMs !== undefined && (
                      <span> · ETA {formatDuration(cloudAttachProgress.etaMs)}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void cancelPreparingCloudAgent()}
                  className="shrink-0 rounded-md border border-[var(--pear-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                >
                  Cancel
                </button>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--pear-bg-overlay)]">
                {preparingProgressPercent === null ? (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--pear-accent)]/70" />
                ) : (
                  <div
                    className="h-full rounded-full bg-[var(--pear-accent)] transition-[width] duration-500"
                    style={{ width: `${preparingProgressPercent}%` }}
                  />
                )}
              </div>
            </div>
            <div className="min-w-0 flex-[1.4]">
              <ChatComposerInput
                value={firstPromptText}
                placeholder={queuedFirstPrompt ? 'First prompt queued' : 'Queue the first prompt'}
                sendLabel="Queue first prompt"
                runningAgents={agents}
                activeProjectId={activeProjectId}
                disabled={Boolean(queuedFirstPrompt)}
                canSend={Boolean(firstPromptText.trim()) && !queuedFirstPrompt}
                onChange={setFirstPromptText}
                onSubmit={queuePreparingPrompt}
              />
              {queuedFirstPrompt && (
                <div className="mt-2 truncate text-[11px] text-[var(--pear-text-faint)]">
                  Queued: {queuedFirstPrompt.text}
                </div>
              )}
              {queuedPromptError && (
                <div className="mt-2 text-[11px] text-[var(--pear-red)]">
                  {queuedPromptError}
                </div>
              )}
            </div>
          </div>
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
                  burnSummariesByAgentKey={burnSummariesByAgentKey}
                  visible={visible}
                  activeAgentKey={activeAgentKey}
                  onActivateAgent={setActiveAgentKey}
                  onDeliveryModeChange={(agent, mode) => void handleDeliveryModeChange(agent, mode)}
                  onOpenBurn={openBurnDetails}
                  autoHold={autoHold}
                  makeAutoHoldHandlers={makeAutoHoldHandlers}
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
                className="absolute inset-0 transition-opacity duration-150 ease-out"
                style={{
                  opacity: active ? 1 : 0,
                  pointerEvents: active ? 'auto' : 'none'
                }}
                aria-hidden={!active}
              >
                <TerminalProject
                  agent={agent}
                  visible={active}
                  active={active}
                  onActivate={() => setActiveAgentKey(agentKey)}
                  autoHold={autoHold}
                  {...makeAutoHoldHandlers(agent)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
