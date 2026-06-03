# Spec 05 — Integrations Connect via the Relayfile SDK (Nango)

> Remediation + completion spec. The integrations **catalog** now renders (Nango
> logos + active-provider filter landed 2026-05-21), but **Connect does not
> work**. Pear hand-rolls a connect flow against a *random* workspace id with the
> wrong token and endpoint. This spec rewires Connect to the relayfile SDK's
> first-class `connectIntegration` (the SDK form of the `relayfile integration
> connect` CLI command), backed by a single **account-wide** relayfile workspace.

## Problem

Clicking **Connect** on a catalog entry (`AccountSettings.tsx` → `startConnect`)
calls, in `src/main/integrations.ts`:

```
POST /api/v1/workspaces/{relayWorkspaceId}/integrations/{provider}/connect-session   (empty body)
```

Three things are wrong:

1. **No real relayfile workspace.** `project.relayWorkspaceId` is a
   client-generated `crypto.randomUUID()` (`src/main/store.ts:387`) and is
   *never* set to a real workspace — pear never calls `createWorkspace` /
   `joinWorkspace`. So the call targets a workspace that doesn't exist on the
   relayfile cloud.
2. **Wrong endpoint + body.** The canonical route is
   `POST /api/v1/workspaces/{ws}/integrations/connect-session` with the provider
   (and backend) **in the body** — not a per-provider path segment with an empty
   body. (See the CLI: `relayfile/cmd/relayfile-cli/main.go:1532`.)
3. **Wrong token.** Pear sends the *pear-cloud auth* bearer token. The connect
   flow needs a **relayfile workspace token** obtained by joining the workspace.

The fix: *use the relayfile SDK to call Nango via the `relayfile connect`
command.* The SDK's typed `WorkspaceHandle.connectIntegration` is the connect
primitive — **but** its `assertProvider` guard (`setup.ts:1178`) hard-throws
`UnknownProviderError` for any provider outside the frozen 6-entry
`WORKSPACE_INTEGRATION_PROVIDERS` whitelist (`github, slack-sage,
slack-my-senior-dev, slack-nightcto, notion, linear`). That whitelist does not
cover the active set (jira, confluence, google-mail, google-calendar, gitlab),
and there is **no newer SDK** — `../relayfile`'s source is also `0.7.23`.

Decision: call the same endpoint `connectIntegration` calls, directly, via the
public `WorkspaceHandle.requestJson`, bypassing the whitelist. This is still
"the relayfile SDK calling Nango" — `connectIntegration`'s own body is exactly
this request (verified in `setup.ts`):

```ts
const handle = await relayWorkspace.getWorkspaceHandle()       // joinWorkspace/createWorkspace, account-wide
const session = await handle.requestJson({
  operation: 'connectIntegration',
  method: 'POST',
  path: `api/v1/workspaces/${handle.workspaceId}/integrations/connect-session`,
  body: { allowedIntegrations: [toRelayfileProvider(provider)] }
}) as { connectLink: string | null; connectionId?: string; token?: string; expiresAt?: string }
if (session.connectLink) await shell.openExternal(session.connectLink)   // Nango hosted connect UI
// then poll GET .../integrations/{provider}/status until ready (waitForConnection-equivalent)
```

`requestJson` uses the workspace token automatically. Status polling replicates
`waitForConnection` against `GET api/v1/workspaces/{ws}/integrations/{provider}/status`
(the same route `waitForConnection` uses), again via `requestJson` so it is not
gated by the whitelist.

## Design decisions (settled with Khaliq 2026-05-21)

- **One account-wide relayfile workspace, not per project.** This is the README
  "target model." Integrations connect **once at the account level** and are
  available to every project. Pear provisions/join a single workspace for the
  signed-in account, persists its real id, and reuses it everywhere. This
  **supersedes** the per-project `relayWorkspaceId` in Specs [[01-cloud-agents]]
  and [[04-cloud-agent-box]]: the cloud-agent box/mount uses the same account
  workspace id (see "Cross-spec impact").
- **The relayfile workspace and the broker are orthogonal.** The account-wide
  relayfile workspace is the **filesystem** layer only (mounts, integration VFS).
  The messaging **broker** is unchanged and stays **per-project**: `broker.ts`
  `connectCloud` creates a per-project sandbox via `POST /api/v1/sandboxes` and
  takes its `apiKey` from `/api/v1/sandboxes/{id}/terminal` — it does not use
  `relayWorkspaceId`. `joinWorkspace` returns a `relaycastApiKey`; pear **ignores
  it** (the broker has its own per-project apiKey). So there is no conflict with
  the README's "one broker per project" — the two systems do not share an id.
- **Credentials: reuse the pear cloud token.** `RelayfileSetup` is constructed
  exactly as `cloud-agent.ts:706` already does it —
  `new RelayfileSetup({ cloudApiUrl: auth.apiUrl, accessToken: () => auth.accessToken })`
  from `resolveCloudAuth()` ([[cloud-credential-sources]]). No separate relayfile
  credential is needed; `joinWorkspace`/`createWorkspace` authenticate with this
  token and return the workspace token internally.
- **Workspace join params (fixed).** Join/create with
  `agentName: 'pear-account'`, `scopes: ['relayfile:fs:read:/**', 'relayfile:fs:write:/**']` —
  the same read/write scope pair `cloud-agent.ts:718` already uses, widened to
  account scope.
- **Per-project visibility = mount-path scoping.** A connected integration's VFS
  lives at `/integrations/{provider}/…` in the account workspace. Per-project
  visibility (default on) is enforced by whether that subtree is included in the
  project's relayfile mount scope (the mount `remotePath` + path-scoped token),
  not by a separate per-project connection. Connect once (account); include/
  exclude per project.
- **Catalog/logos are done.** Active-provider filter (`ACTIVE_PROVIDERS` in
  `integrations.ts`) and Nango logos (`iconUrl` via
  `scripts/build-integrations-catalog.mjs`) already shipped. Do not redo them.
- **Provider id mapping (fixed).** Pear's catalog ids already match the relayfile/
  Nango canonical ids **except `gmail` → `google-mail`**. `slack` stays `slack`
  (cloud migrated `slack-sage` → `slack` with `slack-sage` retained only as an
  alias; the cloud resolves `slack`). So `toRelayfileProvider` is the identity map
  with the single override `gmail → google-mail`. (Note the SDK's stale whitelist
  still lists `slack-sage`; irrelevant because we bypass it via `requestJson`.)

## Behavior

### Account workspace bootstrap

Introduce a `RelayWorkspaceManager` (main process) that owns the single account
workspace:

1. On first need (sign-in, or first integrations/cloud-agent action), check the
   account store for a persisted `relayWorkspace.id`.
2. If absent: `setup.createWorkspace({ agentName: 'pear-account', scopes: ['relayfile:fs:read:/**', 'relayfile:fs:write:/**'] })`
   → persist `{ id, createdAt }`. If present:
   `setup.joinWorkspace(id, { agentName: 'pear-account', scopes: ['relayfile:fs:read:/**', 'relayfile:fs:write:/**'] })`.
3. Cache the live `WorkspaceHandle` for the process lifetime; refresh its token
   via `handle.refreshToken()` on `401`. Expose
   `getWorkspaceHandle(): Promise<WorkspaceHandle>` and `getWorkspaceId(): string`.

`RelayfileSetup` is constructed with the pear cloud auth as the `accessToken`
provider and the resolved `apiUrl`:
`new RelayfileSetup({ cloudApiUrl: auth.apiUrl, accessToken: () => auth.accessToken })`
from `resolveCloudAuth()` — identical to `cloud-agent.ts:706`.

### Connect flow (replaces the bespoke connect-session/poll/mount)

`integrationsManager.startConnect(provider)` becomes account-scoped, using
`handle.requestJson` (not `connectIntegration`, which is whitelist-gated):

1. `const handle = await relayWorkspace.getWorkspaceHandle()`
2. POST `api/v1/workspaces/{handle.workspaceId}/integrations/connect-session` via
   `handle.requestJson` with body `{ allowedIntegrations: [toRelayfileProvider(provider)] }`.
3. If the provider already shows connected (status check below): mark connected,
   skip browser.
4. Else `shell.openExternal(session.connectLink)` and surface an `awaiting-user`
   session to the renderer.
5. Poll `GET api/v1/workspaces/{ws}/integrations/{relayfileProvider}/status` via
   `handle.requestJson` until `ready` (bounded; surface progress). On ready →
   mark connected, persist, emit `integration-added`.

`disconnect` → `DELETE api/v1/workspaces/{ws}/integrations/{relayfileProvider}`
via `handle.requestJson`. Scope/visibility updates set the project's mount-path
inclusion (see the visibility design decision) and re-scope the account mount.
Drop the old hand-rolled per-provider `connect-session`, `pollConnect`, and
`mount` fetches against the random workspace id.

### SDK provider coverage (resolved)

`connectIntegration`/`waitForConnection`/`disconnectIntegration` call
`assertProvider` (`setup.ts:1178`) and throw `UnknownProviderError` outside the
frozen 6-entry whitelist (`github, slack-sage, slack-my-senior-dev,
slack-nightcto, notion, linear`). The active set (jira, confluence, google-mail,
google-calendar, gitlab) is not in it, and there is **no newer SDK** (`../relayfile`
source is also `0.7.23`). Therefore do **not** use the typed wrappers and do
**not** bump or fork the SDK. Call the underlying endpoints directly through the
public `WorkspaceHandle.requestJson` (POST `connect-session`, GET
`integrations/{provider}/status`, DELETE `integrations/{provider}`) — exactly
what the typed wrappers do internally, minus `assertProvider`. The cloud routes
are provider-generic, so every active provider works. No `@relayfile/sdk` version
change is required.

## Implementation surface (`pear/`)

### New files

| File | Purpose |
|------|---------|
| `src/main/relay-workspace.ts` | `RelayWorkspaceManager`: provisions/join the single account workspace, caches the `WorkspaceHandle`, exposes `getWorkspaceHandle()` + `getWorkspaceId()`. Single source of the real workspace for integrations **and** cloud agents. |
| `src/main/relay-workspace.types.ts` | Types for the persisted account workspace record. |

### Files to edit

| File | Change |
|------|--------|
| `src/main/store.ts` | Add account-level `relayWorkspace?: { id: string; createdAt: string }` to `StoreData` (top level, not per-project). Add load/normalize + a setter. Stop generating `Project.relayWorkspaceId` (remove `relayWorkspaceId: crypto.randomUUID()` at line 387); leave the field type for back-compat read but treat it as dead. Existing projects' random ids are ignored in favor of the account workspace. |
| `src/main/integrations.ts` | Rewrite `startConnect`/`pollConnect`/`completeConnect`/`disconnect`/`updateScope` to use `RelayWorkspaceManager` + `WorkspaceHandle.requestJson` against `connect-session` / `integrations/{provider}/status` / `integrations/{provider}` (NOT the whitelist-gated `connectIntegration`). Add `toRelayfileProvider(pearProvider)` = identity with the single override `gmail → google-mail`. Keep `listCatalog` + `ACTIVE_PROVIDERS` as-is. |
| `src/main/cloud-agent.ts` | Replace `project.relayWorkspaceId` usages (`warmBox`, `updateMountPaths`, `deleteBox`, mount setup at lines ~454/604/684/706-723) with `relayWorkspace.getWorkspaceId()`. Coordinates with Spec 04. |
| `src/main/ipc-handlers.ts` | `integrations:start-connect` no longer needs `projectId` for the workspace (account-scoped); keep `projectId` only for per-project visibility. Add `integrations:set-visibility` (projectId, integrationId, visible). |
| `src/preload/index.ts` / `src/renderer/src/lib/ipc.ts` | Mirror the adjusted integrations namespace + visibility toggle. |
| `src/renderer/src/components/settings/AccountSettings.tsx` | Connect flow stays in Account Settings (it's account-level). Show "Opening browser… / Waiting for authorization…" from the `awaiting-user` session. Connected list already renders logos. |
| `src/renderer/src/components/settings/ProjectSettings.tsx` | Per-project visibility toggles for account-connected integrations. |

### Account state on disk

```
~/.config/Pear/config/store.json   (extended)
{
  "relayWorkspace": { "id": "ws_real_…", "createdAt": "2026-05-21T…Z" },
  "projects": [ { "id": "…", /* relayWorkspaceId deprecated/unused */ } ],
  "activeProjectId": "…"
}
```

The workspace token is NOT persisted in plaintext here; it's fetched per-process
via `joinWorkspace`/`getToken` and refreshed via `handle.refreshToken()`.

## Cross-spec impact

- **Supersedes the per-project workspace** in Specs 01 and 04. After this spec,
  `relayWorkspaceId` on `Project` is dead; the cloud-agent box and mount are keyed
  on the account workspace id from `RelayWorkspaceManager.getWorkspaceId()`. **Land
  this spec's `RelayWorkspaceManager` before (or with) Spec 04** so the box is
  built against the real account workspace rather than 04's auth-resolved fallback.
- **No `../cloud` change.** The `connect-session`, `integrations/{provider}/status`,
  and disconnect routes already exist
  (`cloud/packages/web/app/api/v1/workspaces/[workspaceId]/integrations/…`).

## Cross-repo footprint

| Repo | Touched | Why |
|------|---------|-----|
| `pear/` | ✓ | The entire rework. No other repo changes. |
| `../cloud` | (verify only) | Connect-session/status/disconnect routes already exist; no change. |
| `@relayfile/sdk` | ✗ | No version change — we call the endpoints via `requestJson`, bypassing the typed whitelist. |

### Workflow (mandatory)

Implement in a **git worktree**, not the primary checkout, and finish with a PR:

```bash
# in pear
git worktree add ../pear.wt-integrations-connect -b ricky/wave-pear-cloud-agents/05-integrations-connect
```

All work for this spec happens in that worktree on branch
`ricky/wave-pear-cloud-agents/05-integrations-connect`. **End with one PR** from
that branch on `pear` (the only repo this spec changes), quoting the
acceptance-gate results. Remove the worktree once the PR is open. The spec is not
done until the PR exists. See the wave README "Workflow" section.

## Acceptance

Deterministic gates:

1. **Build clean.** `npm run build` exits 0.
2. **No hand-rolled fetchJson connect.** `grep -n "fetchJson" src/main/integrations.ts`
   returns **0 matches** for the connect/poll/mount paths (replaced by the
   workspace handle).
3. **SDK workspace handle used for connect.** `grep -nE "requestJson|getWorkspaceHandle|connect-session" src/main/integrations.ts`
   returns ≥3 matches, and `grep -n "connectIntegration(" src/main/integrations.ts`
   returns **0 matches** (we deliberately bypass the whitelist-gated wrapper).
4. **Account workspace manager exists.** `src/main/relay-workspace.ts` exports a
   `RelayWorkspaceManager` with `getWorkspaceHandle` and `getWorkspaceId`, and
   `grep -nE "createWorkspace|joinWorkspace" src/main/relay-workspace.ts` ≥1.
5. **Account-level store field.** `grep -nE "relayWorkspace\??:\s*\{" src/main/store.ts`
   returns ≥1 match at the `StoreData` level.
6. **No random per-project workspace id generated.** `grep -n "relayWorkspaceId: crypto.randomUUID()" src/main/store.ts`
   returns 0 matches.
7. **Provider mapping present.** `grep -nE "google-mail|toRelayfileProvider" src/main/integrations.ts` ≥1.
8. **Cloud-agent uses the account workspace.** `grep -n "project.relayWorkspaceId" src/main/cloud-agent.ts`
   returns 0 matches (replaced by the account workspace id).
9. **No SDK whitelist dependency.** `grep -n "WorkspaceIntegrationProvider\b" src/main/integrations.ts`
   returns 0 matches (provider is a plain string sent to the generic endpoint),
   and `@relayfile/sdk` version in `package.json` is **unchanged**.

## Manual verification

Run `npm run dev`, signed in.

1. **Account workspace bootstrap.** First integrations action provisions/join a
   real workspace; `store.json` gains `relayWorkspace.id` (a real cloud id, not a
   random UUID).
2. **Connect GitHub end-to-end.** Account Settings → Catalog → GitHub → **Connect**.
   The Nango hosted connect UI opens in the browser. Authorize. Pear shows
   "Waiting for authorization…" → flips to connected; GitHub moves to the
   CONNECTED list with its logo.
3. **Already-connected short-circuit.** Click Connect on GitHub again → no browser
   reopen; pear reports already connected.
4. **Second provider.** Repeat for Notion (different provider id, no mapping) and
   Gmail (mapping `gmail`→`google-mail`) — both connect.
5. **Disconnect.** Trash icon → DELETE `integrations/{provider}` runs; provider
   returns to the catalog as connectable.
6. **Per-project visibility.** In two projects, toggle a connected integration's
   visibility; verify the mount paths appear/disappear for that project only.
7. **Restart.** Quit + relaunch; the account workspace re-joins silently (same
   `relayWorkspace.id`); connected integrations persist.

## Out of scope

- **In-pear provider-credential connect for cloud agents** (`agent-relay cloud
  connect <provider>`) — unrelated to relayfile integrations.
- **Composio backend selection UI.** Default backend per provider; no backend
  picker in pear v1.
- **Migrating existing per-project random workspace ids to real ones for old
  projects' data** — there is no real data behind the random ids, so nothing to
  migrate; just stop using them.

## Notes for ricky

- Read `relayfile/packages/sdk/typescript/src/setup.ts` `connectIntegration`
  (~line 1000) to copy the exact `connect-session` request shape, and
  `assertProvider` (`setup.ts:1178`) to see why the typed wrappers can't be used
  for the active providers. `WorkspaceHandle.requestJson`, `getToken`,
  `refreshToken`, and `workspaceId` are all public. Mirror the CLI flow in
  `relayfile/cmd/relayfile-cli/main.go:1894-1951` (`runIntegrationConnect`) for
  the open-link-then-wait sequence.
- `RelayWorkspaceManager` is the single owner of the account workspace; both
  integrations and the Spec-04 cloud-agent box must go through it. Do not
  reintroduce per-project random workspace ids.
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` on commits.
- Pairs with [[04-cloud-agent-box]] (shared account workspace) and depends on the
  catalog/logo work already in `integrations.ts` + `build-integrations-catalog.mjs`.
