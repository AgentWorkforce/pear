# Scripts

- `build-integrations-catalog.mjs` regenerates `src/main/integrations.catalog.ts` from the static integration catalog source in the script.
- `prove-integrations-store-normalization.mjs` proves project integration metadata survives store save/load and reaches `IntegrationsManager.syncAgentState`.
- `prove-integrations-cloud-bridge.mjs` proves the real exported `cloudAgentManager` bridge methods PATCH cloud-agent box mount paths and inject an integrations system message.
- `prove-integrations-ipc-account-contract.mjs` proves the integrations IPC/preload/renderer contract and mounted account settings route exist.
- `prove-account-settings-async-connect.mjs` proves Account Settings completes an async OAuth session after the later `session-update` event.

## Factory sync-fidelity canary (`factory-canary.sh`)

`factory-canary.sh` runs `factory canary <issue>` against the live relayfile mount and asserts a known "Ready for Agent" issue is still classified **dispatch-ready** by the real triage path. It is the regression detector for Linear sync-fidelity drift (sparse records / stub primaries — see AgentWorkforce/cloud#2284 and AgentWorkforce/factory#10): if a synced issue ever stops being dispatchable, this exits non-zero and (optionally) posts a Slack alert, so the regression is caught before it silently blocks every factory dispatch.

Run it manually from the pear repo root:

```bash
FACTORY_CANARY_ISSUE=AR-305 ./scripts/factory-canary.sh
```

Schedule it (every 6h) via launchd using `scripts/com.agentrelay.factory-canary.plist` — see the install steps in that file's header. Set `FACTORY_CANARY_SLACK_WEBHOOK` for failure alerts.

Notes:
- Run from the pear repo root so the canary reuses the running Pear relay broker (`.agentworkforce/relay/connection.json`).
- Requires a factory build with the `canary` command (factory#10+); until that publishes, set `FACTORY_BIN` to a local build.
- **CI alternative:** the canary logic itself is covered by the factory unit suite (the stub-primary golden test runs on every PR). A *live* canary needs the operator's workspace creds + mount, so it belongs in this scheduled job rather than package CI.
