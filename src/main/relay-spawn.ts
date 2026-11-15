import type { ChatSpawnInput, ChatSpawnResult, RelaySpawnNode } from '../shared/types/ipc'

type Json = Record<string, unknown>

export type SpawnRequest = <T>(path: string, options: { method?: string; body?: unknown }) => Promise<T>

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,47}$/
const LIVE_AGENTS_CAPABILITY = 'relay:live-agents:v1'

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function records(value: unknown): Json[] {
  if (Array.isArray(value)) return value.map(record)
  const wrapped = record(value)
  for (const key of ['nodes', 'data', 'items']) {
    if (Array.isArray(wrapped[key])) return (wrapped[key] as unknown[]).map(record)
  }
  return []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Same machine under two installs (`mac.local`, `Mac`) shows once. */
export function machineKey(name: string): string {
  return name.trim().replace(/\.$/, '').replace(/\.local$/i, '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function isSpawnHost(node: Json): boolean {
  const tags = Array.isArray(node.tags) ? node.tags : []
  return text(node.status) === 'online' && node.live !== false && node.handlers_live !== false && !tags.includes('direct')
}

/** Online relay machines that advertise `spawn:<harness>`, one per machine, by name. */
export function parseSpawnNodes(raw: unknown): RelaySpawnNode[] {
  const nodes = records(raw).flatMap((node) => {
    if (!isSpawnHost(node)) return []
    const name = text(node.name)
    const spawns = records(node.capabilities).filter((capability) => {
      const value = text(capability.name)
      return value.startsWith('spawn:') && value.length > 6
    })
    const harnesses = [...new Set(spawns.map((capability) => text(capability.name).slice(6)))].sort()
    const repositories = [...new Set(spawns.flatMap((capability) => {
      const listed = record(record(capability.metadata).configured).repositories
      return Array.isArray(listed) ? listed.map(text).filter(Boolean) : []
    }))].sort()
    if (!name || harnesses.length === 0) return []
    return [repositories.length > 0 ? { name, harnesses, repositories } : { name, harnesses }]
  })
  nodes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name))
  const seen = new Set<string>()
  return nodes.filter((node) => {
    const key = machineKey(node.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Node id → name, for agents that only report the node they run on. */
export function nodeNamesById(raw: unknown): Map<string, string> {
  const names = new Map<string, string>()
  for (const node of records(raw)) {
    const id = text(node.id) || text(node.node_id)
    const name = text(node.name)
    if (id && name) names.set(id, name)
  }
  return names
}

/** Whether `node` reports `name` among its live agents. */
export function nodeHasLiveAgent(raw: unknown, node: string, name: string): boolean {
  return records(raw).some((entry) =>
    text(entry.name) === node &&
    isSpawnHost(entry) &&
    records(entry.capabilities).some((capability) =>
      text(capability.name) === LIVE_AGENTS_CAPABILITY &&
      Array.isArray(record(capability.metadata).names) &&
      (record(capability.metadata).names as unknown[]).includes(name)
    )
  )
}

/** A start error as a sentence a person can act on, keeping the raw detail. */
export function spawnFailureMessage(detail: string, node: string, name: string, harness: string): string {
  const raw = detail.trim()
  const lower = raw.toLowerCase()
  let summary: string
  if (lower.includes('d1_pressure') || lower.includes('liveness retry pending')) {
    summary = `Agent Relay is busy and could not register ${name}. Wait a minute, then try again.`
  } else if (lower.includes('spawn_readiness_timeout') || lower.includes('readiness timeout')) {
    summary = `${name} did not become ready on ${node} in time. Check the agent list before trying again.`
  } else if (lower.includes('preflight')) {
    summary = `${node} could not set up Agent Relay tools for ${name}, so it did not start the agent.`
  } else if (harness === 'codex' && lower.includes('codex') && lower.includes('lock')) {
    summary = `Codex on ${node} is in use by another session. Try again later or choose another agent type.`
  } else if (['operation not permitted', 'permission denied', 'eperm', 'eacces'].some((s) => lower.includes(s))) {
    summary = `${node} cannot open that folder. Folders on an external drive may not be readable by background apps; choose one on the internal disk.`
  } else if (['enoent', 'no such file', 'not a directory'].some((s) => lower.includes(s))) {
    summary = `That folder does not exist on ${node}. Check the path.`
  } else if (
    lower.includes('name_in_use') || lower.includes('name_taken') ||
    (lower.includes('already') && ['exists', 'taken', 'in use'].some((s) => lower.includes(s)))
  ) {
    summary = `The name ${name} is already in use, possibly by an earlier start still being cleaned up. Choose another name.`
  } else {
    summary = `${node} did not start ${name}.`
  }
  return raw ? `${summary}\nDetails: ${raw}` : summary
}

/** Problem with the start form, or null when it can be sent. */
export function spawnInputProblem(input: ChatSpawnInput, node: RelaySpawnNode | undefined): string | null {
  if (!node) return 'That machine is no longer available. Refresh and choose another.'
  if (!node.harnesses.includes(input.harness)) return `${node.name} can't start ${input.harness} agents.`
  if (!NAME_PATTERN.test(input.name.trim())) {
    return 'Names start with a lowercase letter and use 2–48 lowercase letters, digits, or dashes.'
  }
  if (!input.task.trim()) return 'Describe what the agent should work on.'
  const folder = input.workingDirectory?.trim() ?? ''
  if (folder) {
    if (folder.startsWith('~')) return `Enter the full path on ${node.name}, such as /Users/name/project. ~ is not expanded.`
    if (!folder.startsWith('/')) return `Enter the full path on ${node.name}, starting with /.`
    if (folder.includes('\n')) return 'Enter the folder on one line.'
  }
  return null
}

export class SpawnError extends Error {}

/**
 * Starts agents on relay machines the way the Relay apps do: invoke the
 * node's `spawn` action, then wait for its readiness receipt. A start that
 * was accepted but never confirmed is reported as such and is never sent
 * again, and repeated requests for the same agent share one attempt.
 */
export class RelaySpawner {
  private readonly inFlight = new Map<string, Promise<ChatSpawnResult>>()

  constructor(
    private readonly request: SpawnRequest,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly pollAttempts = 60,
    private readonly pollIntervalMs = 2_000
  ) {}

  async listNodes(): Promise<RelaySpawnNode[]> {
    return parseSpawnNodes(await this.request<unknown>('/nodes', {}))
  }

  spawn(input: ChatSpawnInput): Promise<ChatSpawnResult> {
    const key = `${input.node}\u0000${input.name.trim()}`
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const attempt = this.start(input).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, attempt)
    return attempt
  }

  private async start(input: ChatSpawnInput): Promise<ChatSpawnResult> {
    const nodes = await this.listNodes()
    const node = nodes.find((candidate) => candidate.name === input.node)
    const problem = spawnInputProblem(input, node)
    if (problem || !node) throw new SpawnError(problem ?? 'That machine is no longer available.')

    const name = input.name.trim()
    const body: Json = {
      capability: `spawn:${input.harness}`,
      cli: input.harness,
      node: node.name,
      target_node: node.name,
      name,
      task: input.task.trim(),
      verify_ready: true
    }
    const folder = input.workingDirectory?.trim()
    if (folder) body.worker_cwd = folder

    let accepted: Json
    try {
      accepted = record(await this.request<unknown>(`/nodes/${encodeURIComponent(node.name)}/actions/spawn/invoke`, {
        method: 'POST',
        body: { input: body }
      }))
    } catch (error) {
      throw new SpawnError(spawnFailureMessage(error instanceof Error ? error.message : String(error), node.name, name, input.harness))
    }
    const invocationId = text(accepted.invocation_id)
    if (!invocationId) {
      throw new SpawnError('The start request did not return a receipt. Check the agent list before trying again.')
    }

    const done = (outcome: ChatSpawnResult['outcome']): ChatSpawnResult => ({ outcome, name, node: node.name })
    for (let attempt = 1; attempt <= this.pollAttempts; attempt += 1) {
      await this.sleep(this.pollIntervalMs)
      // Some nodes start the worker but never complete the receipt, so the
      // node's live-agent list also counts as proof the agent is up.
      if (attempt % 5 === 0 && await this.isLive(node.name, name)) return done('running')
      let receipt: Json
      try {
        receipt = record(await this.request<unknown>(`/actions/spawn/invocations/${encodeURIComponent(invocationId)}`, {}))
      } catch {
        continue
      }
      const status = text(receipt.status)
      if (status === 'completed') {
        const output = record(receipt.output)
        if (output.spawned !== true || output.ready === false) {
          throw new SpawnError(spawnFailureMessage(text(output.error), node.name, name, input.harness))
        }
        return done('ready')
      }
      if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
        throw new SpawnError(spawnFailureMessage(text(receipt.error), node.name, name, input.harness))
      }
    }
    return done(await this.isLive(node.name, name) ? 'running' : 'unconfirmed')
  }

  private async isLive(node: string, name: string): Promise<boolean> {
    try {
      return nodeHasLiveAgent(await this.request<unknown>('/nodes', {}), node, name)
    } catch {
      return false
    }
  }
}
