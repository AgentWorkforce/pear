# Pear by Agent Relay

Pear is a macOS Electron desktop workspace where humans and AI agents collaborate in real time. It provides shared terminals (xterm.js), a chat layer, live git diffs, and integrations — all brokered through a local Agent Relay server that manages agent lifecycles, PTY streams, and IPC between the main process and the React UI.

**Stack:** Electron 42 · electron-vite 5 · React 19 · Zustand 5 · xterm.js 5.5 · Tailwind CSS 4 · TypeScript 5.7 · Vite 6

---

## Quick start

**Prerequisites:** Node 22 (matches CI).

```sh
npm install
npm run dev
```

`npm run dev` launches the electron-vite dev server with hot reload for the renderer and live-reloads the main process on changes.

---

## Directory map

```
src/
  main/             Main process: broker lifecycle, agent orchestration, IPC handlers
    __tests__/      node:test suite (see Testing below)
    broker.ts       Agent Relay broker — start/stop, PTY routing, event streaming
    integrations.ts Integration management (mounts, symlinks, catalog)
    cloud-agent.ts  Cloud agent state sync
    auth.ts         Authentication
    git.ts          Git helpers
    ipc-handlers.ts Electron IPC handler registration
  renderer/
    src/            React UI
      components/   UI components (terminal panels, chat, git diff viewer, …)
      stores/       Zustand stores
      hooks/        React hooks
      lib/          Renderer-side utilities
  preload/          Context bridge — exposes typed IPC API to the renderer
  shared/           Types, schemas, and IPC contracts shared across processes
    types/
    schemas/
    lib/

scripts/            Build and verification helpers (see scripts/README.md)
docs/specs/         Design documents for in-progress and recent features
tests/playwright/   Browser-mode integration and stress test suites
```

---

## Testing

There are four test runners; each targets a different scope.

### 1. `npm test` — node:test (main process unit tests)

```sh
npm test
```

Runs `src/main/__tests__/*.test.ts` directly with Node's built-in test runner via `--experimental-strip-types`. No build step required.

### 2. `npx vitest run` — Vitest (unit + DOM)

```sh
npx vitest run
```

Runs two projects defined in `vitest.config.mjs`:

| Project | Environment | Includes |
|---------|-------------|----------|
| `node`  | node        | `src/main/**/*.test.ts`, `src/renderer/src/**/*.test.ts`, `packages/**/*.test.ts` (excludes `src/main/__tests__/` and `*.dom.test.ts`) |
| `dom`   | happy-dom   | `src/renderer/src/**/*.dom.test.ts` |

### 3–5. Playwright suites — browser integration tests

All three Playwright suites require a production web build first:

```sh
npm run build:web   # vite build --config vite.web.config.ts
```

| Script | Config | Spec(s) | What it tests |
|--------|--------|---------|---------------|
| `npm run test:fidelity` | `playwright.fidelity.config.ts` | `fidelity-no-duplication.spec.ts` | Event deduplication correctness |
| `npm run test:stress`   | `playwright.stress.config.ts`   | `stress-1000-agents.spec.ts`, `stress-explorer.spec.ts` | High-agent-count stability |
| `npm run test:redraw`   | `playwright.redraw.config.ts`   | `redraw-drain.spec.ts` | Terminal redraw / drain throughput |

Each suite starts a `vite preview` server on a fixed port and runs Playwright against it.

---

## Build & release

### Development build

```sh
npm run build
```

Runs `generate:mcp-resources` first (produces MCP extra-resources manifest), then `electron-vite build`. The `verify:mcp-resources-drift` check gates CI — if the generated manifest is out of date the build fails.

### Local macOS package

```sh
npm run dist:mac
```

Applies the macOS icon mask, builds, then runs `electron-builder --mac --publish never`. Output lands in `dist/`.

### Release (signed + notarized)

Releases are triggered manually via **Actions → "Release (macOS)" → Run workflow**. The workflow:

1. Computes a date-based version (`YEAR.MONTH.N`, e.g. `2026.6.1`).
2. Generates a changelog from GitHub's release-notes API.
3. Builds, code-signs (Developer ID), and notarizes via App Store Connect API — with up to 3 retries for transient Apple notary failures.
4. Uploads to a draft GitHub Release, then publishes it (making it the `latest` release so `electron-updater` and the `/pear/download` URL pick it up).

Secrets required: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

---

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`:

- `verify:mcp-resources-drift` — fails if the MCP resources manifest needs regeneration
- `npm test` — node:test suite
- `npx vitest run src/main/broker.test.ts` — broker-specific Vitest coverage
- `npm run build` — full Electron build

A separate `packaged-mcp-smoke` job builds a macOS package and runs `verify:mcp-spawn` to confirm packaged MCP servers launch correctly.

---

## Further reading

- **`AGENTS.md`** — Duplicate-event hardening doctrine. Required reading before touching broker start, event streaming, PTY buffering, or integration notifications.
- **`docs/specs/`** — Design documents for multi-instance support, integration event re-drive, issue control center, and workforce persona agents.
- **`scripts/README.md`** — What each script does, including the integrations catalog builder and the prove-* verification scripts.
