import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Flame, RefreshCcw } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { formatTokenCount, formatUsd } from '@/lib/format'
import { pear, type BurnSessionBreakdown } from '@/lib/ipc'
import { useUIStore } from '@/stores/ui-store'
import { Metric, Section, sessionShortId } from '@/components/burn/BurnPrimitives'
import { useBurnFingerprintRefresh } from '@/components/burn/useBurnFingerprintRefresh'

const burnSessionDetailCache = new Map<string, BurnSessionBreakdown>()

interface BreakdownState {
  sessionId: string | null
  breakdown: BurnSessionBreakdown | null
  loading: boolean
  error: string | null
}

function createBreakdownState(sessionId: string | null): BreakdownState {
  const cached = sessionId ? burnSessionDetailCache.get(sessionId) ?? null : null
  return {
    sessionId,
    breakdown: cached,
    loading: Boolean(sessionId && !cached),
    error: null
  }
}

const KIND_CHIP_CLASSES: Record<string, string> = {
  file: 'bg-[var(--pear-blue)]/15 text-[var(--pear-blue)]',
  bash: 'bg-[var(--pear-orange)]/15 text-[var(--pear-orange)]',
  mcp: 'bg-[var(--pear-green)]/15 text-[var(--pear-green)]',
  subagent: 'bg-[var(--pear-purple)]/15 text-[var(--pear-purple)]'
}

export function BurnSessionDetailPage(): React.ReactNode {
  const activeTab = useUIStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const openTab = useUIStore((s) => s.openTab)
  const sessionId = activeTab?.burnSessionId ?? null

  const mountedRef = useRef(true)
  const loadingKeyRef = useRef<string | null>(null)
  const [breakdownState, setBreakdownState] = useState<BreakdownState>(() => createBreakdownState(sessionId))

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadBreakdown = useCallback(async (force = false) => {
    if (!sessionId) {
      setBreakdownState(createBreakdownState(null))
      return
    }

    if (!force && loadingKeyRef.current === sessionId) return

    const cached = burnSessionDetailCache.get(sessionId) ?? null
    loadingKeyRef.current = sessionId
    setBreakdownState({
      sessionId,
      breakdown: cached,
      loading: true,
      error: null
    })

    try {
      const next = await pear.burn.getSessionBreakdown(force ? { sessionId, force: true } : { sessionId })
      const nextError = next.status === 'unavailable' && next.error ? next.error : null
      if (next.status === 'ok') burnSessionDetailCache.set(sessionId, next)
      if (!mountedRef.current) return
      setBreakdownState((current) => {
        if (current.sessionId !== sessionId) return current
        return {
          sessionId,
          breakdown: next.status === 'ok' ? next : current.breakdown ?? cached ?? next,
          loading: false,
          error: nextError
        }
      })
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err)
      if (!mountedRef.current) return
      setBreakdownState((current) => {
        if (current.sessionId !== sessionId) return current
        return {
          sessionId,
          breakdown: current.breakdown ?? cached,
          loading: false,
          error: nextError
        }
      })
    } finally {
      if (loadingKeyRef.current === sessionId) {
        loadingKeyRef.current = null
      }
    }
  }, [sessionId])

  useEffect(() => {
    void loadBreakdown()
  }, [loadBreakdown])

  useBurnFingerprintRefresh(
    { sessionId: sessionId ?? undefined },
    12_000,
    loadBreakdown
  )

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)] text-sm text-[var(--pear-text-faint)]">
        No burn session selected
      </div>
    )
  }

  const cachedBreakdown = burnSessionDetailCache.get(sessionId) ?? null
  const stateMatchesSession = breakdownState.sessionId === sessionId
  const display = stateMatchesSession ? breakdownState.breakdown : cachedBreakdown
  const loading = stateMatchesSession ? breakdownState.loading : Boolean(sessionId && !cachedBreakdown)
  const error = stateMatchesSession ? breakdownState.error : null
  const initialLoading = loading && !display
  const hotspots = display?.hotspots
  const insights = display?.insights ?? []

  const agent = display?.agent ?? activeTab?.burnAgent
  const agentName = agent && 'name' in agent ? agent.name : undefined
  const agentCli = agent && 'cli' in agent ? agent.cli : undefined
  const agentCwd = agent && 'cwd' in agent ? agent.cwd : undefined
  const agentProjectId = display?.agent?.projectId

  return (
    <div className="h-full overflow-y-auto bg-[var(--pear-bg)]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs text-[var(--pear-text-faint)]">
              <Flame size={14} className="text-[var(--pear-orange)]" />
              <span>Session burn</span>
            </div>
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)]">
                <AgentHarnessIcon cli={agentCli} className="h-5 w-5 text-[var(--pear-text-secondary)]" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold text-[var(--pear-text)]">
                  {sessionShortId(sessionId)}
                </h1>
                <p className="mt-1 truncate text-sm text-[var(--pear-text-faint)]">
                  {agentName
                    ? agentName
                    : loading
                      ? 'Updating burn data...'
                      : agentCwd ?? agentProjectId ?? 'Pear session'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {agentProjectId && (
              <button
                type="button"
                onClick={() => openTab({ kind: 'burn-project', projectId: agentProjectId })}
                className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                title="Project burn rollup"
              >
                <Flame size={15} />
                <span>Project rollup</span>
              </button>
            )}
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
          <Metric label="Models" value={String(display?.models.length ?? 0)} loading={initialLoading} />
        </div>

        <Section title="Cost Insights" empty={!insights.length} loading={initialLoading} loadingRows={4}>
          <div className="space-y-2">
            {insights.map((insight, index) => (
              <div
                key={`${insight.kind}:${insight.label}:${index}`}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-3 text-sm"
              >
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${KIND_CHIP_CLASSES[insight.kind] ?? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)]'}`}
                >
                  {insight.kind}
                </span>
                <div className="min-w-0">
                  <span
                    className={`block truncate ${insight.kind === 'file' || insight.kind === 'bash' ? 'font-mono text-xs text-[var(--pear-text)]' : 'text-[var(--pear-text)]'}`}
                  >
                    {insight.label}
                  </span>
                  {insight.detail && (
                    <span className="block truncate text-xs text-[var(--pear-text-faint)]">{insight.detail}</span>
                  )}
                </div>
                {insight.ridingTurns != null && (
                  <span className="shrink-0 rounded bg-[var(--pear-bg-overlay)] px-1.5 py-0.5 text-xs text-[var(--pear-text-faint)]">
                    {insight.ridingTurns} turns
                  </span>
                )}
                <span className="shrink-0 text-[var(--pear-text-faint)]">{formatUsd(insight.totalCost)}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="File Hotspots" empty={!hotspots?.files.length} loading={initialLoading} loadingRows={4}>
          <div className="space-y-2">
            {hotspots?.files.map((file) => (
              <div key={file.path} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 text-sm">
                <span className="truncate font-mono text-xs text-[var(--pear-text)]">{file.path}</span>
                <span className="text-[var(--pear-text-faint)]">{formatTokenCount(file.initialTokens + file.persistenceTokens)}</span>
                <span className="text-[var(--pear-text-faint)]">{file.ridingTurns} turns</span>
                <span className="text-[var(--pear-text-faint)]">{formatUsd(file.totalCost)}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="MCP Servers" empty={!hotspots?.mcpServers.length} loading={initialLoading}>
          <div className="space-y-2">
            {hotspots?.mcpServers.map((srv) => (
              <div
                key={srv.server}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 text-sm"
              >
                <span className="truncate text-[var(--pear-text)]">{srv.server}</span>
                <span className="text-[var(--pear-text-faint)]">{srv.callCount} calls</span>
                {srv.topTools.length > 0 && (
                  <span className="max-w-[160px] truncate text-xs text-[var(--pear-text-faint)]">
                    {srv.topTools.join(', ')}
                  </span>
                )}
                <span className="text-[var(--pear-text-faint)]">{srv.ridingTurns} turns</span>
                <span className="text-[var(--pear-text-faint)]">{formatUsd(srv.totalCost)}</span>
              </div>
            ))}
          </div>
        </Section>

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <Section title="Bash Verbs" empty={!hotspots?.bashVerbs.length} loading={initialLoading}>
            <div className="space-y-3">
              {hotspots?.bashVerbs.map((verb) => (
                <div key={verb.verb} className="space-y-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
                    <span className="truncate text-[var(--pear-text)]">{verb.verb}</span>
                    <span className="text-[var(--pear-text-faint)]">{verb.callCount} calls</span>
                    <span className="text-[var(--pear-text-faint)]">{formatUsd(verb.totalCost)}</span>
                  </div>
                  {verb.topExamples[0] && (
                    <div className="truncate font-mono text-xs text-[var(--pear-text-faint)]">{verb.topExamples[0]}</div>
                  )}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Subagents" empty={!hotspots?.subagents.length} loading={initialLoading}>
            <div className="space-y-2">
              {hotspots?.subagents.map((sub) => (
                <div key={sub.subagentType} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
                  <span className="truncate text-[var(--pear-text)]">{sub.subagentType}</span>
                  <span className="text-[var(--pear-text-faint)]">{sub.callCount} calls</span>
                  <span className="text-[var(--pear-text-faint)]">{formatUsd(sub.totalCost)}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <Section title="Commands" empty={!hotspots?.bash.length} loading={initialLoading} loadingRows={4}>
          <div className="space-y-2">
            {hotspots?.bash.map((command) => (
              <div
                key={`${command.command || 'command'}:${command.totalCost}`}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm"
              >
                <span className="truncate font-mono text-xs text-[var(--pear-text)]">{command.command || '(unknown)'}</span>
                <span className="text-[var(--pear-text-faint)]">{command.callCount} calls</span>
                <span className="text-[var(--pear-text-faint)]">{formatUsd(command.totalCost)}</span>
              </div>
            ))}
          </div>
        </Section>

        {hotspots && (
          <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-4 py-3 text-xs text-[var(--pear-text-faint)]">
            Attributed {formatUsd(hotspots.attributedTotal)} of {formatUsd(hotspots.grandTotal)}
            {hotspots.attributionDegraded ? ' with degraded attribution' : ''}
          </div>
        )}
      </div>
    </div>
  )
}
