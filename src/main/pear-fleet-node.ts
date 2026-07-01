import { basename, resolve } from 'node:path'
import {
  action,
  defineNode,
  invokeNodeHandler,
  nodeInfo,
  nodeManifest,
  type FleetCapabilityValue,
  type FleetNodeDefinition
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
  opencode,
  type PtyHarness
} from '@agent-relay/harnesses'
import { resolveStaticHarnessConfig, type RestartPolicy } from '@agent-relay/harness-driver'
import { PROTOCOL_VERSION, type NodeManifest } from '@agent-relay/harness-driver/protocol'
import WebSocket from 'ws'
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
} satisfies Record<string, PtyHarness>

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 5_000
const REQUEST_TIMEOUT_MS = 5_000
const DEREGISTER_TIMEOUT_MS = 1_000

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
  connection: {
    url: string
    apiKey?: string
  }
  log?: (message: string) => void
  warn?: (message: string) => void
}

export interface RunningPearFleetSidecar {
  readonly registered: Promise<NodeManifest>
  readonly done: Promise<void>
  stop(): Promise<void>
}

type BrokerFrame = {
  type?: string
  request_id?: string
  payload?: unknown
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createPearFleetNodeDefinition(options: PearFleetNodeOptions): FleetNodeDefinition {
  const nodeName = pearFleetNodeName(options)
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

export function startPearFleetSidecar(options: PearFleetSidecarOptions): RunningPearFleetSidecar {
  const controller = new AbortController()
  let resolveRegistered: (manifest: NodeManifest) => void
  let rejectRegistered: (error: Error) => void
  let registeredSettled = false
  const registered = new Promise<NodeManifest>((resolve, reject) => {
    resolveRegistered = (manifest) => {
      registeredSettled = true
      resolve(manifest)
    }
    rejectRegistered = (error) => {
      registeredSettled = true
      reject(error)
    }
  })

  const definition = createPearFleetNodeDefinition(options)
  const done = runPearFleetSidecarLoop({
    ...options,
    definition,
    signal: controller.signal,
    onRegistered: (manifest) => {
      if (!registeredSettled) resolveRegistered(manifest)
    },
    onInitialFailure: (error) => {
      if (!registeredSettled) rejectRegistered(error)
    }
  })

  return {
    registered,
    done,
    stop: async () => {
      controller.abort()
      await done
    }
  }
}

function pearFleetNodeName(options: PearFleetNodeOptions): string {
  const rawName = `${options.brokerName || options.projectId || 'pear'}-local-fleet`
  return rawName.replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'pear-local-fleet'
}

async function runPearFleetSidecarLoop(options: PearFleetSidecarOptions & {
  definition: FleetNodeDefinition
  signal: AbortSignal
  onRegistered: (manifest: NodeManifest) => void
  onInitialFailure: (error: Error) => void
}): Promise<void> {
  let attempt = 0
  let registeredOnce = false

  while (!options.signal.aborted) {
    try {
      await runPearFleetSidecarConnection({
        ...options,
        onRegistered: (manifest) => {
          registeredOnce = true
          options.onRegistered(manifest)
        }
      })
      attempt = 0
    } catch (error) {
      const err = toError(error)
      if (!registeredOnce) {
        options.onInitialFailure(err)
      }
      if (options.signal.aborted) return
      options.warn?.(`Pear fleet sidecar disconnected: ${err.message}; reconnecting`)
    }

    if (options.signal.aborted) return
    attempt += 1
    await delay(Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1)), options.signal)
  }
}

function runPearFleetSidecarConnection(options: PearFleetSidecarOptions & {
  definition: FleetNodeDefinition
  signal: AbortSignal
  onRegistered: (manifest: NodeManifest) => void
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(fleetWsUrl(options.connection.url), {
      headers: options.connection.apiKey ? { 'X-API-Key': options.connection.apiKey } : undefined
    })
    const pending = new Map<string, PendingRequest>()
    let requestSeq = 0
    let settled = false
    let nodeRegistered = false

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(new Error('Pear fleet sidecar connection closed'))
      }
      pending.clear()
      options.signal.removeEventListener('abort', abort)
      fn()
    }

    const sendRequest = (type: string, payload: unknown): Promise<unknown> => {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('Pear fleet sidecar websocket is not open'))
      }
      const requestId = `pear_fleet_${Date.now()}_${++requestSeq}`
      const frame = {
        v: PROTOCOL_VERSION,
        type,
        request_id: requestId,
        payload
      }

      return new Promise((requestResolve, requestReject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          requestReject(new Error(`Pear fleet sidecar ${type} request timed out after ${REQUEST_TIMEOUT_MS}ms`))
        }, REQUEST_TIMEOUT_MS)
        const pendingRequest: PendingRequest = {
          timer,
          resolve: (value) => {
            clearTimeout(timer)
            requestResolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            requestReject(error)
          }
        }
        pending.set(requestId, pendingRequest)
        ws.send(JSON.stringify(frame), (error) => {
          if (!error) return
          if (!pending.has(requestId)) return
          pending.delete(requestId)
          pendingRequest.reject(error)
        })
      })
    }

    const close = async (): Promise<void> => {
      if (ws.readyState === WebSocket.OPEN && nodeRegistered) {
        await withTimeout(sendRequest('deregister_node', {}), DEREGISTER_TIMEOUT_MS).catch(() => undefined)
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    const ignoreCloseError = (error: unknown): void => {
      options.warn?.(`Pear fleet sidecar close skipped: ${toError(error).message}`)
    }

    const abort = (): void => {
      void close().catch(ignoreCloseError).finally(() => settle(resolve))
    }

    const sendHandlerResult = async (invocationId: string, output: unknown, error?: unknown): Promise<void> => {
      const payload = error
        ? { invocation_id: invocationId, error: toError(error).message }
        : { invocation_id: invocationId, output: output ?? null }
      await sendRequest('handler_result', payload)
    }

    const handleInvoke = async (payload: unknown): Promise<void> => {
      const record = asRecord(payload)
      const invocationId = typeof record.invocation_id === 'string' ? record.invocation_id : undefined
      const name = typeof record.name === 'string' ? record.name : undefined
      if (!invocationId || !name) return

      try {
        const output = await invokeNodeHandler(options.definition, name, record.input, {
          node: nodeInfo(options.definition),
          invocationId,
          relay: {
            sendMessage: (input) => sendRequest('send_message', {
              to: input.to,
              text: input.text,
              from: input.from ?? options.definition.name,
              ...(input.threadId ? { thread_id: input.threadId } : {}),
              ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
              ...(input.workspaceAlias ? { workspace_alias: input.workspaceAlias } : {}),
              ...(input.mode ? { mode: input.mode } : {}),
              ...(input.data ? { data: input.data } : {})
            })
          },
          spawnAgent: (input) => sendRequest('spawn_agent', {
            agent: input.agent,
            ...(input.initialTask !== undefined ? { initial_task: input.initialTask } : {}),
            skip_relay_prompt: input.skipRelayPrompt ?? false,
            ...((input.invocationId ?? invocationId) ? { invocation_id: input.invocationId ?? invocationId } : {})
          })
        })
        await sendHandlerResult(invocationId, output)
      } catch (error) {
        await sendHandlerResult(invocationId, undefined, error)
      }
    }

    options.signal.addEventListener('abort', abort, { once: true })

    ws.on('open', () => {
      void (async () => {
        const manifest = nodeManifest(options.definition)
        await sendRequest('hello', {
          client_name: 'pear-local-fleet',
          client_version: '1.0.0'
        })
        await sendRequest('register_node', { manifest })
        nodeRegistered = true
        await sendRequest('register_handlers', { names: Object.keys(options.definition.capabilities) })
        options.log?.(`Pear fleet node "${manifest.name}" registered with ${manifest.capabilities.length} capabilities.`)
        options.onRegistered(manifest)
      })().catch((error) => {
        settle(() => reject(toError(error)))
        void close().catch(ignoreCloseError)
      })
    })

    ws.on('message', (data) => {
      const frame = parseBrokerFrame(data)
      if (!frame) return
      if (frame.request_id && pending.has(frame.request_id)) {
        const pendingRequest = pending.get(frame.request_id)
        pending.delete(frame.request_id)
        if (!pendingRequest) return
        if (frame.type === 'error') {
          pendingRequest.reject(frameError(frame.payload))
        } else {
          pendingRequest.resolve(readOkResult(frame.payload))
        }
        return
      }
      if (frame.type === 'invoke_handler') {
        void handleInvoke(frame.payload).catch((error) => options.warn?.(toError(error).message))
      }
    })

    ws.on('close', () => settle(resolve))
    ws.on('error', (error) => settle(() => reject(toError(error))))
  })
}

function parseBrokerFrame(data: WebSocket.RawData): BrokerFrame | null {
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString()
    return JSON.parse(text) as BrokerFrame
  } catch {
    return null
  }
}

function readOkResult(payload: unknown): unknown {
  return payload && typeof payload === 'object' && 'result' in payload
    ? (payload as { result: unknown }).result
    : payload
}

function frameError(payload: unknown): Error {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const error = new Error(typeof record.message === 'string' ? record.message : 'Pear fleet sidecar request failed')
    error.name = typeof record.code === 'string' ? record.code : 'PearFleetSidecarError'
    return error
  }
  return new Error('Pear fleet sidecar request failed')
}

function fleetWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '').replace(/^http/u, 'ws')}/api/fleet/ws`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
