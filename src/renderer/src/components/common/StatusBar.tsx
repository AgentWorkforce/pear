import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { CircleX, FileDiff, Flame, GitMerge } from 'lucide-react'
import { formatGitDiffLineCount, formatTokenCount, formatUsd } from '@/lib/format'
import { useBurnFingerprintRefresh } from '@/components/burn/useBurnFingerprintRefresh'
import { useAgentStore } from '@/stores/agent-store'
import { useGitStore } from '@/stores/git-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { pear, type BurnProjectBreakdown, type GitPullRequest } from '@/lib/ipc'

const PULL_REQUEST_REFRESH_MS = 60_000

function pullRequestHasBlockingStatus(pullRequest: GitPullRequest): boolean {
  return pullRequest.mergeState === 'blocked' || pullRequest.ciState === 'failing'
}

function pullRequestStatusTitle(pullRequest: GitPullRequest): string {
  const state = [
    pullRequest.mergeState === 'mergeable'
      ? 'mergeable'
      : pullRequest.mergeState === 'blocked'
        ? 'not mergeable'
        : 'mergeability unknown',
    pullRequest.ciState === 'passing'
      ? 'CI passing'
      : pullRequest.ciState === 'failing'
        ? 'CI failing'
        : pullRequest.ciState === 'pending'
          ? 'CI pending'
          : 'CI unknown'
  ].join(', ')

  return `${pullRequest.owner}/${pullRequest.repo} ${pullRequest.branch} (${state})${pullRequest.title ? `: ${pullRequest.title}` : ''}`
}

export function StatusBar(): React.ReactNode {
  const brokerStatus = useAgentStore((s) => s.brokerStatus)
  const brokerErrors = useAgentStore((s) => s.brokerErrors)
  const project = useProjectStore((s) => s.getActiveProject())
  const projectChangedFiles = useGitStore((s) => s.projectFiles)
  const projectSummary = useGitStore((s) => s.projectSummary)
  const openTab = useUIStore((s) => s.openTab)
  const projectId = project?.id
  const projectRootPathKey = project?.roots
    .filter((root) => root.pathExists)
    .map((root) => root.path)
    .join('\0') || ''
  const projectSummaryMatchesRoots = !!projectSummary && projectSummary.rootPathKey === projectRootPathKey

  const [burn, setBurn] = useState<BurnProjectBreakdown | null>(null)
  const [pullRequests, setPullRequests] = useState<GitPullRequest[]>([])

  const loadBurn = useCallback(async () => {
    if (!projectId) {
      setBurn(null)
      return
    }
    try {
      const next = await pear.burn.getProjectBreakdown({ projectId })
      setBurn(next.status === 'ok' ? next : null)
    } catch {
      // Burn data is informational — leave the prior value on failure.
    }
  }, [projectId])

  useEffect(() => {
    setBurn(null)
    void loadBurn()
  }, [loadBurn])

  // Cheap fingerprint poll — only refetches the project burn totals when the
  // ledger actually changed (global scope, since the bar shows the whole project).
  useBurnFingerprintRefresh({}, 15_000, () => {
    void loadBurn()
  })

  useEffect(() => {
    let cancelled = false
    const rootPaths = projectRootPathKey ? projectRootPathKey.split('\0').filter(Boolean) : []

    async function loadPullRequests(): Promise<void> {
      if (rootPaths.length === 0) {
        setPullRequests([])
        return
      }

      try {
        const nextPullRequests = await pear.git.activePullRequests(rootPaths)
        if (!cancelled) setPullRequests(nextPullRequests)
      } catch {
        if (!cancelled) setPullRequests([])
      }
    }

    setPullRequests([])
    void loadPullRequests()
    const interval = window.setInterval(() => {
      void loadPullRequests()
    }, PULL_REQUEST_REFRESH_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
    // Include `projectSummary?.branch` so a branch checkout triggers an
    // immediate PR refresh rather than waiting up to PULL_REQUEST_REFRESH_MS
    // (60s) for the next poll.
  }, [projectRootPathKey, projectSummary?.branch])

  const statusColor =
    brokerStatus === 'connected'
      ? 'bg-[var(--pear-accent)]'
      : brokerStatus === 'error'
        ? 'bg-[var(--pear-red)]'
        : 'bg-[var(--pear-text-faint)]'
  const pullRequestMergeIconColor = pullRequests.some(pullRequestHasBlockingStatus)
    ? 'text-[var(--pear-orange)]'
    : 'text-[var(--pear-green)]'

  return (
    <div className="relative flex h-[38px] shrink-0 items-center gap-6 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-6 text-xs text-[var(--pear-text-dim)]">
      <button
        type="button"
        title="Open Agent Relay Status"
        aria-label={`Agent Relay status ${brokerStatus}. Open Agent Relay Status.`}
        onClick={() => openTab({
          kind: 'broker-details',
          projectId: project?.id,
          title: project ? `${project.name} Relay` : undefined
        })}
        className={`flex items-center gap-2 rounded-full px-2.5 py-1 transition-colors ${
          brokerStatus === 'error'
            ? 'border border-[var(--pear-red)]/25 bg-[var(--pear-red)]/10 text-[var(--pear-text)] hover:bg-[var(--pear-red)]/15'
            : 'hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]'
        }`}
      >
        <div className={`h-2 w-2 rounded-full ${statusColor}`} />
        <span>{brokerStatus}</span>
        {brokerErrors.length > 0 && (
          <span className="rounded-full bg-[var(--pear-red)]/15 px-1.5 py-0.5 text-[10px] text-[var(--pear-red)]">
            {brokerErrors.length}
          </span>
        )}
      </button>

      <div className="flex-1" />

      {project && burn && (
        <button
          type="button"
          onClick={() => openTab({ kind: 'burn-project', projectId: project.id })}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
          title="Open project token burn breakdown"
          aria-label={`Open project token burn. ${formatTokenCount(burn.totalTokens)} tokens, ${formatUsd(burn.totalCost)} spent.`}
        >
          <Flame size={12} className="text-[var(--pear-orange)]" />
          <span className="tabular-nums">{formatTokenCount(burn.totalTokens)} tokens</span>
          <span className="text-[var(--pear-text-faint)]">·</span>
          <span className="tabular-nums">{formatUsd(burn.totalCost)}</span>
        </button>
      )}

      {pullRequests.length > 0 && (
        <div
          className="flex min-w-0 max-w-[42vw] items-center gap-1.5 overflow-hidden px-1 py-1 text-[var(--pear-text-dim)]"
          aria-label="Active pull requests"
        >
          <GitMerge size={12} className={`shrink-0 ${pullRequestMergeIconColor}`} />
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {pullRequests.map((pullRequest) => {
              const blocked = pullRequestHasBlockingStatus(pullRequest)
              const statusTitle = pullRequestStatusTitle(pullRequest)
              return (
                <a
                  key={pullRequest.url}
                  href={pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 tabular-nums text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
                  title={statusTitle}
                  aria-label={`Open PR #${pullRequest.number}. ${statusTitle}`}
                >
                  <span>PR #{pullRequest.number}</span>
                  {blocked && <CircleX size={11} className="text-[var(--pear-red)]" aria-hidden="true" />}
                </a>
              )
            })}
          </div>
        </div>
      )}

      {project && projectSummaryMatchesRoots && (
        <button
          type="button"
          onClick={() => openTab({ kind: 'source-control', projectId: project.id })}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
          title={`Open source control across ${projectSummary.rootCount} Git ${projectSummary.rootCount === 1 ? 'root' : 'roots'}`}
          aria-label={`Open source control. ${projectChangedFiles.length} changed files across ${projectSummary.rootCount} Git ${projectSummary.rootCount === 1 ? 'root' : 'roots'}.`}
        >
          <FileDiff size={12} className="text-[var(--pear-text-faint)]" />
          <span>{projectChangedFiles.length} changed file{projectChangedFiles.length === 1 ? '' : 's'}</span>
          {(projectSummary.additions > 0 || projectSummary.deletions > 0) && (
            <span className="tabular-nums">
              <span className="text-[var(--pear-green)]">+{formatGitDiffLineCount(projectSummary.additions)}</span>
              <span className="mx-1 text-[var(--pear-text-faint)]">/</span>
              <span className="text-[var(--pear-red)]">-{formatGitDiffLineCount(projectSummary.deletions)}</span>
            </span>
          )}
        </button>
      )}
    </div>
  )
}
