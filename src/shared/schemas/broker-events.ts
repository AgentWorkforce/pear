import { z } from 'zod'

/**
 * Zod schemas for the broker events the app ingests from
 * `@agent-relay/harness-driver` (`HarnessDriverClient.onEvent`). These mirror
 * the SDK's `BrokerEvent` discriminated union (keyed on `kind`) and are used to
 * validate events ONCE at main-process ingress (see `BrokerManager`).
 *
 * Design notes:
 *
 * - **`kind` is the discriminator.** The SDK union — and every consumer in
 *   `broker.ts` / `agent-store.ts` — switches on `kind`, not `name`.
 *
 * - **Every payload uses `.passthrough()`.** The SDK adds fields between minor
 *   versions, and the duplicate-suppression logic in `broker.ts` reads some
 *   fields dynamically (`seq`, `event_id`, `id`, `chunk`). Stripping unknown
 *   keys would silently break dedupe and drop forward-compatible data, so we
 *   keep everything and only validate the fields the SDK declares.
 *
 * - **Enum-ish fields stay loose `z.string()`** (runtime, provider, delivery
 *   mode). A new enum value shipped in an SDK minor must not cause an otherwise
 *   valid event to be dropped.
 *
 * - **Required fields mirror the SDK contract.** A known event missing a field
 *   the SDK guarantees is genuinely malformed; ingress drops it (throttled
 *   warning). Unknown `kind`s are forwarded unchanged for forward-compat — see
 *   `classifyBrokerEvent`.
 */

const agentSpawned = z
  .object({
    kind: z.literal('agent_spawned'),
    name: z.string(),
    runtime: z.string(),
    provider: z.string().optional(),
    cli: z.string().optional(),
    model: z.string().optional(),
    sessionId: z.string().optional(),
    parent: z.string().optional(),
    pid: z.number().optional(),
    source: z.string().optional()
  })
  .passthrough()

const agentReleased = z
  .object({
    kind: z.literal('agent_released'),
    name: z.string()
  })
  .passthrough()

const agentExit = z
  .object({
    kind: z.literal('agent_exit'),
    name: z.string(),
    reason: z.string()
  })
  .passthrough()

const agentExited = z
  .object({
    kind: z.literal('agent_exited'),
    name: z.string(),
    code: z.number().optional(),
    signal: z.string().optional(),
    reason: z.string().optional()
  })
  .passthrough()

const agentContextLow = z
  .object({
    kind: z.literal('agent_context_low'),
    name: z.string(),
    pct: z.number()
  })
  .passthrough()

const relayInbound = z
  .object({
    kind: z.literal('relay_inbound'),
    event_id: z.string(),
    from: z.string(),
    target: z.string(),
    body: z.string(),
    thread_id: z.string().optional(),
    mode: z.string().optional(),
    injection_mode: z.string().optional()
  })
  .passthrough()

const workerStream = z
  .object({
    kind: z.literal('worker_stream'),
    name: z.string(),
    stream: z.string(),
    chunk: z.string()
  })
  .passthrough()

const deliveryRetry = z
  .object({
    kind: z.literal('delivery_retry'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string(),
    attempts: z.number()
  })
  .passthrough()

const deliveryDropped = z
  .object({
    kind: z.literal('delivery_dropped'),
    name: z.string(),
    count: z.number(),
    reason: z.string()
  })
  .passthrough()

const deliveryQueued = z
  .object({
    kind: z.literal('delivery_queued'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string(),
    timestamp: z.unknown().optional()
  })
  .passthrough()

const agentPendingDrained = z
  .object({
    kind: z.literal('agent_pending_drained'),
    name: z.string(),
    count: z.number(),
    reason: z.string().optional()
  })
  .passthrough()

const agentInboundDeliveryModeChanged = z
  .object({
    kind: z.literal('agent_inbound_delivery_mode_changed'),
    name: z.string(),
    previous_mode: z.string(),
    mode: z.string()
  })
  .passthrough()

const deliveryInjected = z
  .object({
    kind: z.literal('delivery_injected'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string(),
    timestamp: z.unknown().optional()
  })
  .passthrough()

const deliveryVerified = z
  .object({
    kind: z.literal('delivery_verified'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string()
  })
  .passthrough()

const deliveryFailed = z
  .object({
    kind: z.literal('delivery_failed'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string(),
    reason: z.string()
  })
  .passthrough()

const messageDeliveryConfirmed = z
  .object({
    kind: z.literal('message_delivery_confirmed'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string(),
    from: z.string(),
    to: z.string()
  })
  .passthrough()

const messageDeliveryFailed = z
  .object({
    kind: z.literal('message_delivery_failed'),
    name: z.string(),
    delivery_id: z.string().optional(),
    event_id: z.string().optional(),
    from: z.string(),
    to: z.string(),
    attempts: z.number(),
    lastError: z.string()
  })
  .passthrough()

const deliveryActive = z
  .object({
    kind: z.literal('delivery_active'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string()
  })
  .passthrough()

const deliveryAck = z
  .object({
    kind: z.literal('delivery_ack'),
    name: z.string(),
    delivery_id: z.string(),
    event_id: z.string()
  })
  .passthrough()

const channelSubscribed = z
  .object({
    kind: z.literal('channel_subscribed'),
    name: z.string(),
    channels: z.array(z.string())
  })
  .passthrough()

const channelUnsubscribed = z
  .object({
    kind: z.literal('channel_unsubscribed'),
    name: z.string(),
    channels: z.array(z.string())
  })
  .passthrough()

const workerReady = z
  .object({
    kind: z.literal('worker_ready'),
    name: z.string(),
    runtime: z.string(),
    provider: z.string().optional(),
    cli: z.string().optional(),
    model: z.string().optional(),
    sessionId: z.string().optional(),
    pid: z.number().optional()
  })
  .passthrough()

const workerError = z
  .object({
    kind: z.literal('worker_error'),
    name: z.string(),
    code: z.string(),
    message: z.string()
  })
  .passthrough()

const relaycastPublished = z
  .object({
    kind: z.literal('relaycast_published'),
    event_id: z.string(),
    to: z.string(),
    target_type: z.string()
  })
  .passthrough()

const relaycastPublishFailed = z
  .object({
    kind: z.literal('relaycast_publish_failed'),
    event_id: z.string(),
    to: z.string(),
    reason: z.string()
  })
  .passthrough()

const aclDenied = z
  .object({
    kind: z.literal('acl_denied'),
    name: z.string(),
    sender: z.string(),
    owner_chain: z.array(z.string())
  })
  .passthrough()

const agentIdle = z
  .object({
    kind: z.literal('agent_idle'),
    name: z.string(),
    idle_secs: z.number(),
    since: z.string().optional()
  })
  .passthrough()

const agentResult = z
  .object({
    kind: z.literal('agent_result'),
    name: z.string(),
    result_id: z.string(),
    data: z.unknown(),
    final: z.boolean(),
    metadata: z.unknown().optional()
  })
  .passthrough()

const agentBlockedOnSend = z
  .object({
    kind: z.literal('agent_blocked_on_send'),
    name: z.string(),
    blocked_secs: z.number(),
    pending_delivery_count: z.number()
  })
  .passthrough()

const agentRestarting = z
  .object({
    kind: z.literal('agent_restarting'),
    name: z.string(),
    code: z.number().optional(),
    signal: z.string().optional(),
    restart_count: z.number(),
    delay_ms: z.number()
  })
  .passthrough()

const agentRestarted = z
  .object({
    kind: z.literal('agent_restarted'),
    name: z.string(),
    restart_count: z.number()
  })
  .passthrough()

const agentPermanentlyDead = z
  .object({
    kind: z.literal('agent_permanently_dead'),
    name: z.string(),
    reason: z.string()
  })
  .passthrough()

/**
 * Discriminated union of every broker event `kind` the SDK emits and the app
 * forwards. Membership defines the "known" set — see `classifyBrokerEvent`.
 */
export const BrokerEventSchema = z.discriminatedUnion('kind', [
  agentSpawned,
  agentReleased,
  agentExit,
  agentExited,
  agentContextLow,
  relayInbound,
  workerStream,
  deliveryRetry,
  deliveryDropped,
  deliveryQueued,
  agentPendingDrained,
  agentInboundDeliveryModeChanged,
  deliveryInjected,
  deliveryVerified,
  deliveryFailed,
  messageDeliveryConfirmed,
  messageDeliveryFailed,
  deliveryActive,
  deliveryAck,
  channelSubscribed,
  channelUnsubscribed,
  workerReady,
  workerError,
  relaycastPublished,
  relaycastPublishFailed,
  aclDenied,
  agentIdle,
  agentResult,
  agentBlockedOnSend,
  agentRestarting,
  agentRestarted,
  agentPermanentlyDead
])

export type ValidatedBrokerEvent = z.infer<typeof BrokerEventSchema>

/**
 * The shape every forwarded broker event satisfies: an object carrying a
 * string `kind`. Both validated and (kind-only-validated) unknown events are
 * assignable to this, so the main-process ingress can forward them without any
 * `as unknown as` casts.
 */
export type BrokerEventPayload = Record<string, unknown> & { kind: string }

/** The set of event `kind`s the schema recognizes. */
export const KNOWN_BROKER_EVENT_KINDS: ReadonlySet<string> = new Set(
  BrokerEventSchema.options.map((option) => option.shape.kind.value)
)

export type BrokerEventClassification =
  /** A recognized `kind` whose payload matched the schema. */
  | { status: 'valid'; kind: string; event: ValidatedBrokerEvent }
  /** A `kind` the schema doesn't know — forward unchanged (forward-compat). */
  | { status: 'unknown'; kind: string; event: BrokerEventPayload }
  /** A recognized `kind` (or no usable `kind`) whose payload failed validation. */
  | { status: 'malformed'; kind?: string; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid event shape'
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * Classify a raw broker event at ingress:
 * - no usable `kind`            → `malformed`
 * - unknown `kind`              → `unknown` (caller forwards it unchanged)
 * - known `kind`, payload OK    → `valid`
 * - known `kind`, payload bad   → `malformed` (caller drops it)
 */
export function classifyBrokerEvent(raw: unknown): BrokerEventClassification {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !raw.kind) {
    return { status: 'malformed', reason: 'missing event kind' }
  }
  const kind = raw.kind
  if (!KNOWN_BROKER_EVENT_KINDS.has(kind)) {
    return { status: 'unknown', kind, event: raw as BrokerEventPayload }
  }
  const parsed = BrokerEventSchema.safeParse(raw)
  if (parsed.success) {
    return { status: 'valid', kind, event: parsed.data }
  }
  return { status: 'malformed', kind, reason: describeIssue(parsed.error) }
}
