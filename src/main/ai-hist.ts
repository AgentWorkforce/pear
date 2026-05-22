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

class AiHistManager {
  private instance: AiHistInstance | null = null
  private loadingPromise: Promise<AiHistInstance | null> | null = null
  private status: AiHistStatus | null = null

  private async ensureLoaded(): Promise<AiHistInstance | null> {
    if (this.instance) return this.instance
    if (this.loadingPromise) return this.loadingPromise
    this.loadingPromise = (async () => {
      try {
        // Deferred require so the WASM doesn't load until first use.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('ai-hist') as typeof import('ai-hist')
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
    return inst?.listSessions(opts) ?? []
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

  async stats(): Promise<Stats | null> {
    const inst = await this.ensureLoaded()
    return inst?.stats() ?? null
  }

  resumeCommand(entry: { source: Source; sessionId: string | null; project: string | null }): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('ai-hist') as typeof import('ai-hist')
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
}

export const aiHistManager = new AiHistManager()
