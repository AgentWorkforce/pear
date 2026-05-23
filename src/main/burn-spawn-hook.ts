/**
 * Burn integration for Pear-spawned sessions.
 *
 * Registered as a `beforeAgentSpawn` listener on `AgentRelayClient`. For
 * each session Pear spawns, it preallocates a session id (when the
 * launcher supports one) and writes a burn stamp so the session shows up
 * in `burn summary --tags spawner=pear`.
 *
 * Two code paths:
 *
 * - **Claude** → mint a UUID, return a `SpawnPatch` injecting
 *   `--session-id <uuid>` into `args`, then call `@relayburn/sdk`
 *   `writeStamp({ sessionId, enrichment })`. Most reliable — burn ties
 *   the stamp directly to the eventual jsonl file in
 *   `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
 * - **Codex / OpenCode / unknown** → no pre-spawn session id is
 *   available, so fall back to the sidecar `writePendingStamp` manifest
 *   that burn ingest matches by `cwd` + `spawnerPid` + `spawnStartTs`.
 *
 * Burn integration code stays here (in Pear) rather than in
 * `@agent-relay/sdk` so the SDK has zero burn dependency. Any other
 * launcher that wants the same behavior copies this pattern.
 */

import { randomUUID } from 'node:crypto'
import type {
  BeforeAgentSpawnContext,
  BeforeAgentSpawnHandler,
  SpawnPatch,
  SpawnPtyInput,
  SpawnProviderInput
} from '@agent-relay/sdk'

type Harness = 'claude' | 'codex' | 'opencode'

/** Map `SpawnPtyInput.cli` / `SpawnProviderInput.provider` to burn's harness enum. */
function inferHarness(input: SpawnPtyInput | SpawnProviderInput): Harness | 'unknown' {
  const launcher = (
    'cli' in input ? input.cli : (input as SpawnProviderInput).provider
  )?.toLowerCase()
  if (launcher === 'claude') return 'claude'
  if (launcher === 'codex') return 'codex'
  if (launcher === 'opencode') return 'opencode'
  return 'unknown'
}

export interface PearBurnHookOptions {
  /**
   * Static enrichment merged into every spawn. Defaults to
   * `{ spawner: 'pear', on_relay: 'true', spawned_by: 'direct' }` if not
   * provided.
   */
  enrichment?: Record<string, string>
  /** Dynamic enrichment computed per-spawn. Merged over `enrichment`. */
  enrich?: (ctx: BeforeAgentSpawnContext) => Record<string, string>
  /** Override the burn ledger location. Defaults to `~/.agentworkforce/burn`. */
  ledgerHome?: string
  /**
   * Override the dynamic import path for `@relayburn/sdk`. Tests inject a
   * stub here; production callers leave this undefined to use the
   * installed package.
   */
  loadBurn?: () => Promise<{
    writeStamp: (opts: {
      sessionId: string
      enrichment: Record<string, string>
      ledgerHome?: string
    }) => Promise<void>
    writePendingStamp: (opts: {
      harness: 'claude' | 'codex' | 'opencode'
      cwd: string
      enrichment: Record<string, string>
      spawnerPid?: number
      spawnStartTs?: string
      ledgerHome?: string
    }) => Promise<unknown>
  }>
}

const DEFAULT_ENRICHMENT: Record<string, string> = {
  spawner: 'pear',
  on_relay: 'true',
  spawned_by: 'direct'
}

/**
 * Build a `beforeAgentSpawn` handler that writes a burn stamp for the
 * session. Register it via `client.addListener('beforeAgentSpawn',
 * burnListener)` once per `AgentRelayClient`.
 */
export function createPearBurnSpawnListener(
  options: PearBurnHookOptions = {}
): BeforeAgentSpawnHandler {
  const staticEnrichment = options.enrichment ?? DEFAULT_ENRICHMENT
  const loadBurn = options.loadBurn ?? (() => import('@relayburn/sdk'))

  return async (ctx: BeforeAgentSpawnContext): Promise<SpawnPatch | void> => {
    const harness = inferHarness(ctx.input)
    const dynamic = options.enrich?.(ctx) ?? {}
    const enrichment: Record<string, string> = { ...staticEnrichment, ...dynamic }

    let burn: Awaited<ReturnType<typeof loadBurn>>
    try {
      burn = await loadBurn()
    } catch (err) {
      // Burn is optional — if it isn't installed, silently no-op.
      console.warn('[burn-spawn-hook] @relayburn/sdk unavailable, skipping stamp:', err)
      return
    }

    if (harness === 'claude') {
      const sessionId = randomUUID()
      try {
        await burn.writeStamp({
          sessionId,
          enrichment,
          ...(options.ledgerHome ? { ledgerHome: options.ledgerHome } : {})
        })
      } catch (err) {
        console.warn('[burn-spawn-hook] writeStamp failed; falling back to no-stamp spawn:', err)
        // Don't return a patch — let the spawn proceed un-stamped rather than break it.
        return
      }
      return {
        args: [...(ctx.input.args ?? []), '--session-id', sessionId]
      }
    }

    if (harness === 'codex' || harness === 'opencode') {
      try {
        await burn.writePendingStamp({
          harness,
          cwd: ctx.input.cwd ?? process.cwd(),
          enrichment,
          spawnerPid: ctx.spawnerPid,
          spawnStartTs: ctx.spawnStartTs,
          ...(options.ledgerHome ? { ledgerHome: options.ledgerHome } : {})
        })
      } catch (err) {
        console.warn('[burn-spawn-hook] writePendingStamp failed:', err)
      }
      return
    }

    // Unknown launcher — best-effort sidecar stamp with the launcher coerced
    // to 'claude' so burn ingest doesn't reject the manifest. If burn later
    // can't match it (cwd/pid mismatch) the manifest is GC'd after 24h.
    try {
      await burn.writePendingStamp({
        harness: 'claude',
        cwd: ctx.input.cwd ?? process.cwd(),
        enrichment,
        spawnerPid: ctx.spawnerPid,
        spawnStartTs: ctx.spawnStartTs,
        ...(options.ledgerHome ? { ledgerHome: options.ledgerHome } : {})
      })
    } catch (err) {
      console.warn('[burn-spawn-hook] writePendingStamp (unknown launcher) failed:', err)
    }
  }
}
