# HANDOFF — Pear Issue-Management Control Center (Attention Inbox)

Date: 2026-06-09. Lead: claude-1. Build agents: implementer (codex), claude-2 (nav), shadow-reviewer.
Spec: `docs/specs/2026-06-09-issue-control-center.md` (all design decisions LOCKED there).

## Status: Phase 1 COMPLETE — real Linear data live in Electron (verified after restart)

The Attention Inbox loads in both the web build (mock fixtures) and the real
Electron app (67 real Linear issues from the Agent Relay team). Khaliq confirmed
the real board renders after restarting Pear.

## What it is
- **Attention Inbox, NOT kanban.** 3 bands: ⚠ Needs you / ◐ In motion / ✓ Settled.
  Status (7-stage) is a derived chip; actor (agent/pairing/human) is a label. Empty when calm.
- **3-level drill:** L1 overview card (with a live agent-authored "what's happening"
  one-liner) → L2 status detail (stage, trajectory, GitHub PR/CI) → L3 jump INTO the
  live Pear project/agent implementing the issue.
- **Bidirectional nav:** forward jump (card → project) + reverse `▸ implementing PEAR-X`
  chip (agent view → card) + `↩ PEAR-X` breadcrumb (Electron-only).
- **Web-first:** same component runs on mock IPC (`npm run dev`/`build:web`, browser) and
  real IPC (Electron) with no rewrite.

## How real data loads (IMPORTANT — not what it looks like)
- Reads via the **remote SDK**, NOT local files and NOT historical sync.
  `issues-store` → `listRemoteDir/readRemoteFile` → `withIntegrationRemoteHandle`
  → `RelayfileSetup.joinWorkspace(accountWorkspaceId rw_7ccfea89)` → `listTree/readFile`.
- The 67 records were already in the remote Relayfile workspace (webhook/initial-sync,
  complete). `downloadHistoricalData` (local mirroring) is irrelevant to the Inbox and
  can be left off.

## Why a restart was required
The two changes that unlock real data live in the **main process** and are read at
Electron startup: (1) Fix 1 (the read-seam workspace routing in `integrations.ts`),
and (2) the integration scope mount (`updateScope` adding `/linear/issues`). The web
build hot-reloads, but main-process reads needed the restart. Done; now live.

## Working tree (UNCOMMITTED — on branch `feat/mount-optional-dep-no-postinstall`)
New:
- `src/renderer/src/components/issues/` — AttentionInbox + L1 card + L2 detail
- `src/renderer/src/stores/issues-store.ts` — load/normalize/band/onEvent; `agentForIssue`/`issueForAgent`; payload-unwrap (real `{envelope,payload}` AND flat fixtures)
- `src/renderer/src/lib/issue-navigation.ts` — `jumpToIssueWork` (L3, avoids ui-store↔agent-store import cycle)
- `docs/specs/2026-06-09-issue-control-center.md` — spec
Modified:
- `src/main/integrations.ts` — **Fix 1**: `withIntegrationRemoteHandle` routes reads to the account workspace + caches the handle (1 join, N reads); scope-containment checks unchanged
- `src/renderer/src/stores/ui-store.ts` — `'issues'` tab kind + `selectedIssueId`/`agentJumpIssueId` (localStorage-persisted)
- `src/renderer/src/App.tsx` — route only (propless `<AttentionInbox/>`; component derives projectId from store)
- `src/renderer/src/components/sidebar/ProjectSidebar.tsx` — global "Issues" nav entry
- `src/renderer/src/components/terminal/TerminalPane.tsx` — reverse `▸ implementing` chip
- `src/renderer/src/lib/ipc-mock.ts` — Linear/GitHub fixtures + agent narration

NOTE: this branch also carries the unrelated `dc80afb` (relayfile-mount optional-dep) — separate work; don't bundle in the control-center commit.

## Real Linear scope mutation — REVERSIBLE
`updateScope` added `/linear/issues` to the Agent Relay Linear integration (team
`50cf92f3-f53c-4ab6-bf05-ea76ebd21692`); merge-safe, zero removals.
**Revert recipe / pre-image backup:** `/tmp/projects.json.before-linear-issues-union.1781006398577`
(pre-state: scope `{provider, providerConfigKey}`, mountPaths `['/integrations/linear/teams']`).

## Known / expected (NOT bugs)
- Real issues classify **mostly In-motion + actor `unknown`** because the 7 states +
  3 actor labels aren't codified in the Agent Relay Linear team yet → **Phase 0**.
- `↩ PEAR-X` breadcrumb is Electron-only by design (web stubs the jump).
- Phase-1 action buttons (approve/reject/reply/fork) are rendered but **inert** → Phase 2.
- `tsc -b` (full/main) is RED on **pre-existing** drift (broker/cloud-agent/test target/lib),
  NOT from this work. Renderer gate `tsc -p tsconfig.web.json` is GREEN; `npm run build:web` green.

## Next, in order
1. **Phase 0 — band/actor meaning on real data.** NOTE: the Linear writeback adapter
   exposes only issues/comments/agent-activities — it CANNOT create workflow states or
   labels; that's operator-UI work in Linear team settings (not agent-doable). DONE
   instead (2026-06-09, code-side, zero Linear chores): `issues-store` classifier now
   derives bands from real Linear signals — review-stage name → needs-you, completed/
   canceled state types + Merged/Done → settled, else in-motion; actor falls back to
   `human` when an issue is assigned (codified `agent/pairing/human` labels still win
   when present). OPTIONAL refinement: operator creates the 3 actor labels in Linear →
   agents apply them via issue writeback for authoritative actor tagging.
2. **Phase 2 — write path:** add `integrations.writeMount` IPC → make the inert buttons live (status move, comment, assign-and-spawn via existing spawn flow).
3. **Phase 3 — board steward:** proactive agent maintains the board (triage GitHub issues, move cards, write agent-session activities).
4. **Housekeeping:** commit the control-center working tree on its own branch (separate from `dc80afb`); pre-existing `tsc -b` drift is a separate cleanup; decide whether the latent Slack-picker improvement (Fix 1 side effect) is intended to ship.

## Team state
claude-1 (lead), implementer (codex), claude-2 (nav), shadow-reviewer — all parked.
Keep for Phase 0/2, or terminate via `remove_agent`. Verification artifacts:
`/tmp/v2-*.png`, `/tmp/v4-persist.png`, `/tmp/pear-attention-inbox*.png`.
