import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Flame, RefreshCcw, TerminalSquare } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { formatRelativeShort, formatTokenCount, formatUsd } from '@/lib/format'
import { pear, type BurnAgentBreakdown, type BurnAgentInput } from '@/lib/ipc'
import { useUIStore } from '@/stores/ui-store'

function Metric({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <div className="min-w-[120px] rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-4 py-3">
      <div className="text-[11px] uppercase text-[var(--pear-text-faint)]">{label}</div>
      <div className="mt-1 text-xl font-semibold text-[var(--pear-text)]">{value}</div>
    </div>
  )
}

function Section({
  title,
  children,
  empty
}: {
  title: string
  children: React.ReactNode
  empty?: boolean
}): React.ReactNode {
  return (
    <section className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="flex h-11 items-center border-b border-[var(--pear-border-subtle)] px-4">
        <h2 className="text-sm font-semibold text-[var(--pear-text)]">{title}</h2>
      </div>
      <div className="p-4">
        {empty ? (
          <div className="py-5 text-sm text-[var(--pear-text-faint)]">No data yet</div>
        ) : children}
      </div>
    </section>
  )
}

function sessionShortId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}` : sessionId
}

function getBurnAgent(tabBurnAgent: BurnAgentInput | undefined): BurnAgentInput | null {
  if (!tabBurnAgent?.name.trim()) return null
  return {
    name: tabBurnAgent.name,
    projectId: tabBurnAgent.projectId,
    cwd: tabBurnAgent.cwd,
    cli: tabBurnAgent.cli
  }
}

export function BurnSessionPage(): React.ReactNode {
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const openTab = useUIStore((s) => s.openTab)
  const burnAgent = useMemo(() => getBurnAgent(activeTab?.burnAgent), [activeTab?.burnAgent])
  const [breakdown, setBreakdown] = useState<BurnAgentBreakdown | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadBreakdown = useCallback(async () => {
    if (!burnAgent) return
    setLoading(true)
    setError(null)
    try {
      const next = await pear.burn.getAgentBreakdown(burnAgent)
      setBreakdown(next)
      if (next.status === 'unavailable' && next.error) {
        setError(next.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [burnAgent])

  useEffect(() => {
    void loadBreakdown()
  }, [loadBreakdown])

  if (!burnAgent) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)] text-sm text-[var(--pear-text-faint)]">
        No burn session selected
      </div>
    )
  }

  const display = breakdown
  const hotspots = display?.hotspots

  return (
    <div className="h-full overflow-y-auto bg-[var(--pear-bg)]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs text-[var(--pear-text-faint)]">
              <Flame size={14} className="text-[var(--pear-orange)]" />
              <span>Burn breakdown</span>
            </div>
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)]">
                <AgentHarnessIcon cli={burnAgent.cli} className="h-5 w-5 text-[var(--pear-text-secondary)]" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold text-[var(--pear-text)]">{burnAgent.name}</h1>
                <p className="mt-1 truncate text-sm text-[var(--pear-text-faint)]">
                  {display?.primarySessionId
                    ? sessionShortId(display.primarySessionId)
                    : burnAgent.cwd || burnAgent.projectId || 'Pear agent'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openTab({ kind: 'agents', projectId: burnAgent.projectId })}
              className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
              title="Open terminals"
            >
              <TerminalSquare size={15} />
              <span>Terminals</span>
            </button>
            <button
              type="button"
              onClick={() => void loadBreakdown()}
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
          <Metric label="Tokens" value={formatTokenCount(display?.totalTokens ?? 0)} />
          <Metric label="Cost" value={formatUsd(display?.totalCost ?? 0)} />
          <Metric label="Turns" value={String(display?.turnCount ?? 0)} />
          <Metric label="Sessions" value={String(display?.sessionIds.length ?? 0)} />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <Section title="Models" empty={!display?.byModel.length}>
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

          <Section title="Tools" empty={!display?.byTool.length}>
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

        <Section title="File Hotspots" empty={!hotspots?.files.length}>
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

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <Section title="Bash Verbs" empty={!hotspots?.bashVerbs.length}>
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

          <Section title="Sessions" empty={!display?.sessionIds.length}>
            <div className="space-y-2">
              {display?.sessionIds.map((session) => (
                <div key={session.sessionId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                  <span className="truncate font-mono text-xs text-[var(--pear-text)]">{session.sessionId}</span>
                  <span className="text-[var(--pear-text-faint)]">
                    {session.ts ? formatRelativeShort(Date.parse(session.ts)) : ''}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <Section title="Commands" empty={!hotspots?.bash.length}>
          <div className="space-y-2">
            {hotspots?.bash.map((command) => (
              <div key={`${command.command || 'command'}:${command.totalCost}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
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
