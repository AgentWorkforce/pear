import type { SpawnPtyInput } from '@agent-relay/harness-driver'
import { isRecord } from './guards'

export type BrokerSpawnResult = {
  name: string
  runtime: string
  cli?: string
}

export type PersonaBrokerSpawnResult = BrokerSpawnResult & {
  workerStreamBaselineSeq?: number
  workerStreamBaselineCount: number
}


// Coerce the loosely-typed spawnPty result into a BrokerSpawnResult, filling in
// a fallback name/runtime and preferring an explicitly resolved CLI over the
// one the broker echoed back.
export function normalizeSpawnPtyResult(
  value: unknown,
  fallbackName: string,
  cli?: string
): BrokerSpawnResult {
  const record = isRecord(value) ? value : {}
  const name = typeof record.name === 'string' && record.name.trim()
    ? record.name.trim()
    : fallbackName
  const runtime = typeof record.runtime === 'string' && record.runtime.trim()
    ? record.runtime.trim()
    : 'pty'
  const result: BrokerSpawnResult = { name, runtime }
  const resolvedCli = typeof cli === 'string' && cli.trim()
    ? cli.trim()
    : typeof record.cli === 'string' && record.cli.trim()
      ? record.cli.trim()
      : undefined
  if (resolvedCli) result.cli = resolvedCli
  return result
}

// Allocate a name that does not collide with any already-known agent. A spawn
// coalesced behind one promise still has to land on a unique relay name, and a
// name-conflict retry (see isAgentNameConflict) re-runs this to pick the next
// `${base}-${n}`.
export function getAvailableAgentName(requestedName: string, existingNames: Set<string>): string {
  const trimmedName = requestedName.trim()
  if (!existingNames.has(trimmedName)) {
    return trimmedName
  }

  const match = trimmedName.match(/^(.*?)-(\d+)$/)
  const baseName = match ? match[1] : trimmedName
  let index = match ? Number(match[2]) + 1 : 2

  while (existingNames.has(`${baseName}-${index}`)) {
    index += 1
  }

  return `${baseName}-${index}`
}

// True when a spawn failed only because the name was taken — the caller bumps
// the name and retries rather than surfacing the error.
export function isAgentNameConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /agent ['"].+['"] already exists/i.test(message) || message.includes('already exists')
}

// Dedup key for a direct agent spawn. Two spawn requests that stringify to the
// same key are the same logical operation and coalesce onto one in-flight
// promise (AGENTS.md: coalesce concurrent starts/spawns behind a keyed promise).
// The field set is load-bearing — it is exactly what distinguishes a "different
// spawn" from a "retry of the same spawn", so leave it byte-for-byte unchanged.
export function spawnRequestKey(
  projectId: string,
  input: SpawnPtyInput & { broker?: 'local' | 'cloud' },
  options: { parentAgentName?: string }
): string {
  return JSON.stringify({
    projectId,
    broker: input.broker || 'auto',
    name: input.name,
    cli: input.cli,
    cwd: input.cwd || '',
    args: input.args || [],
    task: input.task || '',
    model: input.model || '',
    parentAgentName: options.parentAgentName || ''
  })
}

// Dedup key for a workforce-persona spawn. Intentionally keyed only by
// project + persona id (not broker/cwd/etc.) so repeated Add-Persona clicks for
// the same persona coalesce. Do not "complete" this key — its narrowness is the
// established semantics, not an oversight.
export function personaSpawnRequestKey(projectId: string, personaId: string): string {
  return JSON.stringify({
    projectId,
    personaId
  })
}

// Owns the keyed in-flight-promise dedup for spawns plus the pending-persona
// readiness set. BrokerManager delegates here and keeps the actual spawn work
// (broker client calls, name allocation, lineage stamping) inline — this module
// only guarantees that identical concurrent spawns share one promise and that
// the gate clears in `finally`.
export class SpawnCoordinator {
  private inFlightSpawnRequests = new Map<string, Promise<{ name: string; runtime: string }>>()
  private inFlightPersonaSpawnRequests = new Map<string, Promise<BrokerSpawnResult>>()
  // Persona agents that have registered with the broker but not yet passed
  // harness-readiness verification. Keyed by `${sessionKey}:${name}` so a
  // project's local and cloud brokers track readiness independently. Snapshot
  // queries hide these so a half-ready persona never leaks into the UI.
  private pendingPersonaReadiness = new Set<string>()

  // Coalesce a direct spawn behind its request key. An identical concurrent
  // spawn waits on the existing promise instead of forking a second broker
  // spawn; the factory only runs when no spawn is already in flight for the key.
  coalesceSpawn(
    key: string,
    factory: () => Promise<{ name: string; runtime: string }>
  ): Promise<{ name: string; runtime: string }> {
    return this.coalesce(this.inFlightSpawnRequests, key, factory)
  }

  coalescePersonaSpawn(
    key: string,
    factory: () => Promise<BrokerSpawnResult>
  ): Promise<BrokerSpawnResult> {
    return this.coalesce(this.inFlightPersonaSpawnRequests, key, factory)
  }

  // The gate clears in `finally` only when the map still points at *this*
  // promise, so a later distinct spawn that reused the key after this one
  // settled is never evicted by this call's cleanup (promise identity guard).
  private coalesce<T>(
    map: Map<string, Promise<T>>,
    key: string,
    factory: () => Promise<T>
  ): Promise<T> {
    const inFlight = map.get(key)
    if (inFlight) return inFlight

    const promise = factory().finally(() => {
      if (map.get(key) === promise) {
        map.delete(key)
      }
    })
    map.set(key, promise)
    return promise
  }

  private personaReadinessKey(sessionKey: string, name: string): string {
    return `${sessionKey}:${name}`
  }

  markPersonaReadinessPending(sessionKey: string, name: string): void {
    this.pendingPersonaReadiness.add(this.personaReadinessKey(sessionKey, name))
  }

  clearPersonaReadinessPending(sessionKey: string, name: string): void {
    this.pendingPersonaReadiness.delete(this.personaReadinessKey(sessionKey, name))
  }

  isPersonaReadinessPending(sessionKey: string, name: string): boolean {
    return this.pendingPersonaReadiness.has(this.personaReadinessKey(sessionKey, name))
  }
}
