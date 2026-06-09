# Pear as Issue-Management Control Center — Design Spec

Source: 2026-06-09 standup (Khaliq + Will). Status: DESIGN / FOR REVIEW.
Implementer: `implementer` (codex). Lead: claude-1.

## Thesis

Pear becomes the **control center** for issue management — a normalized view
over Linear + GitHub (+ later Jira/shortcut) where the **agent maintains the
board and the human watches and intervenes**. Not a PM tool we hand-curate:
"minimal human UI, maximally agent-action oriented. The UI is a visualization of
what the agent is doing." (Will, standup.)

The key realization from the codebase audit: **we do not build a new task
database.** Pear already has the entire substrate. "Implement this cleaner" =
render the integration mounts we already have, add one write primitive, and let
a proactive agent drive the board.

## What already exists (foundations)

| Primitive | Where | Why it matters |
|---|---|---|
| Linear as normalization layer | `/linear/issues` records carry `state` (column), `labels`, `assignee`, `project`, and `syncedWith` → linked GitHub PR/issue | A normalized board is *read the Linear mount, join GitHub by `syncedWith`*. No new schema. |
| Native agent trajectory | `/linear/agent-sessions/{sessionId}/activities` (Linear Agent Sessions API, exposed as writeback) | This **is** the "trajectory of each decision point" Will wants. Linear renders it too. Schema is currently empty — inferred on first sync; needs one real session to populate. |
| Writeback (agent action path) | `.adapter.md` per provider; agents write JSON files under mount roots: issue `stateId` update, comments, PR `merge.json`, reviews | Agents already act by writing files. Moving a card = update `stateId`. |
| Renderer read IPC | `window.api.integrations.listRemoteDir` / `readRemoteFile` / `listMountDir` / `readMountPreview` (`src/shared/types/ipc.ts:978-981`) | Renderer can already read issues out of the mounts. |
| Real-time event stream | `relayfile-change` events → `integrations.onEvent` (`ipc.ts:1009`); produced by `integration-event-bridge.ts` `ChangeEvent` pipeline | Board re-reads on change → watch an agent move a card / pick up an issue live. "I want to see the spawn happen in pear." |
| Local trajectories | `.trajectories/` (+ `.trajectories/completed/`) | Link a Linear agent-session activity → local trajectory file = "jump to that part of the conversation, fork from there." |
| Renderer nav shell | tab system in `src/renderer/src/stores/ui-store.ts` (`AppTabKind`, `ViewMode`); view switch in `src/renderer/src/App.tsx:99-117`; sidebar in `components/sidebar/` | Adding a surface is: new tab kind + view + sidebar entry. Clean seam. |
| Spawn flow | `SpawnAgentDialog`, `lib/spawn-agent.ts`, broker `add_agent` | "Assign to agent" reuses this → closes the see-the-spawn loop. |
| Proactive agents | `src/main/proactive-agent.ts` + `components/proactive/` | The board-maintainer agent (Phase 3) runs on existing infra. |

**The only genuinely new main-process primitive is a renderer write IPC**
(`integrations.writeMount`). Today only agents write to mounts; the renderer is
read-only.

## Status model (resolves the standup debate)

The standup circled on "should statuses be human vs agent." Resolution: **actor
is a label, stage is a status. Orthogonal.**

- **Statuses (stage):** `Backlog → Planning → To do → In Progress → In review →
  Merged → Done`. ("QA" and "Watching" fold into *In review* as the optional
  human gate — where the standup landed.)
- **Labels (actor / how):** `agent`, `pairing`, `human`.

Maps 1:1 onto Linear workflow states + labels, so **Phase 0 is configuration,
not code**, and an agent can apply it via writeback today.

## Backing-store decision (locked direction)

Linear = source of truth now. GitHub = synced mirror (`syncedWith`). Renderer =
normalized read layer. This matches the standup arc: "use Linear now → board
management moves to agents → becomes a stateless DB → eventually an
agent-relay-backed task list." Because the read layer is normalized, **swapping
the backing store later is a store change, not a UI rewrite.** GitHub Issues are
supported out of the box for OSS triage (read + comment + triage-label).

## Primary view — Attention Inbox (LOCKED)

Decided 2026-06-09 (Khaliq). **Not a kanban board** — a kanban just rebuilds the
Linear UI and isn't AI-native (the standup's "already structure, nothing new"
objection). The organizing axis is **attention, not status**. The human is a
triage queue that drains; the default calm state is empty.

```
INBOX · pear                            3 need you
──────────────────────────────────────────────────
⚠ NEEDS YOU            (only humans can clear these)
  PEAR-145  review PR #182          ⑂  ✓ ✗
  PEAR-149  "which auth flow?"      reply
──────────────────────────────────────────────────
◐ IN MOTION                              (4) ▾   ← collapsed/ambient
  implementer · PEAR-148 · editing ipc.ts · 2m
──────────────────────────────────────────────────
✓ SETTLED today                          (6) ▾
──────────────────────────────────────────────────
              ·  all clear when empty  ·
```

Three bands:
- **⚠ Needs you** — pinned top. The only items requiring a human: review gates
  (*In review*), agent questions, blocks. Inline actions (approve/reject/reply/
  fork). This is Will's "show what agents need for your attention."
- **◐ In motion** — collapsed by default, ambient. Live agent work (`editing
  ipc.ts · 2m`), updates in place from `relayfile-change` + the broker agent
  graph. Expand to watch.
- **✓ Settled** — collapsed. Recently shipped/merged, for audit.

Status (the 7-stage model) is **derived metadata on each row**, never the axis.
Kanban survives only as an optional "explorer" lens for when someone wants
pipeline structure. Every row deep-links to its trajectory ("jump to that
decision / ⑂ fork from here").

## Navigation — progressive drill-down (LOCKED)

Decided 2026-06-09 (Khaliq). Each issue is **one overview card**; you drill
deeper in two clicks, ending *inside the live Pear workspace doing the work*.

```
L1  Overview card        L2  Status detail        L3  The Project (live)
┌────────────────┐  ▸    ┌──────────────────┐  ▸  ┌────────────────────┐
│ PEAR-148       │       │ PEAR-148         │     │  Pear ▸ project X  │
│ writeMount     │       │ stage: In Prog.  │     │  agent: implementer│
│ ◐ implementer  │       │ ◐ editing ipc.ts │     │  ┌──────────────┐  │
│ ┄┄ agent chat ┄│       │ trajectory ↓     │     │  │ live terminal│  │
│ "wiring write- │       │  🤖 decided …  ↗ │     │  │ / agent chat │  │
│  Mount thru    │       │ PR #182 · CI ✓   │     │  └──────────────┘  │
│  preload, 1    │       │  [open project ▸]│     │  you are now here  │
│  type left" 2m │       └──────────────────┘     └────────────────────┘
└────────────────┘
   glance + live narration
```

- **L1 — Overview card** (in the Inbox band): one glanceable card per issue —
  title, derived stage, the actor/agent working it, AND an **embedded agent-chat
  snippet: a concise, live, agent-authored "what is happening"** in the agent's
  own words (e.g. *"wiring writeMount through preload, one type mismatch left"*),
  not just a raw tool-activity line. The card should feel like watching a
  teammate, not reading a status field. Source: the latest broker chat message
  from the assigned agent (`pear.broker` chat stream / reconciled messages) or
  the newest agent-session activity, truncated to one line; updates live via
  `onEvent`. Tapping the snippet expands the recent chat inline before you commit
  to L2/L3.
- **L2 — Status detail** (click the card): the full picture — derived stage,
  agent-session activity / trajectory timeline (with `↗ jump` / `⑂ fork`), synced
  GitHub PR + CI, comments. The "what's going on" view. Ends with the **[open
  project ▸]** affordance.
- **L3 — The Project** (click in from L2): **navigates into the Pear project +
  agent session that's implementing this issue** — its live terminal / agent
  chat. You land on the agent doing the work, live. Reuses the existing shell
  nav: resolve issue `assignee` → agent name → its `projectId` + agent key →
  `setActiveProject` + `openTab({kind:'agents'})` + `setActiveAgentKey`.

The L2→L3 join is the crux of the whole product: issue → assigned agent → its
project/session → open it. In the **web-first** build, L3 is a stub that fires
the nav intent (toast/log of the resolved target) since the browser has no real
projects; the same call routes to real shell nav when running in Electron.

## Navigability — Control Center ⟷ Project/Agent view (LOCKED)

The issue and the live work are **two faces of one thing**; you round-trip in a
single click each way, and your place is preserved. Join key:
`issue.assignee → agentName → (projectId, agentKey)` and its inverse, kept as an
**agent⟷issue index** in `issues-store`.

1. **Forward — CC → live work (L3 jump):** card → resolve assignee:
   - *Agent running* → `setActiveProject(projectId)` + `openTab({kind:'agents',
     projectId})` + `setActiveAgentKey(agentKey)`. Arrive with a breadcrumb chip
     **`↩ PEAR-148`** in the agent-view header (one click back to the card).
   - *Assigned but not spawned* → **"Spawn agent on PEAR-148"** (existing spawn
     flow), then land on it live — the see-the-spawn loop.
   - *Unassigned* → **"Assign & spawn"** CTA.
2. **Reverse — Project → CC:** the agents/terminal view header shows
   **`▸ implementing PEAR-148`** whenever the active agent maps to an issue →
   click → opens the `issues` tab focused on that card.
3. **Return / back:** the `issues` tab **persists its selected-issue**; ui-store
   `navigateBack` (or re-clicking the Issues tab) restores your place. A jump
   never closes the inbox.
4. **Scope coupling:** the inbox is a **global cross-project** view; the agent
   view is project-scoped. From a project, "show this project's issues" filters
   the inbox; the inbox can also scope to the active project. Cross-project jump =
   project switch + tab open (tab model preserves both sides).

Web-first: forward jumps that need a real project are **stubbed** in the browser
(toast the resolved `(project, agent)` target); the identical call routes to real
shell nav in Electron. The reverse chip + selected-issue persistence work fully
in the browser against fixtures.

## Web-first delivery (LOCKED)

Build the Inbox as a **standalone web view first** so it's viewable in a browser
immediately, then folds into Pear with **zero rewrite**. The seam already exists:

| Mechanism | Where | Effect |
|---|---|---|
| `VITE_PEAR_MOCK_IPC=true` | `vite.web.config.ts` | web build forces mock IPC |
| auto-swap `pearMock` vs `electronPear` | `src/renderer/src/lib/ipc.ts` | same `pear` API, different backend |
| mock impl | `src/renderer/src/lib/ipc-mock.ts` | add sample Linear/GitHub issue fixtures here |
| build | `npm run build:web` → `out/web` | open in any browser |

Component code calls the same `pear.integrations.*` API in both modes. Web =
`pearMock` (fixtures). Electron = real mounts. No component change crossing over.

## Phased plan

### Phase 0 — codify workflow in Linear (no Pear code)
- Create the 7 workflow states on the team + the 3 actor labels via writeback.
- Owner: an agent (writeback). Deliverable: states/labels live in Linear.

### Phase 1 — Attention Inbox, web-first, read-only (the 80%)
- **Build & view in browser first** via `npm run build:web` (or vite dev) — mock
  IPC, no Electron needed. Then it drops into Pear unchanged.
- `lib/ipc-mock.ts`: add `pearMock.integrations.listRemoteDir/readRemoteFile`
  fixtures — a realistic set of Linear issues (varied states/labels/assignees,
  some with `syncedWith` GitHub links) + a couple of live "in motion" + "needs
  you" examples. This is what renders in the browser.
- `stores/issues-store.ts` (zustand): load via `pear.integrations.listRemoteDir('/linear/issues')`
  + `readRemoteFile`; normalize to an `Issue` view-model; join GitHub by
  `syncedWith`; classify each into a band (needs-you / in-motion / settled);
  subscribe to `pear.integrations.onEvent` (filter `relayfile-change` on
  `/linear/**` + `/github/**`) for live updates.
- `<AttentionInbox />` view: the 3 bands above. Needs-you expanded, in-motion +
  settled collapsed. Row = issue + actor chip + derived status + live activity
  line. Inline action affordances rendered but **inert in Phase 1** (wired in
  Phase 2).
- Wire into Pear: add `AppTabKind`/`ViewMode` `'issues'` in `ui-store.ts`, route
  in `App.tsx`, add sidebar entry.
- Row → detail: description, synced GitHub PR + CI status, agent-session activity
  timeline with trajectory deep-links into `.trajectories/`.
- **Read-only.** No mutations yet. Ships a viewable browser prototype first.

### Phase 2 — human actions (the write path)
- **New IPC `integrations.writeMount(projectId, integrationId, path, json)`** →
  writeback file create/update (the one new primitive). Mirror existing read IPC
  wiring in `src/main/ipc-handlers.ts` + `src/main/integrations.ts` + preload.
- Wire: drag card between columns → update issue `stateId`; comment composer →
  comment writeback; "assign to agent" → existing spawn flow + write `assignee`
  + `agent` label.
- Respect writeback contract: read `.schema.json` / `.create.example.json`, never
  set `readOnly` fields.

### Phase 3 — agent-native board maintenance (the thesis)
- A proactive "board steward" persona (on `proactive-agent` infra) that: triages
  inbound GitHub issues into Backlog, moves cards as work progresses, writes
  agent-session activities, requests human review by moving to *In review*.
- This is also Will's guardrail: the agent maintains the board, the human is not
  doing performative status updates.

## Non-goals (this spec)
- No new task database / agent-relay-backed store yet (that's the *eventual* arc).
- No Jira/shortcut adapters yet (architecture leaves room; not in scope).
- No web surface; Electron renderer only.
- No CRDT/merge — Linear is single source of truth; Pear writes through to it.
- No bidirectional GitHub-as-source authoring; GitHub is a synced mirror + triage.

## Open questions for review
1. Board grouping: by Linear team, by project, or unified across teams? (Standup
   hit the "statuses are team-specific" foot-gun — Phase 1 should pick one team
   or render team as a swimlane.)
2. Agent-activity rail: drive from Linear agent-sessions, from our live broker
   graph, or both merged? (Both is richer but needs a correlation key.)
3. `writeMount` conflict handling — do we need optimistic UI + reconcile on the
   `relayfile-change` echo, or block-until-confirmed?
4. Trajectory deep-link: what's the stable key joining a Linear agent-session
   activity to a local `.trajectories/` file?

## First implementer steps (Phase 1 scaffold)
1. Confirm a real Linear issue mount is populated: `listRemoteDir /linear/issues`.
2. Add the `'issues'` tab kind + a stub `<IssueControlCenter />` rendering raw
   normalized issues (prove the read path end-to-end before board UI).
3. Wire `integrations.onEvent` live refresh; verify a writeback from an agent
   moves a card without manual reload.
