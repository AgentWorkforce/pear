/**
 * Which Relaycast registrations the companion lists: agents that can receive
 * a message right now, plus people. Mirrors the iOS app's
 * `RelayAgent.isReachable` and `ConversationRoster.includes`.
 */

export interface RosterAgent {
  name?: string
  type?: string
  status?: string
  lastSeen?: string
  persona?: string | null
  metadata?: Record<string, unknown>
}

/**
 * `@relaycast/sdk` camelizes every response key, agent metadata included, so
 * `session_id` arrives as `sessionId`. Metadata is free-form and every rule
 * that reads it (Cloud's session binding, the iOS tool detection) uses the
 * wire names, so top-level keys are restored to snake_case here.
 */
export function wireMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return metadata
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    out[key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)] = value
  }
  return out
}

/** Matches the relay core's five-minute presence window. */
export const PRESENCE_WINDOW_MS = 5 * 60 * 1000

const REACHABLE_STATUSES = new Set(['active', 'online', 'waiting', 'blocked'])

function metadataString(agent: RosterAgent, key: string): string {
  const value = agent.metadata?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function isHumanAgent(agent: RosterAgent): boolean {
  return agent.type?.toLowerCase() === 'human'
}

export function isReachableAgent(agent: RosterAgent, now: number = Date.now()): boolean {
  if (agent.lastSeen) {
    const seen = Date.parse(agent.lastSeen)
    if (Number.isFinite(seen) && now - seen > PRESENCE_WINDOW_MS) return false
  }
  const status = agent.status?.toLowerCase() ?? ''
  if (REACHABLE_STATUSES.has(status)) return true
  // A desktop registration that goes idle no longer has a session to inject into.
  if (status === 'idle') return metadataString(agent, 'source') !== 'relay-desktop'
  return false
}

/**
 * Registrations to show, one per name: people, and agents that are reachable.
 * Renamed registrations only forward to their new name, and the companion
 * never lists itself.
 */
export function listedRosterAgents<T extends RosterAgent>(
  agents: T[],
  ownName: string | null | undefined,
  now: number = Date.now()
): T[] {
  const own = ownName?.trim().toLowerCase() ?? ''
  const seen = new Set<string>()
  return agents.filter((agent) => {
    const key = agent.name?.trim().toLowerCase() ?? ''
    if (!key || key === own || seen.has(key)) return false
    if (metadataString(agent, 'renamed_to')) return false
    if (!isHumanAgent(agent) && !isReachableAgent(agent, now)) return false
    seen.add(key)
    return true
  })
}

function metadataText(record: unknown, key: string): string {
  const value = record && typeof record === 'object' ? (record as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

/** Where an agent works and runs, from what its session publishes. */
export function agentPlacement(
  name: string,
  metadata: Record<string, unknown> | undefined,
  nodeNames: ReadonlyMap<string, string>
): { project?: string; machine?: string } {
  const project = metadataText(metadata?.activity, 'repo') || metadataText(metadata, 'project')
  const nodeId = metadataText(metadata?.fleet, 'nodeId') || metadataText(metadata, 'node_id')
  const at = name.lastIndexOf('@')
  const machine = metadataText(metadata, 'host') ||
    (nodeId ? nodeNames.get(nodeId) ?? '' : '') ||
    (at > 0 ? name.slice(at + 1).trim() : '')
  return { ...(project ? { project } : {}), ...(machine ? { machine } : {}) }
}
