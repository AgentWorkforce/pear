# Integration Event Re-Drive After Lost Steers

Issue: #147. Base: #145 (`split/132-slack-integration-event-context-retry`).
Status: DESIGN ONLY. Do not implement or merge until #145 has landed. The
broker delivery-signal contract was pinned by relay-worker and project-lead on
2026-06-07.

## Problem

The integration-event bridge currently treats broker send acceptance as delivery.
For Slack logical dedupe, `claimSlackLogicalInjection()` records the
logical/content-hash claim before a steer is known to have reached the target
agent. For non-Slack paths, `wasRecentlyInjected()` does the same with the path
dedupe key.

That is safe for duplicate suppression only when the broker send reliably reaches
the agent. The confirmed failure mode from 2026-06-07 is different:

- Relayfile emits the same Slack record several times.
- The first delivery logs `injecting` for `slack-comms`, so the bridge claims the
  logical key.
- The steer is lost after broker acceptance and never appears in the agent
  conversation.
- Later re-deliveries are suppressed for the one-hour Slack replay TTL because
  the content hash is unchanged.

#145 fixes the separate "content unavailable" path, but it cannot fix a lost
first steer with unchanged content. The bridge needs delivery confirmation and a
bounded re-drive window.

## Goals

- Make dedupe claims provisional until delivery is confirmed.
- Commit a provisional claim only after the broker/harness-driver reports that
  the steer reached the intended recipient.
- Release a provisional claim on explicit delivery failure or confirmation
  timeout, so a duplicate/replayed event can re-drive the same message.
- Preserve current pacing: event dispatch must not block the project send queue
  while waiting for delivery confirmation.
- Keep duplicate hardening by stable event identity first, Slack logical key and
  content hash second.
- Make telemetry low-noise: count released provisional claims and confirmation
  timeouts without logging every duplicate.

## Non-Goals

- No durable mailbox design in this PR. That belongs to relay#1056.
- No delivery retry loop inside Pear beyond releasing the dedupe claim. Relayfile
  replay, stream reconnect, or event-feed polling provides the re-drive input.
- No merge before Khaliq's explicit go. This design stacks on #145 and should
  become a follow-up PR after #145 lands.
- No implementation until relay-worker confirms `delivery_injected` coverage for
  every agent transport the integration bridge can target.

## Broker Delivery Contract

Pear already has a related confirmation helper,
`BrokerManager.sendMessageAndWaitForDelivery(projectId, input, { timeoutMs })`.
That helper:

- sends through the broker;
- captures the returned `event_id` and targets;
- subscribes to `session.client.onEvent(...)`;
- resolves on `delivery_ack`, `delivery_verified`, or
  `message_delivery_confirmed` for that event and target;
- rejects on `delivery_failed`, `message_delivery_failed`, or its own timeout.

Project-lead ruled that #147 must NOT commit on that helper's current success
condition. `delivery_ack` and `delivery_verified` can be satisfied by an echo
timeout fallback, which is too weak for this bug: it could commit the dedupe
claim even if the steer never crossed the lost hop.

Commit signal for #147: `delivery_injected`, filtered by returned
`event_id` and target. That event is emitted by the PTY worker after it writes
the injection bytes and carriage return to the PTY. It is the correct boundary
for mode-B loss: "accepted by broker" is too early, and "read by model" is out
of scope.

Relay-worker owns the BrokerManager helper extension. The bridge should depend
on a sibling helper, not hand-subscribe to broker events:

```ts
sendMessageAndWaitForInjected(
  projectId: string,
  input: SendMessageInput,
  options?: { timeoutMs?: number }
): Promise<{ eventId: string; targets: string[] }>
```

Semantics:

- Internals share/refactor the existing send-plus-event-wait logic from
  `sendMessageAndWaitForDelivery`.
- Success is only `delivery_injected` matching the returned `event_id` and
  target `name`.
- `delivery_ack`, `delivery_verified`, and `message_delivery_confirmed` are not
  success for this helper. If they arrive without `delivery_injected`, the
  helper keeps waiting until `delivery_injected` or timeout.
- Failure stays `delivery_failed` / `message_delivery_failed`, or helper
  timeout.
- Target handling matches the existing helper: use returned `targets` when
  present; for direct agent sends with no targets, fall back to `[input.to]`.
- Unsupported brokers may return no `eventId` or no targets; the bridge treats
  those as accepted-only and commits immediately, preserving current behavior.

The helper may internally reuse the current `sendMessageAndWaitForDelivery`
mechanics: send once, capture `event_id` / targets, subscribe internally, filter
events in BrokerManager. It must differ by resolving only on
`delivery_injected`.

Calling this helper from the existing project pacer and awaiting it would
reintroduce the old head-of-line block. The bridge must start the helper as a
background confirmation task, attach `.then(commit).catch(release)`, and return
from the pacer callback immediately after starting the send attempt. The pacer
rate-limits starts, not confirmation completion.

Coverage result: relay-worker confirmed `delivery_injected` is emitted for the
agent transports the integration bridge can inject to. Local PTY workers emit it
after writing the injection bytes and carriage return. Headless/app-server
runtimes emit it on successful handler delivery before ack/failure.
Cloud-attached sandboxes use the same harness-driver event stream through
`attachCloudSandbox`, so direct sends to cloud-owned agents use the same
delivery signal once the agent has been observed/listed.

Timing result: for current integration-event `mode: 'steer'`, `delivery_injected`
is not gated on the model becoming idle. PTY steer sends ESC ESC, waits briefly,
writes the injection and CR, then emits `delivery_injected`. It can still wait
behind the worker's local pending-injection queue or a wedged PTY write, but it
does not wait for a long model turn to complete.

Channel caveat: the bridge can target channels as well as direct agents. Broker
channel sends fan out to concrete workers that use the same delivery machinery,
but today's `/api/send` response does not include the resolved worker names.
Existing wait helpers therefore see `targets=[]` for `#channel` sends and return
immediately. For #147, that must NOT count as committed delivery. The
implementation must either resolve concrete channel recipients before
waiting/committing, or explicitly leave channel-target commit/re-drive as a
residual and avoid committing on `targets=[]` for channel sends. The long-term
fix is for the broker send response to include resolved targets.

File ownership for implementation:

- pear-worker owns the additive BrokerManager helper and the bridge state
  machine.
- relay-worker owns BrokerManager helper tests.
- Keep broker.ts changes strictly additive: new helper, new predicate, and
  shared/refactored wait logic only. A shared wait refactor is allowed, but it
  must preserve `sendMessageAndWaitForDelivery()` behavior exactly and keep that
  method's existing tests green. Do not touch the #146 workspace-key/cloud
  regions.

## Bridge State Model

Replace optimistic one-shot claims with a small state machine shared by generic
path dedupe and Slack logical/content-hash dedupe.

```ts
type DeliveryClaimStatus = 'provisional' | 'committed'

type DeliveryClaim = {
  status: DeliveryClaimStatus
  expiresAt: number
  confirmationDeadline: number
  recipients: Map<string, 'pending' | 'confirmed' | 'failed'>
  contentHash?: string
  eventIds: Set<string>
}
```

For Slack logical keys, the entry is still keyed by logical Slack identity. A
content-hash bucket carries one claim:

```ts
type SlackLogicalInjectionState = {
  expiresAt: number
  blindClaim?: DeliveryClaim
  contentHashes: Map<string, DeliveryClaim>
}
```

Behavior:

- A committed matching content hash suppresses duplicates until TTL expiry.
- A provisional matching content hash suppresses only concurrent in-flight alias
  copies while confirmation is still pending.
- When confirmation times out or fails, the provisional claim is removed. A later
  replay of the same logical key/content hash can inject again.
- A blind claim can still learn the first later content hash as in #145, but that
  hash stays provisional until delivery is confirmed.
- Genuine edits with new content hashes continue to inject independently.

For non-Slack integration events, the existing recent-injection map becomes the
same provisional/committed state keyed by `eventDedupeKeyWithFingerprint()`.

## Delivery Flow

1. Build the dedupe key and resolve recipients as today.
2. If an equivalent committed claim exists, drop as duplicate.
3. If an equivalent provisional claim exists, drop as duplicate only while its
   confirmation window is still open.
4. Create or update a provisional claim before sending, scoped to the event key,
   content hash, and intended recipients.
5. Enqueue each broker send through the existing project pacer. The pacer starts
   the `sendMessageAndWaitForInjected()` task and does not await its
   confirmation.
6. For each started send, attach background handlers:
   - On `delivery_injected`: mark that recipient confirmed.
   - When all recipients are confirmed: commit the claim and extend `expiresAt`
     to the normal replay TTL.
   - On failure or timeout: mark failed and release the provisional claim if no
     recipient confirmed.
7. If every recipient fails synchronously before send acceptance, release the
   claim immediately as today.
8. If some recipients confirm and some fail, commit for confirmed recipients and
   log/telemetry the partial failure. A later replay should target only missing
   recipients if recipient-scoped tracking is implemented in the same pass;
   otherwise release the whole claim to prefer duplicate delivery over message
   loss.

The first implementation should prefer whole-claim release on partial failure.
It may duplicate a message for a recipient that already got it, but it avoids the
known worse behavior of losing human instructions.

## Timeout And Telemetry

Default injection-confirmation timeout: 5 seconds for direct `mode: 'steer'`
agent sends.

Rationale: relay-worker confirmed `delivery_injected` fires after the PTY worker
writes bytes, not after the model reads or completes a turn. Five seconds is
therefore intentionally generous for healthy agents while keeping the
provisional claim window short enough that replay can recover promptly and
concurrent duplicate suppression does not linger.

Add aggregate counters/logs:

- `deliveryClaimsProvisional`
- `deliveryClaimsCommitted`
- `deliveryClaimsReleased`
- `deliveryInjectedTimeouts`
- `deliveryInjectedUnsupported`

Use the existing aggregated warning cadence for failures and include only
projectId, provider, logical key prefix, recipient count, and reason. Do not log
message content.

## Test Plan

Add integration-event bridge tests on top of the existing #145 suite:

- Slack unchanged-content replay re-drives after first accepted steer never
  emits `delivery_injected`.
- Slack unchanged-content replay is suppressed after `delivery_injected`
  commits the content hash.
- Slack alias copies during an open provisional window are suppressed, but a
  later replay after timeout is delivered.
- Generic non-Slack event dedupe releases after delivery timeout and re-drives.
- No-recipient and synchronous send-failure paths still release immediately.
- Project broker pacing does not wait on delivery confirmation; the existing
  "does not wait on delivery confirmation path" test should become "does not
  wait while tracking injection confirmation".
- Missing `sendMessageAndWaitForInjected` in tests/mocks is treated as a hard
  harness gap after #147 lands; do not silently fall back to
  `sendMessageAndWaitForDelivery`.
- Unsupported injection confirmation commits accepted sends immediately and
  emits low-noise telemetry.

Add broker tests for relay-worker's helper extension:

- send acceptance returns before `delivery_injected`;
- confirmation resolves on `delivery_injected` for the matching event id and
  target;
- confirmation rejects on delivery failure;
- confirmation rejects on timeout;
- `delivery_ack` / `delivery_verified` without `delivery_injected` do not
  commit the helper;
- multi-target sends wait for all reported targets.

## Rollout

1. Land #145 and restart Pear on it to restore reliable content reads.
2. Direct-agent implementation can use `delivery_injected` with a 5-second
   timeout. Channel targets must either resolve concrete recipients before
   commit or remain explicitly residual without committing on `targets=[]`.
3. pear-worker adds the additive BrokerManager helper and bridge state machine;
   relay-worker adds helper tests.
4. Implement #147 as a follow-up stacked from #145/main using that helper as the
   confirmation source.
5. Keep slack-comms' debug-log/OOB drop guard enabled until #147 is merged and
   the running app is restarted on it.

Residual risk: if the PTY accepts bytes but the agent process is wedged and
never semantically processes them, `delivery_injected` still commits. That is an
agent-liveness/read-receipt problem and belongs to the fuller relay#1056 read
ack path, not #147.
