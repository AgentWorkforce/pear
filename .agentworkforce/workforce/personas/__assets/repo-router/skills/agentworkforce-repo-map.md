---
name: agentworkforce-repo-map
description: Canonical map of all AgentWorkforce GitHub org repos, their roles, responsibilities, and key signals. Read this before routing any issue or deciding which repo to open a PR in. Use as a seed index — always verify against the live org with `gh repo list AgentWorkforce` since new repos are created frequently.
---

# AgentWorkforce Repo Map

This skill is the canonical reference for which repo owns what in the AgentWorkforce GitHub organization. Read it before routing an issue, spawning an agent, or opening a PR.

## How to verify against the live org

```bash
# List all repos with descriptions
gh repo list AgentWorkforce --limit 100 --json name,description

# Read a specific repo's README
gh api repos/AgentWorkforce/{repo}/contents/README.md --jq '.content' | base64 -d

# Read package.json
gh api repos/AgentWorkforce/{repo}/contents/package.json --jq '.content' | base64 -d

# List top-level directory structure
gh api repos/AgentWorkforce/{repo}/contents --jq '[.[] | {name, type}]'
```

## Core repos

### `pear`
**Role**: Desktop application — the primary user-facing product.
**Stack**: Electron, TypeScript, React, relayfile mount client.
**Owns**: Claude Code session UI, renderer process, PTY I/O, relayfile mount integration, integration event rendering (Slack/Linear/GitHub panels), Pear app settings, local persona installation.
**Key signals in issues**: "pear", "desktop", "renderer", "mount", "PTY", "session", "UI", "Electron", "integration panel", "local", "writeback path", "integration-remote-paths".

### `cloud`
**Role**: Backend — Cloudflare Workers API and integration orchestration.
**Stack**: Cloudflare Workers, TypeScript, D1, KV, Durable Objects, Nango, Hono.
**Owns**: REST API, Slack/Linear/GitHub webhook consumers, Nango connection management, picker options, worker dispatch, relay worker identity, conversation sandbox, proactive agent triggers.
**Key signals in issues**: "cloud", "API", "worker", "Slack", "Linear", "webhook", "Nango", "cf-", "KV", "D1", "Durable Object", "picker", "integration event", "cloud worker".

### `agents`
**Role**: Autonomous agent harnesses deployed as persistent workers.
**Stack**: TypeScript, agent-relay SDK, relayfile.
**Owns**: pr-reviewer agent, merge-on-green logic, agent harness framework, agents deployed as long-running relay workers.
**Key signals in issues**: "pr-reviewer", "merge-on-green", "agent harness", "autonomous agent", "review bot", "persistent agent", "relay worker".

### `workforce`
**Role**: Tooling for building, installing, and running agent personas.
**Stack**: TypeScript, Node.js monorepo (pnpm workspaces).
**Owns**: persona packages (`@agentworkforce/persona-*`), CLI (`agentworkforce install`), runtime, deploy tooling, workload router, persona-kit, harness-kit.
**Key signals in issues**: "persona", "CLI", "runtime", "deploy", "workforce", "install", "agentworkforce", "persona-kit", "harness", "workload router".

### `agent-assistant`
**Role**: SDK for building production-grade assistants from explicit runtime primitives.
**Stack**: TypeScript monorepo, npm workspaces.
**Owns**: `@agent-assistant/*` packages: traits, turn-context, harness, continuation, inbox, memory, sessions, surfaces, policy, proactive behavior, routing, connectivity, coordination, VFS, examples, Cloudflare/webhook runtimes.
**Key signals in issues**: "agent-assistant", "@agent-assistant", "assistant SDK", "traits", "turn-context", "bounded turn", "continuation", "inbox", "assistant memory", "surfaces", "policy", "coordination", "connectivity", "assistant vfs".

### `relayfile`
**Role**: Integration filesystem for agents: queue-first VFS-over-REST, local mount, SDK, CLI, file observer, schemas, and Go services.
**Stack**: TypeScript packages, Go services, local mount/FUSE, Cloudflare-facing SDK surfaces.
**Owns**: relayfile core server/runtime, `@relayfile/sdk`, `relayfile` CLI, local mount behavior, VFS layout, ACLs, file observer, writeback queue semantics, sync/eval harnesses, schemas.
**Key signals in issues**: "relayfile", "VFS", "virtual filesystem", "mount layout", "LAYOUT.md", "local-mount", "ACL", "file observer", "writeback queue", "dead-letter", "replay", "sync", "RelayFileClient", "@relayfile/sdk".

### `relayfile-adapters`
**Role**: TypeScript packages that project external providers into relayfile trees and implement provider-specific writeback.
**Stack**: TypeScript, Cloudflare Workers.
**Owns**: provider adapters (Linear, Slack, GitHub, Notion), resource path shapes, provider event emission, provider-specific writeback translation, adapter publish/deploy pipeline.
**Key signals in issues**: "adapter", "provider adapter", "Linear adapter", "Slack adapter", "GitHub adapter", "Notion adapter", "provider sync", "writeback protocol", "resource shape", "relayfile-adapter", "@relayfile/".

### `relayfile-providers`
**Role**: Auth and credential-management providers for relayfile integrations.
**Stack**: TypeScript integration/provider packages.
**Owns**: provider auth plumbing, credential exchange, hosted provider connectors, Nango/Composio/Pipedream-style provider boundaries used by relayfile.
**Key signals in issues**: "relayfile provider", "provider auth", "credential provider", "Nango", "Composio", "Pipedream", "connection token", "integration credentials".

### `burn`
**Role**: Token/cost observability for agent CLI sessions.
**Stack**: TypeScript, Rust/N-API, pnpm monorepo.
**Owns**: `relayburn` CLI, burn ledger, cost ingestion for Claude Code/Codex/OpenCode logs, pricing updates, hotspots, overhead attribution, model comparison, MCP server for cost queries.
**Key signals in issues**: "burn", "relayburn", "token usage", "cost", "hotspots", "overhead", "CLAUDE.md cost", "AGENTS.md cost", "pricing", "ledger", "usage limits", "mcp-server cost".

### `relay`
**Role**: The core Agent Relay product — server, broker, SDK, protocol.
**Stack**: Rust/TypeScript web and package surfaces.
**Owns**: relay server, broker, `@agent-relay/sdk`, relay protocol, agent registration, message routing, workspace management, core messaging substrate.
**Key signals in issues**: "relay", "broker", "SDK", "@agent-relay/sdk", "relay server", "subscription", "workspace", "agent registration", "message routing", "channel", "DM", "thread".

### `skills`
**Role**: Skill packs consumed by agent personas at runtime.
**Stack**: Markdown (SKILL.md files), PRPM package manager.
**Owns**: `@agent-relay/` and `@agent-workforce/` skill namespaces, skill authoring tooling, skill discovery.
**Key signals in issues**: "skill", "SKILL.md", "skill pack", "@agent-relay/skill", "@agent-workforce/skill", "skills repo".

## Product and workflow repos

### `relaycast`
**Role**: Headless Slack-style collaboration product for AI agents.
**Owns**: Relaycast workspace UX/API, agent chat surfaces, real-time collaboration patterns that are product-specific rather than core Relay protocol.
**Key signals in issues**: "relaycast", "headless Slack", "agent workspace", "agent chat product", "real-time agent collaboration".

### `relayauth`
**Role**: Authorization and capability constraints for agents.
**Owns**: permission/authority model, scoped access, action authorization, capability boundaries.
**Key signals in issues**: "relayauth", "authorization", "capability", "permissions", "least privilege", "agent can do exactly".

### `relayflows`
**Role**: Multi-step, multi-agent workflow orchestration across Agent Relay workers.
**Owns**: workflow graph/runtime concepts, orchestration recipes, worker coordination flows.
**Key signals in issues**: "relayflows", "workflow orchestration", "multi-step", "multi-agent execution", "workflow runner".

### `ricky`
**Role**: Workflow reliability agent and workflow runner for AgentWorkforce.
**Owns**: workflow reliability, runner behavior, workflow execution monitoring.
**Key signals in issues**: "ricky", "workflow reliability", "workflow runner", "runner failed", "workflow monitor".

### `nightcto`
**Role**: Overnight CTO-style autonomous engineering/product agent.
**Owns**: NightCTO persona/product behavior, overnight planning/execution workflow, CTO automation.
**Key signals in issues**: "nightcto", "night CTO", "overnight", "CTO agent", "autonomous CTO".

### `sage`
**Role**: Research, clarification, and planning agent that turns conversations into executable workflows.
**Owns**: planning/research workflow, requirements clarification, conversation-to-plan behavior.
**Key signals in issues**: "sage", "research", "clarify", "planning workflow", "requirements", "executable development workflow".

### `proactive-agents`
**Role**: Marketing/blog site for proactive agent concepts.
**Owns**: proactive-agents website content and messaging.
**Key signals in issues**: "proactive-agents site", "marketing site", "blog", "proactive agents content".

### `proactive`
**Role**: Tools to build proactive agents.
**Owns**: proactive-agent primitives and tooling outside the marketing site.
**Key signals in issues**: "proactive", "follow-up", "watch rule", "scheduler", "proactive agent tooling".

### `internal-agents`
**Role**: Internal AgentWorkforce agent implementations.
**Owns**: private/internal agents not packaged as public personas.
**Key signals in issues**: "internal agent", "internal-agents", "private agent", "ops agent".

### `workflows`
**Role**: Repeatable Agent Relay workflows and repo-hygiene cookbooks.
**Owns**: workflow templates, cookbook docs, repo hygiene automation patterns.
**Key signals in issues**: "workflow cookbook", "repo hygiene", "workflows repo", "repeatable workflow".

### `agent-relay-personas`
**Role**: Workforce personas that leverage Agent Relay.
**Owns**: Agent Relay-specific persona packs outside this `workforce` monorepo.
**Key signals in issues**: "agent-relay-personas", "relay persona", "Agent Relay persona pack".

### `agent-relay-acp-bridge`
**Role**: ACP bridge for Agent Relay.
**Owns**: Agent Client Protocol bridge integration with Agent Relay.
**Key signals in issues**: "ACP", "agent client protocol", "ACP bridge", "agent-relay-acp-bridge".

### `agent-relay-openclaw`
**Role**: Agent Relay bridge for OpenClaw.
**Owns**: OpenClaw integration, real-time channels/threads/DMs beyond built-in OpenClaw surfaces.
**Key signals in issues**: "openclaw", "agent-relay-openclaw", "OpenClaw bridge".

### `agent-relay-vscode`
**Role**: VS Code extension for Agent Relay.
**Owns**: VS Code integration, editor extension commands/views for Relay.
**Key signals in issues**: "VS Code", "vscode", "extension", "agent-relay-vscode".

### `relay-dashboard`
**Role**: Dashboard for agents collaborating through Agent Relay.
**Owns**: dashboard UI, collaboration visualization/product surfaces.
**Key signals in issues**: "dashboard", "relay-dashboard", "collaboration dashboard".

### `relay-visualizer`, `relay-pulse`, `relay-pty-visualizer`
**Role**: Visual explainers and interactive protocol/PTY visualizations.
**Owns**: visualization UIs, animated protocol demos, PTY pipeline explainers.
**Key signals in issues**: "visualizer", "relay-pulse", "relay-pty", "animated explainer", "protocol visualization".

### `ai-hist`
**Role**: Sync and search Claude Code/Codex CLI conversation history in SQLite.
**Owns**: conversation-history ingestion/search, local SQLite indexes.
**Key signals in issues**: "ai-hist", "conversation history", "history search", "SQLite", "Claude Code history", "Codex history".

### `trajectories`
**Role**: Document layer for agent work and traces.
**Owns**: trajectory document format and generated/documented agent work artifacts.
**Key signals in issues**: "trajectory", "trajectories", "agent trace document", "work trace".

### `agent-trace`
**Role**: Standard trace format for AI-generated code.
**Owns**: trace schema/format for AI coding outputs.
**Key signals in issues**: "agent-trace", "trace format", "AI-generated code trace".

### `build-plans`
**Role**: Collection of build plans using the Agent Relay SDK.
**Owns**: planning docs/examples for Relay SDK-based builds.
**Key signals in issues**: "build plan", "build-plans", "Relay SDK plan".

### `demos`, `relay-examples`, `simple-swarm`, `swarm-patterns`, `tic-tac-toe`, `relay-cross-framework-demo`
**Role**: Demos, examples, and proof points for Agent Relay/swarm patterns.
**Owns**: example apps, demo scenarios, swarm visualizations, cross-framework demos, sample games.
**Key signals in issues**: "demo", "example", "simple swarm", "swarm pattern", "tic-tac-toe", "cross framework", "LangGraph", "CrewAI".

### `relay-cloud`, `relayfile-cloud`, `relayfile-cli`
**Role**: Split-out cloud/CLI package repos for Relay and Relayfile surfaces.
**Owns**: hosted cloud code or dedicated CLI surfaces when an issue names these repos explicitly.
**Key signals in issues**: "relay-cloud", "relayfile-cloud", "relayfile-cli", "hosted relayfile", "cloud code split".

## Routing rules

| Issue surface | Primary repo | Secondary repo (if applicable) |
|---|---|---|
| Desktop UI, session rendering, local mount | `pear` | — |
| Slack/Linear webhook, API endpoint, Nango | `cloud` | — |
| PR reviewer, merge automation, agent harness | `agents` | — |
| Assistant SDK/runtime primitives | `agent-assistant` | — |
| Persona authoring, CLI, runtime deploy | `workforce` | — |
| Relayfile core VFS, SDK, CLI, local mount, ACLs | `relayfile` | — |
| Relay protocol, broker, SDK | `relay` | — |
| Provider-specific relayfile trees/writeback | `relayfile-adapters` | — |
| Relayfile provider auth/credentials | `relayfile-providers` | `cloud` if hosted API/Nango wiring changes too |
| Token/cost observability | `burn` | — |
| Skill content | `skills` | — |
| Slack feature end-to-end | `cloud` + `pear` | cloud = webhook/dispatch, pear = mount/render |
| New integration (e.g. Jira) | `relayfile-adapters` + `relayfile-providers` + `cloud` | adapter = sync/writeback, provider = auth, cloud = hosted connection |
| New persona | `workforce` | — |
| Agent workflow orchestration | `relayflows` | `workforce` if packaged as persona/runtime |
| Agent Relay examples/demos | demo repo named in issue | `relay` if core SDK/protocol bug |

## Multi-repo issues

When an issue spans multiple repos, spawn one implementer per repo in parallel. Common patterns:
- **New Slack integration feature**: `cloud` (webhook + API) + `pear` (mount rendering)
- **New external provider**: `relayfile-adapters` (resource tree/writeback) + `relayfile-providers` (auth/credential provider) + `cloud` (hosted connection setup)
- **Agent behavior + UI**: `agents` (harness logic) + `pear` (rendering the agent's output)
- **Assistant runtime + product integration**: `agent-assistant` (runtime primitive) + product repo such as `cloud`, `pear`, or `relaycast`
- **Relayfile mount bug with provider symptoms**: `relayfile` (core VFS/local mount) + `relayfile-adapters` (provider path/writeback) after reproducing which layer fails

## Disambiguation

If an issue is ambiguous, use `gh api repos/AgentWorkforce/{repo}/contents` to check directory structure of candidate repos before deciding. For example: if an issue mentions "writeback" it could be `pear` (path construction) or `relayfile-adapters` (sync protocol) — check which layer the bug is in.

## Compact org index

Use this as a candidate list before falling back to live `gh repo list`. Several repos are products, demos, prototypes, or split-out package surfaces; route to them only when the issue names them directly or their ownership signals match.

| Repo | Signal |
|---|---|
| `awp` | Agent Workforce Protocol |
| `axiom` | Intent preservation for AI coding agents |
| `c2a` | Chat 2 Agents Protocol |
| `ceo`, `cfo`, `cmo`, `sales`, `supportly`, `rachel`, `openkaren`, `openviktor` | role/persona/product experiments; route only when named |
| `clawrunner` | OpenClaw deployment sandbox |
| `code-storybook` | AI-narrated code storybook |
| `credential-proxy` | credential proxy surface |
| `gitclawlab` | hosting/deploying code for AI agents |
| `kairo` | Mac calendar connected to agents |
| `limit` | terminal dashboard for Claude Code/Codex usage limits |
| `megaclaude` | Claude Code wrapper/variant |
| `moltslack`, `transport` | headless Slack / agent messaging experiments |
| `n8n-nodes-relayfile`, `relaycast-n8n-bridge` | n8n integration packages |
| `open-world`, `open-world-game`, `soccer`, `scout` | game/demo/prototype repos |
| `planner` | web UI for planning tasks with agents |
| `profiles` | identity files for agents |
| `relay-broker`, `relay-sdk`, `relay-tui` | split-out Relay broker/SDK/TUI surfaces; verify whether current work belongs in `relay` first |
| `relay-poc-*` | Relay Communicate SDK proof-of-concept apps |
| `relaycron` | scheduled work for agents |
| `relayed` | relay daemon/runtime surface |
| `relayrank` | ranking/evaluation surface |
| `sloppypaste` | "Stop dumping slop" product/tool |
| `superset` | IDE for running many agent CLIs |
| `vscode-acp` | ACP support for VS Code |
| `wash` | cleanup tool/product |
| `watchdog-agents` | Watchdog agents deployed on Agent Relay |
