/**
 * History's generated session briefs (`{ title, description }`), read through
 * Cloud's `reflex/sessions/{id}/brief?admit=false`. Reading without
 * `admit=false` queues model work under a daily budget, so this only ever
 * reads cached briefs. Lookups run in the background and never hold up the
 * conversation list; `onUpdated` fires once a batch turns up new briefs.
 */
export interface SessionBriefCacheOptions {
  /** One session's cached brief text, or null when History has none. */
  fetchBrief: (sessionId: string) => Promise<string | null>
  onUpdated: () => void
  ttlMs?: number
  concurrency?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_CONCURRENCY = 4

export class SessionBriefCache {
  private readonly options: SessionBriefCacheOptions
  private readonly ttlMs: number
  private readonly concurrency: number
  private readonly now: () => number
  private readonly entries = new Map<string, { text: string | null; at: number }>()
  private readonly inFlight = new Set<string>()

  constructor(options: SessionBriefCacheOptions) {
    this.options = options
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    this.now = options.now ?? Date.now
  }

  /** The cached brief, if any; stale entries still answer until refreshed. */
  get(sessionId: string): string | null {
    return this.entries.get(sessionId)?.text ?? null
  }

  /** Look up missing or stale briefs in the background. Repeated calls share work. */
  refresh(sessionIds: readonly string[]): Promise<void> {
    const due = [...new Set(sessionIds)].filter((id) => {
      if (!id || this.inFlight.has(id)) return false
      const entry = this.entries.get(id)
      return !entry || this.now() - entry.at >= this.ttlMs
    })
    if (due.length === 0) return Promise.resolve()
    for (const id of due) this.inFlight.add(id)
    return this.run(due)
  }

  private async run(ids: string[]): Promise<void> {
    let changed = false
    const queue = [...ids]
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const text = (await this.options.fetchBrief(id).catch(() => null))?.trim() || null
          const before = this.entries.get(id)?.text ?? null
          this.entries.set(id, { text, at: this.now() })
          if (text !== before) changed = true
        } finally {
          this.inFlight.delete(id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, ids.length) }, worker))
    if (changed) this.options.onUpdated()
  }
}

/** The brief's text from Cloud's response: its description, else its title. */
export function briefText(body: unknown): string | null {
  const brief = body && typeof body === 'object' ? (body as { brief?: unknown }).brief : null
  if (!brief || typeof brief !== 'object') return null
  const { description, title } = brief as { description?: unknown; title?: unknown }
  const titleText = typeof title === 'string' ? title.trim() : ''
  // A title without a space is the generated session slug (`infra-7d`), not a summary.
  const text = typeof description === 'string' && description.trim()
    ? description.trim()
    : /\s/.test(titleText) ? titleText : ''
  return text ? text.slice(0, 320) : null
}
