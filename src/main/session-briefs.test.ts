import { describe, expect, it, vi } from 'vitest'
import { SessionBriefCache, briefText } from './session-briefs'

describe('SessionBriefCache', () => {
  it('fetches each session once across overlapping refreshes and reports new briefs once', async () => {
    const fetchBrief = vi.fn(async (id: string) => (id === 's1' ? 'Fixing the broker reconnect' : null))
    const onUpdated = vi.fn()
    const cache = new SessionBriefCache({ fetchBrief, onUpdated })
    await Promise.all([cache.refresh(['s1', 's2', 's1']), cache.refresh(['s1', 's2'])])
    expect(fetchBrief).toHaveBeenCalledTimes(2)
    expect(onUpdated).toHaveBeenCalledTimes(1)
    expect(cache.get('s1')).toBe('Fixing the broker reconnect')
    expect(cache.get('s2')).toBeNull()

    await cache.refresh(['s1', 's2'])
    expect(fetchBrief).toHaveBeenCalledTimes(2)
  })

  it('rechecks after the TTL and stays quiet when nothing changed', async () => {
    let now = 0
    const fetchBrief = vi.fn(async () => 'same')
    const onUpdated = vi.fn()
    const cache = new SessionBriefCache({ fetchBrief, onUpdated, ttlMs: 1_000, now: () => now })
    await cache.refresh(['s1'])
    now = 1_000
    await cache.refresh(['s1'])
    expect(fetchBrief).toHaveBeenCalledTimes(2)
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })

  it('treats a failed lookup as no brief and keeps the batch going', async () => {
    const fetchBrief = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('503')
      return 'ok'
    })
    const cache = new SessionBriefCache({ fetchBrief, onUpdated: vi.fn(), concurrency: 1 })
    await cache.refresh(['bad', 'good'])
    expect(cache.get('bad')).toBeNull()
    expect(cache.get('good')).toBe('ok')
  })
})

describe('briefText', () => {
  it('prefers the description, falls back to the title, and ignores missing briefs', () => {
    expect(briefText({ status: 'ready', brief: { title: 'T', description: 'What it is doing' } })).toBe('What it is doing')
    expect(briefText({ status: 'ready', brief: { title: 'Only a title', description: '' } })).toBe('Only a title')
    expect(briefText({ status: 'pending', brief: null })).toBeNull()
    expect(briefText(null)).toBeNull()
  })
})
