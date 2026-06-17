Run the Pear integration mount eval suite. Use when asked to run evals, check writeback coverage, validate variant pass rates, or confirm that prescriptive/full-inject work for claude or opencode CLIs.

# Run Mount Evals

Eval runner lives in `evals/`. The harness library (`@agent-relay/evals`) lives in `../relay/packages/evals/src/`.

## Quick commands

```bash
# All scenarios, all variants, default repeat=3 (~10 min)
npm run eval

# Single variant across all scenarios
npm run eval -- --variant=prescriptive
npm run eval -- --variant=full-inject

# Specific CLI — opencode uses free Chinese model by default
npm run eval -- --cli=opencode --variant=prescriptive

# Fast smoke check
npm run eval -- --cli=opencode --variant=prescriptive --scenario=s01 --repeat=1

# Reduce repeats for a faster full sweep
npm run eval -- --variant=prescriptive --repeat=2
```

## CLIs

| `--cli` | Transport | Default model |
|---------|-----------|---------------|
| (omitted) | PTY (claude) | session default |
| `opencode` | headless | `opencode/deepseek-v4-flash-free` |

For opencode, **use free or Chinese models** — do not use claude models for opencode evals.

Non-claude CLIs always use `--variant=prescriptive` in production (`ipc-handlers.ts`). Match prod by running `--cli=opencode --variant=prescriptive`.

## Variants

| Variant | What it provides to the agent |
|---------|-------------------------------|
| `bare` | Nothing — zero guidance |
| `claude-md` | CLAUDE.md pointing at `.integrations/discovery/` |
| `slim-inject` | Provider names + mount roots in task prefix |
| `full-inject` | Full `<integrations-update>` block (matches `initialSpawnInstructions`) |
| `prescriptive` | Compact write-path table (matches `prescriptiveSpawnInstructions`, used for non-claude CLIs) |

Expected: `prescriptive`, `full-inject`, `slim-inject` → 100%. `bare`, `claude-md` → 0–50%.

## Scenarios

| ID | Title |
|----|-------|
| s01 | Slack channel post |
| s02 | Slack direct message |
| s03 | Linear issue creation |
| s04 | Linear issue update |
| s05 | Linear issue comment |
| s06 | Linear issue delete |

## Flags

```
--variant=<name>[,<name>]   Comma-separated (default: all 5)
--scenario=<id>[,<id>]      Comma-separated (default: all 6)
--repeat=N                  Runs per cell (default: 3; use 1–2 for speed)
--model=<id>                Model override for claude PTY runs
--cli=<name>                omit for claude, or 'opencode'
```

## Reports

Each run writes `evals/reports/report-<timestamp>.json` and `.html`. Open the HTML for a colour-coded pass/fail grid.

## Source layout

```
evals/
  runner.ts       # CLI entrypoint — arg parsing + orchestration
  harness.ts      # Broker + CLI spawn (spawnCli for opencode, spawnPty for claude)
  variants.ts     # variantTaskPrefix(), variantClaudeMd(), prescriptivePrefix()
  fixture.ts      # createFixture(), snapshotMount(), newMountFiles()
  scenarios/      # s01–s06 scenario definitions
  report.ts       # JSON + HTML report writer

../relay/packages/evals/src/
  harness.ts      # RelayEvalClient — broker setup, spawnPty/spawnCli, onEvent()
  scoring/mount.ts # scoreMountRun(), mountCellStats()
  types.ts        # MountScenarioResult
```

## When to re-run

- After changing `prescriptiveSpawnInstructions` or `initialSpawnInstructions` in `src/main/integrations.ts`
- After changing `evals/variants.ts`
- After bumping `@agent-relay/evals` in `package.json`
- After a cloud discovery-emitter fix (verify live mount reflects new examples before claiming end-to-end)
- After adding a new integration provider (add a matching scenario)

## Updating the harness library

```bash
cd ../relay/packages/evals && npm run build
cd - && npm install
# If bumping the published version, update devDependencies in package.json
```
