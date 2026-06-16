# Codex Fix - factory p5 pear teardown

## Result

Fixed the remaining valid review finding.

## Finding Addressed

### Split factory configs could lose inherited checkout mappings on save

`factory:read-config` now matches the published factory loader's split-config inheritance behavior for `workspaceConfig` / `nodeConfig` files:

- `nodeConfig.workspaceId` falls back to `workspaceConfig.workspaceId` when omitted.
- `nodeConfig.cloneRoot` falls back to `workspaceConfig.repos.cloneRoot` when omitted.
- `nodeConfig.clonePaths` falls back to `workspaceConfig.repos.clonePaths` when omitted.

`factory:save-config` now writes split configs without materializing inherited checkout fields as node-level overrides when those fields were absent from the existing `nodeConfig`. This prevents a no-op read/save from turning inherited workspace checkout mappings into explicit `nodeConfig` overrides. Existing explicit `nodeConfig.clonePaths: {}` overrides are preserved.

## Files Changed

- `src/main/ipc-handlers.ts`
- `src/main/ipc-handlers.test.ts`

## Tests / Proofs Added

- Added a split-config regression test that reads and saves a config with inherited `workspaceConfig.repos.cloneRoot` and `workspaceConfig.repos.clonePaths`, then verifies the effective `nodeConfig` with the published factory loader implementation.
- Added a regression test that preserves an explicit split-config empty `nodeConfig.clonePaths` override.

## Verification

- `env -u AGENT_RELAY_BROKER_PID npx vitest run src/main/ipc-handlers.test.ts` - PASS, 23 tests.
- `npm run typecheck:node` - PASS.
- `npm run typecheck:web` - PASS.
- `env -u AGENT_RELAY_BROKER_PID npx vitest run` - PASS, 31 files / 440 tests.
- `git diff --check` - PASS.
- `npm test` - PASS, 122 tests.

## Notes

`npm test` prints expected diagnostic warnings from burn-spawn-hook tests for simulated fallback cases (`ledger locked` and missing `@relayburn/sdk`), but the command exits successfully with all tests passing.
