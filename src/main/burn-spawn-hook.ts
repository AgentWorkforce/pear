/**
 * Burn integration for Pear-spawned sessions.
 *
 * Registered as a `beforeAgentSpawn` listener on `HarnessDriverClient`. For
 * each session Pear spawns, it preallocates a session id (when the
 * launcher supports one) and writes a burn stamp so the session shows up
 * in `burn summary --tags spawner=pear`.
 *
 * Three code paths:
 *
 * - **Claude** → mint a UUID, return a `SpawnPatch` injecting
 *   `--session-id <uuid>` into `args`, then call `@relayburn/sdk`
 *   `writeStamp({ sessionId, enrichment })`. Most reliable — burn ties
 *   the stamp directly to the eventual jsonl file in
 *   `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
 * - **Codex** → wait for Codex to write `session_meta` under
 *   `~/.codex/sessions`, recover the session id, then call
 *   `writeStamp({ sessionId, enrichment })`.
 * - **OpenCode / unknown** → no pre-spawn session id is available, so fall
 *   back to the sidecar `writePendingStamp` manifest that burn ingest
 *   matches by `cwd` + `spawnerPid` + `spawnStartTs`.
 *
 * Burn integration code stays here (in Pear) rather than in
 * `@agent-relay/harness-driver` so the driver has zero burn dependency. Any other
 * launcher that wants the same behavior copies this pattern.
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SpawnPtyInput } from '@agent-relay/harness-driver'

type SpawnProviderInput = {
  name: string
  provider: string
  args?: string[]
  cwd?: string
  model?: string
  team?: string
}

type PearSpawnInput = SpawnPtyInput | SpawnProviderInput

export type SpawnPatch = Partial<Pick<
  SpawnPtyInput,
  'args' | 'channels' | 'task' | 'model' | 'team' | 'agentToken' | 'harnessConfig'
>>

export interface BeforeAgentSpawnContext<TInput extends PearSpawnInput = PearSpawnInput> {
  kind: 'pty' | 'cli' | 'headless' | 'provider'
  input: Readonly<TInput>
  spawnerPid: number
  spawnStartTs: string
  baseUrl: string
}

export type BeforeAgentSpawnHandler = (
  ctx: BeforeAgentSpawnContext
) => void | SpawnPatch | Promise<void | SpawnPatch>

type Harness = 'claude' | 'codex' | 'opencode'

const CODEX_SESSION_LOOKBACK_MS = 10_000
const CODEX_SESSION_LOOKAHEAD_MS = 10 * 60_000
const CODEX_SESSION_META_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_CODEX_STAMP_RETRY_DELAYS_MS = [0, 1_000, 3_000, 7_000, 15_000]

interface CodexSessionCandidate {
  sessionId: string
  timestampMs: number
}

interface CodexSessionMetaRecord {
  type?: string
  payload?: {
    id?: unknown
    timestamp?: unknown
    cwd?: unknown
  }
}

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
      ts?: string
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

export interface PearBurnSpawnedAgentOptions extends Pick<PearBurnHookOptions, 'ledgerHome' | 'loadBurn'> {
  codexHome?: string
  retryDelaysMs?: number[]
}

const DEFAULT_ENRICHMENT: Record<string, string> = {
  spawner: 'pear',
  on_relay: 'true',
  spawned_by: 'direct'
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readFirstLine(filePath: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(CODEX_SESSION_META_READ_BYTES)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytesRead <= 0) return null
    const newlineIndex = buffer.subarray(0, bytesRead).indexOf(10)
    const end = newlineIndex >= 0 ? newlineIndex : bytesRead
    return buffer.toString('utf8', 0, end)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close failures from best-effort session scanning.
      }
    }
  }
}

function readCodexSessionCandidate(filePath: string, cwd: string): CodexSessionCandidate | null {
  const firstLine = readFirstLine(filePath)
  if (!firstLine) return null

  let record: CodexSessionMetaRecord
  try {
    record = JSON.parse(firstLine) as CodexSessionMetaRecord
  } catch {
    return null
  }

  if (record.type !== 'session_meta') return null
  const payload = record.payload
  if (payload?.cwd !== cwd || typeof payload.id !== 'string' || typeof payload.timestamp !== 'string') {
    return null
  }

  const timestampMs = Date.parse(payload.timestamp)
  if (!Number.isFinite(timestampMs)) return null

  return {
    sessionId: payload.id,
    timestampMs
  }
}

function addSessionDateDir(dirs: Set<string>, codexHome: string, date: Date, utc: boolean): void {
  const year = utc ? date.getUTCFullYear() : date.getFullYear()
  const month = utc ? date.getUTCMonth() + 1 : date.getMonth() + 1
  const day = utc ? date.getUTCDate() : date.getDate()
  dirs.add(join(
    codexHome,
    'sessions',
    String(year),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ))
}

function getCodexSessionDateDirs(codexHome: string, spawnStartMs: number): string[] {
  const dirs = new Set<string>()
  for (const offsetDays of [-1, 0, 1]) {
    const date = new Date(spawnStartMs + offsetDays * 24 * 60 * 60 * 1000)
    addSessionDateDir(dirs, codexHome, date, false)
    addSessionDateDir(dirs, codexHome, date, true)
  }
  return Array.from(dirs)
}

export function findCodexSessionForSpawn(input: {
  cwd: string
  spawnStartTs: string
  codexHome?: string
}): CodexSessionCandidate | null {
  const spawnStartMs = Date.parse(input.spawnStartTs)
  if (!Number.isFinite(spawnStartMs)) return null

  const codexHome = input.codexHome ?? join(homedir(), '.codex')
  const candidates: CodexSessionCandidate[] = []

  for (const dir of getCodexSessionDateDirs(codexHome, spawnStartMs)) {
    if (!existsSync(dir)) continue

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl') || !basename(entry).startsWith('rollout-')) continue
      const candidate = readCodexSessionCandidate(join(dir, entry), input.cwd)
      if (!candidate) continue
      if (
        candidate.timestampMs < spawnStartMs - CODEX_SESSION_LOOKBACK_MS ||
        candidate.timestampMs > spawnStartMs + CODEX_SESSION_LOOKAHEAD_MS
      ) {
        continue
      }
      candidates.push(candidate)
    }
  }

  candidates.sort((left, right) => {
    const leftAfter = left.timestampMs >= spawnStartMs
    const rightAfter = right.timestampMs >= spawnStartMs
    if (leftAfter !== rightAfter) return leftAfter ? -1 : 1
    return Math.abs(left.timestampMs - spawnStartMs) - Math.abs(right.timestampMs - spawnStartMs)
  })

  return candidates[0] ?? null
}

export async function stampPearBurnSpawnedAgent(
  input: SpawnPtyInput | SpawnProviderInput,
  spawnStartTs: string,
  enrichment: Record<string, string>,
  options: PearBurnSpawnedAgentOptions = {}
): Promise<void> {
  const harness = inferHarness(input)
  if (harness !== 'codex') return

  const cwd = input.cwd ?? process.cwd()
  const loadBurn = options.loadBurn ?? (() => import('@relayburn/sdk'))
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_CODEX_STAMP_RETRY_DELAYS_MS

  let burn: Awaited<ReturnType<typeof loadBurn>>
  try {
    burn = await loadBurn()
  } catch (err) {
    console.warn('[burn-spawn-hook] @relayburn/sdk unavailable, skipping post-spawn stamp:', err)
    return
  }

  for (const delayMs of retryDelaysMs) {
    await wait(delayMs)
    const session = findCodexSessionForSpawn({
      cwd,
      spawnStartTs,
      codexHome: options.codexHome
    })
    if (!session) continue

    try {
      await burn.writeStamp({
        sessionId: session.sessionId,
        enrichment,
        ts: new Date(session.timestampMs).toISOString(),
        ...(options.ledgerHome ? { ledgerHome: options.ledgerHome } : {})
      })
    } catch (err) {
      console.warn('[burn-spawn-hook] Codex writeStamp failed:', err)
    }
    return
  }
}

/**
 * Build a `beforeAgentSpawn` handler that writes a burn stamp for the
 * session. Register it via `client.addListener('beforeAgentSpawn',
 * burnListener)` once per `HarnessDriverClient`.
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

    // Codex does not support a caller-supplied session id. Pear writes the
    // exact stamp after spawn once the Codex session_meta file appears.
    if (harness === 'codex') return

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

    if (harness === 'opencode') {
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
