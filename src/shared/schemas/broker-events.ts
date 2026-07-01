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
    provider: z.string().nullish(),
    cli: z.string().nullish(),
    model: z.string().nullish(),
    sessionId: z.string().nullish(),
    parent: z.string().nullish(),
    pid: z.number().nullish(),
    source: z.string().nullish()
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
    code: z.number().nullish(),
    signal: z.string().nullish(),
    reason: z.string().nullish()
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
    thread_id: z.string().nullish(),
    mode: z.string().nullish(),
    injection_mode: z.string().nullish()
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
    reason: z.string().nullish()
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
    delivery_id: z.string().nullish(),
    event_id: z.string(),
    timestamp: z.unknown().optional()
  })
  .passthrough()

const deliveryVerified = z
  .object({
    kind: z.literal('delivery_verified'),
    name: z.string(),
    delivery_id: z.string().nullish(),
    event_id: z.string()
  })
  .passthrough()

const deliveryFailed = z
  .object({
    kind: z.literal('delivery_failed'),
    name: z.string(),
    delivery_id: z.string().nullish(),
    event_id: z.string(),
    reason: z.string()
  })
  .passthrough()

const messageDeliveryConfirmed = z
  .object({
    kind: z.literal('message_delivery_confirmed'),
    name: z.string(),
    delivery_id: z.string().nullish(),
    event_id: z.string(),
    from: z.string(),
    to: z.string()
  })
  .passthrough()

const messageDeliveryFailed = z
  .object({
    kind: z.literal('message_delivery_failed'),
    name: z.string(),
    delivery_id: z.string().nullish(),
    event_id: z.string().nullish(),
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
    delivery_id: z.string().nullish(),
    event_id: z.string()
  })
  .passthrough()

const deliveryAck = z
  .object({
    kind: z.literal('delivery_ack'),
    name: z.string(),
    delivery_id: z.string().nullish(),
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
    provider: z.string().nullish(),
    cli: z.string().nullish(),
    model: z.string().nullish(),
    sessionId: z.string().nullish(),
    pid: z.number().nullish()
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
    since: z.string().nullish()
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
    code: z.number().nullish(),
    signal: z.string().nullish(),
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
 * Sent over the broker's local dashboard WebSocket (the same connection
 * `relay_inbound`/chat events flow over) when a reconnect requested replay
 * from a `sinceSeq` the broker's in-memory replay buffer no longer has —
 * e.g. because a burst of other events (like `worker_stream` chunks)
 * evicted it first. Any event between `requestedSinceSeq` and
 * `oldestAvailable` was silently dropped; the reconciliation flow (see
 * `agent-store.ts` / `use-message-reconciliation.ts`) treats this as a
 * signal to refetch canonical channel/DM history rather than trusting the
 * live event stream for that gap.
 */
const replayGap = z
  .object({
    kind: z.literal('replay_gap'),
    requestedSinceSeq: z.number(),
    oldestAvailable: z.number(),
    seq: z.number()
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
  agentPermanentlyDead,
  replayGap
])

export type ValidatedBrokerEvent = z.infer<typeof BrokerEventSchema>

/** Per-variant inferred types — use with `satisfies` to catch payload drift at compile time. */
export type AgentSpawnedEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_spawned' }>
export type AgentReleasedEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_released' }>
export type AgentExitEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_exit' }>
export type AgentExitedEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_exited' }>
export type AgentContextLowEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_context_low' }>
export type RelayInboundEvent = Extract<ValidatedBrokerEvent, { kind: 'relay_inbound' }>
export type WorkerStreamEvent = Extract<ValidatedBrokerEvent, { kind: 'worker_stream' }>
export type DeliveryRetryEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_retry' }>
export type DeliveryDroppedEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_dropped' }>
export type DeliveryQueuedEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_queued' }>
export type AgentPendingDrainedEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_pending_drained' }>
export type AgentInboundDeliveryModeChangedEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_inbound_delivery_mode_changed' }>
export type DeliveryInjectedEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_injected' }>
export type DeliveryVerifiedEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_verified' }>
export type DeliveryFailedEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_failed' }>
export type MessageDeliveryConfirmedEvent = Extract<ValidatedBrokerEvent, { kind: 'message_delivery_confirmed' }>
export type MessageDeliveryFailedEvent = Extract<ValidatedBrokerEvent, { kind: 'message_delivery_failed' }>
export type DeliveryActiveEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_active' }>
export type DeliveryAckEvent = Extract<ValidatedBrokerEvent, { kind: 'delivery_ack' }>
export type ChannelSubscribedEvent = Extract<ValidatedBrokerEvent, { kind: 'channel_subscribed' }>
export type ChannelUnsubscribedEvent = Extract<ValidatedBrokerEvent, { kind: 'channel_unsubscribed' }>
export type WorkerReadyEvent = Extract<ValidatedBrokerEvent, { kind: 'worker_ready' }>
export type WorkerErrorEvent = Extract<ValidatedBrokerEvent, { kind: 'worker_error' }>
export type RelaycastPublishedEvent = Extract<ValidatedBrokerEvent, { kind: 'relaycast_published' }>
export type RelaycastPublishFailedEvent = Extract<ValidatedBrokerEvent, { kind: 'relaycast_publish_failed' }>
export type AclDeniedEvent = Extract<ValidatedBrokerEvent, { kind: 'acl_denied' }>
export type AgentIdleEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_idle' }>
export type AgentResultEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_result' }>
export type AgentBlockedOnSendEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_blocked_on_send' }>
export type AgentRestartingEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_restarting' }>
export type AgentRestartedEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_restarted' }>
export type AgentPermanentlyDeadEvent = Extract<ValidatedBrokerEvent, { kind: 'agent_permanently_dead' }>
export type ReplayGapEvent = Extract<ValidatedBrokerEvent, { kind: 'replay_gap' }>

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
  if (error.issues.length === 0) return 'invalid event shape'
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')
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
