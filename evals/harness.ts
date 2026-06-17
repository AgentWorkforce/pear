/**
 * Thin wrapper around HarnessDriverClient for pear mount evals.
 *
 * Starts a local broker, creates an ephemeral Relaycast workspace for isolation,
 * spawns an agent with its cwd set to the fixture dir, collects broker events,
 * then waits for exit.
 *
 * The workspace key is cached for the lifetime of the process so we don't
 * create N workspaces for N runs in a single runner invocation.
 */

import { HarnessDriverClient } from '@agent-relay/harness-driver'
import type { BrokerEvent, AgentExitInfo } from '@agent-relay/harness-driver'
import { RelaycastSetup } from '@relaycast/sdk'

const AGENT_EXIT_TIMEOUT_MS = 180_000  // 3 min max per run
const AGENT_IDLE_THRESHOLD_SECS = 30   // release after 30s idle

export interface EvalRunResult {
  agentName: string
  exit: AgentExitInfo
  events: BrokerEvent[]
  durationMs: number
}

export interface RunEvalOptions {
  agentName: string
  task: string
  /** Temp dir with the fake .integrations/ mount (agent's cwd). */
  fixtureDir: string
  /** Agent CLI binary (default: 'claude'). E.g. 'codex' for OpenAI. */
  cli?: string
  model?: string
}

let _cachedWorkspaceKey: string | undefined

async function ensureWorkspaceKey(): Promise<string> {
  if (_cachedWorkspaceKey) return _cachedWorkspaceKey
  if (process.env.RELAY_API_KEY?.trim()) {
    _cachedWorkspaceKey = process.env.RELAY_API_KEY.trim()
    return _cachedWorkspaceKey
  }
  const setup = new RelaycastSetup()
  const ws = await setup.createWorkspace({ name: `pear-eval-${Date.now().toString(36)}` })
  _cachedWorkspaceKey = ws.apiKey
  return _cachedWorkspaceKey
}

/**
 * Run one eval: start broker, spawn agent in fixture dir, wait for exit, tear down.
 */
// Default model IDs for each CLI (used when no model is specified).
// opencode uses provider/model format; must be a real model from `opencode models`.
// Use a free model by default to avoid unnecessary costs in CI.
const DEFAULT_MODELS: Record<string, string> = {
  opencode: 'opencode/deepseek-v4-flash-free',
}

export async function runEval(opts: RunEvalOptions): Promise<EvalRunResult> {
  const { agentName, task, fixtureDir, cli = 'claude' } = opts
  const model = opts.model ?? DEFAULT_MODELS[cli]
  const workspaceKey = await ensureWorkspaceKey()
  const start = Date.now()
  const events: BrokerEvent[] = []

  // codex reads its model from OPENAI_MODEL env var; pass through to broker.
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (cli === 'codex' && model) env['OPENAI_MODEL'] = model

  const client = await HarnessDriverClient.spawn({
    workspaceKey,
    cwd: fixtureDir,
    channels: ['eval-general'],
    startupTimeoutMs: 30_000,
    env,
  })

  client.onEvent((event) => {
    events.push(event)
  })

  try {
    // opencode uses headless transport; all others use PTY.
    // skipRelayPrompt=true: skip Agent Relay MCP injection (opencode doesn't have it;
    // our evals only need filesystem writes, not relay messaging).
    const spawnInput = {
      name: agentName,
      cli,
      task,
      cwd: fixtureDir,
      channels: ['eval-general'],
      idleThresholdSecs: AGENT_IDLE_THRESHOLD_SECS,
      skipRelayPrompt: true,
      ...(model ? { model } : {}),
    }
    const agent = await (cli === 'opencode'
      ? client.spawnCli({ ...spawnInput, transport: 'headless' as const })
      : client.spawnPty(spawnInput))

    const exit = await agent.waitForExit(AGENT_EXIT_TIMEOUT_MS)

    return { agentName, exit, events, durationMs: Date.now() - start }
  } finally {
    await client.shutdown().catch(() => {})
  }
}
