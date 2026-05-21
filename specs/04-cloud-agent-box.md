# Spec 04 — Cloud Agent Box (attach / warm) backend

> Remediation + completion spec. Spec [[01-cloud-agents]] declared the
> `POST /api/v1/workspaces/{workspaceId}/cloud-agents/{cloudAgentId}/box`
> endpoint as a one-line cross-repo row, but it was **never built** in `../cloud`.
> The pear-side client for it *is* built and shipping (untracked `src/main/cloud-agent.ts`),
> so attaching a cloud agent fails at runtime with `Failed to warm cloud agent box: Not Found`.
> This spec builds the missing `../cloud` box endpoints to the exact contract pear already calls.

## Problem

A "cloud agent" in pear **is a provider credential** — a configured model
provider (Anthropic, OpenAI, …) on the user's Agent Relay workspace. This was
settled with Khaliq on 2026-05-21: *"the list is correct, if credentials are
present then those agents are available."* The cloud's `GET /api/v1/cloud-agents`
returns rows from the `provider_credentials` table, and `DELETE
/api/v1/cloud-agents/{id}` (fixed 2026-05-21) deletes that row.

What is **missing** is the ability to *use* one. When the user selects a cloud
agent and clicks "Attach to project", pear's `CloudAgentManager.attach()` calls
`warmBox()` →

```
POST /api/v1/workspaces/{workspaceId}/cloud-agents/{cloudAgentId}/box
```

There is no such route in `../cloud`. The closest existing route,
`POST /api/v1/workspaces/{workspaceId}/sandboxes`, is **persona/workforce-specific**
(it requires `purpose: "workforce-deploy"` + a server-side `personaId` JSON file)
and — by design — mints the relayfile token *into the sandbox env and never returns
it to the caller*. Pear needs the opposite: a box keyed by a **provider credential**
that **returns** a path-scoped relayfile token so the desktop app can mount the
project locally and run the agent's tool calls inside the synced sandbox.

So this spec adds the box endpoints and reuses the existing Daytona provisioning
machinery, returning the contract pear already consumes.

## What pear already calls (the contract is fixed by the client)

All four verbs hit the same path. Pear's code is the source of truth — do not
change pear's request/response shape; implement the server to match it.

| Verb | Pear method | Purpose | Body |
|------|-------------|---------|------|
| `POST` | `warmBox()` → `fetchBox(url,'POST')` (`cloud-agent.ts:600-655`) | Warm or create the sticky sandbox for this cloud agent; return the box | none |
| `GET` | `warmBox()` poll loop → `fetchBox(url,'GET')` | Poll status until `ready` (every 2s, 60s timeout) | none |
| `PATCH` | `updateMountPaths()` (`cloud-agent.ts:445-462`) | Re-scope the relayfile mount paths for an attached box | `{ relayfileMountPaths: string[] }` |
| `DELETE` | `deleteBox()` (`cloud-agent.ts:664-692`) | Mark box for stop-after-idle (does NOT delete the cloud agent identity). Pear treats `404` as success. | none |

### Required response shape (POST / GET / PATCH)

Pear's `normalizeSandbox()` (`cloud-agent.ts:112-133`) **throws "incomplete box
response" unless all four of these resolve**:

```jsonc
{
  // sandboxId  — accepted as `sandboxId` OR `id`
  "sandboxId": "sbx_…",
  // execUrl    — accepted as `execUrl` OR `httpUrl` OR `baseUrl` OR `url`
  "execUrl": "https://….daytona…/",
  // relayfileToken — REQUIRED, no alias. This is the new behavior vs the workforce route.
  "relayfileToken": "rft_…",
  // relayfileMountPath — accepted as `relayfileMountPath` OR `mountPath`
  "relayfileMountPath": "/workspace",
  // status — one of: warming | ready | stopping | stopped (default "warming" if omitted)
  "status": "ready",
  // optional, surfaced by pear but not required:
  "filesUrl": "https://…/files",
  "apiKey": "…"            // used by AgentRelayClient.connect against the sandbox
}
```

Status mapping the server must honor: while the Daytona box is being created /
resumed → `"warming"`; once the box is reachable and the token is minted →
`"ready"`. Pear polls `GET` on a 2s interval and gives up after 60s
(`WARM_POLL_MS` / `WARM_TIMEOUT_MS`), so a cold create must reach `ready` inside
that window or return `warming` repeatedly and let pear keep polling.

## Design decisions

Read before implementing.

- **Cloud agent = provider credential.** The `{cloudAgentId}` path segment is a
  `provider_credentials.id` (a UUID). The box endpoint must (a) verify that
  credential exists and is owned by the requesting user+workspace, and (b)
  configure the sandbox to run with that credential's `harness` + `defaultModel`
  / `modelProvider`. A box for a credential whose `status` is not usable (e.g.
  `lastError` set, or credential expired) returns `409 { error, code:
  "credential_unavailable" }`.

- **Sticky sandbox, one per (workspace, cloud agent).** Reuse the
  spec-01 model: a cloud agent's box is **one Daytona sandbox at a time,
  reusable across pear sessions**, suspended by `autoStopInterval` after
  inactivity and resumed on demand. On `POST`, look up an existing `sandboxes`
  row where `workspaceId = ?` AND `cloudAgentId = ?` AND `status IN
  ('running','warming')`; resume it if suspended, otherwise create a new one and
  tag it with `cloudAgentId`. Take a **row-level lock** while warming so two pear
  instances opening the same project serialize onto the same box.

- **The URL `{workspaceId}` is the real account workspace (from Spec 05).**
  Historically pear sent a `crypto.randomUUID()` `relayWorkspaceId`. Spec
  [[05-integrations-connect]]'s `RelayWorkspaceManager` replaces that with the
  account's real relayfile workspace id, which pear now sends. So the box route
  uses the standard `requireWorkspaceSandboxAuth(request, context)` against the
  URL `{workspaceId}` — no special-casing. As defense in depth it also confirms
  `auth.workspaceId` owns the credential (provider credentials are scoped by
  `auth.workspaceId`). **Ordering:** land Spec 05's `RelayWorkspaceManager` before
  or with this spec so the id pear sends is real.

- **The relayfile token IS returned to the desktop client — on purpose.** Unlike
  the workforce-deploy sandbox (which keeps the token server-side in the sandbox
  env), the pear desktop app is the trusted mount client: it runs
  `@relayfile/sdk` locally against the project directory using this token. Mint a
  **path-scoped** token via `mintPathScopedRelayfileToken` (`../cloud/packages/core/src/relayfile/client.ts:237`)
  scoped to the requested `relayfileMountPaths` (default `["/workspace"]`), TTL =
  the sandbox `autoStopInterval`. Never mint an unscoped/workspace-wide token here.

- **DELETE never destroys the cloud agent.** `DELETE …/box` only marks the
  Daytona sandbox for stop-after-idle (or stops it) and sets the `sandboxes` row
  `status='stopping'`. The `provider_credentials` row is untouched. Deleting the
  cloud agent itself is the separate, already-shipped `DELETE /cloud-agents/{id}`.

## Implementation surface (`../cloud`)

### New files

| File | Purpose |
|------|---------|
| `packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/route.ts` | The box endpoint. Exports `POST`, `GET`, `PATCH`, `DELETE`. Resolves workspace from auth; loads + validates the provider credential; reuses/creates the sticky Daytona sandbox; mints and returns the path-scoped relayfile token; maps Daytona state → `warming`/`ready`/`stopping`/`stopped`. |
| `packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager.ts` | Pure-ish helper: `warmCloudAgentBox(deps, { auth, cloudAgentId, mountPaths })`, `readCloudAgentBox(...)`, `stopCloudAgentBox(...)`. Keep DB + Daytona + token-mint orchestration here so the route stays thin and testable (mirror the DI style of `cloud-agents/[agentId]/route.ts`). |
| `packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager.test.ts` | Unit tests for the manager with injected fakes (no live Daytona/DB). |

### Files to edit

| File | Change |
|------|--------|
| `packages/core/src/db/schema.ts` | Add nullable `cloudAgentId: uuidColumn("cloud_agent_id")` to the `sandboxes` table, plus index `idx_sandboxes_workspace_cloud_agent` on `(workspaceId, cloudAgentId, status)`. (This was promised in spec 01 gate 10 but only lands here.) |
| `packages/core/drizzle/` | New generated migration adding `cloud_agent_id` + index. Run the repo's drizzle generate script; commit the SQL. |
| `packages/web/app/api/v1/workspaces/[workspaceId]/sandboxes/sandbox-utils.ts` | Export the Daytona create/resume helpers and `requireWorkspaceSandboxAuth` internals needed by `box-manager.ts` so the box route reuses the exact provisioning + rollback path rather than copying it. If a function is currently file-private, widen it minimally. |

### Provisioning reuse

Reuse, do not fork, the Daytona path in
`workspaces/[workspaceId]/sandboxes/route.ts:316-367`:
`createDaytonaClient()` → `client.create({ language: "typescript", envVars,
autoStopInterval, labels })` → insert `sandboxes` row →
`recordWorkforceSandboxCreated(...)` (add a parallel `recordCloudAgentBoxWarmed`
audit event). Use the **same `language: "typescript"` image** as the
workforce-deploy sandbox — there is one runtime; the harness selects behavior via
env, not a different image. Differences for the box route:

- `labels`/`source`: tag `source: "cloud-agent"`, `labels.cloudAgentId`, and set
  the new `sandboxes.cloudAgentId` column.
- **Model-provider auth (resolved):** inject the provider credential's API key
  via `resolveProviderCredentialRuntimeEnv(credential)` from
  `@/lib/billing/provider-credential-runtime` — it returns the correct env var
  for the credential's `modelProvider` (`anthropic→ANTHROPIC_API_KEY`,
  `openai→OPENAI_API_KEY`, `google→GOOGLE_API_KEY`, `openrouter→OPENROUTER_API_KEY`;
  see `PROVIDER_API_KEY_ENV` in that file). Merge its result into `envVars`. This
  is the same mechanism the proactive-runtime deploy uses, so byok/managed
  credentials both work.
- Other env: `RELAY_AGENT_HARNESS = credential.harness`,
  `RELAY_DEFAULT_MODEL = credential.defaultModel`,
  `RELAY_AGENT_NAME = credential.displayName`,
  `RELAYFILE_TOKEN` (the minted token, also returned in the body),
  `RELAYFILE_MOUNT_PATHS = JSON.stringify(mountPaths)`.
- **Broker `apiKey` (resolved):** after the sandbox is ready, read its broker
  connection info from the existing `/api/v1/sandboxes/{sandboxId}/terminal`
  helper (the same one `pear/src/main/broker.ts:576-582` consumes — returns
  `{ httpUrl, apiKey }`). Return that `apiKey` (and `httpUrl` as `execUrl`) in the
  box body so `AgentRelayClient.connect` can authenticate.
- Return body per the contract above (include `relayfileToken`, `execUrl`, `apiKey`).

### `PATCH` (re-scope mount paths)

Validate `{ relayfileMountPaths: string[] }`, re-mint a path-scoped token for the
new paths, update the sandbox env / mount config, and return the same box shape
with the fresh token. If the box is not currently warm, `409 { code:
"box_not_running" }` so pear can re-`POST` first.

## Cross-repo footprint

| Repo | Touched | Why |
|------|---------|-----|
| `../cloud` | ✓ | The box route, box-manager, schema + migration, sandbox-utils export. |
| `pear/` | (verify only) | No code change — the client is already built. Spec 04's pear acceptance is purely runtime verification that attach succeeds. If `normalizeSandbox` rejects a field, fix the **server** to match, not pear. |
| `../relayfile` | ✗ | No change. `mintPathScopedRelayfileToken` already accepts a `paths` array and scopes the token to it (`../cloud/packages/core/src/relayfile/client.ts:237` → relayauth `/v1/tokens/path`). |

### Workflow (mandatory)

Implement in a **git worktree**, not the primary checkout, and finish with a PR:

```bash
# in ../cloud
git worktree add ../cloud.wt-cloud-agent-box -b ricky/wave-pear-cloud-agents/04-cloud-agent-box
```

All work for this spec happens in that worktree on branch
`ricky/wave-pear-cloud-agents/04-cloud-agent-box`. **End with one PR** from that
branch on `../cloud` (the only repo this spec changes), quoting the acceptance-gate
results. Remove the worktree (`git worktree remove`) once the PR is open. The spec
is not done until the PR exists. See the wave README "Workflow" section.

## Acceptance

Deterministic gates ricky must pass before reporting done:

1. **Route exists with all four verbs.** The file
   `../cloud/packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/route.ts`
   exists and `grep -E "export (async function|const).*(POST|GET|PATCH|DELETE)"`
   shows all of `POST`, `GET`, `PATCH`, `DELETE`.
2. **Schema column + migration.** `grep "cloud_agent_id" ../cloud/packages/core/src/db/schema.ts`
   returns ≥1 match, and a new migration file under `../cloud/packages/core/drizzle/`
   contains `cloud_agent_id`.
3. **Token is minted path-scoped and returned.** `grep -n "mintPathScopedRelayfileToken"`
   in the box route/manager returns ≥1 match, and the POST/GET JSON response
   includes a `relayfileToken` field (assert in the manager unit test).
4. **Workspace authorized via `requireWorkspaceSandboxAuth`.** The route calls
   `requireWorkspaceSandboxAuth(request, context)` on the URL `{workspaceId}`
   (the real account workspace from Spec 05) and additionally confirms
   `auth.workspaceId` owns the credential; a test with a credential the caller
   doesn't own returns `404`.
5. **Credential validation.** A POST for a `{cloudAgentId}` that is not a
   `provider_credentials` row owned by the caller returns `404`; a credential in
   an unusable state returns `409 credential_unavailable` (unit tests).
6. **Sticky reuse.** Two sequential POSTs for the same `(workspace, cloudAgentId)`
   return the **same** `sandboxId` when the first box is still running (unit test
   with a fake Daytona client + in-memory sandboxes table).
7. **DELETE is idempotent + non-destructive.** DELETE on a running box sets the
   `sandboxes` row to `stopping` and leaves the `provider_credentials` row intact;
   DELETE on an absent box returns `404` (which pear treats as success). Unit tests.
8. **Cloud build/typecheck clean.** The `../cloud` web package builds /
   typechecks with no new errors, and `box-manager.test.ts` passes.

## Manual verification (end-to-end, in pear)

Run `npm run dev` in `pear/` against a `../cloud` deploy that includes this spec.

1. **Cold attach.** Sign in. In a project, "Add agent" → "Cloud agent" → pick an
   agent backed by a real provider credential (e.g. Anthropic) → "Attach to
   project". Pear shows "Warming sandbox…" → "Ready" within 60s (no
   `Failed to warm cloud agent box` error).
2. **Mount appears.** Within ~5s of "Ready", `.relay/` state files appear in the
   project's local working tree (relayfile mounted with the returned token).
3. **Round-trip.** Send "create HELLO.md containing 'hi'" in chat. Within one
   reconcile cycle, `HELLO.md` appears locally with "hi" (tool call ran in the
   sandbox, synced back).
4. **Re-scope.** Connect an integration that adds a mount path (Spec 02 flow), or
   call `updateMountPaths`; verify the PATCH returns a fresh token and the new
   path mounts.
5. **Restart resilience.** Quit + relaunch pear. The project re-attaches silently;
   the box endpoint resumes the *same* sandbox (same `sandboxId` in
   `<BrokerDetailsPage>`) within 60s.
6. **Detach.** "Detach cloud agent" → the local mount stops, the box DELETE marks
   the sandbox stopping, and the cloud agent still appears in the picker
   (credential not deleted).
7. **Delete still works.** From the picker, delete the cloud agent → it disappears
   (provider credential removed via `DELETE /cloud-agents/{id}`), independent of any box.

## Out of scope

- **Real workspace-id provisioning** — owned by Spec [[05-integrations-connect]]
  (`RelayWorkspaceManager`), which this spec depends on. Not re-solved here.
- **Multiple concurrent boxes per cloud agent.** One sticky box per
  `(workspace, cloudAgent)`; multi-box is a v2 concern.
- **Provider-credential connect flow inside pear.** Still `agent-relay cloud
  connect <provider>` in a terminal (per spec-01 non-goals). This spec assumes the
  credential already exists.
- **Billing/cost observability per box.** Deferred.

## Notes for ricky

- The pear client contract is **frozen** — read `pear/src/main/cloud-agent.ts`
  (`warmBox`, `fetchBox`, `normalizeSandbox`, `updateMountPaths`, `deleteBox`) and
  implement the server to satisfy `normalizeSandbox` exactly. If you think pear is
  wrong, stop and surface it rather than diverging the contract.
- Reuse the Daytona provisioning + rollback in the existing `sandboxes/route.ts`;
  do not copy-paste a second Daytona client lifecycle.
- `mintPathScopedRelayfileToken` needs a `workspaceToken` (the caller's bearer
  token), `relayAuthUrl` (`WEB_RELAYAUTH_URL` ?? `RELAYAUTH_URL` ?? default), and
  non-empty `paths`. See `sandboxes/route.ts:284-308` for the established call site.
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` on commits.
- Depends conceptually on [[01-cloud-agents]] (the manager + picker) and pairs with
  [[02-integrations]] (which calls `PATCH …/box` to add integration mount paths).
