# Spec 01 — Cloud Agents in Pear (remaining work)

> Slimmed 2026-05-21 to **only what is missing**. The cloud-agent scaffolding in
> pear is already implemented — do not redo it. This spec finishes the two gaps
> that remain. The attach/warm backend is **not** here: it is [[04-cloud-agent-box]].

## Already implemented (do not touch)

`src/main/cloud-agent.ts` (`CloudAgentManager` incl. `restore()`, `mountWorkspace`,
git sync-back / `autoPullAfterRun`), the 7 `cloud-agent:*` IPC channels, the
`cloudAgent` preload namespace, the `Project.cloudAgent` store schema, and the
renderer (`AddAgentDialog`, `CloudAgentDialog`, `CloudAgentPicker`,
`CloudAuthRequired`, `use-cloud-agent`, `cloud-agent-store`). The `../relay`
`deployProactiveAgent` overload exists. Auth now flows through `resolveCloudAuth`
(see [[cloud-credential-sources]]), superseding the old `readStoredAuth` gate.

## Remaining work

### 1. Restore cloud agents on launch (pear)

`CloudAgentManager.restore(projectId)` exists but is **never called at startup**
— `src/main/index.ts` only calls `cloudAgentManager.shutdownAll()`. On app
`ready`, iterate `loadStore().projects` and, for any project with a persisted
`cloudAgent`, call `cloudAgentManager.restore(project.id)` (best-effort, logged
on failure). This re-attaches the box + mount silently after a restart. Depends
on [[04-cloud-agent-box]] (so the box warms) and the account workspace from
[[05-integrations-connect]].

### 2. Relayfile `--conflict-policy` flag (`../relayfile`)

Pear's `createConflictPolicyLauncher` already computes `remote-wins` /
`local-wins`, but the `relayfile-mount` binary has no flag to receive it. Add
`--conflict-policy={local-wins|remote-wins}` (default `local-wins`) to
`cmd/relayfile-mount/main.go`, and plumb a `conflictPolicy` option through
`packages/sdk/typescript/src/setup.ts` `MountWorkspaceOptions` → CLI args. When
`remote-wins`, on conflict restore the remote version and write the local copy to
`.relay/conflicts/<ts>-<path>`.

## Acceptance (only the remaining gates)

1. **Restore-on-launch wired.** `grep -E "cloudAgentManager\.restore" src/main/index.ts`
   returns ≥1 match, inside the app-`ready`/startup path.
2. **Build clean.** `npm run build` exits 0.
3. **Relayfile conflict-policy flag.** `grep -E "conflict-policy|ConflictPolicy" ../relayfile/cmd/relayfile-mount/main.go`
   returns ≥1 match, and `grep -E "conflictPolicy" ../relayfile/packages/sdk/typescript/src/setup.ts` ≥1.

## Manual verification

1. Attach a cloud agent to a project (requires Specs 04 + 05 landed). Quit and
   relaunch pear; the project's cloud-agent badge returns to "Ready" within ~60s
   with no user action.
2. During an agent run, edit a mounted file locally; confirm the conflict lands
   in `.relay/conflicts/` (sandbox-wins during run) and local-wins once idle.

### Workflow (mandatory)

Implement in git worktrees, end with a PR per touched repo:

```bash
# in pear
git worktree add ../pear.wt-cloud-agents -b ricky/wave-pear-cloud-agents/01-cloud-agents
# in ../relayfile
git worktree add ../relayfile.wt-cloud-agents -b ricky/wave-pear-cloud-agents/01-cloud-agents
```

Open one PR per repo (`pear`, `../relayfile`) from that branch, cross-linked,
quoting the acceptance-gate results. Remove the worktrees once the PRs are open.
See the wave README "Workflow" section.
