# Fresh-eyes Review — factory p5 (pear teardown)

**Verdict: APPROVE WITH MINOR FINDINGS.** The teardown is clean and the core claims verify. No
hard blockers. Findings below are test-coverage gaps and dead/asymmetric surface, all actionable.

## What I verified (independently re-run, not trusted from self-reflection)

- `npm run typecheck:node` — PASS
- `npm run typecheck:web` — PASS (FactoryPage rewrite typechecks against the new `FactoryStatus`/`FactoryNodeConfig`)
- `npx vitest run src/main/ipc-handlers.test.ts` — PASS (10/10); the existing IPC test does **not** reference the deleted `factory-manager`, so the deletion broke nothing.
- Proof greps over `src bin scripts`: no `factory-sdk`, `factoryManager`, `FactoryManager`, `factory:start`, `factory:stop`, `FactoryLogLine`, `/tmp/factory-run`, `packages/factory-sdk`. Clean.
- No dangling callers of `pear.factory.start/stop` in the renderer.
- `bin/pear.mjs`: all imports still used after the `pear factory` branch removal — no dead imports.
- `@agent-relay/factory@0.1.1` is installed and exports `FactoryConfig`; the `Pick<FactoryConfig, 'capabilities'|'clonePaths'|'dryRun'> & Partial<Pick<…,'workspaceId'|'cloneRoot'>>` type resolves (those fields exist at the FactoryConfig top level).
- `auth.resolveCloudAuth` / `getAccountWorkspaceId` / `accountWorkspaceReadyRetryOptions` exist with the shape used (`CloudAuth` has `apiUrl` + `accessToken`); `fetch` in the Electron-42 main process is an established pattern (cloud-agent/integrations/broker all use it).
- `factoryStatusInFlight` in-flight coalescing aligns with the AGENTS.md "coalesce concurrent starts/attaches with keyed in-flight promises" rule.
- `electron-builder.mcp-resources.yml` diff is a benign regenerated artifact: the removed nested `@agent-relay/harnesses/node_modules/@agent-relay/broker-*` globs are deduped — the top-level `@agent-relay/broker-*` entries remain, so the broker binaries are still bundled. `@agent-relay/fleet/**` + `jiti/**` were added as factory transitive deps. No packaging regression.

## Findings

### 1. [Medium] New factory cloud-status + config-parsing logic has ZERO test coverage
**File:** `src/main/ipc-handlers.ts` (lines ~82–430)

The teardown added a substantial block of non-trivial, branch-heavy logic with no tests:
`normalizeNodeConfigInput`, `extractNodeConfig`, `readFactoryNodeConfig`, `saveFactoryNodeConfig`,
`normalizeIssue`, `normalizeAgent`, `normalizeFactoryCloudStatus`, `readFactoryCloudStatus`
(endpoint fallback on 404/405/501, 401/403 → `unauthenticated`, non-OK → `unavailable`, payload
normalization, config-shape detection on save). The existing `ipc-handlers.test.ts` does not touch
factory, and `npm test` (the `src/main/__tests__/*.test.ts` glob) does not even run the vitest file
that would.

**Required fix:** Add a vitest spec exercising this surface. The functions are module-private, so test
through the registered IPC handlers — the existing `ipc-handlers.test.ts` mock already captures
handlers via the `ipcMain.handle` mock. Required cases:
- `factory:read-config` / `factory:save-config` round-trip against a temp `factory.config.json` (assert the saved file shape and that a re-read reproduces the draft).
- `factory:status` with a mocked global `fetch`: (a) all endpoints 404 → `state: 'empty'`; (b) 401 → `state: 'unauthenticated'`, `connected: false`; (c) a 200 payload with `agents`/`issues`/`counters` → normalized output with `state: 'online'`; (d) unauthenticated (`resolveCloudAuth` → null) → `state: 'unauthenticated'`.
- A duplicate `factory:status` call while one is in flight returns the **same** promise (covers the `factoryStatusInFlight` coalescing — this is the AGENTS.md replay-hardening path and deserves an explicit regression test).

### 2. [Low] Dead `factory:event` push path — status never updates live
**Files:** `src/preload/index.ts:309`, `src/shared/types/ipc.ts:459` (`FactoryEvent`), `src/renderer/src/components/factory/FactoryPage.tsx:96-98`

Main no longer emits `factory:event` (the emitter was removed with `factoryManager`), but the channel
is still plumbed through preload, the `FactoryEvent` type, the mock, and `FactoryPage` subscribes via
`pear.factory.onEvent`. That subscription can never fire. Cloud status is therefore fetched only on
mount and on the manual Refresh button — there is no polling/auto-refresh.

**Required fix:** Pick one and make it intentional:
- (a) If a refreshing view is intended, add a polling interval in the `FactoryPage` effect (guard against overlap with the existing in-flight coalescer) — and add a test for it; **or**
- (b) If a manual read-only snapshot is the spec, delete the now-dead `onEvent`/`FactoryEvent`/`factory:event` plumbing (preload + type + mock + FactoryPage subscription), or leave a one-line comment marking it reserved for Phase 2 so it isn't read as live.

**Required test:** whichever path is chosen, assert the refresh behavior (mock returns a new status on the second `pear.factory.status()` and the UI reflects it after refresh/poll).

### 3. [Low] `read` vs `save` asymmetry for `cloneRoot` / `clonePaths`
**File:** `src/main/ipc-handlers.ts` — `extractNodeConfig` (reads `source.cloneRoot ?? repos?.cloneRoot`) vs `saveFactoryNodeConfig` (else branch writes top-level `{...raw, ...parsed.config}`)

This repo's `factory.config.json` is the compact single-source shape (operative values under `repos.cloneRoot`/`repos.clonePaths`, no `nodeConfig`/`factoryConfig` wrapper). On read, the editor
falls back into `repos.*`; on save it writes a **top-level** `cloneRoot`/`clonePaths` and leaves
`repos.*` untouched. Net: after editing "Clone root" and saving, the file carries both a top-level
`cloneRoot` (edited) and a stale `repos.cloneRoot`, which can silently diverge. This is *probably*
correct for the published loader (NodeConfigSchema picks the top-level fields), but the duplication is
a foot-gun and the read-fallback-then-promote behavior is undocumented.

**Required fix:** Add a brief comment documenting that NodeConfig fields live at the top level,
distinct from the workspace-level `repos.*`. **Required test:** the round-trip test from Finding 1
should assert the saved file shape explicitly against the `repos`-based input so this asymmetry is
pinned and any future loader-location change fails loudly.

### 4. [Nit] Issue list can emit duplicate React keys
**File:** `src/main/ipc-handlers.ts` — `normalizeFactoryCloudStatus`; `FactoryPage.tsx:187` (`key={issue.key}`)

`issues` is built by concatenating the `issues` + `inFlight`/`inflight` + `queued` buckets with no
dedup by `key`. If a speculative cloud payload lists the same issue in two buckets, React warns on
duplicate keys.

**Required fix:** dedup by `key` (keep first occurrence) before returning `issues` — also the more
correct behavior and consistent with the AGENTS.md "treat duplicate delivery as normal" guidance.
**Required test:** covered by adding a duplicate-key issue to the mocked payload in the Finding 1
`factory:status` test and asserting the returned `issues` length.

## Summary

Spec coverage is met: the in-Pear daemon model is fully removed (no `FactoryManager`, no spawn, no
heartbeat/reaper/registry, no `pear factory` passthrough, no `factory:start`/`stop` IPC), config IPC is
NodeConfig-only, and `FactoryPage` is a read-only cloud view + local NodeConfig editor. Typechecks and
the existing vitest pass; nothing dangling. The gaps are: (1) untested new parsing/status logic incl.
the coalescer, (2) a dead `factory:event` path with no auto-refresh, (3) an undocumented read/write
location asymmetry for `cloneRoot`/`clonePaths`, and (4) a duplicate-React-key nit. All are
test-and-polish items, not blockers.
