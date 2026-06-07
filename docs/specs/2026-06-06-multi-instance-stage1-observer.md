# Multi-Instance Stage 1: Read-Only Observer — Design Spec

Issue: #127 (Stage 1 of 3). Prerequisites: #125 (explicit workspace join + named
broker instances — pear side landed `435d78c`, relay/cloud halves in flight),
#126 (remote host support — not started).

Status: DESIGN ONLY. Written 2026-06-06 during the #125 build-out; contract
references below are to the locked #125 naming contract.

## Goal

A second Pear instance (same user, different machine — multi-user comes with
invite scoping later in this stage) can open a project that is "hosted"
elsewhere, see the same agent graph, and watch live terminal output. It cannot
send PTY input, spawn/stop agents, or mutate project settings.

## Non-goals (Stage 1)

- No write path of any kind from the observer (Stage 2).
- No per-user permission levels beyond owner/observer (Stage 3 adds editor).
- No presence avatars/notifications UI beyond a minimal "N instances connected"
  indicator (Stage 3).
- No CRDT/merge for project definitions: single-writer (the host instance),
  observers treat shared state as read-only snapshots.
- No web observer; Electron only.

## Foundations this builds on (all #125 vintage)

| Primitive | Where | Why it matters here |
|---|---|---|
| Explicit workspace join | relay `--workspace-key` / `AGENT_RELAY_WORKSPACE_KEY`, fail-loud on invalid key | Observer joins the project workspace; MUST hard-fail rather than silently create a fresh one (the #125 failure mode) |
| Named broker instances | `--instance-name` / `AGENT_RELAY_BROKER_NAME`; `RuntimeSpawnOptions.workspaceKey?/brokerName?` | Instance identity. Observers are addressable, and ownership checks key off the name |
| Workspace key seam | `brokerManager.workspaceKeyForProject(projectId)` (broker.ts) | The host-side source of truth an invite token wraps |
| Remote attach primitive | `attachCloudSandbox()` connects by `execUrl + apiKey` (broker.ts:1467) | The observer's connection path to the host broker is the same shape (#126 generalizes it) |
| Event dedupe discipline | `slackLogicalInjections` canonical-identity claims (integration-event-bridge.ts) | Fan-out to N instances multiplies the duplicate-delivery surface; reuse logical-identity claims, never per-copy revisions |

## Instance naming

Local broker names are currently `pear-${project.relayWorkspaceId}`
(project-store.ts:58) — project-stable but NOT instance-unique; two instances
on one project collide. This was explicitly deferred out of #125. Stage 1 is
where it lands:

- Name = `pear-<relayWorkspaceId>-<machineSlug>` where machineSlug =
  hostname-derived, 8 chars, persisted in local app config on first run
  (NOT regenerated per session — names must be stable for ownership checks).
- The HOST instance keeps the legacy un-suffixed name working via PEAR
  METADATA, not broker-side aliasing (relay-worker ruling, 2026-06-06): the
  shared project definition publishes both `brokerName` (canonical suffixed)
  and `legacyBrokerName`; consumers resolve through the definition. Broker-side
  aliasing would disturb the just-stabilized strict-name registration
  semantics and is rejected.

## 1. Shared project definitions

Authoritative project definition moves to the relay workspace as a single
relayfile document: `/pear/project.json` (channels, integration scopes, roots,
host assignment, schema version). Rationale for relayfile over a new relay
cloud API: sync, change events, and conflict surface already exist; observers
already need relayfile access for mirrors.

- Host instance: writes `/pear/project.json` on every local mutation
  (debounced). Local `projects.json` stays the cache/bootstrap copy.
- Observer instance: subscribes to `/pear/project.json` change events
  (the same `subscribe()` machinery the integration-event bridge uses); applies
  snapshots read-only; never writes.
- Conflict rule (Stage 1): host wins, always — observers don't write, so the
  only conflict is host vs stale cache, resolved by `revision` compare on open.
- Schema versioned (`schemaVersion: 1`); observer with unknown newer version
  shows "upgrade required" instead of guessing.

## 2. Invite / join flow

Stage 1 keeps tokens same-account (multi-user scoping is the second half of
this stage, gated on relay-side scoped tokens):

```
InviteToken = base64url(JSON{
  v: 1,
  workspaceKey,          // from workspaceKeyForProject(projectId)
  relayWorkspaceId,      // account workspace (cloud API URL construction)
  hostBrokerName,        // addressing + ownership root
  brokerUrl?,            // #126 remote-host URL when available; absent = cloud-relay discovery
  role: 'observer'
})
```

- Generate: host instance, new IPC `workspace.invite(projectId)` → token string
  (UI: copy button in project settings).
- Join: `workspace.join(token)` → validates schema/version → spawns/joins
  observer-side broker session with `workspaceKey` + its own instance name →
  fetches `/pear/project.json` → materializes a read-only project entry in the
  local store (flagged `origin: 'shared'`, `role: 'observer'`).
- Fail-loud inheritance: a bad/expired key surfaces the broker's strict-join
  error verbatim. No fallback to create. The broker distinguishes fatal
  rejection (401/403 — "rejected") from rate-limiting (429 — "rate-limited",
  HTTP status preserved through AuthHttpError): the join UI treats the former
  as a bad invite and the latter as retryable with backoff.
- Token carries no bearer secret beyond the workspace key in Stage 1
  (same-account); the multi-user variant swaps `workspaceKey` for a relay-issued
  scoped token and is EXPLICITLY out of scope until relay exposes one.

## 3. Read-only enforcement

Two layers, because UI-only enforcement is not enforcement:

1. **Pear layer (UX):** project entries with `role: 'observer'` get
   permission-aware guards in the renderer stores — spawn/stop/input/settings
   actions disabled with tooltips. IPC handlers for mutating calls check the
   role flag and reject (`ROLE_OBSERVER_READONLY` error) so a buggy renderer
   can't mutate either.
2. **Broker layer (authority):** per relay-worker (2026-06-06) the right home
   is a readonly capability on the CONNECTION/API layer — a flag in the local
   HTTP/WS connection/session context that rejects mutating REST endpoints and
   delivery/spawn/release/write actions, while the host connection keeps
   normal identity. The lease API is explicitly the wrong layer (leases govern
   broker lifetime, not caller authority). Effort: moderate; scheduled with
   relay, not in Stage 1's critical path. Stage 1 ships with pear-layer
   enforcement only; the trust boundary is then "same account", acceptable for
   same-user Stage 1, NOT for multi-user invites (hard gate: multi-user waits
   for the broker-side capability).

## 4. PTY fan-out

The broker already supports multiple clients; #125 makes both instances land in
one workspace. Stage 1 needs verification + hardening, not new plumbing:

- Test matrix: 2 instances × (local host, remote host) × (agent spawn before /
  after observer join) — observer must receive output chunks for agents
  spawned both before and after it connected. Catch-up contract per
  relay-worker (2026-06-06): current visible-screen PTY snapshot (existing
  snapshot/state machinery) + live stream from join. There is NO durable
  per-observer scrollback contract — historical replay is out of scope and the
  UI labels the point where the observer's view begins.
- Duplicate-event hardening per AGENTS.md guidance: PTY chunks are
  sequence-numbered per (agentName, ptyId); pear-side consumer drops
  already-seen sequence numbers — same canonical-identity discipline as the
  slack dedupe, trivially cheaper (monotonic seq, not content hashes).
- Broker events (`agent_spawned`, `agent_exited`, …) fan out to all instances;
  observer applies them to its read-only graph. Event `instanceName` field
  (from the #125 named-instance work) distinguishes "who did that" for the
  Stage 3 presence layer — carried but unused in Stage 1.

## 5. Minimal presence (Stage 1 slice)

- Each instance publishes `{instanceName, role, joinedAt}` on a relaycast
  channel `#pear-presence-<projectId>` on join, tombstone on clean exit,
  TTL-expired by peers on silence (heartbeat every 60s).
- UI: "2 instances connected" pill on the project header. Nothing else.
- This channel is also Stage 2's coordination root (ownership claims), so the
  message schema gets a `kind` discriminator from day one.

## IPC / type additions

- `workspace.invite(projectId) → string`
- `workspace.join(token) → { projectId }`
- `workspace.onPresenceUpdate(projectId, instances[])`
- Project record: `origin: 'local' | 'shared'`, `role: 'owner' | 'observer'`,
  `hostBrokerName?`, `sharedRevision?`
- Mutating IPC handlers gain the role guard (single helper, applied at the
  handler boundary, not per-store).

## Dependencies / sequencing

```
#125 relay strict-join + named instances   [in flight, T3]
#125 cloud verbatim env injection          [in flight, T4]
#126 remote host (broker URL for observer) [not started — Stage 1 can demo
                                            against a cloud-sandbox host first]
relay: scoped invite tokens                [needed for multi-user only]
relay: broker-side readonly capability     [needed for multi-user; stub OK same-user]
```

Buildable order inside Stage 1: instance-name uniqueness → shared
project.json (host write path, observer read path) → invite/join IPC + UI →
PTY fan-out verification → presence slice. Each lands behind a
`PEAR_MULTI_INSTANCE` flag until the stage is coherent.

## Open questions (for #general before implementation)

1. relay-worker: name alias for the legacy un-suffixed host broker name vs
   pear publishing both names — which is cheaper broker-side?
2. relay-worker: per-connection readonly capability — connection API or
   lease API? Effort estimate decides whether same-user Stage 1 waits for it.
3. cloud-lead: does `/pear/project.json` in the account workspace collide with
   any cloud-side relayfile path conventions/reserved prefixes?
4. PTY backfill: does the broker keep enough scrollback per PTY to replay on
   attach, or is "live from join" the Stage 1 contract?

## Test plan sketch

- Unit: invite token round-trip (incl. version/role rejection), role guard on
  every mutating IPC handler (table-driven), project.json snapshot apply +
  revision conflict.
- Integration: two BrokerManager instances against one broker (the
  broker.test.ts harness already mocks spawn; extend with a second client),
  PTY seq dedupe under interleaved chunks, observer join while agent mid-run.
- Manual/e2e (needs T2-style debug logging): second machine joins via token,
  watches a live agent, kill -9 the host instance → observer survives in
  read-only state with stale-host indicator.
