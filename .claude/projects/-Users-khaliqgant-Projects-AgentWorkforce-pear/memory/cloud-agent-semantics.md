---
name: cloud-agent-semantics
description: What a Pear "cloud agent" is, and the known gap in the attach/warm flow
metadata:
  type: project
---

In Pear's cloud-agent feature, a "cloud agent" **is a provider credential** (a configured model provider like Anthropic/OpenAI). Confirmed by the user (2026-05-21): "the list is correct, if credentials are present then those agents are available." The cloud's `GET /api/v1/cloud-agents` returns rows from the `provider_credentials` table (harness, defaultModel, status, lastUsedAt).

Do NOT confuse these with *deployed agents* (the `agents` table / `/api/v1/agents`, `agents/deploy`, `undeployAgent`). They are different resources. Pear's `cloud-agent.ts create()` posts to `/api/v1/agents/deploy` (deployed agents) while `list()` reads `/api/v1/cloud-agents` (provider credentials) — a latent mismatch to watch.

Fixed 2026-05-21: delete now works end-to-end. Cloud `cloud-agents/[agentId]` route (in ../cloud, `packages/web/app/api/v1/cloud-agents/[agentId]/route.ts`) was wrongly calling `undeployAgent`; rewritten to GET/DELETE the `providerCredentials` row scoped to user+workspace. Pear's delete (`cloudDeleteCloudAgent`) targets only `/cloud-agents/{id}` and treats 404 as idempotent success.

STILL UNBUILT: attach/warm. Pear's `warmBox` posts to `POST /api/v1/workspaces/{ws}/cloud-agents/{id}/box` — **no such cloud route exists**. Pear's `normalizeSandbox` requires the response to include `sandboxId`, `execUrl`, `relayfileToken`, AND `relayfileMountPath` (a full relayfile-mounted, warming→ready sandbox). The cloud's existing `POST /workspaces/{ws}/sandboxes` is persona/workforce-specific (requires `purpose: "workforce-deploy"` + `personaId`) and deliberately does NOT return the relayfile token to the caller. Building attach requires a new cloud route that provisions a Daytona sandbox for a provider credential, mints a path-scoped relayfile token (`mintPathScopedRelayfileToken`), and returns it + mount path + exec URL with warming→ready status. See [[cloud-credential-sources]].
