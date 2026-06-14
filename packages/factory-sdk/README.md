# @pear/factory-sdk

The autonomous issue factory: a loop that discovers Linear issues, triages them,
dispatches agents to implement fixes, opens PRs, drives them to completion through
a merge gate, and closes the issues — all under a hard safety scope.

The CLI binary is **`fleet`** (`bin/fleet.mjs`). It is an unpublished workspace
package, so you invoke it through one of:

```bash
# 1. The pear launcher passthrough (no Electron app is launched)
pear factory <action> [options]

# 2. A root npm script
npm run factory:start -- --config <cfg>

# 3. Directly
node packages/factory-sdk/bin/fleet.mjs factory <action> --config <cfg>
```

All three are equivalent; `pear factory …` simply forwards to `fleet factory …`.

> **Heads-up:** every `factory` action requires `--config <path>` (see
> [Configuration](#configuration)). Commands fail fast with
> `factory commands require --config <path>` if it's missing.

---

## Quick start

```bash
# One-shot batch — discover + triage + dispatch one cycle, then exit.
# Add --dry-run to plan without writing or spawning anything.
pear factory run-once --config ./factory.config.json --dry-run

# Live daemon — subscription-driven; runs until SIGINT/SIGTERM.
pear factory start --mode live --config ./factory.config.json
```

## Commands

| Command | What it does |
|---|---|
| `factory run-once` | One discovery→triage→dispatch cycle, then exit. Honors `--dry-run`. |
| `factory loop` | Bounded multi-iteration loop (`loop.maxIterations`), then exit. |
| `factory start --mode live` | Long-lived daemon. Subscription-driven; writes + refreshes a loop heartbeat. The production entrypoint. |
| `factory status` | Print the in-memory factory status as JSON. |
| `factory loop-status` | Read the heartbeat file and report liveness (stale vs. alive). |
| `factory kill-loop` | Send SIGTERM to the daemon PID recorded in the heartbeat. |
| `factory reap-orphans` | Crash backstop: reap orphaned agent pairs whose heartbeat is stale. Run as a scheduled job. |
| `factory triage <KEY\|path>` | Triage a single issue and print the decision. |
| `factory dispatch <KEY\|path>` | Triage + dispatch a single issue. Honors `--dry-run`. |
| `factory close-probe <PR#> --repo <owner/repo> --issue <KEY>` | Manually close a synthetic E2E probe PR. |

Global options (accepted anywhere in the args): `--config <path>`,
`--dry-run`, `--backend <internal\|relay>`.

## The 2-process production model

The factory runs as **two** coordinated processes (see issue #321 §4):

1. **Live daemon** — `pear factory start --mode live --config <live>`. Drives the
   loop and refreshes a heartbeat file.
2. **External reaper** — a *scheduled* `pear factory reap-orphans --config <live>`
   that acts as a crash backstop, cleaning up orphaned agent pairs if the daemon dies.

> **HARD precondition:** the reaper **must** use the **same `--config`** as the
> live daemon. A mismatched config reaps nothing *and* leaves the backstop broken
> (the coupling is load-bearing — see §7 of issue #321).

### Other operating preconditions (issue #321 §7)

- **`gh`-authenticated environment.** The gh-resolver is completion-load-bearing
  while the cloud GitHub→mount PR-sync is degraded; a `gh` auth drop halts completion.
- Run the real binary path (`node packages/factory-sdk/bin/fleet.mjs` from the
  repository root / `pear factory`), not a shim.

## Configuration

Pass a JSON file via `--config`. The schema lives in
[`src/config/schema.ts`](src/config/schema.ts). Minimal config:

```json
{
  "workspaceId": "your-workspace-id",
  "repos": {
    "byLabel": { "pear": "AgentWorkforce/pear" },
    "default": "AgentWorkforce/pear"
  }
}
```

Notable fields (all optional unless noted, defaults in parentheses):

- `workspaceId` *(required)* — relayfile cloud mount workspace.
- `repos.byLabel` *(required)* — map Linear label → `owner/repo`. Also
  `repos.byProject`, `repos.keywordRules`, `repos.clonePaths`, `repos.default`.
- `mergePolicy` (`never`) — `never` keeps PRs open; `on-green-with-review` enables
  autonomous merge on green + approved review. **Stays `never` until the flip is
  thrown** (issue #321 §6).
- `safety.requireTitlePrefix` (`[factory-e2e]`) + `safety.requireTeamKey` (`AR`) —
  the scope gate. Issues outside scope are never dispatched.
- `loop.heartbeatPath` (`/tmp/factory-run/factory-loop-heartbeat.json`),
  `loop.registryPath`, `loop.heartbeatStaleMs` (`60000`) — daemon/reaper coupling.
- `batchSize` (`5`), `dispatch.maxAttempts` (`2`), `models.{implementer,reviewer,triage}`,
  `slack.channel`, `subscription.*`, `liveSubscription.*`.

### Fixture mode (offline testing)

If the config (or a `{ "factoryConfig": …, "fixtureFiles": … }` wrapper) includes a
`fixtureFiles` map, the CLI swaps in fake fleet + mount clients backed by those files —
no cloud, no real agents. See [`test/fixtures/factory.config.json`](test/fixtures/factory.config.json).

## Notes

- **`pear factory …` does not launch the Electron app.** It detects the `factory`
  verb in `bin/pear.mjs` and shells out to `fleet.mjs` in a plain Node process;
  the daemon is headless by design.
- First run builds the CLI with esbuild into `node_modules/.cache/pear-factory-sdk`;
  pass `--rebuild` (or `FLEET_FORCE_BUILD=1`) to force a rebuild.
