import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Allotment } from 'allotment'
import { ClipboardCopy, MessageSquare, RefreshCw, Search } from 'lucide-react'
import { pear } from '@/lib/ipc'

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

const SOURCE_CHIP_STYLES: Record<Source, string> = {
  claude: 'bg-amber-500/15 text-amber-300 ring-amber-400/30',
  codex: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
  cursor: 'bg-sky-500/15 text-sky-300 ring-sky-400/30',
  relay: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-400/30'
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

function ConversationsPanel(): React.ReactNode {
  const [status, setStatus] = useState<Status | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [detailEntries, setDetailEntries] = useState<Entry[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const queryToken = useRef(0)

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
        const opts = source === 'all' ? { limit: 100 } : { source, limit: 100 }
        if (currentQuery.trim()) {
          // Search returns flat HistoryEntries; we still want session
          // grouping in the list, so fall back to listSessions and then
          // filter client-side by whether ANY entry in the session matches.
          // For very large datasets that gets expensive — at the ai-hist
          // scale (tens of thousands of rows) it's fine.
          const hits = (await pear.aiHist.search(currentQuery, opts)) as Entry[]
          if (token !== queryToken.current) return
          const hitSessionIds = new Set(hits.map((h) => h.sessionId).filter(Boolean) as string[])
          const all = (await pear.aiHist.listSessions(opts)) as Session[]
          if (token !== queryToken.current) return
          setSessions(all.filter((sess) => hitSessionIds.has(sess.sessionId)))
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
    void loadSessions(query, sourceFilter)
  }, [loadSessions, query, sourceFilter])

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await pear.aiHist.reload()
      await loadSessions(query, sourceFilter)
    } finally {
      setRefreshing(false)
    }
  }, [loadSessions, query, sourceFilter])

  // Load detail when a session is selected.
  useEffect(() => {
    if (!activeSessionId) {
      setDetailEntries([])
      return
    }
    let cancelled = false
    setDetailLoading(true)
    pear.aiHist
      .getSession(activeSessionId)
      .then((entries) => {
        if (!cancelled) setDetailEntries(entries as Entry[])
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

  // Status banner — DB missing / load failed.
  if (status && !status.ok) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <MessageSquare className="text-[var(--pear-fg-muted)]" size={32} />
        <h2 className="text-base font-medium">ai-hist not available</h2>
        <p className="max-w-md text-sm text-[var(--pear-fg-muted)]">{status.reason}</p>
        <p className="max-w-md text-xs text-[var(--pear-fg-muted)]">
          Install ai-hist (see{' '}
          <code className="rounded bg-[var(--pear-bg-overlay)] px-1 py-0.5">github.com/khaliqgant/ai-hist</code>),
          run <code className="rounded bg-[var(--pear-bg-overlay)] px-1 py-0.5">ai-hist sync</code> once, then
          press refresh.
        </p>
        <button
          onClick={refresh}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--pear-bg-overlay)] px-3 py-1.5 text-xs hover:bg-[var(--pear-bg-overlay-strong)]"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <Allotment defaultSizes={[1, 2]}>
        <Allotment.Pane minSize={280} preferredSize={360}>
          <div className="flex h-full flex-col border-r border-[var(--pear-border)]">
            <div className="flex flex-col gap-2 border-b border-[var(--pear-border)] p-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--pear-fg-muted)]"
                  />
                  <input
                    type="text"
                    placeholder="Search prompts…"
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
                        : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-fg-muted)] hover:text-[var(--pear-fg)]'
                    }`}
                  >
                    {s === 'all' ? 'All' : SOURCE_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && sessions.length === 0 ? (
                <div className="p-6 text-center text-xs text-[var(--pear-fg-muted)]">Loading…</div>
              ) : sessions.length === 0 ? (
                <div className="p-6 text-center text-xs text-[var(--pear-fg-muted)]">
                  {query.trim()
                    ? 'No matches.'
                    : status?.ok
                      ? 'No sessions yet. Run `ai-hist sync` first.'
                      : ''}
                </div>
              ) : (
                <ul className="divide-y divide-[var(--pear-border)]">
                  {sessions.map((sess) => {
                    const isActive = sess.sessionId === activeSessionId
                    return (
                      <li key={sess.sessionId}>
                        <button
                          onClick={() => setActiveSessionId(sess.sessionId)}
                          className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors ${
                            isActive
                              ? 'bg-[var(--pear-bg-overlay-strong)]'
                              : 'hover:bg-[var(--pear-bg-overlay)]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`inline-block rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ring-1 ${SOURCE_CHIP_STYLES[sess.source]}`}
                            >
                              {SOURCE_LABELS[sess.source]}
                            </span>
                            <span className="text-[10px] text-[var(--pear-fg-muted)]">
                              {formatRelative(sess.lastActivityMs)}
                            </span>
                          </div>
                          <div className="line-clamp-2 text-xs text-[var(--pear-fg)]">
                            {sess.firstPrompt || '(empty prompt)'}
                          </div>
                          <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--pear-fg-muted)]">
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
              )}
            </div>
            {status?.ok && (
              <div className="border-t border-[var(--pear-border)] px-3 py-1.5 text-[10px] text-[var(--pear-fg-muted)]">
                <span className="truncate" title={status.dbPath}>{shortenPath(status.dbPath)}</span>
              </div>
            )}
          </div>
        </Allotment.Pane>

        <Allotment.Pane>
          <div className="flex h-full flex-col">
            {activeSession ? (
              <>
                <div className="flex items-start justify-between gap-3 border-b border-[var(--pear-border)] p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ring-1 ${SOURCE_CHIP_STYLES[activeSession.source]}`}
                      >
                        {SOURCE_LABELS[activeSession.source]}
                      </span>
                      <span className="text-[11px] text-[var(--pear-fg-muted)]">
                        {activeSession.promptCount} prompt{activeSession.promptCount === 1 ? '' : 's'} · started{' '}
                        {formatRelative(activeSession.firstActivityMs)}
                      </span>
                    </div>
                    <div
                      className="mt-1 truncate text-xs text-[var(--pear-fg-muted)]"
                      title={activeSession.project || ''}
                    >
                      {activeSession.project || '(no project)'}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--pear-fg-muted)]/70">
                      {activeSession.sessionId}
                    </div>
                  </div>
                  <button
                    onClick={() => copyResume(activeSession)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--pear-bg-overlay)] px-2.5 py-1.5 text-xs hover:bg-[var(--pear-bg-overlay-strong)]"
                  >
                    <ClipboardCopy size={12} />
                    Copy resume command
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {detailLoading ? (
                    <div className="text-center text-xs text-[var(--pear-fg-muted)]">Loading…</div>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {detailEntries.map((entry) => (
                        <li
                          key={entry.id}
                          className="rounded-md bg-[var(--pear-bg-overlay)] p-2.5"
                        >
                          <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--pear-fg-muted)]">
                            <span>{new Date(entry.timestampMs).toLocaleString()}</span>
                            <span>#{entry.id}</span>
                          </div>
                          <pre className="whitespace-pre-wrap font-mono text-xs leading-snug text-[var(--pear-fg)]">
                            {entry.prompt}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-[var(--pear-fg-muted)]">
                Select a conversation to view its prompts.
              </div>
            )}
          </div>
        </Allotment.Pane>
      </Allotment>

      {copyHint && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-[var(--pear-bg-overlay-strong)] px-3 py-1.5 text-xs shadow-lg">
          {copyHint}
        </div>
      )}
    </div>
  )
}

export default ConversationsPanel
