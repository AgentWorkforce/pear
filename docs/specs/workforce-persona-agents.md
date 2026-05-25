# Spec: Launch AgentWorkforce personas from Pear's Spawn Agent dialog

**Status:** Implemented in Pear local-agent flow.
**Scope:** local agents only.
**Spawn method:** SDK discovery plus full-fidelity AgentWorkforce CLI launch.

---

## 1. Goal

In Pear's local **Spawn Agent** dialog, in addition to the existing Claude / Codex
buttons, show a **dropdown of AgentWorkforce personas** discovered from the active
project root's `.agentworkforce` cascade. Selecting a persona and confirming launches
it as a first-class agent in the project — same place existing agents appear.

Concrete target the owner gave: with a project whose root is
`/Users/khaliqgant/Projects/AgentWorkforce/cloud`, the dropdown must list the
`nango-integrations` persona defined at
`cloud/.agentworkforce/workforce/personas/nango-integrations.json`, and launching it
must run that persona **with full fidelity** (its `agentsMdContent` operating manual,
`skills`, `mcpServers`, and `harnessSettings` all in effect).

---

## 2. Key background (already verified)

- The SDK Pear already depends on, `@agent-relay/sdk`, ships first-class
  AgentWorkforce persona support, re-exported from the package root (also at
  `@agent-relay/sdk/personas`):
  - `listPersonas({ cwd }): DiscoveredPersona[]` — `{ id, path, spec }`. The default
    search cascade includes `<cwd>/agentworkforce/personas`,
    `<cwd>/.agentworkforce/workforce/personas`, `~/.agentworkforce/workforce/personas`,
    and `$AGENT_WORKFORCE_HOME/personas`. This is exactly where the cloud personas live.
  - `loadPersona`, `buildPersonaSpawnSpec`, `composePersonaTask`,
    `materializePersonaConfigFiles`, `restorePersonaConfigFiles`.
- **Critical limitation of the SDK persona path:** `buildPersonaSpawnSpec` only carries
  `harness / model / systemPrompt / mcpServers / permissions`. It **drops** `skills`,
  the sidecar markdown (`claudeMdContent` / `agentsMdContent`), `mount`, and `inputs`
  (the SDK docstring says so explicitly). The `nango-integrations` persona has an empty
  `systemPrompt` and puts its whole manual in `agentsMdContent`, so the SDK path would
  launch a nearly empty codex agent. **This is why we spawn via the CLI for fidelity.**
- The `agentworkforce` CLI (`agentworkforce agent <persona-id>`) runs the persona with
  full fidelity: installs skills, applies mount policy, injects sidecar markdown,
  renders inputs, then spawns the harness.
- Pear's broker (`src/main/broker.ts`) uses the lower-level `AgentRelayClient`
  (`session.client`), which exposes `spawnPty` but **not** `spawnPersona` (that lives on
  the higher-level `AgentRelay` class). Existing spawn flow:
  `SpawnAgentDialog` → `spawnProjectAgent` (`src/renderer/src/lib/spawn-agent.ts`) →
  `pear.broker.spawnAgent` → IPC `broker:spawn-agent`
  (`src/main/ipc-handlers.ts:209`) → `BrokerManager.spawnAgent`
  (`src/main/broker.ts:1025`) → `session.client.spawnPty(...)`.

---

## 3. Scope

**In scope:** the local `SpawnAgentDialog` flow only.
**Out of scope:** cloud (Daytona) `CloudAgentPicker`; creating/editing personas from
Pear; persona *tier* selection UI (use SDK default tier; leave a follow-up note).

---

## 4. Design

### 4.1 Discovery (main process)

Add `BrokerManager.listPersonas(projectId): WorkforcePersona[]`:
- Resolve the session for `projectId`; use `session.cwd` (the active root path) as `cwd`.
- Call `listPersonas({ cwd })` from `@agent-relay/sdk`.
- Map each `DiscoveredPersona` → `WorkforcePersona`
  `{ id, description?, harness?, tags?, source }` (`source` = file path; `description`,
  `harness`, `tags` read from `spec`).
- Swallow/log load errors; return `[]` if the dir is absent. Never throw to the renderer
  for "no personas" — that's a normal empty state.

New IPC channel `broker:list-personas` in `src/main/ipc-handlers.ts` (next to
`broker:spawn-agent`, ~line 209):
```ts
ipcMain.handle('broker:list-personas', async (_, projectId: string) =>
  brokerManager.listPersonas(projectId))
```

### 4.2 Spawn (main process)

Add `BrokerManager.spawnPersona(projectId, personaId, opts?)`. Pear discovers personas
via the SDK, then spawns via the pinned `agentworkforce` CLI for fidelity.

1. **Resolve the persona** with `findPersona(personaId, { cwd: session.cwd })` to get its
   on-disk path / harness (for naming + validation). Fail clearly if not found.
2. **Spawn through the broker PTY so relay env is injected**, by treating the
   `agentworkforce` CLI as the command:
   ```ts
   await session.client.spawnPty({
     name,                      // from getAvailableAgentName(personaId, existing)
     cli: <agentworkforce-bin>, // resolve: see note below
     args: ['agent', '--install-in-repo', personaId],
     cwd: session.cwd,
     channels: session.channels,
     skipRelayPrompt: true,     // CLI owns the harness prompt
   })
   ```
   - **Resolve the binary:** prefer a project-local install, Pear's pinned
     `agentworkforce` dependency, a PATH install, or pinned `npx -y agentworkforce@<version>`.
     Detect and, if unavailable, surface a clear error to the renderer
     ("AgentWorkforce CLI not found — install it to launch personas").
   - Reuse `getAvailableAgentName(personaId, existingNames)` + the existing 20-try
     conflict loop from `spawnAgent` (broker.ts:1042-1062). Default name = persona id.
   - Record the agent→project mapping via `rememberAgentProject` like `spawnAgent` does.
3. **Broker registration check:** after spawn, wait briefly for the spawned PTY worker to
   appear in `session.client.listAgents()` and remain present. This confirms Pear can show
   and attach the terminal. It is not a substitute for end-to-end relaycast MCP testing,
   so persona launches use `--install-in-repo` up front to avoid the relayfile sandbox path
   that can hide broker-injected MCP configuration for Claude/OpenCode personas.

### 4.3 Shared types — `src/shared/types/ipc.ts`

- Add:
  ```ts
  export interface WorkforcePersona {
    id: string
    description?: string
    harness?: string
    tags?: string[]
    source?: string
  }
  ```
- Extend `PearAPI.broker` (around line 595-628):
  ```ts
  listPersonas: (projectId: string) => Promise<WorkforcePersona[]>
  spawnPersona: (projectId: string, personaId: string) => Promise<BrokerSpawnAgentResult>
  ```

### 4.4 Preload — `src/preload/index.ts` (~line 193, beside `spawnAgent`)

```ts
listPersonas: (projectId: string) =>
  invoke<WorkforcePersona[]>('broker:list-personas', projectId),
spawnPersona: (projectId: string, personaId: string) =>
  invoke<BrokerSpawnAgentResult>('broker:spawn-persona', projectId, personaId),
```
Add the matching `broker:spawn-persona` handler in `ipc-handlers.ts`.

### 4.5 Renderer logic — `src/renderer/src/lib/spawn-agent.ts`

Mirror `spawnProjectAgent` (lines 24-75):
- `listProjectPersonas(project): Promise<WorkforcePersona[]>` — ensure active
  project/broker, get active root, call `pear.broker.listPersonas(project.id)`.
- `spawnProjectPersona(project, personaId): Promise<string>` — set active project /
  `ensureBroker`, validate `root.pathExists`, call `pear.broker.spawnPersona`, then
  `attachTerminal({ mode: 'passthrough' })`, `trackSpawnedAgent` (cli = persona harness
  if known, else the persona id), `setActiveAgentKey`, open the agents tab — exactly as
  `spawnProjectAgent` does.

### 4.6 Renderer UI — `src/renderer/src/components/sidebar/SpawnAgentDialog.tsx`

- Below the existing Claude/Codex 2-col grid, add a **"Workforce personas"** section:
  a labeled `<select>` (style consistent with the dialog; see `CloudAgentPicker.tsx`
  harness dropdown for an existing select pattern) plus a **Launch** button.
- Load personas on mount via `listProjectPersonas(project)` (only when a project exists);
  show a loading state, and an empty state "No workforce personas found in this project"
  when the list is empty. Don't block the Claude/Codex buttons on this fetch.
- Disable the select/Launch when `!root?.pathExists` or while spawning, consistent with
  the existing buttons.
- On Launch: call `spawnProjectPersona(project, selectedId)`, then `closeDialog()`;
  reuse the existing `error` surface for failures (incl. "CLI not found").
- Keep the existing focus-trap (`handleDialogKeyDown`) working with the new controls.

---

## 5. Acceptance criteria

1. With the active root at `…/AgentWorkforce/cloud`, the dropdown lists
   `nango-integrations` (and `autonomous-actor`). Discovery is non-blocking with a clean
   empty state elsewhere.
2. Launching `nango-integrations` starts an agent that runs **with the persona's full
   instructions and skills** in effect (verify the `agentsMdContent` manual is present —
   not an empty codex).
3. The launched agent is broker-registered and attachable in Pear; persona launch uses
   the CLI `--install-in-repo` path for full fidelity while avoiding the relayfile mount
   path that can hide broker-injected MCP configuration.
4. Existing Claude/Codex spawn buttons are unchanged and still work.
5. `npm run build` and the focused TypeScript checks for touched files pass; no new
   `any` leaks across the IPC boundary.

## 6. Files to touch

- `src/main/broker.ts` — `listPersonas`, `spawnPersona`, binary resolution.
- `src/main/ipc-handlers.ts` — `broker:list-personas`, `broker:spawn-persona`.
- `src/shared/types/ipc.ts` — `WorkforcePersona`, `PearAPI.broker` additions.
- `src/preload/index.ts` — two new bridges.
- `src/renderer/src/lib/spawn-agent.ts` — `listProjectPersonas`, `spawnProjectPersona`.
- `src/renderer/src/components/sidebar/SpawnAgentDialog.tsx` — dropdown + Launch UI.

## 7. Follow-ups (not now)

- Persona tier selector (`@tier`).
- Cloud/Daytona persona selection in `CloudAgentPicker`.
- Full end-to-end relaycast MCP registration test for launched personas.
