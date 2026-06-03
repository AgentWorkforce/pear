import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Flame, RefreshCcw, TerminalSquare } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { Metric, Section, sessionShortId } from '@/components/burn/BurnPrimitives'
import { useBurnFingerprintRefresh } from '@/components/burn/useBurnFingerprintRefresh'
import { formatRelativeShort, formatTokenCount, formatUsd } from '@/lib/format'
import { pear, type BurnProjectBreakdown, type BurnProjectOverhead } from '@/lib/ipc'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

const BURN_PROJECT_REFRESH_MS = 12_000
const burnProjectCache = new Map<string, BurnProjectBreakdown>()

interface BreakdownState {
  projectId: string | null
  breakdown: BurnProjectBreakdown | null
  loading: boolean
  error: string | null
}

function createBreakdownState(projectId: string | null): BreakdownState {
  const cached = projectId ? burnProjectCache.get(projectId) ?? null : null
  return {
    projectId,
    breakdown: cached,
    loading: Boolean(projectId && !cached),
    error: null
  }
}

export function BurnProjectPage(): React.ReactNode {
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const openTab = useUIStore((s) => s.openTab)
  const projectId = activeTab?.projectId ?? null
  const projectName = useProjectStore((s) =>
    projectId ? s.projects.find((project) => project.id === projectId)?.name : undefined
  )
  const mountedRef = useRef(true)
  const loadingProjectIdRef = useRef<string | null>(null)
  const [breakdownState, setBreakdownState] = useState<BreakdownState>(() => createBreakdownState(projectId))
  const [overhead, setOverhead] = useState<BurnProjectOverhead | null>(null)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadBreakdown = useCallback(async (force = false) => {
    if (!projectId) {
      setBreakdownState(createBreakdownState(null))
      return
    }

    if (loadingProjectIdRef.current === projectId) return

    const cached = burnProjectCache.get(projectId) ?? null
    loadingProjectIdRef.current = projectId
    setBreakdownState({
      projectId,
      breakdown: cached,
      loading: true,
      error: null
    })

    try {
      const next = await pear.burn.getProjectBreakdown({ projectId, force })
      const nextError = next.status === 'unavailable' && next.error ? next.error : null
      if (next.status === 'ok') burnProjectCache.set(projectId, next)
      if (!mountedRef.current) return
      setBreakdownState((current) => {
        if (current.projectId !== projectId) return current
        return {
          projectId,
          breakdown: next.status === 'ok' ? next : current.breakdown ?? cached ?? next,
          loading: false,
          error: nextError
        }
      })
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err)
      if (!mountedRef.current) return
      setBreakdownState((current) => {
        if (current.projectId !== projectId) return current
        return {
          projectId,
          breakdown: current.breakdown ?? cached,
          loading: false,
          error: nextError
        }
      })
    } finally {
      if (loadingProjectIdRef.current === projectId) {
        loadingProjectIdRef.current = null
      }
    }
  }, [projectId])

  useEffect(() => {
    void loadBreakdown()
  }, [loadBreakdown])

  useBurnFingerprintRefresh({}, BURN_PROJECT_REFRESH_MS, () => { void loadBreakdown() })

  useEffect(() => {
    if (!projectId) {
      setOverhead(null)
      return
    }
    let cancelled = false
    pear.burn.getProjectOverhead({ projectId }).then((result) => {
      if (!cancelled) setOverhead(result)
    }).catch(() => {
      // Swallow errors — overhead is informational
    })
    return () => {
      cancelled = true
      setOverhead(null)
    }
  }, [projectId])

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)] text-sm text-[var(--pear-text-faint)]">
        No project selected
      </div>
    )
  }

  const cachedBreakdown = burnProjectCache.get(projectId) ?? null
  const stateMatchesProject = breakdownState.projectId === projectId
  const display = stateMatchesProject ? breakdownState.breakdown : cachedBreakdown
  const loading = stateMatchesProject ? breakdownState.loading : Boolean(!cachedBreakdown)
  const error = stateMatchesProject ? breakdownState.error : null
  const initialLoading = loading && !display
  const headerLabel = projectName || projectId

  return (
    <div className="h-full overflow-y-auto bg-[var(--pear-bg)]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs text-[var(--pear-text-faint)]">
              <Flame size={14} className="text-[var(--pear-orange)]" />
              <span>Project burn rollup</span>
            </div>
            <h1 className="truncate text-2xl font-semibold text-[var(--pear-text)]">{headerLabel}</h1>
            <p className="mt-1 truncate text-sm text-[var(--pear-text-faint)]">
              {loading && !display ? 'Updating burn data...' : `${display?.byAgent.length ?? 0} agents · ${display?.sessionIds.length ?? 0} sessions`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openTab({ kind: 'agents', projectId })}
              className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
              title="Open terminals"
            >
              <TerminalSquare size={15} />
              <span>Terminals</span>
            </button>
            <button
              type="button"
              onClick={() => void loadBreakdown(true)}
              disabled={loading}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-3 text-sm text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-50"
              title="Refresh burn data"
            >
              <RefreshCcw size={15} className={loading ? 'animate-spin' : ''} />
              <span>{loading ? 'Refreshing' : 'Refresh'}</span>
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 px-4 py-3 text-sm text-[var(--pear-red)]">
            {error}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Tokens" value={formatTokenCount(display?.totalTokens ?? 0)} loading={initialLoading} />
          <Metric label="Cost" value={formatUsd(display?.totalCost ?? 0)} loading={initialLoading} />
          <Metric label="Turns" value={String(display?.turnCount ?? 0)} loading={initialLoading} />
          <Metric label="Agents" value={String(display?.byAgent.length ?? 0)} loading={initialLoading} />
        </div>

        <Section title="Agents" empty={!display?.byAgent.length} loading={initialLoading} loadingRows={4}>
          <div className="space-y-1">
            {display?.byAgent.map((agent) => (
              <button
                key={agent.agentKey}
                type="button"
                onClick={() =>
                  openTab({
                    kind: 'burn-session',
                    burnAgent: {
                      name: agent.name,
                      projectId,
                      cwd: agent.cwd,
                      cli: agent.cli
                    }
                  })
                }
                className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-[var(--pear-bg-surface-hover)]"
              >
                <AgentHarnessIcon cli={agent.cli} className="h-4 w-4 text-[var(--pear-text-secondary)]" />
                <span className="truncate text-[var(--pear-text)]">{agent.name}</span>
                <span className="text-[var(--pear-text-faint)]">{agent.sessionCount} sessions</span>
                <span className="text-[var(--pear-text-faint)]">{agent.turnCount} turns</span>
                <span className="text-[var(--pear-text-faint)]">{formatTokenCount(agent.totalTokens)}</span>
                <span className="text-[var(--pear-text-faint)]">{formatUsd(agent.totalCost)}</span>
              </button>
            ))}
          </div>
        </Section>

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <Section title="Models" empty={!display?.byModel.length} loading={initialLoading}>
            <div className="space-y-2">
              {display?.byModel.map((model) => (
                <div key={model.model} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
                  <span className="truncate text-[var(--pear-text)]">{model.model}</span>
                  <span className="text-[var(--pear-text-faint)]">{formatTokenCount(model.tokens)}</span>
                  <span className="text-[var(--pear-text-faint)]">{formatUsd(model.cost)}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Tools" empty={!display?.byTool.length} loading={initialLoading}>
            <div className="space-y-2">
              {display?.byTool.map((tool) => (
                <div key={tool.tool} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 text-sm">
                  <span className="truncate text-[var(--pear-text)]">{tool.tool}</span>
                  <span className="text-[var(--pear-text-faint)]">{tool.count} calls</span>
                  <span className="text-[var(--pear-text-faint)]">{formatTokenCount(tool.tokens)}</span>
                  <span className="text-[var(--pear-text-faint)]">{formatUsd(tool.cost)}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <Section title="Recent sessions" empty={!display?.sessionIds.length} loading={initialLoading}>
          <div className="space-y-2">
            {display?.sessionIds.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                onClick={() => openTab({ kind: 'burn-session-detail', burnSessionId: session.sessionId, projectId })}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md text-left text-sm hover:bg-[var(--pear-bg-surface-hover)]"
              >
                <span className="truncate font-mono text-xs text-[var(--pear-text)]">{sessionShortId(session.sessionId)}</span>
                <span className="text-[var(--pear-text-faint)]">
                  {session.ts ? formatRelativeShort(Date.parse(session.ts)) : ''}
                </span>
              </button>
            ))}
          </div>
        </Section>

        {overhead?.status === 'ok' && overhead.recommendations.length > 0 && (
          <Section title="System-prompt overhead">
            <div className="space-y-3">
              <p className="text-sm text-[var(--pear-text-faint)]">
                Trimming these sections could save ~{formatUsd(overhead.perSessionTotal)}/session
              </p>
              <div className="space-y-2">
                {overhead.recommendations.map((rec, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
                    <span className="truncate">
                      <span className="font-mono text-xs text-[var(--pear-text-faint)]">{rec.file}</span>
                      {' — '}
                      <span className="text-[var(--pear-text)]">{rec.heading}</span>
                    </span>
                    <span className="text-[var(--pear-text-faint)]">~{formatUsd(rec.perSessionUsd)}/session</span>
                    <span className="text-[var(--pear-text-faint)]">{formatTokenCount(rec.tokens)}</span>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}
