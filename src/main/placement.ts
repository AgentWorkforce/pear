/**
 * Placement (issue #411, requester side) — pure, electron-free helpers shared by
 * the broker requester path and the isolated E2E harness. A placed agent is
 * dispatched via the relay placement engine (`messaging.placement.spawn`) rather
 * than the local broker's PTY driver; these helpers translate the SDK's
 * RelayPlacementError into a user-facing message and shape the node roster for
 * the picker UI. Kept out of broker.ts so a Node script (the Rung-1 gate) can
 * import them without pulling in electron.
 */
import type { RelayPlacementError, RelayNode } from '@agent-relay/sdk'
import type { BrokerPlacementErrorCode, BrokerNodeSummary } from '../shared/types/ipc'

export class BrokerPlacementError extends Error {
  readonly code: BrokerPlacementErrorCode
  readonly capability?: string
  readonly node?: string
  readonly repo?: string

  constructor(
    code: BrokerPlacementErrorCode,
    message: string,
    ctx: { capability?: string; node?: string; repo?: string } = {}
  ) {
    super(message)
    this.name = 'BrokerPlacementError'
    this.code = code
    this.capability = ctx.capability
    this.node = ctx.node
    this.repo = ctx.repo
  }
}

export function placementRequesterName(projectId: string): string {
  const raw = `pear-requester-${projectId}`
  return raw.replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'pear-requester'
}

export function humanCapability(capability: string): string {
  return capability.startsWith('spawn:') ? capability.slice('spawn:'.length) : capability
}

// The four RelayPlacementError codes each map to a clear, actionable message so
// the spawn UI never shows a raw SDK string or — worse — hangs silently (#411
// fallback requirement).
export function buildPlacementMessage(err: RelayPlacementError): string {
  switch (err.code) {
    case 'capability_mismatch':
      return err.node
        ? `Node "${err.node}" can't run ${humanCapability(err.capability)}.`
        : `No node can run ${humanCapability(err.capability)}.`
    case 'placement_queue_full':
      return 'Too many pending placements right now — try again in a moment.'
    case 'placement_ttl_expired':
      return `No node advertises ${humanCapability(err.capability)} right now.`
    case 'unmapped_repo':
      return err.repo
        ? `No node has repo "${err.repo}" checked out.`
        : 'No node maps the requested repo.'
    default:
      return err.message
  }
}

export function toBrokerNodeSummary(node: RelayNode, selfNodeName: string): BrokerNodeSummary {
  const nodeId = node.nodeId ?? node.id
  return {
    name: node.name,
    ...(nodeId ? { nodeId } : {}),
    live: Boolean(node.live),
    ...(typeof node.load === 'number' ? { load: node.load } : {}),
    ...(typeof node.activeAgents === 'number' ? { activeAgents: node.activeAgents } : {}),
    ...(typeof node.maxAgents === 'number' ? { maxAgents: node.maxAgents } : {}),
    capabilities: node.capabilities.map((cap) => cap.name),
    ...(node.repoKeys ? { repoKeys: node.repoKeys } : {}),
    ...(node.tags ? { tags: node.tags } : {}),
    isSelf: node.name === selfNodeName
  }
}
