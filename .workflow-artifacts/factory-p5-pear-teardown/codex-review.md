# Codex Review - factory p5 pear teardown post-fix

**Verdict: CHANGES REQUESTED.** The Claude fix resolves the first-pass findings in the normal compact config path, removes the dead `factory:event` plumbing from tracked source, and adds useful IPC regression coverage. I found one remaining split-config regression in the new NodeConfig read/save compatibility path.

## Findings

### 1. [Medium] Split factory configs can lose inherited checkout mappings on save

**Files:** `src/main/ipc-handlers.ts:191`, `src/main/ipc-handlers.ts:245`

`saveFactoryNodeConfig` explicitly handles files that contain `workspaceConfig` or `nodeConfig`, but `extractNodeConfig` only reads `raw.nodeConfig` when it exists and does not fall back into `raw.workspaceConfig.repos`. That diverges from the published factory loader's split-config semantics: `combineSplitConfigInput` inherits `cloneRoot` and `clonePaths` from `workspaceConfig.repos` when `nodeConfig` omits them.

The save path then makes this worse because `normalizeNodeConfigInput` always materializes `clonePaths: {}`. For a valid split config such as:

```json
{
  "workspaceConfig": {
    "repos": {
      "cloneRoot": "/work",
      "clonePaths": { "AgentWorkforce/pear": "/custom/pear" }
    }
  },
  "nodeConfig": {
    "capabilities": ["spawn:claude"]
  }
}
```

Pear's editor reads an empty `clonePaths`, and a no-op save rewrites `nodeConfig` with `clonePaths: {}`. The factory loader treats that empty object as an explicit node override, so `workspaceConfig.repos.clonePaths` is no longer inherited. That can silently change the effective checkout map.

**Required fix:** Either remove the split-config branch if Pear only supports compact/root and `factoryConfig` shapes, or make split read/save match `@agent-relay/factory`'s loader semantics. The safest implementation is to add a test with a split `workspaceConfig`/`nodeConfig` fixture and assert that a no-op read/save preserves the effective `cloneRoot`/`clonePaths`. Then update extraction to use `workspaceConfig.repos` as fallback for split configs and avoid writing an empty `nodeConfig.clonePaths` that shadows inherited workspace mappings unless the user actually set an explicit empty override.

## Verification

- `env -u AGENT_RELAY_BROKER_PID npx vitest run src/main/ipc-handlers.test.ts` - PASS, 21 tests.
- `npm run typecheck:node` - PASS.
- `npm run typecheck:web` - PASS.
- `git diff --check` - PASS.
- `env -u AGENT_RELAY_BROKER_PID npx vitest run` - PASS, 31 files / 438 tests.
- Source grep is clean for removed tracked APIs: no `factory:start`, `factory:stop`, `FactoryEvent`, `factoryManager`, `FactoryManager`, `pear factory`, `factory-sdk`, `packages/factory-sdk`, or `/tmp/factory-run` under tracked source areas. The only remaining `factory:event` text in source is an explanatory comment in `FactoryPage.tsx`.

## Summary

I reviewed the changed source, diff, repo instructions, prior review/fix artifacts, installed `@agent-relay/factory` loader behavior, and regression tests. Artifact produced: `.workflow-artifacts/factory-p5-pear-teardown/codex-review.md`.
