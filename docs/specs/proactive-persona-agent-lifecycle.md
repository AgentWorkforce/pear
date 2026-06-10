# Proactive Persona Agent Lifecycle

This document maps the Pear-side lifecycle for proactive persona agents and the
cloud-owned runtime boundary. It is based on the current Pear implementation in
`src/main/proactive-agent.ts`, `src/main/proactive-agent.bundle.ts`,
`src/main/cloud-agent.ts`, `src/main/broker.ts`, and the renderer paths that call
them.

## System Boundary

Pear owns authoring, local persistence, persona bundle staging, deployment calls,
optional cloud sandbox attachment, local Relayfile mounting, and broker event
fan-out. The Cloudflare worker trigger and hosted proactive runtime are owned by
the AgentWorkforce cloud deployment path. Pear declares watch rules and uploads
the bundle; cloud matches those rules and invokes the deployed handler.

```
+----------------------+        +-----------------------------+
| Pear desktop app     |        | AgentWorkforce cloud        |
|                      |        |                             |
| - draft editor       |        | - deployment endpoint       |
| - bundle staging     | -----> | - Cloudflare trigger router |
| - cloud agent attach |        | - hosted persona runtime    |
| - broker fan-out     | <----- | - Daytona sandbox, optional |
+----------------------+        +-----------------------------+
```

The watch contract comes from the persona bundle: `watch.paths`,
`watch.events`, optional `debounceMs`, and optional `match`. The installed
`@agentworkforce/persona-kit` schema describes runtime matching as cloud trigger
router ownership; Pear only validates and deploys the portable declaration.

## Author And Deploy

`ProactiveAgentsSection` and `ProactiveAgentEditor` collect the draft. Renderer
calls go through `pear.proactiveAgent.*` in `src/preload/index.ts`, then IPC
handlers in `src/main/ipc-handlers.ts`, then `ProactiveAgentManager`.

```
Renderer editor
    |
    | proactive-agent:create/update
    v
src/main/ipc-handlers.ts
    |
    v
ProactiveAgentManager.create/update
    |
    | normalize draft
    | validate:
    |   - id is kebab-case
    |   - harness is claude/codex/opencode
    |   - runMode is cloud/local
    |   - watch rules are non-empty
    |   - persona-kit parsePersonaSpec when available
    v
stageBundle()
    |
    | writes:
    |   <userData>/proactive-agents/<projectId>/<personaId>/persona.json
    |   <userData>/proactive-agents/<projectId>/<personaId>/agent.ts
    v
Project store
    |
    | project.proactiveAgents[] binding
    v
Renderer receives proactive-agent:event binding-updated
```

Deploy uses the same manager and staged bundle:

```
Renderer deploy button
    |
    | proactive-agent:deploy(projectId, personaId)
    v
ProactiveAgentManager.deploy
    |
    | validate draft again
    | status = warming
    v
deployBundle()
    |
    | onPhase: validate -> bundle -> upload -> warm -> register
    | calls @agentworkforce/deploy with:
    |   mode: cloud
    |   workspace: project.relayWorkspaceId || project.id
    |   onExists: update
    |   noPrompt: true
    v
AgentWorkforce cloud deployments endpoint
    |
    | uploads persona spec + bundled handler
    v
Cloud trigger router registers watch rules
    |
    v
binding status becomes active, warming, or error
```

Important Pear-side files:

- `src/main/proactive-agent.bundle.ts` builds `persona.json` with `cloud: true`,
  `cloudAgentId`, harness/model/system prompt, integrations, watch rules,
  handler entry, memory, harness settings, and mount policy.
- `src/main/proactive-agent.ts` stores `ProactiveAgentBinding` rows on the
  project and emits `proactive-agent:event` updates.
- `src/main/ipc-handlers.ts` exposes create, update, deploy, pause, resume,
  undeploy, runs, and transcript channels.

## Optional Daytona Sandbox Attach

Pear's cloud-agent path is separate from proactive persona deployment, but it is
the local UI path that creates or reuses a cloud sandbox for an interactive
cloud agent session. The sandbox is optional for the proactive runtime because
the hosted trigger runner may execute handler work without Pear attaching an
interactive terminal.

```
CloudAgentPicker selection
    |
    | hover/selection intent
    v
pear.cloudAgent.prewarm(projectId, cloudAgentId)
    |
    v
CloudAgentManager.prewarm
    |
    | skip if already bound or attach in flight
    | resolve workspace source:
    |   git-overlay, git, or relayfile
    | compute integration mount paths
    v
POST /api/v1/workspaces/<accountWorkspaceId>/cloud-agents/<id>/box?async=true
    |
    | body:
    |   relayfileMountPaths
    |   optional workspaceSource
    |   optional local relay workspaceKey
    |   stable brokerName cloud-<cloudAgentId prefix>
    v
Cloud/Daytona warms sandbox
    |
    | Pear polls GET /box until ready
    v
prewarm cache entry
```

Attach consumes that prewarm or warms a new box:

```
CloudAgentPicker attach click
    |
    v
pear.cloudAgent.attach(projectId, cloudAgentId)
    |
    v
CloudAgentManager.attach
    |
    | attachPromises[projectId] coalesces repeated attaches
    | consume prewarm if workspace source still matches
    | otherwise warmBox()
    v
startMount() when workspace source supports live sync
    |
    | RelayfileSetup.mountWorkspace:
    |   localDir = project.rootPath
    |   remotePath = sandbox.relayfileMountPath
    |   mode = poll
    |   syncMode = mirror
    v
brokerManager.attachCloudSandbox(projectId, sandbox)
    |
    | connects HarnessDriverClient to sandbox execUrl
    | stores cloud session under cloud:<projectId>
    | local broker session remains alive
    | renews cloud owner lease
    v
cloud-agent:event sandbox-status/mount-status
```

After attach, the renderer may spawn an interactive worker inside the sandbox:

```
pear.broker.spawnAgent(projectId, {
  broker: "cloud",
  cwd: "/workspace",
  cli,
  model,
  name
})
    |
    v
BrokerManager.spawnAgent
    |
    | routes to cloud session because broker = cloud
    v
sandbox broker spawns PTY worker
    |
    v
pear.broker.attachTerminal(..., mode: "passthrough")
```

## Runtime Trigger To Agent Session

This path is cloud-owned after deployment. Pear can display status, run history,
and transcripts by asking the cloud API; it does not run the Cloudflare worker
locally.

```
Relayfile or integration writes a watched path
    |
    v
Cloudflare worker trigger
    |
    | cloud trigger router matches deployed watch rules:
    |   paths + created/updated/deleted + debounce/match
    v
Hosted proactive runtime starts a run
    |
    | may create Daytona/process sandbox depending on persona sandbox policy
    | may mount Relayfile paths depending on mount policy
    | calls bundled handler agent.ts
    v
Handler code decides whether to call harness/model tools
    |
    v
Agent session running
    |
    | writes provider data, Relayfile changes, messages, summaries
    v
Cloud run record + transcript
    |
    | Pear reads via:
    |   proactive-agent:runs
    |   proactive-agent:run-transcript
    v
Renderer proactive agent UI
```

## Duplicate Delivery And Reconnect Notes

The existing code already treats parts of this lifecycle as idempotent or
coalesced:

- `CloudAgentManager.attach` uses `attachPromises` keyed by project id so
  repeated attach requests wait on the existing operation.
- `CloudAgentManager.prewarm` reuses a matching prewarm entry and cancels a
  superseded one before starting a new box.
- `BrokerManager.attachCloudSandbox` serializes concurrent cloud attaches with a
  cloud-session start gate and replaces only the previous cloud session, leaving
  the local project broker alive.
- `BrokerManager.attachClient` scopes event listeners with an
  `eventStreamGeneration`; stale callbacks return before publishing IPC events.
- `BrokerManager` dedupes PTY `worker_stream` chunks before sending
  `broker:pty-chunk`.
- `broker:start` returns whether a local session actually started; integration
  notifications are only sent after a real start.

For future changes in this area, keep stable event identity in the cloud run
payloads (`event_id`, `id`, or `seq`) and prefer identity-based dedupe over
content windows. Add duplicate/replay regression coverage when changing watch
registration, sandbox attach, broker event streaming, PTY forwarding, or
integration notification behavior.

## Current Limitations

- Pear does not contain the Cloudflare worker source. The worker trigger router
  is part of the AgentWorkforce cloud runtime reached through
  `@agentworkforce/deploy`.
- Pear's proactive manager currently rejects `runMode: "local"` during deploy;
  local proactive runtime is reserved for a later version.
- Cloud sandbox attach is an interactive cloud-agent path. A deployed proactive
  persona can run without Pear attaching a visible terminal unless the cloud
  runtime or the user explicitly starts a sandbox-backed harness session.
