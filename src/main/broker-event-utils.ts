/**
 * Pure accessors and predicates over `BrokerEvent` payloads.
 *
 * Broker events arrive as a loose discriminated union; many optional fields
 * (`reason`, `lastError`, `chunk`, numeric counters) are not declared on the
 * base type, so these helpers read them through a single dynamic accessor and
 * centralize the delivery/exit/stream classification used by BrokerManager.
 *
 * Extracted out of broker.ts: stateless, no dependency on BrokerManager.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver'
import { isRecord } from './guards'

export function brokerEventString(event: BrokerEvent, key: string): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

export function isDeliveryEventForMessage(
  event: BrokerEvent,
  eventId: string,
  targets: string[],
  allowedKinds: string[] = [
    'delivery_ack',
    'delivery_verified',
    'delivery_failed',
    'message_delivery_confirmed',
    'message_delivery_failed'
  ]
): boolean {
  const kind = brokerEventString(event, 'kind')
  if (!allowedKinds.includes(kind || '')) return false
  if (brokerEventString(event, 'event_id') !== eventId) return false
  const name = brokerEventString(event, 'name')
  return !name || targets.length === 0 || targets.includes(name)
}

export function deliveryFailureMessage(event: BrokerEvent): string {
  if (!isRecord(event)) return 'Broker delivery failed'
  // reason/lastError are not declared on the base BrokerEvent union; read them
  // through the same dynamic accessor used for other optional broker fields.
  const reason = brokerEventString(event, 'reason')
  const lastError = brokerEventString(event, 'lastError')
  return reason || lastError || 'Broker delivery failed'
}

export function isWorkerStreamForAgent(event: BrokerEvent, name: string): boolean {
  return brokerEventString(event, 'kind') === 'worker_stream' && brokerEventString(event, 'name') === name
}

const AGENT_EXIT_EVENT_KINDS = ['agent_exit', 'agent_exited', 'agent_released']

export function isAgentExitEventForAgent(event: BrokerEvent, name: string): boolean {
  return (
    AGENT_EXIT_EVENT_KINDS.includes(brokerEventString(event, 'kind') || '') &&
    brokerEventString(event, 'name') === name
  )
}

export function brokerEventChunk(event: BrokerEvent): string {
  const value = (event as unknown as Record<string, unknown>).chunk
  return typeof value === 'string' ? value : ''
}

export function brokerEventNumber(event: BrokerEvent, key: string): number | undefined {
  const value = (event as unknown as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
