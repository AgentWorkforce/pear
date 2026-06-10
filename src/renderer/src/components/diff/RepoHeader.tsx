import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  FolderGit2,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { pear, type GitBranchInfo, type GitBranchSyncStatus } from '@/lib/ipc'
import type { Project, ProjectRoot } from '@/stores/project-store'
import {
  branchDisplayName,
  formatRelativeDate,
  gitStateForRoot,
  rootStatusLabel,
  syncActionLabel,
  syncStatusText,
  type BranchSelectorTab,
  type BranchSwitchMode,
  type RootGitState
} from './diffPaneUtils'

export function CurrentRootSelector({
  project,
  activeRoot,
  gitStates,
  width,
  onSelect
}: {
  project: Project | undefined
  activeRoot: ProjectRoot | undefined
  gitStates: Record<string, RootGitState>
  width: number
  onSelect: (id: string) => void
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const roots = project?.roots || []
  const activeRootState = activeRoot ? gitStateForRoot(activeRoot, gitStates) : 'not-git'
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRoots = normalizedQuery
    ? roots.filter((root) =>
        `${root.name} ${root.path}`.toLowerCase().includes(normalizedQuery)
      )
    : roots

  useEffect(() => {
    setOpen(false)
    setQuery('')
  }, [project?.id])

  function selectRoot(root: ProjectRoot): void {
    if (gitStateForRoot(root, gitStates) !== 'git') return
    onSelect(root.id)
    setOpen(false)
    setQuery('')
  }

  function renderRoot(root: ProjectRoot): React.ReactNode {
    const state = gitStateForRoot(root, gitStates)
    const selected = root.id === activeRoot?.id
    const disabled = state !== 'git'

    return (
      <button
        key={root.id}
        type="button"
        onClick={() => selectRoot(root)}
        disabled={disabled}
        title={disabled ? rootStatusLabel(root, state) : root.path}
        className={`flex h-10 w-full items-center gap-2.5 px-3.5 text-left ${
          selected && !disabled
            ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
            : disabled
              ? 'cursor-not-allowed text-[var(--pear-text-faint)] opacity-50'
              : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
        }`}
      >
        {selected && !disabled ? (
          <Check size={13} className="shrink-0 text-[var(--pear-text)]" />
        ) : state === 'checking' ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--pear-text-faint)]" />
        ) : (
          <FolderGit2 size={13} className="shrink-0 text-[var(--pear-text-secondary)]" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{root.name}</span>
          <span className="block truncate text-[11px] font-medium text-[var(--pear-text-faint)]">
            {rootStatusLabel(root, state)}
          </span>
        </span>
      </button>
    )
  }

  return (
    <div
      className="relative h-full shrink-0 border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
      style={{ width }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-full w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--pear-bg-surface-hover)]"
        aria-expanded={open}
        aria-label="Select repository root"
        title={activeRoot?.path}
      >
        <FolderGit2
          size={14}
          className={`shrink-0 ${
            activeRootState === 'git'
              ? 'text-[var(--pear-text-secondary)]'
              : 'text-[var(--pear-text-faint)]'
          }`}
        />
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-[11px] font-medium leading-[14px] text-[var(--pear-text-faint)]">
            Repository Root
          </span>
          <span
            className={`block truncate text-[13px] font-semibold leading-4 ${
              activeRootState === 'git'
                ? 'text-[var(--pear-text)]'
                : 'text-[var(--pear-text-faint)]'
            }`}
          >
            {activeRoot?.name || 'No root selected'}
          </span>
        </span>
        {activeRootState === 'checking' ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-[var(--pear-text-secondary)]" />
        ) : open ? (
          <ChevronUp size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
        )}
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 overflow-hidden bg-[var(--pear-bg)] pb-2 shadow-2xl"
          style={{ width: Math.max(width, 420) }}
        >
          <div className="flex items-center gap-2 px-2 py-2">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--pear-accent-dim)] bg-[var(--pear-bg)] px-2.5 text-[12px] text-[var(--pear-text-secondary)] ring-1 ring-[var(--pear-accent-dim)]">
              <Search size={12} className="shrink-0 text-[var(--pear-text-faint)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter"
                className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                  aria-label="Clear root filter"
                >
                  <X size={12} />
                </button>
              )}
            </label>
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {roots.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No roots configured</div>
            ) : filteredRoots.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No roots match</div>
            ) : (
              <div className="pb-1.5">
                <div className="px-3.5 pb-1 pt-2 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                  Project Roots
                </div>
                {filteredRoots.map(renderRoot)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function CurrentBranchSelector({
  rootPath,
  currentBranch,
  loading,
  onBranchChanged
}: {
  rootPath: string
  currentBranch: string
  loading: boolean
  onBranchChanged: (status: GitBranchSyncStatus) => Promise<void>
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [switchingBranch, setSwitchingBranch] = useState(false)
  const [pendingBranch, setPendingBranch] = useState<GitBranchInfo | null>(null)
  const [switchMode, setSwitchMode] = useState<BranchSwitchMode>('stash')
  const [activeBranchTab, setActiveBranchTab] = useState<BranchSelectorTab>('branches')
  const [error, setError] = useState<string | null>(null)

  const filteredBranches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return branches
    return branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery))
  }, [branches, query])
  const defaultBranches = useMemo(() => {
    const localDefaults = filteredBranches.filter((branch) => branch.defaultBranch && !branch.remote)
    return localDefaults.length > 0 ? localDefaults : filteredBranches.filter((branch) => branch.defaultBranch)
  }, [filteredBranches])
  const otherBranches = filteredBranches.filter((branch) => !branch.defaultBranch)

  async function loadBranches(): Promise<void> {
    setBranchesLoading(true)
    setError(null)
    try {
      const details = await pear.git.branchDetails(rootPath)
      setBranches(details)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load branches')
      setBranches([])
    } finally {
      setBranchesLoading(false)
    }
  }

  useEffect(() => {
    setOpen(false)
    setQuery('')
    setBranches([])
    setPendingBranch(null)
    setSwitchMode('stash')
    setActiveBranchTab('branches')
  }, [rootPath])

  useEffect(() => {
    if (open && activeBranchTab === 'branches') void loadBranches()
  }, [open, activeBranchTab])

  async function switchBranch(branch: GitBranchInfo, stashChanges: boolean): Promise<void> {
    setError(null)
    setSwitchingBranch(true)
    try {
      const status = await pear.git.checkoutBranch(rootPath, branch.name, { stashChanges })
      setOpen(false)
      setQuery('')
      setPendingBranch(null)
      setSwitchMode('stash')
      await onBranchChanged(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to switch branches')
    } finally {
      setSwitchingBranch(false)
    }
  }

  async function selectBranch(branch: GitBranchInfo): Promise<void> {
    if (branch.current) return
    setError(null)

    try {
      const localChanges = await pear.git.status(rootPath)
      if (localChanges.length > 0) {
        setPendingBranch(branch)
        setSwitchMode('stash')
        return
      }
      await switchBranch(branch, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to switch branches')
    }
  }

  async function confirmPendingBranchSwitch(): Promise<void> {
    if (!pendingBranch) return
    await switchBranch(pendingBranch, switchMode === 'stash')
  }

  function renderBranch(branch: GitBranchInfo): React.ReactNode {
    return (
      <button
        key={branch.name}
        type="button"
        onClick={() => void selectBranch(branch)}
        disabled={switchingBranch}
        className={`flex h-8 w-full items-center gap-2.5 px-3.5 text-left text-[13px] font-semibold ${
          branch.current
            ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
            : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-60'
        }`}
      >
        {branch.current ? (
          <Check size={13} className="shrink-0 text-[var(--pear-text)]" />
        ) : (
          <GitBranch size={13} className="shrink-0 text-[var(--pear-text-secondary)]" />
        )}
        <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        {branch.lastCommitDate && (
          <span className="shrink-0 text-[11px] font-medium text-[var(--pear-text-faint)]">
            {formatRelativeDate(branch.lastCommitDate)}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="relative h-full w-[360px] shrink-0 border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-full w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--pear-bg-surface-hover)]"
        aria-expanded={open}
      >
        <GitBranch size={14} className="shrink-0 text-[var(--pear-text-secondary)]" />
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-[11px] font-medium leading-[14px] text-[var(--pear-text-faint)]">
            Current Branch
          </span>
          <span className="block truncate text-[13px] font-semibold leading-4 text-[var(--pear-text)]">
            {loading ? 'Loading...' : currentBranch}
          </span>
        </span>
        {open
          ? <ChevronUp size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
          : <ChevronDown size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 w-[460px] overflow-hidden bg-[var(--pear-bg)] pb-2 shadow-2xl">
          <div className="grid h-9 grid-cols-2 bg-[var(--pear-bg-surface-hover)]">
            <button
              type="button"
              data-focus-ring="none"
              onClick={() => setActiveBranchTab('branches')}
              className={`flex items-center justify-center border-b-2 text-[13px] font-semibold ${
                activeBranchTab === 'branches'
                  ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
                  : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]'
              }`}
            >
              Branches
            </button>
            <button
              type="button"
              data-focus-ring="none"
              onClick={() => setActiveBranchTab('worktrees')}
              className={`flex items-center justify-center border-b-2 text-[13px] font-semibold ${
                activeBranchTab === 'worktrees'
                  ? 'border-[var(--pear-selection-blue)] text-[var(--pear-text)]'
                  : 'border-transparent text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]'
              }`}
            >
              Worktrees
            </button>
          </div>

          {activeBranchTab === 'branches' ? (
            <>
              <div className="flex items-center gap-2 px-2 py-2">
                <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--pear-accent-dim)] bg-[var(--pear-bg)] px-2.5 text-[12px] text-[var(--pear-text-secondary)] ring-1 ring-[var(--pear-accent-dim)]">
                  <Search size={12} className="shrink-0 text-[var(--pear-text-faint)]" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter"
                    className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                      aria-label="Clear branch filter"
                    >
                      <X size={12} />
                    </button>
                  )}
                </label>
              </div>

              <div className="max-h-[360px] overflow-y-auto">
                {branchesLoading ? (
                  <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">Loading branches...</div>
                ) : error ? (
                  <div className="px-3 py-4 text-xs text-[var(--pear-red)]">{error}</div>
                ) : filteredBranches.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No branches match</div>
                ) : (
                  <>
                    {defaultBranches.length > 0 && (
                      <div className="pb-1.5">
                        <div className="px-3.5 pb-1 pt-2 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                          Default Branch
                        </div>
                        {defaultBranches.map(renderBranch)}
                      </div>
                    )}
                    <div>
                      {defaultBranches.length > 0 && (
                        <div className="px-3.5 pb-1 pt-2 text-[12px] font-semibold text-[var(--pear-text-faint)]">
                          Other Branches
                        </div>
                      )}
                      {otherBranches.map(renderBranch)}
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-[220px] items-center justify-center px-4 text-[13px] font-medium text-[var(--pear-text-faint)]">
              Coming soon
            </div>
          )}
        </div>
      )}

      {pendingBranch && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4"
          onClick={() => {
            if (!switchingBranch) setPendingBranch(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-branch-title"
            className="w-full max-w-[640px] overflow-hidden rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex h-16 items-center justify-between border-b border-[var(--pear-border-subtle)] px-6">
              <h2 id="switch-branch-title" className="text-xl font-semibold text-[var(--pear-text)]">
                Switch Branch
              </h2>
              <button
                type="button"
                onClick={() => setPendingBranch(null)}
                disabled={switchingBranch}
                className="rounded-md p-1.5 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-50"
                aria-label="Close switch branch dialog"
              >
                <X size={22} />
              </button>
            </div>

            <div className="border-b border-[var(--pear-border-subtle)] px-6 py-8">
              <p className="mb-5 text-lg font-medium text-[var(--pear-text)]">
                You have changes on this branch. What would you like to do with them?
              </p>
              <div className="overflow-hidden rounded-lg border border-[var(--pear-border-subtle)]">
                <button
                  type="button"
                  onClick={() => setSwitchMode('stash')}
                  className={`flex w-full gap-4 px-5 py-4 text-left ${
                    switchMode === 'stash' ? 'bg-[var(--pear-bg-overlay)]' : 'bg-[var(--pear-bg-raised)] hover:bg-[var(--pear-bg-surface-hover)]'
                  }`}
                >
                  <span className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    switchMode === 'stash' ? 'border-[var(--pear-accent)]' : 'border-[var(--pear-text-faint)]'
                  }`}>
                    {switchMode === 'stash' && <span className="h-2.5 w-2.5 rounded-full bg-[var(--pear-accent)]" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[17px] font-semibold text-[var(--pear-text)]">
                      Leave my changes on {currentBranch}
                    </span>
                    <span className="mt-1 block text-[15px] leading-6 text-[var(--pear-text-secondary)]">
                      Your in-progress work will be stashed on this branch for you to return to later
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSwitchMode('carry')}
                  className={`flex w-full gap-4 border-t border-[var(--pear-border-subtle)] px-5 py-4 text-left ${
                    switchMode === 'carry' ? 'bg-[var(--pear-bg-overlay)]' : 'bg-[var(--pear-bg-raised)] hover:bg-[var(--pear-bg-surface-hover)]'
                  }`}
                >
                  <span className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    switchMode === 'carry' ? 'border-[var(--pear-accent)]' : 'border-[var(--pear-text-faint)]'
                  }`}>
                    {switchMode === 'carry' && <span className="h-2.5 w-2.5 rounded-full bg-[var(--pear-accent)]" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[17px] font-semibold text-[var(--pear-text)]">
                      Bring my changes to {branchDisplayName(pendingBranch)}
                    </span>
                    <span className="mt-1 block text-[15px] leading-6 text-[var(--pear-text-secondary)]">
                      Your in-progress work will follow you to the new branch
                    </span>
                  </span>
                </button>
              </div>
              {error && (
                <div className="mt-4 rounded-md border border-[var(--pear-red)]/30 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
                  {error}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 px-6 py-5">
              <button
                type="button"
                onClick={() => setPendingBranch(null)}
                disabled={switchingBranch}
                className="h-10 min-w-[150px] rounded-md border border-[var(--pear-border)] px-4 text-[15px] font-semibold text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPendingBranchSwitch()}
                disabled={switchingBranch}
                className="flex h-10 min-w-[170px] items-center justify-center gap-2 rounded-md bg-[var(--pear-accent)] px-4 text-[15px] font-semibold text-[var(--pear-bg)] hover:bg-[var(--pear-accent-bright)] disabled:opacity-60"
              >
                {switchingBranch && <Loader2 size={15} className="animate-spin" />}
                Switch Branch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function FetchOriginButton({
  status,
  loading,
  lastFetchedAt,
  error,
  onClick
}: {
  status: GitBranchSyncStatus | null
  loading: boolean
  lastFetchedAt: number | null
  error: string | null
  onClick: () => void
}): React.ReactNode {
  const disabled = loading || status?.hasRemote === false || (!!status && status.ahead > 0 && status.behind > 0)

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-full w-[420px] shrink-0 items-center gap-2.5 border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-left hover:bg-[var(--pear-bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-70"
    >
      <RefreshCw size={14} className={`shrink-0 text-[var(--pear-text-secondary)] ${loading ? 'animate-spin' : ''}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold leading-4 text-[var(--pear-text)]">
          {syncActionLabel(status, loading, lastFetchedAt)}
        </span>
        <span className={`block truncate text-[11px] font-medium leading-[14px] ${error ? 'text-[var(--pear-red)]' : 'text-[var(--pear-text-faint)]'}`}>
          {syncStatusText(status, lastFetchedAt, error)}
        </span>
      </span>
    </button>
  )
}
