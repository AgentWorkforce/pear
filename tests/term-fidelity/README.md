# Electron terminal-fidelity matrix

This suite launches the built Electron application, connects it to a dedicated
broker, spawns a real supported CLI, and compares the renderer's live xterm grid
with the broker PTY emulator at quiet checkpoints. It does not use the web mock
or inject synthetic PTY chunks.

## Run

All four supported CLIs must be installed, executable, and authenticated before
an all-CLI run:

```sh
npm run test:term-fidelity -- --cli=all
```

Run one CLI while developing:

```sh
npm run test:term-fidelity -- --cli=claude
npm run test:term-fidelity -- --cli=codex
npm run test:term-fidelity -- --cli=opencode
npm run test:term-fidelity -- --cli=grok
```

Extra arguments are forwarded to Playwright. The runner checks each selected
executable with `--version`, builds the Electron app, and then starts the suite.
Set `TERM_FIDELITY_SKIP_BUILD=1` only when `out/` is already current. Set
`TERM_FIDELITY_KEEP_TEMP=1` to retain the temporary project, broker state, and
Electron user-data directory after a run.

For harness development or a focused fixer-loop rerun, set
`TERM_FIDELITY_WORKLOAD=<workload-directory-name>` to execute one canonical
workload. Normal matrix and CI runs must leave it unset so all six execute.

Real model turns are intentional and consume tokens. Each CLI is run serially.

## Isolation guarantees

Every CLI case creates:

- a temporary project root;
- a temporary Electron `userData` directory, verified in the Electron main
  process after launch;
- a broker state directory under the temporary project;
- a unique broker `--instance-name`; and
- an OS-selected free loopback API port.

The harness prestarts that broker with `HarnessDriverClient.spawn`, then the
production app connects through the temporary project's `connection.json`.
Inherited Relay agent/workspace credentials are stripped from both child
processes. The harness refuses instance name `pear`, API port `3889`, a
non-loopback broker URL, or a connection URL whose port differs from the port it
reserved. It never calls `agent-relay local up`.

Agents are spawned through the production `window.pear.broker.spawnAgent` IPC
surface. The normal renderer stores, broker event stream, PTY attach, terminal
runtime, resize synchronization, predictive echo, and reconciler all remain in
the path under test.

## Matrix workloads

One real agent per selected CLI executes, in order:

1. a multi-kilobyte streaming response;
2. a real shell-tool approval panel, including selection redraws;
3. a multi-step Electron window resize/SIGWINCH bounce during output;
4. human typing while output streams;
5. window blur/hide during output followed by reveal/focus; and
6. scroll into the CLI-visible transcript (xterm-native or TUI-owned) during
   output followed by a return to bottom.

The permission case fails if no approval TUI is observed; this prevents a local
auto-approve setting from silently reducing coverage. Claude and Grok are
launched with their explicit `default` permission mode; Claude also excludes
ambient setting sources so user/project allow rules cannot bypass the panel.
Relay launches Codex in bypass mode, so the workload uses Codex's real
`/permissions` selector to choose `Ask for approval`; Codex also uses
inline/no-alt-screen rendering. OpenCode's
isolated child environment disables its updater and forces shell permissions to
`ask`, avoiding user-global updater and allow-rule state.

## Oracle and quiet gate

The renderer exposes no test-only global. Playwright follows the terminal host's
React fiber to the existing `useTerminal` runtime ref, then reads the public
xterm buffer cell-by-cell and checks the live predictive-echo status. This is a
read-only measurement; no production renderer or rendering-pipeline code is
patched.

The broker side is fetched directly from the documented endpoint:

```text
GET <connection-url>/api/spawned/<name>/snapshot?format=plain
```

using the API key in the isolated `connection.json`. A checkpoint requires two
stable observations with at least 1.5 seconds of no PTY output, no pending
predictions, matching rows and columns, and the renderer returned to the bottom
viewport. The plain broker rows are painted into `@xterm/headless` and compared
with the renderer xterm cell grid, including wide-cell widths.

Any renderer console line containing
`[terminal] viewport diverged from broker screen` fails the case even if the
reconciler subsequently repairs the visible grid.

## Divergence artifacts

A mismatched checkpoint writes:

```text
test-results/term-fidelity/<cli>/<workload>/
  renderer.txt
  broker.txt
  diff.txt
  screen.png
  meta.json
```

`meta.json` includes dimensions, cursors, timestamps, broker offset, quiet-gate
state, installed Relay package and broker versions, isolated instance details,
and reconciler telemetry observed during the workload. A telemetry-only failure
writes its screenshot and metadata under
`test-results/term-fidelity/<cli>/reconciler-telemetry/`.
