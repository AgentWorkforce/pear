---
name: cloud-credential-sources
description: How Pear resolves cloud credentials and how it relates to ../workforce and ../cloud
metadata:
  type: project
---

Cloud-backed features in Pear (this Electron app) authenticate against two distinct credential stores:

1. **Pear's in-app login** (`src/main/auth.ts`) — tokens from the browser OAuth flow, stored **encrypted via Electron `safeStorage`** at `<userData>/config/auth.json`. Uses field `expiresAt`.
2. **The `@agent-relay/cloud` SDK** (canonical mechanism used by `../workforce` deploy and `../cloud`) — `readStoredAuth()` reads `CLOUD_API_*` env vars first, then `~/.agent-relay/cloud-auth.json` (plaintext JSON, mode 0600). Uses field `accessTokenExpiresAt`.

As of 2026-05-21, `src/main/auth.ts` exposes `resolveCloudAuth()` which checks the Pear store first, then falls back to the cloud SDK (env + `~/.agent-relay/cloud-auth.json`). All three cloud modules — `cloud-agent.ts`, `proactive-agent.ts`, `integrations.ts` — now call this single helper so env/file-provisioned creds work the same as in workforce/cloud. Previously only `cloud-agent.ts` did the dual-source check; proactive-agent and integrations honored only the Pear store.
