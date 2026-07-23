import { basename, resolve } from 'node:path'
import {
  action,
  defineNode,
  startServeNode,
  type FleetCapabilityValue,
  type FleetNodeDefinition,
  type FleetNodeInfo,
  type NodeEngineConnection,
  type RunningNode
} from '@agent-relay/fleet'
import {
  aider,
  claude,
  codex,
  cursor,
  droid,
  gemini,
  goose,
  grok,
  opencode
} from '@agent-relay/harnesses'
import {
  resolveStaticHarnessConfig,
  type RestartPolicy,
  type StaticPtyHarnessDefinition
} from '@agent-relay/harness-driver'
import { z } from 'zod'

export const PEAR_LOCAL_SPAWN_HARNESSES = {
  claude,
  codex,
  gemini,
  opencode,
  grok,
  aider,
  goose,
  cursor,
  droid
} satisfies Record<string, StaticPtyHarnessDefinition>

const NODE_TOKEN_WAIT_MS = 15_000
const NODE_TOKEN_POLL_MS = 250

const restartPolicySchema = z.object({
  enabled: z.boolean().optional(),
  max_restarts: z.number().int().min(0).optional(),
  cooldown_ms: z.number().int().min(0).optional(),
  max_consecutive_failures: z.number().int().min(0).optional()
}).passthrough()

const spawnCapabilityInputSchema = z.object({
  name: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  clone_path: z.string().min(1).optional(),
  clonePath: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  task: z.string().optional(),
  model: z.string().min(1).optional(),
  session_ref: z.string().min(1).optional(),
  sessionRef: z.string().min(1).optional(),
  channels: z.array(z.string().min(1)).optional(),
  channel: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  restart_policy: restartPolicySchema.optional(),
  restartPolicy: restartPolicySchema.optional(),
  skip_relay_prompt: z.boolean().optional()
}).passthrough()

type RawSpawnCapabilityInput = z.infer<typeof spawnCapabilityInputSchema>
type SpawnCapabilityInput = RawSpawnCapabilityInput & {
  name: string | undefined
  clonePath: string | undefined
  sessionRef: string | undefined
  channels: string[] | undefined
  restartPolicy: RestartPolicy | undefined
}

export interface PearFleetNodeOptions {
  projectId: string
  cwd: string
  brokerName: string
}

export interface PearFleetSidecarOptions extends PearFleetNodeOptions {
  readBrokerSession: () => Promise<PearFleetBrokerSession | null | undefined>
  log?: (message: string) => void
  warn?: (message: string) => void
}

export interface PearFleetBrokerSession {
  relay_base_url?: string
  node_id?: string
  node_name?: string
  node_token?: string
}

export interface ResolvedPearFleetConnection {
  connection: NodeEngineConnection
  nodeName: string
}

export interface PearFleetConnectionWaitOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

type BrokerSessionReadResult =
  | { status: 'value'; session: PearFleetBrokerSession | null | undefined }
  | { status: 'error'; error: unknown }
  | { status: 'deadline' }
  | { status: 'aborted' }

export interface RunningPearFleetSidecar {
  readonly registered: Promise<FleetNodeInfo>
  readonly done: Promise<void>
  stop(): Promise<void>
}

export function createPearFleetNodeDefinition(options: PearFleetNodeOptions): FleetNodeDefinition {
  const nodeName = pearFleetProviderName(options)
  const clonePathKey = basename(options.cwd) || options.projectId || 'project'
  const clonePaths = { [clonePathKey]: options.cwd }
  const capabilities: Record<string, FleetCapabilityValue> = {}
  for (const [capabilityCli, harness] of Object.entries(PEAR_LOCAL_SPAWN_HARNESSES)) {
    capabilities[`spawn:${capabilityCli}`] = action({
      metadata: {
        pearLocalNode: true,
        cli: capabilityCli,
        command: harness.command,
        clonePaths
      }
    }, async (rawInput, ctx) => {
      const input = parseSpawnCapabilityInput(rawInput)
      if (!input.name) {
        throw new Error(`spawn:${capabilityCli} requires name or agent`)
      }
      const cwd = resolvePearSpawnCwd(options.cwd, input)
      const harnessConfig = resolveStaticHarnessConfig({
        name: input.name,
        cli: harness.command,
        definition: harness,
        args: input.args,
        task: input.task,
        model: input.model,
        cwd
      })

      const output = await ctx.spawnAgent({
        agent: {
          name: input.name,
          runtime: 'pty',
          cli: harness.command,
          ...(input.model ? { model: input.model } : {}),
          ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
          ...(input.channels ? { channels: input.channels } : {}),
          cwd,
          ...(input.sessionRef ? { session_id: input.sessionRef } : {}),
          ...(input.restartPolicy ? { restart_policy: input.restartPolicy as RestartPolicy } : {}),
          harness_config: harnessConfig
        },
        ...(input.task !== undefined ? { initialTask: input.task } : {}),
        skipRelayPrompt: input.skip_relay_prompt ?? false,
        invocationId: ctx.invocationId
      })

      return {
        name: input.name,
        capability: `spawn:${capabilityCli}`,
        cwd,
        invocationId: ctx.invocationId,
        agent: output
      }
    }) as FleetCapabilityValue
  }

  return defineNode({
    name: nodeName,
    capabilities,
    tags: ['pear', 'local', `project:${options.projectId}`],
    version: 'pear-local-fleet-v1'
  })
}

function parseSpawnCapabilityInput(input: unknown): SpawnCapabilityInput {
  const parsed = spawnCapabilityInputSchema.parse(input)
  return {
    ...parsed,
    name: parsed.name ?? parsed.agent,
    clonePath: parsed.clonePath ?? parsed.clone_path,
    sessionRef: parsed.sessionRef ?? parsed.session_ref,
    channels: parsed.channels ?? (parsed.channel ? [parsed.channel] : undefined),
    restartPolicy: parsed.restartPolicy ?? parsed.restart_policy
  }
}

function resolvePearSpawnCwd(projectCwd: string, input: SpawnCapabilityInput): string {
  const explicitPath = input.clonePath ?? input.cwd
  if (!explicitPath) return resolve(projectCwd)

  const requested = resolve(explicitPath)
  const advertised = resolve(projectCwd)
  if (requested !== advertised) {
    throw new Error(`checkout path is not advertised by this node: ${explicitPath}`)
  }
  return requested
}

/**
 * Resolve the broker's v10 fleet identity. The broker publishes `node_id`
 * before its background token mint can complete, so a single session read can
 * strand Pear's capability provider for the lifetime of the broker. Poll for a
 * bounded window and attach to the same engine node once the token appears.
 */
export async function resolvePearFleetConnection(
  readBrokerSession: () => Promise<PearFleetBrokerSession | null | undefined>,
  signal: AbortSignal,
  options: PearFleetConnectionWaitOptions = {}
): Promise<ResolvedPearFleetConnection> {
  const timeoutMs = options.timeoutMs ?? NODE_TOKEN_WAIT_MS
  const pollIntervalMs = options.pollIntervalMs ?? NODE_TOKEN_POLL_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const deadline = now() + timeoutMs
  let lastSession: PearFleetBrokerSession | undefined
  let lastError: unknown

  for (;;) {
    if (signal.aborted) throw abortError()
    const remainingMs = Math.max(0, deadline - now())
    const read = await readBrokerSessionBeforeDeadline(
      readBrokerSession,
      signal,
      remainingMs,
      sleep
    )
    if (read.status === 'aborted') throw abortError()
    if (read.status === 'deadline') break
    if (read.status === 'value') {
      lastSession = read.session ?? undefined
      lastError = undefined
      if (lastSession?.node_id && lastSession.node_token) {
        return {
          connection: {
            nodeId: lastSession.node_id,
            nodeToken: lastSession.node_token,
            ...(lastSession.relay_base_url ? { baseUrl: lastSession.relay_base_url } : {})
          },
          nodeName: lastSession.node_name ?? lastSession.node_id
        }
      }
    } else {
      lastError = read.error
    }

    if (now() >= deadline) break
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())), signal)
  }

  if (signal.aborted) throw abortError()
  if (!lastSession?.node_id) {
    const suffix = lastError ? `: ${toError(lastError).message}` : ''
    throw new Error(`Pear fleet provider timed out waiting for the broker node id${suffix}`)
  }
  throw new Error(`Pear fleet provider timed out waiting for a node token for ${lastSession.node_id}`)
}

// A broker request can wedge independently of the polling clock. Race every
// session read against both the remaining deadline and stop signal so a hung
// getSession() cannot strand sidecar shutdown. The read promise itself may not
// be cancellable, but both of its settlement paths remain observed after the
// race, avoiding a late unhandled rejection.
async function readBrokerSessionBeforeDeadline(
  readBrokerSession: () => Promise<PearFleetBrokerSession | null | undefined>,
  signal: AbortSignal,
  remainingMs: number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
): Promise<BrokerSessionReadResult> {
  if (signal.aborted) return { status: 'aborted' }
  if (remainingMs <= 0) return { status: 'deadline' }

  const deadlineController = new AbortController()
  const onAbort = (): void => deadlineController.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  let sessionPromise: Promise<PearFleetBrokerSession | null | undefined>
  try {
    sessionPromise = readBrokerSession()
  } catch (error) {
    sessionPromise = Promise.reject(error)
  }
  // Give already-settled client mocks/caches one microtask to win before
  // starting the deadline timer. Real in-flight I/O falls through and is
  // bounded below.
  const pendingRead = Symbol('pending broker session read')
  try {
    const immediate = await Promise.race([sessionPromise, Promise.resolve(pendingRead)])
    if (immediate !== pendingRead) {
      signal.removeEventListener('abort', onAbort)
      deadlineController.abort()
      return signal.aborted
        ? { status: 'aborted' }
        : { status: 'value', session: immediate }
    }
  } catch (error) {
    signal.removeEventListener('abort', onAbort)
    deadlineController.abort()
    return signal.aborted ? { status: 'aborted' } : { status: 'error', error }
  }
  const read = sessionPromise.then<BrokerSessionReadResult, BrokerSessionReadResult>(
    (session) => ({ status: 'value', session }),
    (error) => ({ status: 'error', error })
  )
  const timeout = sleep(remainingMs, deadlineController.signal).then<BrokerSessionReadResult>(() =>
    signal.aborted ? { status: 'aborted' } : { status: 'deadline' }
  )

  try {
    return await Promise.race([read, timeout])
  } finally {
    signal.removeEventListener('abort', onAbort)
    deadlineController.abort()
  }
}

export function startPearFleetSidecar(options: PearFleetSidecarOptions): RunningPearFleetSidecar {
  const controller = new AbortController()
  let running: RunningNode | undefined
  let registeredSettled = false
  let resolveRegistered!: (info: FleetNodeInfo) => void
  let rejectRegistered!: (error: Error) => void
  const registered = new Promise<FleetNodeInfo>((resolve, reject) => {
    resolveRegistered = (info) => {
      registeredSettled = true
      resolve(info)
    }
    rejectRegistered = (error) => {
      registeredSettled = true
      reject(error)
    }
  })

  const definition = createPearFleetNodeDefinition(options)
  const done = (async () => {
    try {
      const target = await resolvePearFleetConnection(options.readBrokerSession, controller.signal)
      if (controller.signal.aborted) throw abortError()
      running = startServeNode({
        definition,
        connection: target.connection,
        nameOverride: target.nodeName,
        providerName: definition.name,
        reconnect: true,
        signal: controller.signal,
        log: options.log,
        warn: options.warn,
        onRegistered: (info) => {
          if (!registeredSettled) resolveRegistered(info)
        }
      })
      await running.done
      if (!registeredSettled) {
        rejectRegistered(new Error('Pear fleet provider exited before registering'))
      }
    } catch (error) {
      if (!registeredSettled) rejectRegistered(toError(error))
      if (!controller.signal.aborted) throw error
    }
  })()

  return {
    registered,
    done,
    stop: async () => {
      controller.abort()
      await running?.stop().catch(() => undefined)
      await done
    }
  }
}

export function pearFleetProviderName(options: PearFleetNodeOptions): string {
  const rawName = `${options.brokerName || options.projectId || 'pear'}-local-fleet`
  return rawName.replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'pear-local-fleet'
}

function abortError(): Error {
  const error = new Error('Pear fleet provider stopped')
  error.name = 'AbortError'
  return error
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
