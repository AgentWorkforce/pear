# Spec 03 — Proactive Agents in Pear (remaining work)

> Slimmed 2026-05-21 to **only what is missing**. The proactive-agent main-process
> scaffolding exists in pear, but the **UI is not wired in** and the cloud backend
> is **not built**. This is the least-complete of the three; the gaps below are
> what remain. Depends on [[05-integrations-connect]] (account workspace) and
> [[04-cloud-agent-box]] (sandbox runtime).

## Already implemented (do not touch)

`src/main/proactive-agent.ts` + `proactive-agent.types.ts` + `proactive-agent.bundle.ts`
(`ProactiveAgentManager`), the 10 `proactive-agent:*` IPC channels, the
`proactiveAgent` preload namespace, the `Project.proactiveAgents` store schema,
and the component **files** `ProactiveAgentCard.tsx`, `ProactiveAgentEditor.tsx`,
`ProactiveAgentsSection.tsx` (defined but unmounted — see below). The
`../workforce` persona-kit `watch` field exists.

## Remaining work

### 1. Mount the proactive UI (pear)

The components exist but are **never rendered**, and the editor tab is **not
wired**:

- Render `<ProactiveAgentsSection>` inside `ProjectSettings.tsx`.
- Add `'proactive-agent-editor'` to the `AppTabKind` (and `ViewMode` if needed)
  union in `src/renderer/src/stores/ui-store.ts`, and extend `AppTabInput` with
  the `personaId` field `ProactiveAgentsSection` already passes when it opens the
  tab. (Today `ProactiveAgentsSection.tsx` references `kind: 'proactive-agent-editor'`
  but the union doesn't include it.)
- Render `<ProactiveAgentEditor>` in `App.tsx` for `activeTab?.kind === 'proactive-agent-editor'`.

### 2. Editor dependency (pear)

The editor needs Monaco. Add `@monaco-editor/react` to `package.json` and use it
in `ProactiveAgentEditor.tsx` for the persona/handler source.

### 3. Vendored runtime types (pear)

There is no `vendor/` directory. Add `scripts/sync-runtime-types.mjs` that writes
`vendor/agentworkforce-runtime-types.d.ts` (the persona/runtime types the editor
type-checks against), and wire it into the build/typecheck.

### 4. Cloud proactive-personas backend (`../cloud`)

Build the cloud surface the deploy flow targets (none of this exists yet):

- Routes `api/v1/workspaces/[workspaceId]/proactive-personas/route.ts` and
  `…/proactive-personas/[personaId]/route.ts` with `POST`/`GET`/`PATCH`/`DELETE`.
- A `proactive_personas` table in `packages/core/src/db/schema.ts` (+ migration).
- `packages/core/src/runtime/proactive-trigger-router.ts` and
  `packages/core/src/runtime/proactive-runner.ts`.

### 5. Workforce deploy cloud mode (`../workforce`)

Unstub `packages/deploy/src/modes/cloud` so a proactive persona deploys to the
cloud route above (`grep proactive-personas` should match after).

## Acceptance (only the remaining gates)

1. **Build clean.** `npm run build` exits 0.
2. **Section mounted.** `grep "ProactiveAgentsSection" src/renderer/src/components/settings/ProjectSettings.tsx` ≥1.
3. **Editor tab wired.** `grep "proactive-agent-editor" src/renderer/src/stores/ui-store.ts` ≥1 **and** `grep "ProactiveAgentEditor" src/renderer/src/App.tsx` ≥1.
4. **Monaco present.** `grep "@monaco-editor/react" package.json` ≥1.
5. **Vendored types.** `node scripts/sync-runtime-types.mjs` exits 0 and `vendor/agentworkforce-runtime-types.d.ts` is non-empty.
6. **Cloud routes + schema.** Both `proactive-personas` route files exist with `POST`/`GET`/`PATCH`/`DELETE`; `grep -E "proactive_personas|proactivePersonas" ../cloud/packages/core/src/db/schema.ts` ≥2; `proactive-trigger-router.ts` and `proactive-runner.ts` exist.
7. **Workforce deploy cloud mode.** `grep "proactive-personas" ../workforce/packages/deploy/src/modes/cloud*` ≥1.
8. **Smoke test.** `pear/test/proactive-agent.smoke.ts` (vitest, mocks `@agentworkforce/deploy` + cloud HTTP) does create → deploy → simulated change event → run row `succeeded`, runs <30s, exits 0.

## Manual verification

1. Project Settings → Proactive Agents section is visible; "New" opens the Monaco
   editor in a tab; save a persona.
2. Deploy it; trigger its watched relayfile path (e.g. open a GitHub issue via a
   connected integration); confirm a run appears and reaches `succeeded`.

### Workflow (mandatory)

Implement in git worktrees, end with a PR per touched repo:

```bash
# in pear
git worktree add ../pear.wt-proactive -b ricky/wave-pear-cloud-agents/03-proactive-agents
# in ../cloud
git worktree add ../cloud.wt-proactive -b ricky/wave-pear-cloud-agents/03-proactive-agents
# in ../workforce
git worktree add ../workforce.wt-proactive -b ricky/wave-pear-cloud-agents/03-proactive-agents
```

Open one PR per repo (`pear`, `../cloud`, `../workforce`) from that branch,
cross-linked, quoting the acceptance-gate results. Remove the worktrees once the
PRs are open. See the wave README "Workflow" section.
