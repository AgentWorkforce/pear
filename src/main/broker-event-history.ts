import { compactBrokerEvent, normalizeEventTimestamp } from '../shared/lib/broker-events'

// Keep at most this many broker events in memory, and drop anything older than
// the TTL. The dashboard replays this buffer to rebuild its timeline after a
// reconnect, so it has to be bounded but still cover a realistic working
// session.
const MAX_BROKER_EVENT_HISTORY = 3_000
const BROKER_EVENT_HISTORY_TTL_MS = 12 * 60 * 60 * 1_000

export type BrokerEventRecordPayload = Record<string, unknown> & { kind: string }

export interface BrokerEventRecord {
  id: string
  projectId: string
  timestamp: number
  event: BrokerEventRecordPayload
}

// Owns the in-memory broker event buffer: append-on-record, reactive pruning,
// and the replay query the renderer uses to rehydrate after a reconnect.
// BrokerManager delegates here and keeps event publishing / IPC fan-out inline.
// Pruning stays reactive (runs on every record and on every list) — there is
// deliberately no timer; an idle broker simply stops accreting history.
export class BrokerEventHistory {
  private eventHistory: BrokerEventRecord[] = []
  private eventSerial = 0

  // Stamp, compact, append, and prune a single event. The returned record's
  // `id`/`timestamp` are what publishBrokerEvent forwards to the renderer as
  // historyId/observedAt, so the serial must advance exactly once per record.
  record(projectId: string, event: BrokerEventRecordPayload): BrokerEventRecord {
    const eventRecord = event as Record<string, unknown>
    const timestamp = normalizeEventTimestamp(eventRecord.timestamp) ?? Date.now()
    const record: BrokerEventRecord = {
      id: `${projectId}:${++this.eventSerial}`,
      projectId,
      timestamp,
      event: compactBrokerEvent(event)
    }

    this.eventHistory.push(record)
    this.prune()
    return record
  }

  // Reactive prune: enforce the TTL cheaply (drop the leading expired prefix)
  // while under the size cap, and only fall back to a full filter+slice when the
  // buffer has grown past MAX. `now` is injectable for tests.
  prune(now = Date.now()): void {
    const cutoff = now - BROKER_EVENT_HISTORY_TTL_MS
    if (this.eventHistory.length <= MAX_BROKER_EVENT_HISTORY) {
      const firstFreshIndex = this.eventHistory.findIndex((entry) => entry.timestamp >= cutoff)
      if (firstFreshIndex > 0) {
        this.eventHistory.splice(0, firstFreshIndex)
      } else if (firstFreshIndex === -1 && this.eventHistory.length > 0) {
        this.eventHistory = []
      }
      return
    }

    this.eventHistory = this.eventHistory
      .filter((entry) => entry.timestamp >= cutoff)
      .slice(-MAX_BROKER_EVENT_HISTORY)
  }

  // Replay snapshot for the renderer. Prunes first, then returns shallow copies
  // (record + a fresh event payload object) so callers can't mutate the buffer.
  list(): BrokerEventRecord[] {
    this.prune()
    return this.eventHistory.map((entry) => ({
      ...entry,
      event: { ...(entry.event as Record<string, unknown>) } as BrokerEventRecordPayload
    }))
  }
}
