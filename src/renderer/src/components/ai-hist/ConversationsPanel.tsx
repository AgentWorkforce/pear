import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCopy, MessageSquare, RefreshCw, Search } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { pear } from '@/lib/ipc'
import { useProjectStore, type Project } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useAgentStore, getAgentKey } from '@/stores/agent-store'

type Source = 'claude' | 'codex' | 'cursor' | 'relay'

interface Session {
  sessionId: string
  source: Source
  project: string | null
  firstPrompt: string
  firstActivityMs: number
  lastActivityMs: number
  promptCount: number
}

interface Entry {
  id: number
  source: Source
  sessionId: string | null
  project: string | null
  prompt: string
  timestampMs: number
}

type Status = { ok: true; dbPath: string } | { ok: false; reason: string }

type SourceFilter = 'all' | Source

const SOURCE_LABELS: Record<Source, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  relay: 'Relay'
}

const SOURCE_COLORS: Record<Source, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  cursor: '#FFFFFF',
  relay: '#D493BE'
}

const SOURCE_ICON_CLI: Record<Source, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  relay: 'relay'
}

function formatRelative(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs
  const min = Math.round(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(timestampMs).toLocaleDateString()
}

function shortenPath(path: string | null): string {
  if (!path) return ''
  const segments = path.split('/').filter(Boolean)
  if (segments.length <= 3) return path
  return `…/${segments.slice(-2).join('/')}`
}

function nextSessionId(sessionIds: string[], currentId: string | null, direction: 1 | -1): string | null {
  if (sessionIds.length === 0) return null

  const currentIndex = currentId ? sessionIds.indexOf(currentId) : -1
  if (currentIndex === -1) {
    return direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1]
  }

  const nextIndex = (currentIndex + direction + sessionIds.length) % sessionIds.length
  return sessionIds[nextIndex] || null
}

function scrollSessionRowIntoView(container: HTMLElement | null, sessionId: string | null): void {
  if (!container || !sessionId) return

  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-conversation-session-id]'))
    .find((element) => element.dataset.conversationSessionId === sessionId)

  row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function conversationRowClass(active: boolean): string {
  if (active) return 'bg-[var(--pear-selection-blue)] text-white'
  return 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)]'
}

function conversationMutedTextClass(active: boolean): string {
  return active ? 'text-white/90' : 'text-[var(--pear-text-faint)]'
}

function conversationPrimaryTextClass(active: boolean): string {
  return active ? 'text-white' : 'text-[var(--pear-text)]'
}

function SourceHarnessBadge({ source, active }: { source: Source; active: boolean }): React.ReactNode {
  const color = SOURCE_COLORS[source]

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-4 ring-1 ${
        active ? 'bg-white/15 text-white ring-white/20' : 'bg-[var(--pear-bg-overlay)] ring-[var(--pear-border)]'
      }`}
    >
      <span className="shrink-0" style={{ color }}>
        <AgentHarnessIcon
          cli={SOURCE_ICON_CLI[source]}
          className="h-3.5 w-3.5 [&_*]:fill-current"
        />
      </span>
      <span className={active ? 'text-white' : 'text-[var(--pear-text)]'}>
        {SOURCE_LABELS[source]}
      </span>
    </span>
  )
}

// Map an ai-hist session to the cli + args that the broker should spawn to
// resume it. Returns null for sources without a resume affordance (relay).
function resumeAgentSpec(
  session: { source: Source; sessionId: string; project: string | null }
): { cli: string; args: string[]; cwd?: string } | null {
  switch (session.source) {
    case 'claude':
      return {
        cli: 'claude',
        args: ['--resume', session.sessionId],
        cwd: session.project ?? undefined
      }
    case 'codex':
      return {
        cli: 'codex',
        args: ['resume', session.sessionId],
        cwd: session.project ?? undefined
      }
    case 'cursor':
      return {
        cli: 'cursor-agent',
        args: [`--resume=${session.sessionId}`],
        cwd: session.project ?? undefined
      }
    case 'relay':
      return null
  }
}

// Pick the project to host the spawned resume agent. Prefers the explicitly
// scoped project (the one whose Conversations tab the user is on); otherwise
// matches by session.project path against every pear project's roots.
function pickHostProject(
  scopedProject: Project | null,
  sessionProject: string | null,
  allProjects: Project[]
): Project | null {
  if (scopedProject) return scopedProject
  if (!sessionProject) return null
  return (
    allProjects.find((p) =>
      p.roots.some(
        (r) => sessionProject === r.path || sessionProject.startsWith(`${r.path}/`)
      )
    ) ?? null
  )
}

// A session belongs to a root if its `project` path equals or descends from the
// root's `path`. Comparing on normalized prefix + boundary so `/foo/bar-baz`
// isn't treated as a descendant of `/foo/bar`.
function sessionMatchesRoot(sessionProject: string | null, rootPath: string): boolean {
  if (!sessionProject) return false
  if (sessionProject === rootPath) return true
  const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  return sessionProject.startsWith(prefix)
}

interface SessionGroup {
  label: string
  rootPath: string | null  // null = "Other" group (no matching root)
  sessions: Session[]
}

function ConversationsPanel(): React.ReactNode {
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const projects = useProjectStore((s) => s.projects)
  const scopedProject: Project | null = useMemo(() => {
    if (activeTab?.kind !== 'ai-hist' || !activeTab.projectId) return null
    return projects.find((p) => p.id === activeTab.projectId) ?? null
  }, [activeTab, projects])

  const [status, setStatus] = useState<Status | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [detailEntries, setDetailEntries] = useState<Entry[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const queryToken = useRef(0)
  const sessionListRef = useRef<HTMLDivElement>(null)

  const loadSessions = useCallback(
    async (currentQuery: string, source: SourceFilter): Promise<void> => {
      const token = ++queryToken.current
      setLoading(true)
      try {
        const s = (await pear.aiHist.status()) as Status
        if (token !== queryToken.current) return
        setStatus(s)
        if (!s.ok) {
          setSessions([])
          return
        }
        // Pull a larger window when we're going to filter client-side by
        // project roots — sessions from other projects/paths will be
        // discarded after the SDK call.
        const opts = source === 'all' ? { limit: 500 } : { source, limit: 500 }
        if (currentQuery.trim()) {
          const all = (await pear.aiHist.searchSessions(currentQuery, opts)) as Session[]
          if (token !== queryToken.current) return
          setSessions(all)
        } else {
          const all = (await pear.aiHist.listSessions(opts)) as Session[]
          if (token !== queryToken.current) return
          setSessions(all)
        }
      } finally {
        if (token === queryToken.current) setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query), 150)
    return () => window.clearTimeout(timeoutId)
  }, [query])

  useEffect(() => {
    void loadSessions(debouncedQuery, sourceFilter)
  }, [loadSessions, debouncedQuery, sourceFilter])

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await pear.aiHist.reload()
      await loadSessions(query, sourceFilter)
    } finally {
      setRefreshing(false)
    }
  }, [loadSessions, query, sourceFilter])

  useEffect(() => {
    if (!activeSessionId) {
      setDetailEntries([])
      setDetailError(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    pear.aiHist
      .getSession(activeSessionId)
      .then((entries) => {
        if (cancelled) return
        setDetailEntries(entries as Entry[])
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        // Bubble up so the user sees why the right pane is empty instead
        // of staring at a blank panel — this used to fail silently.
        setDetailError(message || 'Failed to load session entries')
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId]
  )

  // Bucket sessions by project root. When scopedProject is set we only show
  // sessions matching its roots (everything else is hidden). Without a
  // scoped project we just show every root + an "Other" bucket for sessions
  // whose project path didn't match any pear project root.
  const groups = useMemo<SessionGroup[]>(() => {
    if (sessions.length === 0) return []
    if (scopedProject) {
      const buckets: SessionGroup[] = scopedProject.roots.map((root) => ({
        label: root.name,
        rootPath: root.path,
        sessions: sessions.filter((s) => sessionMatchesRoot(s.project, root.path))
      }))
      return buckets.filter((b) => b.sessions.length > 0)
    }
    // No scoped project: group by every pear project root, plus "Other".
    const allRoots = projects.flatMap((p) =>
      p.roots.map((root) => ({
        label: p.roots.length > 1 ? `${p.name} · ${root.name}` : p.name,
        rootPath: root.path
      }))
    )
    const matchedSessionIds = new Set<string>()
    const buckets: SessionGroup[] = []
    for (const r of allRoots) {
      const bucket = sessions.filter((s) => sessionMatchesRoot(s.project, r.rootPath))
      if (bucket.length === 0) continue
      for (const s of bucket) matchedSessionIds.add(s.sessionId)
      buckets.push({ label: r.label, rootPath: r.rootPath, sessions: bucket })
    }
    const other = sessions.filter((s) => !matchedSessionIds.has(s.sessionId))
    if (other.length > 0) {
      buckets.push({ label: 'Other', rootPath: null, sessions: other })
    }
    return buckets
  }, [sessions, scopedProject, projects])

  const totalShown = groups.reduce((acc, g) => acc + g.sessions.length, 0)
  const visibleSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups])
  const visibleSessionIds = useMemo(
    () => visibleSessions.map((session) => session.sessionId),
    [visibleSessions]
  )

  const openTab = useUIStore((s) => s.openTab)
  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)

  useEffect(() => {
    if (activeTab?.kind !== 'ai-hist') return

    window.requestAnimationFrame(() => {
      sessionListRef.current?.focus({ preventScroll: true })
    })
  }, [activeTab?.id, activeTab?.kind])

  useEffect(() => {
    if (loading) return

    const firstSessionId = visibleSessionIds[0] || null
    if (!firstSessionId) {
      if (activeSessionId) setActiveSessionId(null)
      return
    }

    if (!activeSessionId || !visibleSessionIds.includes(activeSessionId)) {
      setActiveSessionId(firstSessionId)
    }
  }, [activeSessionId, loading, visibleSessionIds])

  useEffect(() => {
    scrollSessionRowIntoView(sessionListRef.current, activeSessionId)
  }, [activeSessionId, visibleSessionIds])

  const resumeAndOpen = useCallback(
    async (sess: Session): Promise<void> => {
      const spec = resumeAgentSpec({
        source: sess.source,
        sessionId: sess.sessionId,
        project: sess.project
      })
      if (!spec) {
        setCopyHint('No resume command for this source')
        window.setTimeout(() => setCopyHint(null), 2000)
        return
      }
      const host = pickHostProject(scopedProject, sess.project, projects)
      if (!host) {
        setCopyHint('No matching pear project — add the session path as a root first')
        window.setTimeout(() => setCopyHint(null), 3500)
        return
      }
      try {
        const spawned = await pear.broker.spawnAgent(host.id, {
          name: `resume-${sess.source}-${sess.sessionId.slice(0, 8)}`,
          cli: spec.cli,
          args: spec.args,
          cwd: spec.cwd,
          channels: host.channels
        })
        setActiveAgentKey(getAgentKey(host.id, spawned.name))
        openTab({ kind: 'agents', projectId: host.id })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setCopyHint(`Resume failed: ${message}`)
        window.setTimeout(() => setCopyHint(null), 4000)
      }
    },
    [scopedProject, projects, openTab, setActiveAgentKey]
  )

  const copyResume = useCallback(async (sess: Session): Promise<void> => {
    const cmd = await pear.aiHist.resumeCommand({
      source: sess.source,
      sessionId: sess.sessionId,
      project: sess.project
    })
    if (!cmd) {
      setCopyHint('No resume command for this source')
      window.setTimeout(() => setCopyHint(null), 2000)
      return
    }
    try {
      await navigator.clipboard.writeText(cmd)
      setCopyHint('Resume command copied')
    } catch {
      setCopyHint(cmd)
    }
    window.setTimeout(() => setCopyHint(null), 2500)
  }, [])

  function handleSessionListKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const sessionId = nextSessionId(
        visibleSessionIds,
        activeSessionId,
        event.key === 'ArrowDown' ? 1 : -1
      )
      if (sessionId) setActiveSessionId(sessionId)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (activeSessionId && visibleSessionIds.includes(activeSessionId)) {
        setActiveSessionId(activeSessionId)
      }
    }
  }

  if (status && !status.ok) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <MessageSquare className="text-[var(--pear-text-faint)]" size={32} />
        <h2 className="text-base font-medium">ai-hist not available</h2>
        <p className="max-w-md text-sm text-[var(--pear-text-faint)]">{status.reason}</p>
        <p className="max-w-md text-xs text-[var(--pear-text-faint)]">
          Install ai-hist (see{' '}
          <code className="rounded bg-[var(--pear-bg-overlay)] px-1 py-0.5">github.com/khaliqgant/ai-hist</code>),
          run <code className="rounded bg-[var(--pear-bg-overlay)] px-1 py-0.5">ai-hist sync</code> once, then
          press refresh.
        </p>
        <button
          onClick={refresh}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--pear-bg-overlay)] px-3 py-1.5 text-xs hover:bg-[var(--pear-bg-surface-hover)]"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="relative flex h-full">
      <div className="flex w-[380px] shrink-0 flex-col border-r border-[var(--pear-border)]">
            <div className="flex flex-col gap-2 border-b border-[var(--pear-border)] p-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--pear-text-faint)]"
                  />
                  <input
                    type="text"
                    placeholder={scopedProject ? `Search ${scopedProject.name}…` : 'Search prompts…'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full rounded-md bg-[var(--pear-bg-overlay)] py-1.5 pl-7 pr-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--pear-accent)]"
                  />
                </div>
                <button
                  onClick={refresh}
                  title="Reload (re-reads the SQLite file)"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--pear-bg-overlay)]"
                >
                  <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {(['all', 'claude', 'codex', 'cursor', 'relay'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSourceFilter(s)}
                    className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors ${
                      sourceFilter === s
                        ? 'bg-[var(--pear-accent)] text-white'
                        : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]'
                    }`}
                  >
                    {s === 'all' ? 'All' : SOURCE_LABELS[s]}
                  </button>
                ))}
              </div>
              {scopedProject && (
                <div className="text-[10px] text-[var(--pear-text-faint)]">
                  Scoped to <span className="text-[var(--pear-text)]">{scopedProject.name}</span> ·{' '}
                  {scopedProject.roots.length} root{scopedProject.roots.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
            <div
              ref={sessionListRef}
              data-focus-ring="none"
              className="min-h-0 flex-1 overflow-y-auto"
              tabIndex={0}
              onKeyDown={handleSessionListKeyDown}
              aria-label="Conversation history"
            >
              {loading && sessions.length === 0 ? (
                <div className="p-6 text-center text-xs text-[var(--pear-text-faint)]">Loading…</div>
              ) : totalShown === 0 ? (
                <div className="p-6 text-center text-xs text-[var(--pear-text-faint)]">
                  {query.trim()
                    ? 'No matches.'
                    : scopedProject
                      ? `No conversations found under ${scopedProject.name}'s roots.`
                      : status?.ok
                        ? 'No sessions yet. Run `ai-hist sync` first.'
                        : ''}
                </div>
              ) : (
                <ul className="flex flex-col">
                  {groups.map((group) => (
                    <li key={group.rootPath ?? group.label} className="border-b border-[var(--pear-border)] last:border-b-0">
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-[var(--pear-bg-raised)] px-3 py-1.5">
                        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-[var(--pear-text-faint)]">
                          {group.label}
                        </span>
                        <span className="text-[10px] text-[var(--pear-text-faint)]">
                          {group.sessions.length}
                        </span>
                      </div>
                      {group.rootPath && (
                        <div
                          className="truncate px-3 pb-1 font-mono text-[9px] text-[var(--pear-text-faint)]/70"
                          title={group.rootPath}
                        >
                          {shortenPath(group.rootPath)}
                        </div>
                      )}
                      <ul>
                        {group.sessions.map((sess) => {
                          const isActive = sess.sessionId === activeSessionId
                          const mutedTextClass = conversationMutedTextClass(isActive)
                          return (
                            <li key={sess.sessionId}>
                              <button
                                type="button"
                                tabIndex={-1}
                                data-conversation-session-id={sess.sessionId}
                                onClick={() => setActiveSessionId(sess.sessionId)}
                                onDoubleClick={() => void resumeAndOpen(sess)}
                                title="Click to view transcript · Double-click to resume in pear"
                                className={`flex w-full flex-col gap-1 border-b border-[var(--pear-border-subtle)] px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 focus:outline-none focus-visible:outline-none ${
                                  conversationRowClass(isActive)
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <SourceHarnessBadge source={sess.source} active={isActive} />
                                  <span className={`text-[10px] ${mutedTextClass}`}>
                                    {formatRelative(sess.lastActivityMs)}
                                  </span>
                                </div>
                                <div className={`line-clamp-2 text-xs ${conversationPrimaryTextClass(isActive)}`}>
                                  {sess.firstPrompt || '(empty prompt)'}
                                </div>
                                <div
                                  className={`flex items-center justify-between gap-2 text-[10px] ${mutedTextClass}`}
                                >
                                  <span className="truncate" title={sess.project || ''}>
                                    {shortenPath(sess.project)}
                                  </span>
                                  <span>{sess.promptCount} prompt{sess.promptCount === 1 ? '' : 's'}</span>
                                </div>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {status?.ok && (
              <div className="border-t border-[var(--pear-border)] px-3 py-1.5 text-[10px] text-[var(--pear-text-faint)]">
                <span className="truncate" title={status.dbPath}>{shortenPath(status.dbPath)}</span>
              </div>
            )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
            {activeSession ? (
              <>
                <div className="flex items-start justify-between gap-3 border-b border-[var(--pear-border)] p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <SourceHarnessBadge source={activeSession.source} active={false} />
                      <span className="text-[11px] text-[var(--pear-text-faint)]">
                        {activeSession.promptCount} prompt{activeSession.promptCount === 1 ? '' : 's'} · started{' '}
                        {formatRelative(activeSession.firstActivityMs)}
                      </span>
                    </div>
                    <div
                      className="mt-1 truncate text-xs text-[var(--pear-text-faint)]"
                      title={activeSession.project || ''}
                    >
                      {activeSession.project || '(no project)'}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--pear-text-faint)]/70">
                      {activeSession.sessionId}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => void resumeAndOpen(activeSession)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--pear-accent)] px-2.5 py-1.5 text-xs text-white hover:bg-[var(--pear-accent-bright)]"
                      title="Spawn this session as an agent in pear"
                    >
                      Resume in pear
                    </button>
                    <button
                      onClick={() => copyResume(activeSession)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--pear-bg-overlay)] px-2.5 py-1.5 text-xs hover:bg-[var(--pear-bg-surface-hover)]"
                      title="Copy the shell command to resume manually"
                    >
                      <ClipboardCopy size={12} />
                      Copy
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {detailLoading ? (
                    <div className="text-center text-xs text-[var(--pear-text-faint)]">Loading…</div>
                  ) : detailError ? (
                    <div className="rounded-md bg-red-500/10 p-3 text-xs text-red-300 ring-1 ring-red-500/30">
                      <div className="mb-1 font-medium">Couldn't load session</div>
                      <div className="font-mono">{detailError}</div>
                    </div>
                  ) : detailEntries.length === 0 ? (
                    <div className="text-center text-xs text-[var(--pear-text-faint)]">
                      No prompts found for session {activeSession.sessionId}.
                      <br />
                      (This usually means the SDK's session-id doesn't match the row's — please file a bug.)
                    </div>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {detailEntries.map((entry) => (
                        <li
                          key={entry.id}
                          className="rounded-md bg-[var(--pear-bg-overlay)] p-2.5"
                        >
                          <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--pear-text-faint)]">
                            <span>{new Date(entry.timestampMs).toLocaleString()}</span>
                            <span>#{entry.id}</span>
                          </div>
                          <pre className="whitespace-pre-wrap font-mono text-xs leading-snug text-[var(--pear-text)]">
                            {entry.prompt}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-[var(--pear-text-faint)]">
                Select a conversation to view its prompts.
              </div>
            )}
      </div>

      {copyHint && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-[var(--pear-bg-surface-hover)] px-3 py-1.5 text-xs shadow-lg">
          {copyHint}
        </div>
      )}
    </div>
  )
}

export default ConversationsPanel
