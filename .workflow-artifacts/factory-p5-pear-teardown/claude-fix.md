# Fix report — factory p5 (pear teardown)

All four review findings were valid and have been fixed. No findings were skipped.

## Finding 1 [Medium] — Zero test coverage for new cloud-status + config-parsing logic → FIXED

Added two new `describe` blocks to `src/main/ipc-handlers.test.ts`, driving the
module-private functions through the registered IPC handlers (the existing
`ipcMain.handle` mock captures them).

`./auth` is now mocked with `resolveCloudAuth` / `getAccountWorkspaceId` /
`accountWorkspaceReadyRetryOptions`, and `fetch` is stubbed per-case via
`vi.stubGlobal`. Config round-trips use a real temp dir (`mkdtempSync`) since the
handlers use real `fs/promises` + `existsSync`.

`registerIpcHandlers factory:read-config / factory:save-config`:
- empty NodeConfig when the file does not exist
- save→file→re-read round-trip reproduces the draft; asserts the on-disk shape
- reads NodeConfig fields that live under `repos.*` via fallback
- promotes edited fields to the top level, leaving `repos.*` untouched (Finding 3 pin)
- returns validation errors without writing on an invalid draft

`registerIpcHandlers factory:status`:
- (a) all endpoints 404 → `state:'empty'` (asserts the 3-endpoint fallback walk)
- (b) 401 → `state:'unauthenticated'`, `connected:false`
- non-OK 500 → `state:'unavailable'`, message contains the status code
- (c) 200 payload with agents/issues/counters → `state:'online'` normalized output
- (d) `resolveCloudAuth` → null → `state:'unauthenticated'`, no workspace lookup
- duplicate concurrent `factory:status` → `resolveCloudAuth` consulted **once**
  (covers the `factoryStatusInFlight` coalescer). Note: the IPC handler is `async`
  so it wraps the shared promise in a fresh one each call; the coalescing is
  therefore asserted via the single underlying `resolveCloudAuth` call (and equal
  resolved values), not via `===` promise identity.

## Finding 2 [Low] — Dead `factory:event` push path → FIXED (option b: delete dead plumbing)

The teardown's spec is a read-only manual snapshot (no main-side emitter), so the
dead subscription plumbing was removed rather than wiring up polling:
- `src/shared/types/ipc.ts`: removed the `FactoryEvent` type and `factory.onEvent`
  from the `PearAPI` factory surface.
- `src/preload/index.ts`: removed the two `FactoryEvent` type imports and the
  `onEvent`/`subscribe('factory:event')` binding.
- `src/renderer/src/lib/ipc-mock.ts`: removed the `onEvent` mock entry.
- `src/renderer/src/components/factory/FactoryPage.tsx`: the mount effect no longer
  subscribes; added a comment documenting that status is a read-only snapshot
  fetched on mount and via the manual Refresh button (daemon removed in p5).

Grep confirms no `FactoryEvent` / `factory:event` / `factory.onEvent` references
remain (only the explanatory comment in `FactoryPage.tsx`).

## Finding 3 [Low] — read/save asymmetry for `cloneRoot`/`clonePaths` → FIXED

Added a comment above `extractNodeConfig` in `src/main/ipc-handlers.ts` documenting
that NodeConfig fields live at the **top level** (where `NodeConfigSchema` picks
them), distinct from the workspace-level `repos.*` block; read falls back into
`repos.*`, save always promotes to the top level. The asymmetry is now pinned by
the "promotes edited NodeConfig fields to the top level, leaving repos.* untouched"
test, which fails loudly if the loader location ever changes.

## Finding 4 [Nit] — duplicate React keys from issue buckets → FIXED

`normalizeFactoryCloudStatus` now dedups issues by `key` (keep first occurrence)
across the `issues` + `inFlight`/`inflight` + `queued` buckets via a `Set`, with a
comment referencing the AGENTS.md "treat duplicate delivery as normal" guidance.
Covered by the 200-payload test (AR-1 appears in two buckets → `issues.length === 2`).

## Commands run (all from the worktree root)

- `env -u AGENT_RELAY_BROKER_PID npx vitest run src/main/ipc-handlers.test.ts` → 21/21 pass
- `npm run typecheck:node` → PASS
- `npm run typecheck:web` → PASS
- `npx eslint <all changed files>` → clean (no output)
- `env -u AGENT_RELAY_BROKER_PID npx vitest run` → **31 files, 438 tests, all pass**

## Files changed

- `src/main/ipc-handlers.ts` (dedup + doc comment)
- `src/main/ipc-handlers.test.ts` (new factory config + status test suites)
- `src/shared/types/ipc.ts` (removed `FactoryEvent` + `factory.onEvent`)
- `src/preload/index.ts` (removed `FactoryEvent` imports + `onEvent` binding)
- `src/renderer/src/lib/ipc-mock.ts` (removed `onEvent` mock)
- `src/renderer/src/components/factory/FactoryPage.tsx` (removed dead subscription, added comment)
