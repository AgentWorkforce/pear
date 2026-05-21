# Pear specs — Wave: Cloud Agents, Integrations, Proactive Agents

As of 2026-05-21 every spec has been **slimmed to only its remaining work** — the
scaffolding from the first pass is already in pear; each spec now finishes the
gaps that its acceptance gates still fail. Run them in **dependency order**
(not numeric order) with `./specs/run-remaining-work.sh`:

```
05 → 04 → 01 → 02 → 03
```

05 builds the account-wide relayfile workspace everything else keys on; 04 builds
the cloud-agent box on top of it; 01/02/03 finish their UI/wiring/backends.

## Specs (remaining work)

1. [01-cloud-agents.md](./01-cloud-agents.md) — finish: restore-on-launch wiring + relayfile `--conflict-policy` flag. (Scaffolding done.)
2. [02-integrations.md](./02-integrations.md) — finish: scope-picker components + per-project visibility section + relayfile-cloud workspace-integrations route. (Catalog + logos done.)
3. [03-proactive-agents.md](./03-proactive-agents.md) — finish: mount the UI (section + editor tab) + Monaco + vendored types + the cloud proactive-personas backend. (Main-process scaffolding done; UI unmounted.)

### Remediation specs (gaps found 2026-05-21)

4. [04-cloud-agent-box.md](./04-cloud-agent-box.md) — build the `POST/GET/PATCH/DELETE …/cloud-agents/{id}/box` endpoints in `../cloud` that Spec 01 declared but never built. Pear's client side is shipping and calling them, so attaching a cloud agent currently fails with `Failed to warm cloud agent box: Not Found`. `../cloud`-only. Settled context: a "cloud agent" **is a provider credential** (`GET /cloud-agents` reads `provider_credentials`); `DELETE /cloud-agents/{id}` was fixed on 2026-05-21.
5. [05-integrations-connect.md](./05-integrations-connect.md) — rewire integrations **Connect** to the relayfile SDK's `WorkspaceHandle.connectIntegration` (Nango), backed by a single **account-wide** relayfile workspace, replacing the random per-project `relayWorkspaceId` and the hand-rolled connect-session call. The catalog logos + active-provider filter already landed; only Connect is broken. Mostly `pear/`; needs an `@relayfile/sdk` bump for full provider coverage. Supersedes the per-project workspace assumption in Specs 01 & 04.

Each spec is self-contained and lists exact files to create/edit in pear plus required cross-repo changes in `../cloud`, `../relay`, `../relayfile`, `../relayfile-cloud`, `../workforce`. The cross-repo changes are explicit on purpose — ricky should commit them on sibling branches in each repo and cross-link in the PR descriptions.

## Cross-cutting design decisions (from the May 20 call — apply to all three specs)

- **Workspaces, not worktrees, for v1.** One RelayCast workspace per project, one broker per project, no worktree tab/branch model. Re-introducing worktrees is a v2 concern.
- **One Relayfile mount per user account, shared across all projects.** Specs 01 and 02 currently ship a per-project mount as a pragmatic starting point but their public APIs are project-scoped so a future migration to a single account-wide mount is an internal refactor inside `CloudAgentManager`. Integrations connect once (account-level) and are exposed to each project via a visibility toggle.
- **In the UI, call them "Agents", not "Personas".** Khaliq + Will agreed. "Agent" is the user-facing label; "persona" stays as the on-disk Workforce schema name in code.
- **Granola is the UX reference** for cloud-connect/sign-in affordances. Match its cleanliness.
- **Most personas should NOT use the relayfile mount.** Mount is slow today (~12s deploy); the editor's "Use relayfile mount" toggle defaults OFF. Will is filing a Linear issue to dig into the perf. Specs should not assume the perf is fixed; deploy UIs must show progress so the slowness is visible rather than mysterious.
- **Known sync-back bug:** when an agent in a sandbox makes a git push, the local working tree never auto-updates because git only flows one way through relayfile. Spec 01 fixes this with an end-of-run `git fetch && git pull --ff-only` when the local tree is clean.
- **Local proactive agents are valuable**, but v1 ships cloud-only. Editor IPC includes a `runMode: 'cloud' | 'local'` field locked to `cloud` until v2.

## How ricky should run this

Run from the pear repo (cwd = `/Users/khaliqgant/Projects/AgentWorkforce/pear`). Each spec produces a separate workflow artifact, runs in its own worktree, and ends with a PR per touched repo.

Run all specs' remaining work in dependency order with:

```bash
cd /Users/khaliqgant/Projects/AgentWorkforce/pear
./specs/run-remaining-work.sh                 # 05 → 04 → 01 → 02 → 03
./specs/run-remaining-work.sh 04              # run only one spec (by NN prefix)
DRY_RUN=1 ./specs/run-remaining-work.sh       # print the ricky commands without executing
```

For each spec the script runs:

```bash
ricky --mode local --spec-file specs/<NN-name>.md --run
```

It stops on the first failure and prints how to resume.

## Workflow: every spec runs in a worktree and ends with a PR

This is mandatory for **all** specs (01–05). Do not implement on the checked-out
working copy or commit directly to `main`.

1. **Create a git worktree per spec, in every repo it touches.** From each repo's
   root:
   ```bash
   git worktree add ../<repo>.wt-<slug> -b ricky/wave-pear-cloud-agents/<NN>-<slug>
   ```
   (e.g. `pear.wt-cloud-agent-box`, `cloud.wt-cloud-agent-box`). Do all work for
   that spec inside its worktree(s); leave the primary checkout untouched.
2. **Branch name is identical across repos** for one spec:
   `ricky/wave-pear-cloud-agents/<NN>-<slug>`.
3. **End every spec with a PR per touched repo.** Open one PR from each worktree's
   branch, cross-link the pear PR to all sibling PRs in its description, and quote
   the acceptance-gate results. A spec is not "done" until its PR(s) are open.
4. **Clean up** the worktree(s) after the PR is open
   (`git worktree remove <path>`); the branch lives on in the PR.

## Branch convention

- Pear: `ricky/wave-pear-cloud-agents/0N-<slug>` (one branch per spec), worked in a worktree.
- Sibling repos: same branch name, same worktree-per-spec rule, in each affected repo.
- Open one PR per affected repo per spec. Cross-link the pear PR description to all sibling PRs.

## Cross-repo footprint summary

| Spec | pear | ../cloud | ../relay | ../relayfile | ../relayfile-cloud | ../workforce |
|------|------|----------|----------|--------------|--------------------|--------------|
| 01   | ✓    | ✓        | ✓        | ✓            |                    |              |
| 02   | ✓    | ✓        |          | ✓            | ✓                  |              |
| 03   | ✓    | ✓        |          |              | (maybe — change stream)            | ✓            |

Each spec's "Cross-repo changes" section lists exact files and the change required.

## Expected output

Per spec, ricky produces:

1. A PR on the pear repo on branch `ricky/wave-pear-cloud-agents/0N-<slug>`.
2. PRs on each sibling repo touched by that spec, on the same branch name.
3. A workflow artifact under `pear/.workflow-artifacts/ricky-local-runs/<run-id>/` with per-step evidence (test runs, grep results for the acceptance gates, build logs).
4. A short markdown summary at the top of the pear PR linking out to the sibling PRs and quoting the acceptance-gate results.

## Acceptance for the overall wave

After all three specs land (PRs merged in order):

- A user can open pear, sign in to agent-relay cloud, attach a cloud agent to a project, connect GitHub + Slack via the integrations panel, then create a proactive persona that watches the GitHub integration mount and fires automatically when an issue is opened — all without leaving pear or touching a JSON file by hand.

The end-to-end demo walkthrough is the sum of the **Manual verification** sections of each spec performed in order.

## Non-goals for this wave

Deliberately deferred (do not let the agent expand scope into these):

- Provider-credential connect flow inside pear (still `agent-relay cloud connect <provider>` in a terminal).
- Cron / webhook triggers for proactive agents (v1 is relayfile-change only).
- A persona marketplace / catalog.
- Multi-user / org-wide sharing of cloud agents and integrations.
- Cost or billing observability per cloud-agent or per persona run.

## Notes

- Pear has no tests or lint today. Each spec's acceptance lists `grep`-based deterministic gates (works without a test harness) plus manual verification. Spec 03 adds a minimal vitest smoke test as part of its acceptance.
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` should appear on commits.
