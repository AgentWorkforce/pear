import { describe, expect, it } from 'vitest'
import { BrokerEventHistory, type BrokerEventRecordPayload } from './broker-event-history'

const HOUR_MS = 60 * 60 * 1_000

const payload = (overrides: Partial<BrokerEventRecordPayload> = {}): BrokerEventRecordPayload => ({
  kind: 'worker_stream',
  ...overrides
})

describe('BrokerEventHistory.record', () => {
  it('assigns a monotonic project-scoped id and returns the record', () => {
    const history = new BrokerEventHistory()
    const first = history.record('proj', payload())
    const second = history.record('proj', payload())
    expect(first.id).toBe('proj:1')
    expect(second.id).toBe('proj:2')
    expect(first.projectId).toBe('proj')
  })

  it('honors an event-supplied timestamp, falling back to now otherwise', () => {
    const history = new BrokerEventHistory()
    const now = Date.now()
    const stamped = history.record('proj', payload({ timestamp: now - HOUR_MS }))
    expect(stamped.timestamp).toBe(now - HOUR_MS)

    const unstamped = history.record('proj', payload())
    expect(unstamped.timestamp).toBeGreaterThan(0)
  })

  it('makes recorded events visible via list', () => {
    const history = new BrokerEventHistory()
    history.record('proj', payload({ name: 'alice' }))
    const events = history.list()
    expect(events).toHaveLength(1)
    expect(events[0].event.name).toBe('alice')
  })
})

describe('BrokerEventHistory.list', () => {
  it('returns copies that cannot mutate the buffer', () => {
    const history = new BrokerEventHistory()
    history.record('proj', payload({ name: 'alice' }))
    const events = history.list()
    events[0].event.name = 'mutated'
    expect(history.list()[0].event.name).toBe('alice')
  })
})

describe('BrokerEventHistory pruning', () => {
  it('drops events older than the 12h TTL on record, keeping fresh ones', () => {
    const history = new BrokerEventHistory()
    const now = Date.now()
    // Reactive prune runs on each record against the wall clock: the expired
    // entry is gone by the time the fresh one lands.
    history.record('proj', payload({ timestamp: now - 13 * HOUR_MS }))
    history.record('proj', payload({ timestamp: now - 1 * HOUR_MS }))
    const events = history.list()
    expect(events).toHaveLength(1)
    expect(events[0].timestamp).toBe(now - 1 * HOUR_MS)
  })

  it('empties the buffer when every event has expired (injected now)', () => {
    const history = new BrokerEventHistory()
    history.record('proj', payload())
    history.record('proj', payload())
    expect(history.list()).toHaveLength(2)
    // Advance the clock past the TTL: everything recorded just now is expired.
    history.prune(Date.now() + 13 * HOUR_MS)
    expect(history.list()).toHaveLength(0)
  })

  it('caps the buffer at the 3000 most recent events', () => {
    const history = new BrokerEventHistory()
    for (let i = 0; i < 3_100; i += 1) {
      history.record('proj', payload())
    }
    const events = history.list()
    expect(events).toHaveLength(3_000)
    // The first 100 serials were evicted; the buffer keeps the most recent 3000.
    expect(events[0].id).toBe('proj:101')
    expect(events[events.length - 1].id).toBe('proj:3100')
  })
})
