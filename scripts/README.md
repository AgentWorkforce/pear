# Scripts

- `build-integrations-catalog.mjs` regenerates `src/main/integrations.catalog.ts` from the static integration catalog source in the script.
- `prove-integrations-store-normalization.mjs` proves project integration metadata survives store save/load and reaches `IntegrationsManager.syncAgentState`.
- `prove-integrations-cloud-bridge.mjs` proves the real exported `cloudAgentManager` bridge methods PATCH cloud-agent box mount paths and inject an integrations system message.
- `prove-integrations-ipc-account-contract.mjs` proves the integrations IPC/preload/renderer contract and mounted account settings route exist.
- `prove-account-settings-async-connect.mjs` proves Account Settings completes an async OAuth session after the later `session-update` event.
