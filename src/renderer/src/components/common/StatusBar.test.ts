import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({ pear: {} }))

const { relayConnection } = await import('./StatusBar')

describe('relayConnection', () => {
  it('reports the relay link the chat list uses, not the local broker', () => {
    expect(relayConnection(null, null)).toBe('connecting')
    expect(relayConnection(null, '2026-11-15T04:00:00Z')).toBe('connected')
    expect(relayConnection('fetch failed', '2026-11-15T04:00:00Z')).toBe('offline')
  })
})
