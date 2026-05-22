/**
 * Pear main-process wrapper around the `ai-hist` SDK. Lazy-loads the SDK
 * (sql.js WASM) on first use so app startup isn't affected. Surfaces
 * load / DB-missing failures via `getStatus()` rather than crashing.
 */

import type {
  AiHist as AiHistInstance,
  HistoryEntry,
  SessionSummary,
  ListOptions,
  SearchOptions,
  Stats,
  Source
} from 'ai-hist'

export type AiHistStatus =
  | { ok: true; dbPath: string }
  | { ok: false; reason: string }

type QueryValue = string | number | null

interface SqlStatement {
  bind(params: QueryValue[]): void
  step(): boolean
  getAsObject(): Record<string, unknown>
  free(): void
}

interface SqlDatabaseLike {
  prepare(sql: string): SqlStatement
}

interface AiHistWithDatabase {
  db?: SqlDatabaseLike
}

interface HistoryRow {
  id: number
  source: Source
  session_id: string
  project: string | null
  prompt: string
  timestamp_ms: number
}

function buildHistoryFilters(opts: ListOptions | SearchOptions = {}, columnPrefix = ''): { sql: string; params: QueryValue[] } {
  const clauses: string[] = []
  const params: QueryValue[] = []
  const prefix = columnPrefix ? `${columnPrefix}.` : ''
  if (opts.source) {
    clauses.push(`${prefix}source = ?`)
    params.push(opts.source)
  }
  if (opts.project) {
    clauses.push(`${prefix}project = ?`)
    params.push(opts.project)
  }
  if (typeof opts.beforeMs === 'number') {
    clauses.push(`${prefix}timestamp_ms < ?`)
    params.push(opts.beforeMs)
  }
  return {
    sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    params
  }
}

function runQuery(db: SqlDatabaseLike, sql: string, params: QueryValue[]): Record<string, unknown>[] {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params)
    const rows: Record<string, unknown>[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    return rows
  } finally {
    stmt.free()
  }
}

function historyRowFromQuery(row: Record<string, unknown>): HistoryRow | null {
  if (typeof row.session_id !== 'string' || row.session_id.length === 0) return null
  if (typeof row.prompt !== 'string') return null
  return {
    id: Number(row.id),
    source: row.source as Source,
    session_id: row.session_id,
    project: typeof row.project === 'string' ? row.project : null,
    prompt: row.prompt,
    timestamp_ms: Number(row.timestamp_ms)
  }
}

function sessionKey(source: Source, sessionId: string, project: string | null): string {
  return `${source}\u0000${sessionId}\u0000${project ?? ''}`
}

function entryKey(entry: HistoryEntry): string | null {
  return entry.sessionId ? sessionKey(entry.source, entry.sessionId, entry.project) : null
}

function rowKey(row: HistoryRow): string {
  return sessionKey(row.source, row.session_id, row.project)
}

function summarizeRows(rows: HistoryRow[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary & { firstPromptId: number }>()
  for (const row of rows) {
    const key = rowKey(row)
    let session = sessions.get(key)
    if (!session) {
      session = {
        sessionId: row.session_id,
        source: row.source,
        project: row.project,
        firstPrompt: row.prompt,
        firstPromptId: row.id,
        firstActivityMs: row.timestamp_ms,
        lastActivityMs: row.timestamp_ms,
        promptCount: 0
      }
      sessions.set(key, session)
    }
    session.promptCount += 1
    if (
      row.timestamp_ms < session.firstActivityMs ||
      (row.timestamp_ms === session.firstActivityMs && row.id < session.firstPromptId)
    ) {
      session.firstActivityMs = row.timestamp_ms
      session.firstPrompt = row.prompt
      session.firstPromptId = row.id
    }
  }
  return Array.from(sessions.values()).map(({ firstPromptId: _firstPromptId, ...session }) => session)
}

function sessionsFromSearchHits(hits: HistoryEntry[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>()
  for (const hit of hits) {
    if (!hit.sessionId) continue
    const key = sessionKey(hit.source, hit.sessionId, hit.project)
    const existing = sessions.get(key)
    if (!existing) {
      sessions.set(key, {
        sessionId: hit.sessionId,
        source: hit.source,
        project: hit.project,
        firstPrompt: hit.prompt,
        firstActivityMs: hit.timestampMs,
        lastActivityMs: hit.timestampMs,
        promptCount: 1
      })
      continue
    }
    existing.firstActivityMs = Math.min(existing.firstActivityMs, hit.timestampMs)
    existing.lastActivityMs = Math.max(existing.lastActivityMs, hit.timestampMs)
    existing.promptCount += 1
  }
  return Array.from(sessions.values()).sort((a, b) => b.lastActivityMs - a.lastActivityMs)
}

class AiHistManager {
  private instance: AiHistInstance | null = null
  private loadingPromise: Promise<AiHistInstance | null> | null = null
  private status: AiHistStatus | null = null

  private async ensureLoaded(): Promise<AiHistInstance | null> {
    if (this.instance) return this.instance
    if (this.loadingPromise) return this.loadingPromise
    this.loadingPromise = (async () => {
      try {
        // Deferred dynamic import — sql.js WASM doesn't load until first use.
        // Dynamic import (not require) because the SDK ships as ESM.
        const mod = (await import('ai-hist')) as typeof import('ai-hist')
        const inst = await mod.openAiHist()
        this.instance = inst
        this.status = { ok: true, dbPath: inst.dbPath }
        return inst
      } catch (err) {
        this.status = {
          ok: false,
          reason: err instanceof Error ? err.message : String(err)
        }
        return null
      } finally {
        this.loadingPromise = null
      }
    })()
    return this.loadingPromise
  }

  async getStatus(): Promise<AiHistStatus> {
    await this.ensureLoaded()
    return this.status ?? { ok: false, reason: 'unknown' }
  }

  async recent(opts?: ListOptions): Promise<HistoryEntry[]> {
    const inst = await this.ensureLoaded()
    return inst?.recent(opts) ?? []
  }

  async listSessions(opts?: ListOptions): Promise<SessionSummary[]> {
    const inst = await this.ensureLoaded()
    if (!inst) return []
    try {
      return this.fastListSessions(inst, opts)
    } catch {
      return inst.listSessions(opts)
    }
  }

  async getSession(sessionId: string): Promise<HistoryEntry[]> {
    const inst = await this.ensureLoaded()
    return inst?.getSession(sessionId) ?? []
  }

  async search(query: string, opts?: SearchOptions): Promise<HistoryEntry[]> {
    const inst = await this.ensureLoaded()
    if (!inst) return []
    const cleaned = query.trim()
    if (!cleaned) return []
    return inst.search(cleaned, opts)
  }

  async searchSessions(query: string, opts?: SearchOptions): Promise<SessionSummary[]> {
    const inst = await this.ensureLoaded()
    if (!inst) return []
    const cleaned = query.trim()
    if (!cleaned) return []
    try {
      return this.fastSearchSessions(inst, cleaned, opts)
    } catch {
      return sessionsFromSearchHits(inst.search(cleaned, opts))
    }
  }

  async stats(): Promise<Stats | null> {
    const inst = await this.ensureLoaded()
    return inst?.stats() ?? null
  }

  async resumeCommand(entry: { source: Source; sessionId: string | null; project: string | null }): Promise<string | null> {
    try {
      const mod = (await import('ai-hist')) as typeof import('ai-hist')
      return mod.resumeCommand(entry)
    } catch {
      return null
    }
  }

  /**
   * Drop the cached snapshot so the next call re-reads the DB file. Pear
   * doesn't have a file watcher here; the renderer can call this from a
   * manual refresh button after the user kicks off `ai-hist sync`.
   */
  reload(): void {
    this.instance?.close()
    this.instance = null
    this.status = null
  }

  dispose(): void {
    this.instance?.close()
    this.instance = null
  }

  private getDb(inst: AiHistInstance): SqlDatabaseLike {
    const db = (inst as unknown as AiHistWithDatabase).db
    if (!db) throw new Error('ai-hist database handle is unavailable')
    return db
  }

  private fastListSessions(inst: AiHistInstance, opts: ListOptions = {}): SessionSummary[] {
    const db = this.getDb(inst)
    const limit = opts.limit ?? 50
    const { sql, params } = buildHistoryFilters(opts)
    const rows = runQuery(
      db,
      `SELECT id, source, session_id, project, prompt, timestamp_ms
       FROM history
       WHERE session_id IS NOT NULL AND session_id != ''${sql}
       ORDER BY timestamp_ms DESC, id DESC`,
      params
    )
      .map(historyRowFromQuery)
      .filter((row): row is HistoryRow => row !== null)
    return summarizeRows(rows).slice(0, limit)
  }

  private fastSearchSessions(inst: AiHistInstance, query: string, opts: SearchOptions = {}): SessionSummary[] {
    const db = this.getDb(inst)
    const hits = inst.search(query, opts)
    const sessionOrder = new Map<string, number>()
    for (const hit of hits) {
      const key = entryKey(hit)
      if (key && !sessionOrder.has(key)) sessionOrder.set(key, sessionOrder.size)
    }
    if (sessionOrder.size === 0) return []

    const { sql, params } = buildHistoryFilters(opts)
    const rows = runQuery(
      db,
      `SELECT id, source, session_id, project, prompt, timestamp_ms
       FROM history
       WHERE session_id IS NOT NULL AND session_id != ''${sql}
       ORDER BY timestamp_ms DESC, id DESC`,
      params
    )
      .map(historyRowFromQuery)
      .filter((row): row is HistoryRow => row !== null && sessionOrder.has(rowKey(row)))

    return summarizeRows(rows).sort(
      (a, b) =>
        (sessionOrder.get(sessionKey(a.source, a.sessionId, a.project)) ?? Number.MAX_SAFE_INTEGER) -
        (sessionOrder.get(sessionKey(b.source, b.sessionId, b.project)) ?? Number.MAX_SAFE_INTEGER)
    )
  }
}

export const aiHistManager = new AiHistManager()
