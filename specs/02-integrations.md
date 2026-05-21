# Spec 02 — Integrations in Pear (remaining work)

> Slimmed 2026-05-21 to **only what is missing**. The integrations scaffolding +
> catalog (with Nango logos, active-provider filter) are already implemented in
> pear — do not redo them. The **Connect flow rework** is not here: it is
> [[05-integrations-connect]]. This spec finishes the remaining UI + one route.

## Already implemented (do not touch)

`src/main/integrations.ts` (`IntegrationsManager`), the `integrations:*` IPC
channels, the `integrations` preload namespace, the `Project.integrations` store
schema, `injectSystemMessage`, and the catalog: `scripts/build-integrations-catalog.mjs`
+ `src/main/integrations.catalog.ts` (36 adapters, `iconUrl` Nango logos,
`ACTIVE_PROVIDERS` filter), rendered with logos in `AccountSettings.tsx`. The
`../relayfile-cloud` catalog route (`src/routes/integrations.ts`) exists.

## Remaining work

### 1. Scope-picker components (pear)

There is no `src/renderer/src/components/settings/scope-pickers/` directory. Add
per-provider scope pickers so a user can choose what to mount when connecting:
`GitHubRepoPicker.tsx`, `SlackChannelPicker.tsx`, `LinearTeamPicker.tsx`,
`NotionDatabasePicker.tsx`, plus a generic fallback picker. Each returns a
`scope` object + `mountPaths` consumed by the connect flow ([[05-integrations-connect]]).
Drive the picker from the connected provider's `listAccessibleResources`.

### 2. Per-project visibility section (pear)

`ProjectSettings.tsx` has no `IntegrationVisibilitySection`. Add it: list the
account-connected integrations with a per-project visibility toggle (default on)
that includes/excludes each provider's `/integrations/{provider}` subtree from
that project's relayfile mount scope (the visibility model from
[[05-integrations-connect]]).

### 3. Workspace-integrations route (`../relayfile-cloud`)

`../relayfile-cloud/src/routes/workspace-integrations.ts` does not exist. Add it
with the `connect-session`, `mount`, and `disconnect` endpoints the workspace
integration flow needs (mirroring the cloud routes pear's SDK calls).

## Acceptance (only the remaining gates)

1. **Build clean.** `npm run build` exits 0.
2. **Scope pickers exist.** `GitHubRepoPicker.tsx`, `SlackChannelPicker.tsx`,
   `LinearTeamPicker.tsx`, `NotionDatabasePicker.tsx`, and a generic fallback all
   exist under `src/renderer/src/components/settings/scope-pickers/`.
3. **Visibility section mounted.** `grep "IntegrationVisibilitySection" src/renderer/src/components/settings/ProjectSettings.tsx`
   returns ≥1 match.
4. **Cross-repo route.** `../relayfile-cloud/src/routes/workspace-integrations.ts`
   exists with `connect-session`, `mount`, `disconnect` handlers.

## Manual verification

1. Connect a provider (Spec 05 flow). The scope picker appears; choose a subset
   (e.g. one GitHub repo); the mount reflects only that scope.
2. In two projects, toggle a connected integration's visibility; verify its
   `/integrations/{provider}` paths appear/disappear for that project only.

### Workflow (mandatory)

Implement in git worktrees, end with a PR per touched repo:

```bash
# in pear
git worktree add ../pear.wt-integrations -b ricky/wave-pear-cloud-agents/02-integrations
# in ../relayfile-cloud
git worktree add ../relayfile-cloud.wt-integrations -b ricky/wave-pear-cloud-agents/02-integrations
```

Open one PR per repo (`pear`, `../relayfile-cloud`) from that branch,
cross-linked, quoting the acceptance-gate results. Remove the worktrees once the
PRs are open. Depends on [[05-integrations-connect]] (connect must work first).
