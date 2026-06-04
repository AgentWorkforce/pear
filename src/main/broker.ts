import { accessSync, constants, existsSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { delimiter, basename, dirname, join } from 'path'
import { execFileSync } from 'child_process'
import { app, BrowserWindow } from 'electron'
import {
  HarnessDriverClient as AgentRelayClient,
  type RuntimeSpawnOptions as AgentRelaySpawnOptions,
  type SpawnPtyInput,
  type SendMessageInput,
  type BrokerEvent,
  type BrokerStatus,
  type ListAgent,
  type InboundDeliveryMode,
  type PendingRelayMessage,
  type PtyInputStream
} from '@agent-relay/harness-driver'
import { getAccessToken, getApiUrl } from './auth'
import { assertDirectory } from './path-utils'
import { createPearBurnSpawnListener, stampPearBurnSpawnedAgent } from './burn-spawn-hook'
import { getBurnLedgerHome, getPearBurnAgentKey } from './burn'
import {
  BrokerConnectionFileSchema,
  GeneratedCommitDraftSchema,
  type GeneratedCommitDraft
} from './schemas'
import { compactBrokerEvent, normalizeEventTimestamp } from '../shared/lib/broker-events'
import type { WorkforcePersona } from '../shared/types/ipc'

function isShellLikeCommand(cli: string): boolean {
  const normalized = basename(cli).toLowerCase()
  return ['shell', 'sh', 'bash', 'zsh', 'fish', 'nu', 'nushell', 'pwsh', 'powershell'].includes(normalized)
}

function spawnCliLabel(cli: string): string {
  return basename(cli).toLowerCase()
}

function resolveShellCommand(): string {
  const configuredShell = process.env.SHELL?.trim()
  if (configuredShell) {
    return configuredShell
  }

  if (process.platform === 'win32') {
    return 'powershell.exe'
  }

  return '/bin/zsh'
}

function canExecute(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveCommandOnPath(command: string): string | undefined {
  const pathValue = process.env.PATH || ''
  const extensions = process.platform === 'win32'
    ? ['', '.cmd', '.exe', '.bat']
    : ['']

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      if (canExecute(candidate)) return candidate
    }
  }

  try {
    const resolved = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).split(/\r?\n/)[0]?.trim()
    return resolved || undefined
  } catch {
    return undefined
  }
}

function commonUserBinDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.asdf', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
}

function augmentedPath(): string {
  const current = process.env.PATH || ''
  const entries = new Set(current.split(delimiter).filter(Boolean))
  for (const dir of commonUserBinDirs()) entries.add(dir)
  return Array.from(entries).join(delimiter)
}

function resolveCommandWithAugmentedPath(command: string): string | undefined {
  const resolved = resolveCommandOnPath(command)
  if (resolved) return resolved

  for (const dir of commonUserBinDirs()) {
    const candidate = join(dir, command)
    if (canExecute(candidate)) {
      process.env.PATH = augmentedPath()
      return candidate
    }
  }

  return undefined
}

function resolvePackageBin(packageName: string, binName: string): string | undefined {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`)
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const binPath = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[binName]
    if (!binPath) return undefined

    const candidate = join(dirname(packageJsonPath), binPath)
    return canExecute(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function resolvePackageVersion(packageName: string): string | undefined {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`)
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      version?: string
    }
    return packageJson.version?.trim() || undefined
  } catch {
    return undefined
  }
}

function resolveAgentWorkforceCommand(cwd: string): { cli: string; args: string[] } {
  const binaryName = process.platform === 'win32' ? 'agentworkforce.cmd' : 'agentworkforce'
  const localCandidates = [
    join(cwd, 'node_modules', '.bin', binaryName),
    join(process.cwd(), 'node_modules', '.bin', binaryName)
  ]

  for (const candidate of localCandidates) {
    if (canExecute(candidate)) return { cli: candidate, args: [] }
  }

  const packageCommand = resolvePackageBin('agentworkforce', 'agentworkforce')
  if (packageCommand) {
    if (process.platform !== 'win32') return { cli: packageCommand, args: [] }
    const nodeCommand = resolveCommandOnPath('node')
    if (nodeCommand) return { cli: nodeCommand, args: [packageCommand] }
  }

  const pathCommand = resolveCommandOnPath('agentworkforce')
  if (pathCommand) return { cli: pathCommand, args: [] }

  const npxCommand = resolveCommandOnPath('npx')
  if (npxCommand) return { cli: npxCommand, args: ['-y', `agentworkforce@${AGENTWORKFORCE_CLI_VERSION}`] }

  throw new Error('AgentWorkforce CLI not found — install it to launch personas')
}

function resolveNodeCommandForMcp(): string | undefined {
  const execBasename = basename(process.execPath).toLowerCase()
  if (execBasename === 'node' || execBasename === 'node.exe') {
    return process.execPath
  }

  return resolveCommandOnPath('node')
}

function resolveBundledAgentRelayMcpScript(): string | undefined {
  const packageCommand = resolvePackageBin('agent-relay', 'agent-relay')
  if (packageCommand) {
    const sibling = join(dirname(packageCommand), 'agent-relay-mcp.js')
    if (existsSync(sibling)) return sibling
  }

  try {
    const packageJsonPath = require.resolve('agent-relay/package.json')
    const candidate = join(dirname(packageJsonPath), 'dist', 'cli', 'agent-relay-mcp.js')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function resolveAgentRelayMcpCommand(): string | undefined {
  const configured = process.env.AGENT_RELAY_MCP_COMMAND?.trim()
  if (configured) return configured

  const bundledMcpScript = resolveBundledAgentRelayMcpScript()
  const nodeCommand = bundledMcpScript ? resolveNodeCommandForMcp() : undefined
  if (bundledMcpScript && nodeCommand) {
    return `${nodeCommand} ${bundledMcpScript}`
  }

  const packageCommand = resolvePackageBin('agent-relay', 'agent-relay') || resolveCommandOnPath('agent-relay')
  if (packageCommand) return `${packageCommand} mcp`

  const npxCommand = resolveCommandOnPath('npx')
  if (npxCommand) {
    return `${npxCommand} -y agent-relay@${resolvePackageVersion('agent-relay') || AGENT_RELAY_CLI_VERSION} mcp`
  }

  return undefined
}

function parseAgentWorkforceJson<T>(output: string, label: string): T {
  try {
    return JSON.parse(output) as T
  } catch (err) {
    throw new Error(`Failed to parse AgentWorkforce ${label} JSON: ${toErrorMessage(err)}`)
  }
}

function runAgentWorkforceJson<T>(
  cwd: string,
  command: { cli: string; args: string[] },
  args: string[],
  label: string
): T {
  const output = execFileSync(command.cli, [...command.args, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return parseAgentWorkforceJson<T>(output, label)
}

function normalizePersonaTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags = value
    .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    .map((tag) => tag.trim())
  return tags.length > 0 ? tags : undefined
}

function normalizePersonaSummary(summary: AgentWorkforcePersonaSummary): WorkforcePersona | null {
  const id = typeof summary.persona === 'string'
    ? summary.persona.trim()
    : typeof summary.id === 'string'
      ? summary.id.trim()
      : ''
  if (!id) return null

  const description = typeof summary.description === 'string' && summary.description.trim()
    ? summary.description.trim()
    : undefined
  const harness = typeof summary.harness === 'string' && summary.harness.trim()
    ? summary.harness.trim()
    : undefined
  const source = typeof summary.source === 'string' && summary.source.trim()
    ? summary.source.trim()
    : undefined
  const tags = normalizePersonaTags(summary.tags)

  return {
    id,
    ...(description ? { description } : {}),
    ...(harness ? { harness } : {}),
    ...(tags ? { tags } : {}),
    ...(source ? { source } : {})
  }
}

function normalizeResolvedPersona(output: AgentWorkforceShowOutput, requestedId: string): ResolvedWorkforcePersona {
  const spec = output.spec
  if (!spec || typeof spec !== 'object') {
    throw new Error(`Workforce persona not found: ${requestedId}`)
  }

  const raw = spec as Record<string, unknown>
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : requestedId
  const description = typeof raw.description === 'string' && raw.description.trim()
    ? raw.description.trim()
    : undefined
  const harness = typeof raw.harness === 'string' && raw.harness.trim()
    ? raw.harness.trim()
    : undefined
  const source = typeof output.source === 'string' && output.source.trim()
    ? output.source.trim()
    : undefined
  const tags = normalizePersonaTags(raw.tags)

  return {
    ...(source ? { source } : {}),
    spec: {
      id,
      ...(description ? { description } : {}),
      ...(harness ? { harness } : {}),
      ...(tags ? { tags } : {})
    }
  }
}

function listWorkforcePersonas(cwd: string): WorkforcePersona[] {
  const command = resolveAgentWorkforceCommand(cwd)
  const output = runAgentWorkforceJson<AgentWorkforceListOutput>(
    cwd,
    command,
    ['list', '--json'],
    'list'
  )
  const personas = Array.isArray(output.personas) ? output.personas : []
  return personas
    .map((persona) => normalizePersonaSummary(persona as AgentWorkforcePersonaSummary))
    .filter((persona): persona is WorkforcePersona => persona !== null)
}

function findWorkforcePersona(
  cwd: string,
  personaId: string,
  command = resolveAgentWorkforceCommand(cwd)
): ResolvedWorkforcePersona {
  try {
    const output = runAgentWorkforceJson<AgentWorkforceShowOutput>(
      cwd,
      command,
      ['show', personaId, '--json'],
      'show'
    )
    return normalizeResolvedPersona(output, personaId)
  } catch (err) {
    throw new Error(`Workforce persona not found: ${personaId}: ${toErrorMessage(err)}`)
  }
}

// Resolve the broker binary bundled with the v8 harness-driver runtime.
// The runtime normally resolves this via import.meta.url, but that breaks when
// electron-vite bundles the driver into the main process (import.meta.url points
// to out/main/ instead of node_modules/).
function resolveBundledBrokerBinary(): string {
  // Use local relay build if available (for development)
  const localBinary = join(__dirname, '..', '..', '..', 'relay', 'target', 'debug', 'agent-relay-broker')
  try {
    require('fs').accessSync(localBinary, require('fs').constants.X_OK)
    console.log('[broker] Using local relay binary:', localBinary)
    return localBinary
  } catch {
    // Fall back to SDK-bundled binary
  }

  const suffix = `${process.platform}-${process.arch}`
  const unpackIfPackaged = (binary: string): string =>
    app.isPackaged ? binary.replace('app.asar', 'app.asar.unpacked') : binary

  // v8 ships the broker as a per-platform optional package (@agent-relay/broker-*).
  const optionalPackageBinary = join(
    __dirname, '..', '..', 'node_modules', '@agent-relay', `broker-${suffix}`, 'bin',
    process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker'
  )
  if (canExecute(optionalPackageBinary)) return unpackIfPackaged(optionalPackageBinary)

  // Backward-compatible fallback for SDK packages that still carry per-platform
  // broker binaries directly.
  const brokerBinary = join(
    __dirname, '..', '..', 'node_modules', '@agent-relay', 'sdk', 'bin',
    `agent-relay-broker-${suffix}${process.platform === 'win32' ? '.exe' : ''}`
  )
  return unpackIfPackaged(brokerBinary)
}

type TerminalAttachMode = 'view' | 'drive' | 'passthrough'

export interface CloudAgentSandboxHandle {
  sandboxId: string
  execUrl: string
  apiKey?: string
  relayfileMountPath?: string
}

type BrokerEventObserver = (projectId: string, event: BrokerEvent) => void

export interface AttachTerminalInput {
  name: string
  rows?: number
  cols?: number
  mode?: TerminalAttachMode
}

export interface AttachTerminalResult {
  name: string
  mode: InboundDeliveryMode
  previousMode?: InboundDeliveryMode
  pending: number
  snapshot?: {
    rows: number
    cols: number
    cursor: [number, number]
    screen: string
  }
}

export type { GeneratedCommitDraft }

export interface BrokerRuntimeAutoFixResult {
  removed: string[]
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const BROKER_DETAILS_TIMEOUT_MS = 3_000
const COMMIT_DRAFT_MAX_DIFF_CHARS = 80_000
const COMMIT_DRAFT_TIMEOUT_MS = 180_000
const MAX_BROKER_EVENT_HISTORY = 3_000
const BROKER_EVENT_HISTORY_TTL_MS = 12 * 60 * 60 * 1_000
// After this many consecutive failures to open a PTY input stream, give up on
// the WS fast path for that agent and send over HTTP until it re-attaches.
const MAX_INPUT_STREAM_OPEN_FAILURES = 3
// A single broker read timeout can be a one-off slow response; a run of them
// means that endpoint is wedged (alive, accepting TCP, never answering).
// After this many consecutive timeouts for one project/operation we respawn it
// rather than time out every poll forever. A successful request for that same
// operation resets the streak.
const MAX_BROKER_TIMEOUTS_BEFORE_REVIVE = 2
const BROKER_REVIVE_TERM_GRACE_MS = 1_500
const PERSONA_REGISTRATION_TIMEOUT_MS = 5_000
const PERSONA_REGISTRATION_STABILITY_MS = 1_000
const AGENTWORKFORCE_CLI_VERSION = '3.0.35'
const AGENT_RELAY_CLI_VERSION = '8.1.2'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface PearLineageEntry {
  lineageId: string
  agentKey: string
  parentAgentKey?: string
  cwd?: string
  cli?: string
}

interface AgentWorkforcePersonaSummary {
  persona?: unknown
  id?: unknown
  source?: unknown
  harness?: unknown
  tags?: unknown
  description?: unknown
}

interface AgentWorkforceListOutput {
  personas?: unknown
}

interface AgentWorkforceShowOutput {
  source?: unknown
  spec?: unknown
}

interface AgentWorkforcePersonaSpec {
  id: string
  description?: string
  harness?: string
  tags?: string[]
}

interface ResolvedWorkforcePersona {
  source?: string
  spec: AgentWorkforcePersonaSpec
}

function getPearBurnSpawnEnrichment(
  projectId: string,
  input: { name: string; cwd?: string; cli?: string; team?: string; model?: string },
  lineage?: { lineageId: string; parentAgentKey?: string }
): Record<string, string> {
  return {
    // Defaults that the spawn listener applies via DEFAULT_ENRICHMENT. The
    // Codex post-spawn path and observed-child-spawn path write stamps without
    // going through the listener, and burn queries/rollups filter on
    // `spawner: 'pear'` (see getPearBurnAgentTags / getPearBurnProjectTags), so
    // these must be present or the session disappears from every rollup.
    spawner: 'pear',
    on_relay: 'true',
    spawned_by: 'direct',
    pear_project_id: projectId,
    pear_agent_name: input.name,
    pear_agent_key: getPearBurnAgentKey(projectId, input.name),
    ...(input.cwd ? { pear_cwd: input.cwd } : {}),
    ...(input.cli ? { pear_cli: input.cli } : {}),
    ...(input.team ? { relay_team: input.team } : {}),
    ...(input.model ? { model_requested: input.model } : {}),
    ...(lineage?.lineageId ? { pear_lineage_id: lineage.lineageId } : {}),
    ...(lineage?.parentAgentKey ? { pear_parent_agent_key: lineage.parentAgentKey } : {})
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await delay(100)
  }
  return !isProcessAlive(pid)
}

async function terminateOwnedBrokerProcess(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 0 || !Number.isInteger(pid) || !isProcessAlive(pid)) return

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn(`[broker] Failed to terminate broker process ${pid}:`, err)
    }
    return
  }

  if (await waitForProcessExit(pid, BROKER_REVIVE_TERM_GRACE_MS)) return

  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn(`[broker] Failed to kill broker process ${pid}:`, err)
    }
  }
}

// NOTE: an earlier version of this file wrapped HarnessDriverClient.spawn in an
// outer retry for retryable errors. That was unsafe: every spawn() call forks
// a fresh broker child process (see client.js spawn → child_process.spawn),
// and the SDK does NOT kill the child on partial failure. Retrying after the
// SDK's built-in 10s 503-poll exhausted left the first broker alive while a
// second one started — two brokers fought over connection.json, workspace
// identity, and ports, which surfaced as mass agent release and a dead
// broker. The SDK's internal 10s polling is the only retry that's safe at
// this layer; if it fails, surface the error and let the user retry through
// the UI (which goes through connectExistingBroker first).

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type BrokerEventRecordPayload = Record<string, unknown> & { kind: string }

function getErrorStatus(err: unknown): unknown {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined
  return (err as { status?: unknown }).status
}

function isUnsupportedInputStreamError(err: unknown): boolean {
  return getErrorStatus(err) === 404 || /\b404\b|not found|unsupported/i.test(toErrorMessage(err))
}

function isMissingAgentError(err: unknown): boolean {
  return getErrorStatus(err) === 404 || /agent_not_found|no worker named|not found/i.test(toErrorMessage(err))
}

function isWorkspaceNotStartedError(err: unknown): boolean {
  return /relay workspace not started|no relay workspace found/i.test(toErrorMessage(err))
}

// Walk an error's `cause` chain looking for any node that satisfies `predicate`.
// Node's `fetch` wraps the real socket error: a dead broker surfaces as
// `TypeError: fetch failed` whose `cause` carries the `ECONNREFUSED` code, and
// `toErrorMessage` only reads the top-level `.message`, so the cause chain is
// where the actionable signal lives.
function someInCauseChain(err: unknown, predicate: (node: Record<string, unknown>) => boolean): boolean {
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if (predicate(current as Record<string, unknown>)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

// A dead local broker (process exited, nothing listening on the cached port)
// fails the connection outright with `ECONNREFUSED`/`ECONNRESET`. This is a
// definitive "broker is gone" signal — safe to respawn on the spot.
function isBrokerUnreachableError(err: unknown): boolean {
  return someInCauseChain(err, (node) => {
    const code = node.code
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return true
    const message = node.message
    return typeof message === 'string' && /ECONNREFUSED|ECONNRESET/.test(message)
  })
}

// A wedged broker (alive, accepting the TCP connection, but never answering the
// HTTP request) surfaces as the transport's `AbortSignal.timeout` firing — a
// `TimeoutError` DOMException — or as a socket-level `ETIMEDOUT`. Unlike an
// unreachable broker this can also be a one-off slow response, so callers gate
// respawning behind a consecutive-timeout count rather than acting immediately.
function isBrokerTimeoutError(err: unknown): boolean {
  return someInCauseChain(err, (node) => {
    if (node.code === 'ETIMEDOUT') return true
    if (node.name === 'TimeoutError') return true
    const message = node.message
    return typeof message === 'string' && /aborted due to timeout|ETIMEDOUT|timed?out/i.test(message)
  })
}

// The PTY input WS rejects in-flight sends with `input_stream_closed` when the
// stream is deliberately torn down (project/agent shutdown, terminal re-attach)
// while a keystroke was mid-flight. That's an expected close, not a transport
// failure — callers fall through to HTTP without logging it as an error.
function isInputStreamClosedError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === 'input_stream_closed'
}

function getBrokerEventName(event: BrokerEvent): string | undefined {
  return 'name' in event && typeof event.name === 'string' && event.name.trim()
    ? event.name
    : undefined
}

function getBrokerEventFrom(event: BrokerEvent): string | undefined {
  return 'from' in event && typeof event.from === 'string' && event.from.trim()
    ? event.from
    : undefined
}

function withBrokerDetailsTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${BROKER_DETAILS_TIMEOUT_MS}ms`))
    }, BROKER_DETAILS_TIMEOUT_MS)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  return url?.trim().replace(/\/+$/, '') || undefined
}

function parsePortFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.port) {
      return Number.parseInt(parsed.port, 10)
    }
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined
  } catch {
    return undefined
  }
}

function getClientBaseUrl(client: AgentRelayClient): string | undefined {
  return normalizeBaseUrl(client.baseUrl || (client as unknown as BrokerClientInternals).transport?.baseUrl)
}

function getClientApiKey(client: AgentRelayClient): string | undefined {
  return (client as unknown as BrokerClientInternals).transport?.apiKey
}

function getBrokerConnectionFileInfo(
  cwd: string,
  baseUrl: string | undefined,
  brokerPid: number | undefined
): BrokerConnectionFileInfo {
  if (!cwd) {
    return { hasApiKey: false }
  }

  const connectionPath = join(cwd, '.agent-relay', 'connection.json')
  if (!existsSync(connectionPath)) {
    return { path: connectionPath, status: 'missing', hasApiKey: false }
  }

  try {
    const parsed = BrokerConnectionFileSchema.safeParse(
      JSON.parse(readFileSync(connectionPath, 'utf-8'))
    )
    if (!parsed.success) {
      return { path: connectionPath, status: 'invalid', hasApiKey: false }
    }
    const connectionUrl = normalizeBaseUrl(parsed.data.url)
    const sameUrl = !!baseUrl && connectionUrl === baseUrl
    const samePid = !brokerPid || !parsed.data.pid || parsed.data.pid === brokerPid

    return {
      path: connectionPath,
      status: sameUrl && samePid ? 'matches' : 'different',
      hasApiKey: !!parsed.data.apiKey,
      apiKey: parsed.data.apiKey
    }
  } catch {
    return { path: connectionPath, status: 'invalid', hasApiKey: false }
  }
}

function toInboundDeliveryMode(mode?: TerminalAttachMode): InboundDeliveryMode {
  return mode === 'drive' ? 'manual_flush' : 'auto_inject'
}

function normalizeChannels(channels: string[]): string[] {
  return Array.from(new Set(channels.map((channel) => channel.trim()).filter(Boolean)))
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function compactCommitDiff(diff: string): string {
  if (diff.length <= COMMIT_DRAFT_MAX_DIFF_CHARS) return diff
  return `${diff.slice(0, COMMIT_DRAFT_MAX_DIFF_CHARS)}\n\n[diff truncated at ${COMMIT_DRAFT_MAX_DIFF_CHARS} characters]`
}

function buildCommitDraftTask(diff: string): string {
  return [
    'Write a Git commit message for the diff below.',
    'You may read repository files for context, but do not edit files, run git commands, or create commits.',
    '',
    'Your FINAL message (and only your final message) must be a single JSON object on its own — no markdown fence, no prose before or after, no code block. Example of the exact output shape:',
    '{"title":"Fix race in lease renewal","body":"Renewals could fire after shutdown and resurrect a dead client. Guard the timer with the shutdown flag."}',
    '',
    'Fields:',
    '- title: imperative summary of the actual change, under 72 characters, no trailing period. Must describe THIS diff — never literally the word "string".',
    '- body: short paragraph explaining WHY (intent, constraint, context). Use "" when the title alone is enough. Never literally the word "string".',
    '',
    'Focus on intent, not a file-by-file enumeration. Derive title and body from the actual diff content.',
    '',
    'Selected diff:',
    '--- DIFF START ---',
    compactCommitDiff(diff),
    '--- DIFF END ---'
  ].join('\n')
}


function getJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = []

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < text.length; index += 1) {
      const char = text[index]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1))
          break
        }
      }
    }
  }

  return candidates
}

function parseGeneratedCommitDraft(text: string): GeneratedCommitDraft {
  const candidates = getJsonObjectCandidates(text)
  for (const candidate of candidates.reverse()) {
    try {
      const draft = GeneratedCommitDraftSchema.safeParse(JSON.parse(candidate))
      if (draft.success) return draft.data
    } catch {
      // Keep scanning terminal output; diffs can contain unrelated braces.
    }
  }
  throw new Error('Commit message agent did not return a usable JSON draft')
}

function getBrokerRuntimeSafeName(name: string): string {
  return name
    .split('')
    .map((char) => /[a-z0-9-]/i.test(char) ? char : '-')
    .join('')
}

function getBrokerRuntimeCleanupPaths(cwd: string, brokerName: string): string[] {
  const root = join(cwd, '.agent-relay')
  const safeName = getBrokerRuntimeSafeName(brokerName)

  return [
    join(root, 'connection.json'),
    join(root, `broker-${safeName}.lock`),
    join(root, `state-${safeName}.json`),
    join(root, `pending-${safeName}.json`)
  ]
}

function isRecoverableBrokerRuntimeError(
  err: unknown,
  options: { allowLivePidConflict?: boolean } = {}
): boolean {
  const message = toErrorMessage(err)
  const hasBrokerLockConflict = /another broker instance is already running in this directory/i.test(message)
  const hasLivePidConflict = /another broker instance is already running in this directory \(pid:\s*\d+/i.test(message)
  const hasStaleLockSignal =
    /stale broker lock detected/i.test(message) ||
    /broker lock held but no valid PID file found/i.test(message)

  return (options.allowLivePidConflict || !hasLivePidConflict) &&
    (hasStaleLockSignal || hasBrokerLockConflict)
}

async function clearBrokerRuntimeFiles(cwd: string, brokerName: string): Promise<string[]> {
  const removed: string[] = []

  for (const filePath of getBrokerRuntimeCleanupPaths(cwd, brokerName)) {
    if (!existsSync(filePath)) continue
    await rm(filePath, { force: true })
    removed.push(filePath)
  }

  return removed
}

function getAvailableAgentName(requestedName: string, existingNames: Set<string>): string {
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

function isAgentNameConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /agent ['"].+['"] already exists/i.test(message) || message.includes('already exists')
}

function brokerErrorData(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== 'object' || err === null || !('data' in err)) return undefined
  const data = (err as { data?: unknown }).data
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined
}

function formatBrokerErrorData(data: Record<string, unknown> | undefined): string {
  if (!data) return ''
  const entries = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
    .map(([key, value]) => `${key}=${String(value)}`)
  return entries.length > 0 ? ` (${entries.join(', ')})` : ''
}

function buildSpawnFailureError(err: unknown, input: SpawnPtyInput, kind: 'local' | 'cloud' = 'local'): Error {
  const data = brokerErrorData(err)
  const detail = formatBrokerErrorData(data)
  return new Error(
    `Failed to spawn ${kind} agent "${input.name}" with ${input.cli} in ${input.cwd || process.cwd()}: ${toErrorMessage(err)}${detail}`
  )
}

function normalizeCloudSpawnInput(input: SpawnPtyInput): SpawnPtyInput {
  if (input.cwd && existsSync(input.cwd)) {
    return { ...input, cwd: '/workspace' }
  }
  return input
}

function preflightSpawnCli(input: SpawnPtyInput): SpawnPtyInput {
  if (isShellLikeCommand(input.cli)) return input
  if (input.cli.includes('/') || input.cli.includes('\\')) {
    if (!canExecute(input.cli)) {
      throw new Error(`Agent CLI is not executable: ${input.cli}`)
    }
    return input
  }

  const label = spawnCliLabel(input.cli)
  if (!['claude', 'codex', 'opencode'].includes(label)) return input
  const resolved = resolveCommandWithAugmentedPath(input.cli)
  if (!resolved) {
    throw new Error(
      `Agent CLI "${input.cli}" was not found on Pear's PATH. Launch Pear from a shell with ${input.cli} available, or install ${input.cli} globally.`
    )
  }
  return { ...input, cli: resolved }
}

interface BrokerSession {
  projectId: string
  client: AgentRelayClient
  window?: BrowserWindow
  unsubEvent: () => void
  cwd: string
  name: string
  channels: string[]
  cloudSandboxId: string | null
  pearLineage: Map<string, PearLineageEntry>
  // For attach-to-remote-broker sessions (cloud sandboxes), the SDK doesn't
  // auto-renew the owner lease the way .spawn() does. The remote broker
  // auto-shuts-down after 120s without a lease renewal, so we own the timer
  // here and clear it on shutdown.
  leaseTimer?: ReturnType<typeof setInterval>
}

export interface BrokerAgentDetails {
  name: string
  runtime: string
  cli?: string
  model?: string
  channels: string[]
  parent?: string
  pid?: number
  currentState?: string
}

export interface BrokerDetails {
  projectId: string
  name: string
  cwd: string
  channels: string[]
  kind: 'local' | 'cloud'
  url?: string
  port?: number
  apiKey?: string
  brokerPid?: number
  cloudSandboxId?: string | null
  connectionPath?: string
  connectionFileStatus?: 'matches' | 'missing' | 'different' | 'invalid'
  apiKeyAvailable: boolean
  health: 'connected' | 'unreachable'
  session?: {
    brokerVersion: string
    protocolVersion: number
    workspaceKey?: string
    defaultWorkspaceId?: string
    mode: string
    uptimeSecs: number
  }
  relaycast?: {
    workspaceKey?: string
    defaultWorkspaceId?: string
    authenticated?: boolean
    workspaceCount?: number
    workspaces: Array<{
      workspaceId: string
      workspaceAlias?: string | null
      selfName: string
      selfAgentId: string
      authenticated: boolean
      default: boolean
    }>
  }
  agentCount: number
  pendingDeliveryCount: number
  agents: BrokerAgentDetails[]
  error?: string
}

export interface BrokerEventRecord {
  id: string
  projectId: string
  timestamp: number
  event: BrokerEventRecordPayload
}

interface BrokerStateSnapshot {
  agents: ListAgent[]
  pendingDeliveryCount: number
  auth?: BrokerStatus['auth']
}

interface BrokerConnectionFileInfo {
  path?: string
  status?: BrokerDetails['connectionFileStatus']
  hasApiKey: boolean
  apiKey?: string
}

interface BrokerClientInternals {
  transport?: {
    baseUrl?: string
    apiKey?: string
  }
}

export class BrokerManager {
  private sessions = new Map<string, BrokerSession>()
  private startPromises = new Map<string, Promise<void>>()
  private revivePromises = new Map<string, Promise<boolean>>()
  private agentProjects = new Map<string, Set<string>>()
  private inputStreams = new Map<string, PtyInputStream>()
  private inputStreamFallbacks = new Set<string>()
  // Keys whose WS input stream has completed the broker's pty_input_ready
  // handshake — only these are safe to send on without blocking. Everything
  // else routes over HTTP until the stream is confirmed open.
  private inputStreamReady = new Set<string>()
  // Consecutive background open failures per key; after MAX we stop retrying the
  // WS for this agent (HTTP-only) until the terminal is re-attached.
  private inputStreamOpenFailures = new Map<string, number>()
  // Consecutive broker read timeouts per project/operation; after MAX we
  // respawn the wedged broker. Reset whenever that operation succeeds.
  private brokerTimeoutCounts = new Map<string, number>()
  private eventObservers = new Set<BrokerEventObserver>()
  private eventHistory: BrokerEventRecord[] = []
  private eventSerial = 0

  get cwd(): string | null {
    return this.sessions.values().next().value?.cwd || null
  }

  get isStarted(): boolean {
    return this.sessions.size > 0
  }

  get isCloud(): boolean {
    return Array.from(this.sessions.values()).some((session) => session.cloudSandboxId !== null)
  }

  onBrokerEvent(observer: BrokerEventObserver): () => void {
    this.eventObservers.add(observer)
    return () => {
      this.eventObservers.delete(observer)
    }
  }

  async start(
    projectId: string,
    cwd: string,
    name: string,
    win: BrowserWindow,
    channels: string[] = []
  ): Promise<void> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) {
      throw new Error('Project id is required')
    }
    assertDirectory(cwd, 'Project path')
    const nextChannels = normalizeChannels(channels)
    const existing = this.sessions.get(normalizedProjectId)

    if (existing) {
      existing.window = win
      existing.cwd = cwd
      existing.name = name
      await this.syncChannels(normalizedProjectId, nextChannels)
      this.sendStatus(normalizedProjectId, 'connected')
      return
    }

    const inFlight = this.startPromises.get(normalizedProjectId)
    if (inFlight) {
      try {
        await inFlight
        const started = this.sessions.get(normalizedProjectId)
        if (!started) {
          throw new Error(`Broker start completed without a session for project ${normalizedProjectId}`)
        }
        started.window = win
        started.cwd = cwd
        started.name = name
        await this.syncChannels(normalizedProjectId, nextChannels)
        this.sendStatus(normalizedProjectId, 'connected')
        return
      } catch (err) {
        this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
        throw err
      }
    }

    const startBroker = async (): Promise<void> => {
      const existingClient = await this.connectExistingBroker(normalizedProjectId, cwd)
      if (existingClient) {
        const unsubEvent = this.attachClient(normalizedProjectId, existingClient, win)
        this.sessions.set(normalizedProjectId, {
          projectId: normalizedProjectId,
          client: existingClient,
          window: win,
          unsubEvent,
          cwd,
          name,
          channels: [],
          cloudSandboxId: null,
          pearLineage: new Map()
        })
        existingClient.connectEvents()

        await this.syncChannels(normalizedProjectId, nextChannels)
        this.publishBrokerEvent(normalizedProjectId, win, {
          kind: 'broker_initialized',
          name,
          cwd,
          url: getClientBaseUrl(existingClient),
          channels: nextChannels,
          source: 'local'
        })
        this.sendStatus(normalizedProjectId, 'connected')
        return
      }

      const agentRelayMcpCommand = resolveAgentRelayMcpCommand()
      if (agentRelayMcpCommand) {
        console.log('[broker] Using Agent Relay MCP command:', agentRelayMcpCommand)
      } else {
        console.warn('[broker] Agent Relay MCP command could not be resolved; broker will use its default MCP command')
      }

      const opts: AgentRelaySpawnOptions = {
        cwd,
        brokerName: name,
        channels: nextChannels,
        binaryArgs: { persist: true },
        binaryPath: resolveBundledBrokerBinary(),
        env: {
          PATH: augmentedPath(),
          ...(agentRelayMcpCommand ? { AGENT_RELAY_MCP_COMMAND: agentRelayMcpCommand } : {})
        },
        onStderr: (line: string) => {
          console.error(`[broker stderr:${normalizedProjectId}]`, line)
        }
      }

      console.log('[broker] Starting with opts:', JSON.stringify({ ...opts, projectId: normalizedProjectId }))
      const client = await AgentRelayClient.spawn(opts)
      console.log('[broker] Started successfully for project:', normalizedProjectId)
      const unsubEvent = this.attachClient(normalizedProjectId, client, win)
      this.sessions.set(normalizedProjectId, {
        projectId: normalizedProjectId,
        client,
        window: win,
        unsubEvent,
        cwd,
        name,
        channels: nextChannels,
        cloudSandboxId: null,
        pearLineage: new Map()
      })

      this.publishBrokerEvent(normalizedProjectId, win, {
        kind: 'broker_initialized',
        name,
        cwd,
        url: getClientBaseUrl(client),
        brokerPid: client.brokerPid,
        channels: nextChannels,
        source: 'local'
      })
      this.sendStatus(normalizedProjectId, 'connected')
    }

    const startPromise = startBroker()
    this.startPromises.set(normalizedProjectId, startPromise)
    try {
      await startPromise
    } catch (err) {
      console.error(`[broker] Failed to start for project ${normalizedProjectId}:`, err)
      this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
      throw err
    } finally {
      if (this.startPromises.get(normalizedProjectId) === startPromise) {
        this.startPromises.delete(normalizedProjectId)
      }
    }
  }

  private async connectExistingBroker(projectId: string, cwd: string): Promise<AgentRelayClient | null> {
    const connectionPath = join(cwd, '.agent-relay', 'connection.json')
    if (!existsSync(connectionPath)) {
      return null
    }

    try {
      const client = AgentRelayClient.connect({ cwd })
      await client.getSession()
      console.log(`[broker] Reusing existing broker for project ${projectId}: ${connectionPath}`)
      return client
    } catch (err) {
      console.warn(`[broker] Existing broker connection is not reusable for project ${projectId}:`, err)
      return null
    }
  }

  // Re-establish a local broker whose process has died or wedged. When this
  // manager owns the broker child process, terminate it first; otherwise a
  // wedged process can keep the runtime lock and make the replacement spawn
  // fail. Deduped per project so concurrent callers don't race teardown/start
  // against each other or fork duplicate brokers.
  private async reviveSession(projectId: string): Promise<boolean> {
    const existing = this.revivePromises.get(projectId)
    if (existing) return existing

    const session = this.sessions.get(projectId)
    if (!session) return false
    // Cloud sessions can't be re-spawned locally — they live in a remote
    // sandbox and are owned by CloudAgentManager.
    if (session.cloudSandboxId) return false
    const win = session.window
    if (!win || win.isDestroyed()) return false

    const { cwd, name, channels } = session
    const brokerPid = session.client.brokerPid
    let promise!: Promise<boolean>
    promise = (async () => {
      console.warn(`[broker] Broker for project ${projectId} is unreachable; restarting on a fresh port`)
      this.dropSession(projectId, { disconnectOnly: true })
      await terminateOwnedBrokerProcess(brokerPid)
      if (this.revivePromises.get(projectId) !== promise) return false
      await this.start(projectId, cwd, name, win, channels)
      return this.sessions.has(projectId)
    })()
    this.revivePromises.set(projectId, promise)
    try {
      return await promise
    } catch (err) {
      console.error(`[broker] Failed to revive broker for project ${projectId}:`, toErrorMessage(err))
      return false
    } finally {
      if (this.revivePromises.get(projectId) === promise) {
        this.revivePromises.delete(projectId)
      }
    }
  }

  async autoFixRuntime(
    projectId: string,
    cwd: string,
    name: string,
    win: BrowserWindow,
    channels: string[] = [],
    errorMessage?: string
  ): Promise<BrokerRuntimeAutoFixResult> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) {
      throw new Error('Project id is required')
    }
    const hasManagedSession = this.sessions.has(normalizedProjectId)
    if (errorMessage && !isRecoverableBrokerRuntimeError(errorMessage, {
      allowLivePidConflict: hasManagedSession
    })) {
      throw new Error('This broker error does not look like stale Agent Relay runtime state.')
    }

    assertDirectory(cwd, 'Project path')
    await this.shutdown(normalizedProjectId)
    const removed = await clearBrokerRuntimeFiles(cwd, name)
    console.warn(
      `[broker] Auto-fixed runtime files for project ${normalizedProjectId}:`,
      removed.length > 0 ? removed : '(no files existed)'
    )
    await delay(250)
    await this.start(normalizedProjectId, cwd, name, win, channels)
    return { removed }
  }

  /**
   * Attach to an already-provisioned cloud sandbox (used by CloudAgentManager
   * which warms the box via the cloud-agents/{id}/box endpoint). connectCloud
   * is the legacy ad-hoc path that creates a sandbox here.
   */
  async attachCloudSandbox(
    projectId: string,
    handle: CloudAgentSandboxHandle,
    win?: BrowserWindow
  ): Promise<string> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) {
      throw new Error('Project id is required')
    }

    const sandboxId = handle.sandboxId.trim()
    const execUrl = handle.execUrl.trim()
    const apiKey = handle.apiKey?.trim() || undefined
    if (!sandboxId) {
      throw new Error('Cloud sandbox id is required')
    }
    if (!execUrl) {
      throw new Error('Cloud sandbox exec URL is required')
    }

    await this.shutdown(normalizedProjectId)

    try {
      console.log('[broker] Connecting to cloud broker via SDK:', execUrl)
      const client = new AgentRelayClient({
        baseUrl: execUrl,
        ...(apiKey ? { apiKey } : {})
      })
      await client.getSession()

      const unsubEvent = this.attachClient(normalizedProjectId, client, win)
      // The remote broker shuts itself down after 120s without an owner-lease
      // renewal. HarnessDriverClient.spawn handles this automatically, but the
      // attach-to-existing path (used here for cloud sandboxes) doesn't —
      // without this timer the broker dies mid-session and every subsequent
      // call surfaces as a 502/disconnect.
      const leaseTimer = setInterval(() => {
        client.renewLease().catch((err) => {
          console.warn(`[broker] Cloud lease renewal failed for project ${normalizedProjectId}:`, toErrorMessage(err))
        })
      }, 60_000)
      this.sessions.set(normalizedProjectId, {
        projectId: normalizedProjectId,
        client,
        window: win,
        unsubEvent,
        cwd: '',
        name: `cloud-${normalizedProjectId}`,
        channels: [],
        cloudSandboxId: sandboxId,
        pearLineage: new Map(),
        leaseTimer
      })
      client.connectEvents()

      this.publishBrokerEvent(normalizedProjectId, win, {
        kind: 'broker_initialized',
        name: `cloud-${normalizedProjectId}`,
        url: getClientBaseUrl(client),
        cloudSandboxId: sandboxId,
        source: 'cloud'
      })
      this.sendStatus(normalizedProjectId, 'connected')
      return sandboxId
    } catch (err) {
      console.error(`[broker] Failed to connect cloud broker for project ${normalizedProjectId}:`, err)
      this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
      throw err
    }
  }

  /**
   * Connect to a broker running in a remote Daytona sandbox.
   * Creates an ad-hoc sandbox via the cloud API, then attaches through the
   * same SDK path used by CloudAgentManager-provisioned sandboxes.
   */
  async connectCloud(projectId: string, win: BrowserWindow): Promise<string> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) {
      throw new Error('Project id is required')
    }

    // Provisioning errors (sandbox create / terminal fetch) are handled here;
    // attachCloudSandbox handles its own error reporting (console.error +
    // broker:status). Splitting the try/catch keeps the two paths from
    // double-logging the same failure to the renderer.
    let sandboxId: string
    let httpUrl: string
    let apiKey: string
    try {
      const token = await getAccessToken()
      if (!token) throw new Error('Not logged in — sign in first')

      const apiUrl = getApiUrl()

      // 1. Create sandbox with broker
      console.log('[broker] Creating cloud sandbox...')
      const createRes = await fetch(`${apiUrl}/api/v1/sandboxes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({ error: createRes.statusText }))
        throw new Error(`Failed to create sandbox: ${(err as { error: string }).error}`)
      }
      ;({ sandboxId } = await createRes.json() as { sandboxId: string })
      console.log('[broker] Sandbox created:', sandboxId)

      // 2. Get terminal connection info
      const termRes = await fetch(`${apiUrl}/api/v1/sandboxes/${sandboxId}/terminal`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!termRes.ok) {
        throw new Error('Failed to get terminal connection info')
      }
      ;({ httpUrl, apiKey } = await termRes.json() as { httpUrl: string; apiKey: string })
    } catch (err) {
      console.error(`[broker] Failed to connect cloud broker for project ${normalizedProjectId}:`, err)
      this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
      throw err
    }

    // attachCloudSandbox owns its own error reporting; let its errors propagate.
    return this.attachCloudSandbox(normalizedProjectId, { sandboxId, execUrl: httpUrl, apiKey }, win)
  }

  private getSessionForProject(projectId: string): BrokerSession {
    const normalizedProjectId = projectId.trim()
    const session = this.sessions.get(normalizedProjectId)
    if (!session) {
      throw new Error('Relay workspace not started — select the project first')
    }
    return session
  }

  private async getOrAwaitSession(projectId: string): Promise<BrokerSession> {
    const normalizedProjectId = projectId.trim()
    const revivePromise = this.revivePromises.get(normalizedProjectId)
    if (revivePromise) {
      await revivePromise.catch(() => undefined)
    }
    const startPromise = this.startPromises.get(normalizedProjectId)
    if (startPromise) {
      await startPromise.catch(() => undefined)
    }
    const session = this.sessions.get(normalizedProjectId)
    if (!session) {
      throw new Error('Relay workspace not started — select the project first')
    }
    return session
  }

  private getSessionForAgent(name: string, projectId?: string): BrokerSession {
    if (projectId?.trim()) {
      return this.getSessionForProject(projectId)
    }

    const mappedProjectIds = this.agentProjects.get(name)
    if (mappedProjectIds?.size === 1) {
      return this.getSessionForProject(Array.from(mappedProjectIds)[0])
    }
    if (mappedProjectIds && mappedProjectIds.size > 1) {
      throw new Error(`Agent name exists in multiple projects; project id is required: ${name}`)
    }

    if (this.sessions.size === 1) {
      const onlySession = this.sessions.values().next().value
      if (onlySession) return onlySession
    }

    throw new Error(`No relay workspace found for agent: ${name}`)
  }

  private resolveLineageEntry(
    session: BrokerSession,
    input: { name: string; cwd?: string; cli?: string }
  ): { lineageId: string; parentAgentKey?: string } {
    const existing = session.pearLineage.get(input.name)
    if (existing) return { lineageId: existing.lineageId, parentAgentKey: existing.parentAgentKey }

    const entry: PearLineageEntry = {
      lineageId: randomUUID(),
      agentKey: getPearBurnAgentKey(session.projectId, input.name),
      cwd: input.cwd,
      cli: input.cli
    }
    session.pearLineage.set(input.name, entry)
    return { lineageId: entry.lineageId }
  }

  /**
   * Pre-record a lineage entry so the next spawn of `name` inherits a
   * parent's lineage_id. Used by `spawnAgent` when a caller declares a
   * parent, and by `handleSpawnedChildLineage` when the broker observes a
   * non-pear-driven child spawn.
   */
  private recordLineageChild(
    session: BrokerSession,
    name: string,
    parentName: string,
    cwd?: string,
    cli?: string
  ): PearLineageEntry | undefined {
    const parent = session.pearLineage.get(parentName)
    if (!parent) return undefined
    if (session.pearLineage.has(name)) return session.pearLineage.get(name)

    const entry: PearLineageEntry = {
      lineageId: parent.lineageId,
      agentKey: getPearBurnAgentKey(session.projectId, name),
      parentAgentKey: parent.agentKey,
      cwd: cwd ?? parent.cwd,
      cli
    }
    session.pearLineage.set(name, entry)
    return entry
  }

  private async handleSpawnedChildLineage(
    projectId: string,
    event: Extract<BrokerEvent, { kind: 'agent_spawned' }>
  ): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session || !event.parent) return
    const entry = this.recordLineageChild(session, event.name, event.parent, undefined, event.cli)
    if (!entry) return

    const enrichment = getPearBurnSpawnEnrichment(
      projectId,
      {
        name: event.name,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.cli ? { cli: entry.cli } : {})
      },
      { lineageId: entry.lineageId, parentAgentKey: entry.parentAgentKey }
    )

    try {
      const burn = await import('@relayburn/sdk')
      await burn.writePendingStamp({
        harness: event.cli === 'codex' ? 'codex' : event.cli === 'opencode' ? 'opencode' : 'claude',
        cwd: entry.cwd ?? session.cwd,
        enrichment,
        ...(event.pid ? { spawnerPid: event.pid } : {}),
        spawnStartTs: new Date().toISOString(),
        ledgerHome: getBurnLedgerHome()
      })
    } catch (err) {
      console.warn('[broker] Failed to stamp spawned child lineage:', err)
    }
  }

  private attachClient(projectId: string, client: AgentRelayClient, win?: BrowserWindow): () => void {
    // Stamp every spawn this session does so burn can attribute Pear sessions
    // via `burn summary --tags spawner=pear`. The listener returns a SpawnPatch
    // for Claude (injects --session-id so burn can stamp by exact id), and
    // falls back to writePendingStamp for other launchers.
    // `beforeAgentSpawn` handlers are uniquely allowed to return a SpawnPatch;
    // cast at this boundary because Pear's listener supports both current and
    // older hook shapes.
    const burnHandler = createPearBurnSpawnListener({
      ledgerHome: getBurnLedgerHome(),
      enrich: (ctx) => {
        const session = this.sessions.get(projectId)
        const lineage = session ? this.resolveLineageEntry(session, ctx.input) : undefined
        return getPearBurnSpawnEnrichment(projectId, ctx.input, lineage)
      }
    }) as Parameters<typeof client.addListener<'beforeAgentSpawn'>>[1]
    const unsubBurn = client.addListener('beforeAgentSpawn', burnHandler)

    const unsubEvent = client.onEvent((event: BrokerEvent) => {
      // Fast path for PTY chunks: ship just (projectId, name, chunk) over a
      // dedicated channel so typing latency doesn't pay for compactBrokerEvent,
      // the broker:event metadata spread, or pushing into eventHistory per
      // character. Activity bookkeeping (rememberAgentProject + cloud sandbox
      // observers) still runs.
      if (
        event.kind === 'worker_stream' &&
        'name' in event && typeof event.name === 'string' &&
        'chunk' in event && typeof event.chunk === 'string'
      ) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('broker:pty-chunk', projectId, event.name, event.chunk)
        }
        this.rememberAgentProject(event.name, projectId)
        if (this.sessions.get(projectId)?.cloudSandboxId) {
          for (const observer of Array.from(this.eventObservers)) {
            observer(projectId, event)
          }
        }
        return
      }

      this.publishBrokerEvent(projectId, win, event as unknown as BrokerEventRecordPayload)

      if (event.kind === 'agent_spawned' && event.name) {
        this.rememberAgentProject(event.name, projectId)
        if (event.parent) {
          void this.handleSpawnedChildLineage(projectId, event)
        }
      } else if (event.kind === 'agent_exit' && event.name) {
        this.closeInputStream(this.getInputStreamKey(projectId, event.name), 1000, 'agent closed')
        this.forgetAgentProject(event.name, projectId)
        void client.release(event.name, 'agent exit').catch((err) => {
          if (!isMissingAgentError(err)) {
            console.warn(`[broker] Failed to release exited agent ${event.name}:`, err)
          }
        })
      } else if ((event.kind === 'agent_exited' || event.kind === 'agent_released') && event.name) {
        this.closeInputStream(this.getInputStreamKey(projectId, event.name), 1000, 'agent closed')
        this.forgetAgentProject(event.name, projectId)
      } else if ('name' in event && typeof event.name === 'string') {
        this.rememberAgentProject(event.name, projectId)
      } else if ('from' in event && typeof event.from === 'string') {
        this.rememberAgentProject(event.from, projectId)
      }

      // Fan out cloud-sandbox events to CloudAgentManager (which observes them
      // to track sandbox/agent activity for its mount + restart logic).
      if (this.sessions.get(projectId)?.cloudSandboxId) {
        for (const observer of Array.from(this.eventObservers)) {
          observer(projectId, event)
        }
      }
    })

    return () => {
      unsubBurn()
      unsubEvent()
    }
  }

  private publishBrokerEvent(
    projectId: string,
    win: BrowserWindow | undefined,
    event: BrokerEventRecordPayload
  ): BrokerEventRecord {
    const record = this.recordBrokerEvent(projectId, event)
    if (win && !win.isDestroyed()) {
      win.webContents.send('broker:event', {
        ...event,
        projectId,
        observedAt: record.timestamp,
        historyId: record.id
      })
    }
    return record
  }

  private recordBrokerEvent(projectId: string, event: BrokerEventRecordPayload): BrokerEventRecord {
    const eventRecord = event as Record<string, unknown>
    const timestamp = normalizeEventTimestamp(eventRecord.timestamp) ?? Date.now()
    const record: BrokerEventRecord = {
      id: `${projectId}:${++this.eventSerial}`,
      projectId,
      timestamp,
      event: compactBrokerEvent(event)
    }

    this.eventHistory.push(record)
    this.pruneBrokerEventHistory()
    return record
  }

  private pruneBrokerEventHistory(now = Date.now()): void {
    const cutoff = now - BROKER_EVENT_HISTORY_TTL_MS
    if (this.eventHistory.length <= MAX_BROKER_EVENT_HISTORY) {
      const firstFreshIndex = this.eventHistory.findIndex((entry) => entry.timestamp >= cutoff)
      if (firstFreshIndex > 0) {
        this.eventHistory.splice(0, firstFreshIndex)
      } else if (firstFreshIndex === -1 && this.eventHistory.length > 0) {
        this.eventHistory = []
      }
      return
    }

    this.eventHistory = this.eventHistory
      .filter((entry) => entry.timestamp >= cutoff)
      .slice(-MAX_BROKER_EVENT_HISTORY)
  }

  private rememberAgentProject(name: string, projectId: string): void {
    const projects = this.agentProjects.get(name) || new Set<string>()
    projects.add(projectId)
    this.agentProjects.set(name, projects)
  }

  private forgetAgentProject(name: string, projectId: string): void {
    const projects = this.agentProjects.get(name)
    if (!projects) return
    projects.delete(projectId)
    if (projects.size === 0) {
      this.agentProjects.delete(name)
    }
  }

  private getInputStreamKey(projectId: string, name: string): string {
    return `${projectId}:${name}`
  }

  // Returns the input stream for an agent plus whether it is *ready* to send on
  // (the broker has acked pty_input_ready). The WS handshake runs in the
  // background and is never awaited here, so a keystroke is never blocked on the
  // up-to-10s open timeout — callers send over HTTP until `ready` flips true.
  private ensureInputStream(
    session: BrokerSession,
    name: string
  ): { stream: PtyInputStream; ready: boolean } {
    const key = this.getInputStreamKey(session.projectId, name)
    const existing = this.inputStreams.get(key)
    if (existing && !existing.closed) {
      return { stream: existing, ready: this.inputStreamReady.has(key) }
    }

    const stream = session.client.openInputStream(name)
    this.inputStreams.set(key, stream)
    this.inputStreamReady.delete(key)
    stream.waitUntilOpen().then(
      () => {
        if (this.inputStreams.get(key) === stream) {
          this.inputStreamReady.add(key)
          this.inputStreamOpenFailures.delete(key)
        }
      },
      () => {
        if (this.inputStreams.get(key) !== stream) return
        this.inputStreams.delete(key)
        this.inputStreamReady.delete(key)
        const failures = (this.inputStreamOpenFailures.get(key) ?? 0) + 1
        this.inputStreamOpenFailures.set(key, failures)
        // A stream that never opens (e.g. broker never sends pty_input_ready)
        // would otherwise be re-opened on every keystroke. Stop trying the WS
        // after a few failures and ride HTTP until the terminal re-attaches.
        // This is the one case worth surfacing: transient not-ready is normal,
        // but a *persistently* unopenable stream means the low-latency fast path
        // is off for this agent — log it once rather than hiding it.
        if (failures >= MAX_INPUT_STREAM_OPEN_FAILURES && !this.inputStreamFallbacks.has(key)) {
          console.warn(
            `[broker] PTY input stream for ${name} failed to open ${failures}x; ` +
            `routing input over HTTP for this agent until the terminal re-attaches`
          )
        }
        if (failures >= MAX_INPUT_STREAM_OPEN_FAILURES) {
          this.inputStreamFallbacks.add(key)
        }
      }
    )
    return { stream, ready: false }
  }

  private closeInputStream(key: string, code = 1000, reason = 'closed'): void {
    const stream = this.inputStreams.get(key)
    this.inputStreams.delete(key)
    this.inputStreamReady.delete(key)
    this.inputStreamFallbacks.delete(key)
    this.inputStreamOpenFailures.delete(key)
    if (stream) {
      stream.close(code, reason)
    }
  }

  // Drop any cached HTTP-only fallback + failure count for an agent so a fresh
  // terminal attach gets another chance at the low-latency WS stream. Does not
  // disturb a healthy open stream.
  private resetInputStreamFallback(key: string): void {
    this.inputStreamFallbacks.delete(key)
    this.inputStreamOpenFailures.delete(key)
  }

  private closeInputStreamsForProject(projectId: string): void {
    const prefix = `${projectId}:`
    for (const key of Array.from(this.inputStreams.keys())) {
      if (key.startsWith(prefix)) {
        this.closeInputStream(key, 1000, 'project closed')
      }
    }
    for (const key of Array.from(this.inputStreamFallbacks)) {
      if (key.startsWith(prefix)) this.inputStreamFallbacks.delete(key)
    }
    for (const key of Array.from(this.inputStreamOpenFailures.keys())) {
      if (key.startsWith(prefix)) this.inputStreamOpenFailures.delete(key)
    }
    for (const key of Array.from(this.inputStreamReady)) {
      if (key.startsWith(prefix)) this.inputStreamReady.delete(key)
    }
  }

  async spawnAgent(
    projectId: string,
    input: SpawnPtyInput,
    options: { parentAgentName?: string } = {}
  ): Promise<{ name: string; runtime: string }> {
    const session = this.getSessionForProject(projectId)
    const shellSession = isShellLikeCommand(input.cli)
    const relayAwareInput: SpawnPtyInput = shellSession
      ? {
          ...input,
          cli: input.cli === 'shell' ? resolveShellCommand() : input.cli,
          args: input.args ?? (process.platform === 'win32' ? [] : ['-l']),
          task: input.task?.trim() || undefined,
          model: undefined,
          skipRelayPrompt: true
        }
      : input

    const existingNames = new Set(
      (await session.client.listAgents()).map((agent) => agent.name)
    )
    let nextInput = {
      ...relayAwareInput,
      name: getAvailableAgentName(relayAwareInput.name, existingNames)
    }
    nextInput = session.cloudSandboxId
      ? normalizeCloudSpawnInput(nextInput)
      : preflightSpawnCli(nextInput)

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const spawnStartTs = new Date().toISOString()
        if (options.parentAgentName) {
          this.recordLineageChild(
            session,
            nextInput.name,
            options.parentAgentName,
            nextInput.cwd,
            nextInput.cli
          )
        }
        const spawned = await session.client.spawnPty(nextInput)
        const spawnedName = spawned.name || nextInput.name
        this.rememberAgentProject(spawnedName, session.projectId)
        const burnInput = { ...nextInput, name: spawnedName }
        const lineage = session.pearLineage.get(spawnedName)
        void stampPearBurnSpawnedAgent(
          burnInput,
          spawnStartTs,
          getPearBurnSpawnEnrichment(
            session.projectId,
            burnInput,
            lineage ? { lineageId: lineage.lineageId, parentAgentKey: lineage.parentAgentKey } : undefined
          ),
          { ledgerHome: getBurnLedgerHome() }
        ).catch((err) => {
          console.warn('[burn-spawn-hook] post-spawn burn stamp failed:', err)
        })
        return spawned
      } catch (err) {
        if (!isAgentNameConflict(err)) {
          throw buildSpawnFailureError(err, nextInput, session.cloudSandboxId ? 'cloud' : 'local')
        }
        existingNames.add(nextInput.name)
        nextInput = {
          ...nextInput,
          name: getAvailableAgentName(nextInput.name, existingNames)
        }
      }
    }

    throw new Error(`Unable to allocate an agent name for ${relayAwareInput.name}`)
  }

  async listPersonas(projectId: string): Promise<WorkforcePersona[]> {
    const session = this.getSessionForProject(projectId)

    try {
      return listWorkforcePersonas(session.cwd)
    } catch (err) {
      console.warn(`[broker] Failed to list workforce personas for project ${projectId}:`, err)
      return []
    }
  }

  async spawnPersona(projectId: string, personaId: string): Promise<{ name: string; runtime: string; cli?: string }> {
    const session = this.getSessionForProject(projectId)
    const trimmedPersonaId = personaId.trim()
    if (!trimmedPersonaId) {
      throw new Error('Persona id is required')
    }

    const command = resolveAgentWorkforceCommand(session.cwd)
    const persona = findWorkforcePersona(session.cwd, trimmedPersonaId, command)

    // Resolve the harness from `agentworkforce show --json`. The actual spawn
    // is delegated to the workforce CLI (`agent --install-in-repo`), which
    // reads the full inherited persona itself, so the broker only needs the
    // harness for the informational `cli` field it returns.
    const resolvedHarness = persona.spec.harness ?? 'claude'
    const spawned = await this.spawnPersonaWithMode(session, {
      personaId: trimmedPersonaId,
      baseName: persona.spec.id,
      command,
      resolvedHarness
    })
    const registeredAgent = await this.verifyPersonaBrokerRegistration(session, spawned.name)
    if (registeredAgent) {
      console.info('[broker] Workforce persona broker registration verified', {
        projectId: session.projectId,
        personaId: trimmedPersonaId,
        name: spawned.name,
        mode: 'cli-install-in-repo',
        runtime: registeredAgent.runtime,
        cli: registeredAgent.cli,
        currentState: registeredAgent.current_state
      })
      return spawned
    }

    await session.client.release(spawned.name, 'persona broker registration verification failed').catch((err) => {
      if (!isMissingAgentError(err)) {
        console.warn(`[broker] Failed to release unverified persona agent ${spawned.name}:`, err)
      }
    })
    throw new Error(
      `Workforce persona ${trimmedPersonaId} launched but did not stay registered with the broker`
    )
  }

  private async spawnPersonaWithMode(
    session: BrokerSession,
    input: {
      personaId: string
      baseName: string
      command: { cli: string; args: string[] }
      resolvedHarness: string
    }
  ): Promise<{ name: string; runtime: string; cli?: string }> {
    const existingNames = new Set(
      (await session.client.listAgents()).map((agent) => agent.name)
    )
    const personaArgs = ['agent', '--install-in-repo', input.personaId]
    let nextInput: SpawnPtyInput = {
      name: getAvailableAgentName(input.baseName, existingNames),
      cli: input.command.cli,
      args: [...input.command.args, ...personaArgs],
      cwd: session.cwd,
      channels: session.channels,
      skipRelayPrompt: true
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const spawned = await session.client.spawnPty(nextInput)
        this.rememberAgentProject(spawned.name || nextInput.name, session.projectId)
        return { ...spawned, cli: input.resolvedHarness }
      } catch (err) {
        if (!isAgentNameConflict(err)) {
          throw err
        }
        existingNames.add(nextInput.name)
        nextInput = {
          ...nextInput,
          name: getAvailableAgentName(nextInput.name, existingNames)
        }
      }
    }

    throw new Error(`Unable to allocate an agent name for ${input.baseName}`)
  }

  // Poll listAgents until `name` appears or the deadline passes. Used at the
  // top of attachTerminal so a freshly-spawned agent doesn't 404 on the
  // first setInboundDeliveryMode/getInboundDeliveryMode call. No-op if the
  // agent is already registered (the first listAgents() call returns it).
  // Returns true when the agent appeared, false on timeout — the caller
  // logs the timeout for debugging and falls through to the downstream
  // calls (with their own retry wrapper) so a registration that completes
  // just after the deadline still works.
  private async waitForAgentRegistration(session: BrokerSession, name: string): Promise<boolean> {
    // Bumped from PERSONA_REGISTRATION_TIMEOUT_MS (5s) — `claude --resume`
    // reads session history before connecting to the broker; a long
    // conversation can push first-registration past 5s.
    const deadlineMs = 15_000
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      try {
        const agents = await session.client.listAgents()
        if (agents.some((agent) => agent.name === name)) return true
      } catch {
        // Transient broker errors during the wait are fine — keep polling
        // until the deadline; if the broker is genuinely down the downstream
        // calls will surface the real error.
      }
      await delay(250)
    }
    return false
  }

  // Retry a broker call that targets a specific agent name on
  // agent_not_found. Closes the residual race between
  // waitForAgentRegistration returning true and the next call hitting a
  // broker node that hasn't seen the registration yet, and also handles
  // the case where waitForAgentRegistration timed out but the agent
  // registers right after (e.g. claude --resume took 16s to boot).
  private async withAgentMissingRetry<T>(label: string, name: string, fn: () => Promise<T>): Promise<T> {
    const attempts = [0, 500, 1000, 2000, 4000]
    let lastErr: unknown
    for (let i = 0; i < attempts.length; i += 1) {
      if (attempts[i] > 0) await delay(attempts[i])
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (!isMissingAgentError(err)) throw err
        console.warn(`[broker] ${label} for ${name} got agent_not_found (attempt ${i + 1}/${attempts.length}); retrying`)
      }
    }
    throw lastErr
  }

  private async verifyPersonaBrokerRegistration(session: BrokerSession, name: string): Promise<ListAgent | null> {
    const deadline = Date.now() + PERSONA_REGISTRATION_TIMEOUT_MS
    let agent: ListAgent | undefined

    while (Date.now() < deadline) {
      agent = (await session.client.listAgents()).find((candidate) => candidate.name === name)
      if (agent) break
      await delay(250)
    }

    if (!agent) {
      return null
    }

    await delay(PERSONA_REGISTRATION_STABILITY_MS)
    const stableAgent = (await session.client.listAgents()).find((candidate) => candidate.name === name)
    if (!stableAgent) {
      return null
    }

    this.rememberAgentProject(stableAgent.name, session.projectId)
    return stableAgent
  }

  async generateCommitDraft(projectId: string, diff: string): Promise<GeneratedCommitDraft> {
    const session = this.getSessionForProject(projectId)
    const selectedDiff = diff.trim()
    if (!selectedDiff) {
      throw new Error('Select changes before generating a message')
    }

    const task = buildCommitDraftTask(selectedDiff)
    const cli = process.env.PEAR_COMMIT_AGENT_CLI?.trim() || 'codex'
    const model = process.env.PEAR_COMMIT_AGENT_MODEL?.trim()
    const timeoutMs = parsePositiveIntegerEnv('PEAR_COMMIT_AGENT_TIMEOUT_MS', COMMIT_DRAFT_TIMEOUT_MS)
    const spawned = await this.spawnAgent(projectId, {
      name: 'commit-draft',
      cli,
      cwd: session.cwd || undefined,
      channels: session.channels,
      task,
      idleThresholdSecs: 1,
      ...(model ? { model } : {})
    })

    // data callback — capture streaming PTY chunks as the agent works, so
    // we have the full transcript to scan for the final JSON object.
    const chunks: string[] = []
    const unsubscribe = session.client.onEvent((event) => {
      if (event.kind === 'worker_stream' && event.name === spawned.name) {
        chunks.push(event.chunk)
      }
    })

    try {
      await this.waitForAgentIdle(session, spawned.name, timeoutMs)
      const output = await this.readAgentOutput(session, spawned.name, chunks)
      return parseGeneratedCommitDraft(output)
    } finally {
      unsubscribe()
      // Leave the spawned commit-draft agent running so the user can inspect
      // or reuse it. Release is up to the renderer (or explicit cleanup).
    }
  }

  private async waitForAgentIdle(session: BrokerSession, name: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    let idleSince: number | null = null

    while (Date.now() - startedAt < timeoutMs) {
      const agent = await session.client.getStatus()
        .then((status) => status.agents.find((entry) => entry.name === name))
        .catch(() => undefined)

      if (!agent) {
        return
      }

      if (agent.current_state === 'idle') {
        idleSince ??= Date.now()
        if (Date.now() - startedAt >= 5_000 && Date.now() - idleSince >= 1_000) {
          return
        }
      } else {
        idleSince = null
      }

      await delay(1_000)
    }

    throw new Error(`Commit message agent timed out after ${Math.round(timeoutMs / 1000)} seconds`)
  }

  private async readAgentOutput(session: BrokerSession, name: string, chunks: string[]): Promise<string> {
    const eventText = session.client.queryEvents({ kind: 'worker_stream', name, limit: 5000 })
      .flatMap((event) => event.kind === 'worker_stream' ? [event.chunk] : [])
      .join('')

    let snapshotText = ''
    try {
      snapshotText = (await session.client.snapshot(name, 'plain')).screen
    } catch (err) {
      console.warn(`[broker] Failed to snapshot commit draft agent ${name}:`, err)
    }

    return [eventText, chunks.join(''), snapshotText].filter(Boolean).join('\n')
  }

  async attachTerminal(projectId: string | undefined, input: AttachTerminalInput): Promise<AttachTerminalResult> {
    const name = input.name.trim()
    if (!name) {
      throw new Error('Agent name is required')
    }

    const session = this.getSessionForAgent(name, projectId)
    const client = session.client
    // A re-attach (window reload, restart, tab re-open) is a fresh start for
    // this terminal — clear any stale HTTP-only fallback so the WS fast path
    // gets retried instead of being stuck on HTTP for the agent's lifetime.
    this.resetInputStreamFallback(this.getInputStreamKey(session.projectId, name))
    // Wait for the broker to register the worker. spawnAgent (used by the
    // Conversations panel's Resume flow and Add Agent dialog) returns as
    // soon as the CLI process is forked, before the worker has connected
    // to the broker, so the renderer races: spawn → mount terminal →
    // attach → broker 404. claude --resume in particular reads session
    // history first and can take 10+ seconds to register.
    const registered = await this.waitForAgentRegistration(session, name)
    if (!registered) {
      console.warn(`[broker] attachTerminal: ${name} did not appear in listAgents within wait window; falling through to per-call retry`)
    }
    const mode = toInboundDeliveryMode(input.mode)
    let previousMode: InboundDeliveryMode | undefined

    try {
      previousMode = await this.withAgentMissingRetry('getInboundDeliveryMode', name, () => client.getInboundDeliveryMode(name))
    } catch (err) {
      console.warn(`[broker] Failed to read delivery mode for ${name}:`, err)
    }

    // Keep the broker's inbound delivery policy aligned with the renderer's
    // queue mode while human terminal input continues to go through sendInput.
    await this.withAgentMissingRetry('setInboundDeliveryMode', name, () => client.setInboundDeliveryMode(name, mode))

    let resizedBeforeSnapshot = false
    if (isPositiveInteger(input.rows) && isPositiveInteger(input.cols)) {
      try {
        await this.withAgentMissingRetry('resizePty', name, () => client.resizePty(name, input.rows!, input.cols!))
        resizedBeforeSnapshot = true
      } catch (err) {
        console.warn(`[broker] Failed to sync PTY size for ${name}:`, err)
      }
    }

    const pending = mode === 'manual_flush'
      ? await this.withAgentMissingRetry('getPending', name, () => client.getPending(name)).then((messages) => messages.length).catch(() => 0)
      : 0

    try {
      if (resizedBeforeSnapshot) {
        await delay(80)
      }
      const snapshot = await this.withAgentMissingRetry('snapshot', name, () => client.snapshot(name, 'ansi'))
      return {
        name,
        mode,
        previousMode,
        pending,
        snapshot: {
          rows: snapshot.rows,
          cols: snapshot.cols,
          cursor: snapshot.cursor,
          screen: Buffer.from(snapshot.screen, 'base64').toString('utf-8')
        }
      }
    } catch (err) {
      console.warn(`[broker] Failed to capture terminal snapshot for ${name}:`, err)
      return {
        name,
        mode,
        previousMode,
        pending
      }
    }
  }

  async sendInput(
    projectId: string | undefined,
    name: string,
    data: string
  ): Promise<{ name: string; bytes_written: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    if (!data) {
      return { name: trimmedName, bytes_written: 0 }
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    const key = this.getInputStreamKey(session.projectId, trimmedName)
    if (!this.inputStreamFallbacks.has(key)) {
      // Kick off (or reuse) the WS stream, but only *send* on it once the broker
      // has acked the handshake. Before that, fall through to HTTP so a keystroke
      // never stalls on the open timeout — the symptom that made typing look dead
      // after a re-attach. Subsequent keystrokes take the fast path once ready.
      const { stream, ready } = this.ensureInputStream(session, trimmedName)
      if (ready && !stream.closed) {
        try {
          return await stream.send(data)
        } catch (err) {
          if (this.inputStreams.get(key) === stream) {
            this.closeInputStream(key, 1011, 'stream send failed')
          }
          if (isUnsupportedInputStreamError(err)) {
            this.inputStreamFallbacks.add(key)
          }
          // A deliberate close (project/agent shutdown, terminal re-attach) that
          // races an in-flight send rejects with `input_stream_closed`. That's
          // not a transport failure — fall through to HTTP silently instead of
          // logging a misleading "stream failed" warning (notably on app quit).
          if (!isInputStreamClosedError(err)) {
            console.warn(`[broker] PTY input stream failed for ${trimmedName}; falling back to HTTP input:`, err)
          }
        }
      }
    }
    return session.client.sendInput(trimmedName, data)
  }

  // Fire-and-forget input for interactive typing. We don't await the PTY
  // ack because we don't need backpressure for human keystrokes — and the
  // extra round-trip latency shows up as a sticky-typing feel. Errors get
  // logged and the broker's existing stream-fallback logic in sendInput
  // takes care of reopening a broken stream.
  sendInputFireAndForget(projectId: string | undefined, name: string, data: string): void {
    const trimmedName = typeof name === 'string' ? name.trim() : ''
    if (!trimmedName || typeof data !== 'string' || data.length === 0) {
      return
    }
    this.sendInput(projectId, trimmedName, data).catch((err) => {
      // Keystroke races with agent shutdown: ignore the "no such agent" 404
      // and the broker's transient "internal channel closed" while it's
      // tearing down. Both surface as noise that's not actionable.
      if (isMissingAgentError(err)) return
      const message = toErrorMessage(err)
      if (/internal channel closed|internal reply dropped/i.test(message)) return
      console.warn(`[broker] sendInputFireAndForget failed for ${trimmedName}:`, err)
    })
  }

  // Latest smoothed input→ack round-trip (ms) for an agent's PTY input stream,
  // or null if there's no open stream or no ack measured yet. Cheap latency
  // signal the renderer's predictive echo bootstraps its adaptive engage
  // decision from, so it engages promptly instead of waiting to measure a full
  // echo-confirmation cycle itself. Safe to call for unknown agents.
  getInputSrtt(projectId: string | undefined, name: string): number | null {
    const trimmedName = typeof name === 'string' ? name.trim() : ''
    if (!trimmedName) return null
    try {
      const session = this.getSessionForAgent(trimmedName, projectId)
      const key = this.getInputStreamKey(session.projectId, trimmedName)
      return this.inputStreams.get(key)?.srttMs ?? null
    } catch {
      return null
    }
  }

  async setTerminalMode(
    projectId: string | undefined,
    name: string,
    mode: TerminalAttachMode
  ): Promise<{ name: string; mode: InboundDeliveryMode; flushed: number; pending: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    let session: BrokerSession
    try {
      session = this.getSessionForAgent(trimmedName, projectId)
    } catch (err) {
      if (isWorkspaceNotStartedError(err)) {
        return { name: trimmedName, mode: toInboundDeliveryMode(mode), flushed: 0, pending: 0 }
      }
      throw err
    }

    let result: { mode: InboundDeliveryMode; flushed: number }
    try {
      result = await session.client.setInboundDeliveryMode(trimmedName, toInboundDeliveryMode(mode))
    } catch (err) {
      if (isMissingAgentError(err)) {
        return { name: trimmedName, mode: toInboundDeliveryMode(mode), flushed: 0, pending: 0 }
      }
      throw err
    }
    const pending = result.mode === 'manual_flush'
      ? await session.client.getPending(trimmedName).then((messages) => messages.length).catch(() => 0)
      : 0

    return {
      name: trimmedName,
      mode: result.mode,
      flushed: result.flushed,
      pending
    }
  }

  async getPendingMessages(projectId: string | undefined, name: string): Promise<PendingRelayMessage[]> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    // When the project is known (the renderer always passes it for the 2.5s
    // poll), await any in-flight revive so a poll racing a respawn picks up the
    // fresh session instead of throwing "workspace not started".
    let session: BrokerSession
    try {
      session = projectId?.trim()
        ? await this.getOrAwaitSession(projectId)
        : this.getSessionForAgent(trimmedName, projectId)
    } catch (err) {
      if (isWorkspaceNotStartedError(err)) return []
      throw err
    }
    // A wedged `/api/pending` endpoint otherwise times out on every poll and
    // floods the IPC log; recover the broker and degrade to [] meanwhile. An
    // empty held-message list is harmless, so degradeOnTimeout is on.
    return this.withWedgeRecovery(session, 'getPending', [] as PendingRelayMessage[], async (current) => {
      try {
        return await current.client.getPending(trimmedName)
      } catch (err) {
        // Small window after the broker releases a worker but before the
        // agent_released event reaches the renderer where we get a 404. Swallow
        // it so the IPC log doesn't flood during normal teardown.
        if (isMissingAgentError(err)) return []
        throw err
      }
    }, { degradeOnTimeout: true })
  }

  async flushPending(projectId: string | undefined, name: string): Promise<{ flushed: number }> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    return session.client.flushPending(trimmedName)
  }

  async resizePty(projectId: string | undefined, name: string, rows: number, cols: number): Promise<void> {
    let session: BrokerSession
    try {
      session = this.getSessionForAgent(name, projectId)
    } catch (err) {
      if (isWorkspaceNotStartedError(err)) return
      throw err
    }
    try {
      await session.client.resizePty(name, rows, cols)
    } catch (err) {
      if (isMissingAgentError(err)) return
      throw err
    }
  }

  async sendMessage(projectId: string | undefined, input: SendMessageInput): Promise<void> {
    const session = input.to.startsWith('#')
      ? this.getSessionForProject(projectId || '')
      : this.getSessionForAgent(input.to, projectId)
    await session.client.sendMessage(input)
  }

  async subscribeAgentChannel(projectId: string | undefined, name: string, channel: string): Promise<void> {
    const trimmedName = name.trim()
    const [channelName] = normalizeChannels([channel])
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    if (!channelName) {
      throw new Error('Channel name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    await session.client.subscribeChannels(trimmedName, [channelName])
  }

  async unsubscribeAgentChannel(projectId: string | undefined, name: string, channel: string): Promise<void> {
    const trimmedName = name.trim()
    const [channelName] = normalizeChannels([channel])
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    if (!channelName) {
      throw new Error('Channel name is required')
    }

    const session = this.getSessionForAgent(trimmedName, projectId)
    await session.client.unsubscribeChannels(trimmedName, [channelName])
  }

  async syncChannels(projectId: string, channels: string[]): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) return
    const nextChannels = normalizeChannels(channels)
    const previousChannels = session.channels
    session.channels = nextChannels

    const added = nextChannels.filter((channel) => !previousChannels.includes(channel))
    const removed = previousChannels.filter((channel) => !nextChannels.includes(channel))

    if (!added.length && !removed.length) {
      return
    }

    const agents = await session.client.listAgents()
    if (!agents.length) {
      return
    }

    await Promise.all(
      agents.map(async (agent) => {
        if (added.length) {
          await session.client.subscribeChannels(agent.name, added)
        }
        if (removed.length) {
          await session.client.unsubscribeChannels(agent.name, removed)
        }
      })
    )
  }

  async releaseAgent(projectId: string | undefined, name: string): Promise<void> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Agent name is required')
    }
    const session = this.getSessionForAgent(trimmedName, projectId)
    await session.client.release(trimmedName)
    this.closeInputStream(this.getInputStreamKey(session.projectId, trimmedName), 1000, 'agent released')
  }

  // Run a per-session broker operation with the same self-healing listAgents
  // uses, so any polled read survives a dead/wedged broker instead of timing out
  // (and flooding the IPC error log) on every call. The broker can wedge a
  // single HTTP endpoint while others stay live — e.g. `/api/pending` hangs but
  // `/api/spawned` answers — so each polled call needs its own recovery rather
  // than relying on listAgents to notice and respawn.
  //
  // - Connection refused → broker is gone → respawn immediately.
  // - Repeated timeouts → broker is wedged → respawn after MAX consecutive.
  // - Still unrecoverable → return `fallback` instead of rejecting.
  //
  // `degradeOnTimeout`: when a timeout is still below the respawn threshold,
  // return `fallback` instead of rethrowing. listAgents opts OUT (false) so the
  // renderer keeps its stale agent list rather than flickering to empty; pollers
  // whose empty result is harmless (pending messages) opt IN to kill log spam.
  private async withWedgeRecovery<T>(
    session: BrokerSession,
    label: string,
    fallback: T,
    run: (session: BrokerSession) => Promise<T>,
    options: { degradeOnTimeout?: boolean } = {}
  ): Promise<T> {
    const timeoutKey = `${session.projectId}:${label}`
    try {
      const result = await run(session)
      this.brokerTimeoutCounts.delete(timeoutKey)
      return result
    } catch (err) {
      // Cloud sessions live in a remote sandbox we can't respawn locally.
      if (session.cloudSandboxId) throw err
      const unreachable = isBrokerUnreachableError(err)
      if (!unreachable) {
        if (!isBrokerTimeoutError(err)) throw err
        const timeouts = (this.brokerTimeoutCounts.get(timeoutKey) ?? 0) + 1
        this.brokerTimeoutCounts.set(timeoutKey, timeouts)
        if (timeouts < MAX_BROKER_TIMEOUTS_BEFORE_REVIVE) {
          if (options.degradeOnTimeout) return fallback
          throw err
        }
        console.warn(
          `[broker] ${label}: broker for project ${session.projectId} timed out ${timeouts}x; ` +
          `restarting it on a fresh port`
        )
      }
      // Restart on a fresh port and retry once against the new session; if
      // recovery fails, degrade to `fallback` rather than rejecting.
      this.brokerTimeoutCounts.delete(timeoutKey)
      const revived = await this.reviveSession(session.projectId)
      const next = revived ? this.sessions.get(session.projectId) : undefined
      if (!next) {
        console.warn(`[broker] ${label}: broker for project ${session.projectId} is unreachable; degrading`)
        return fallback
      }
      try {
        const result = await run(next)
        this.brokerTimeoutCounts.delete(`${next.projectId}:${label}`)
        return result
      } catch (retryErr) {
        console.warn(
          `[broker] ${label}: broker for project ${session.projectId} is still unreachable after restart; degrading:`,
          retryErr
        )
        return fallback
      }
    }
  }

  async listAgents(projectId?: string): Promise<Array<ListAgent & {
    projectId: string
    inboundDeliveryMode?: InboundDeliveryMode
  }>> {
    const sessions = projectId
      ? [await this.getOrAwaitSession(projectId)]
      : (await Promise.all(
          Array.from(new Set([
            ...Array.from(this.sessions.keys()),
            ...Array.from(this.revivePromises.keys()),
            ...Array.from(this.startPromises.keys())
          ])).map((id) => this.getOrAwaitSession(id).catch(() => undefined))
        )).filter((session): session is BrokerSession => !!session)
    // degradeOnTimeout stays false: a below-threshold timeout rethrows so the
    // renderer keeps its stale agent list rather than flickering to empty. A
    // dead/unrecoverable broker still degrades to [] for that one project so a
    // single bad session can't fail the whole call.
    const results = await Promise.all(
      sessions.map((session) =>
        this.withWedgeRecovery<Array<ListAgent & { projectId: string; inboundDeliveryMode?: InboundDeliveryMode }>>(
          session,
          'listAgents',
          [],
          (current) => this.collectSessionAgents(current)
        )
      )
    )
    return results.flat()
  }

  private async collectSessionAgents(session: BrokerSession): Promise<Array<ListAgent & {
    projectId: string
    inboundDeliveryMode?: InboundDeliveryMode
  }>> {
    const agents = await session.client.listAgents()
    // A successful poll means the broker is answering again — clear any wedge
    // streak so a future timeout starts counting from zero.
    this.brokerTimeoutCounts.delete(`${session.projectId}:listAgents`)
    for (const agent of agents) {
      this.rememberAgentProject(agent.name, session.projectId)
    }
    return Promise.all(
      agents.map(async (agent) => {
        const inboundDeliveryMode = await session.client.getInboundDeliveryMode(agent.name).catch(() => undefined)
        return { ...agent, projectId: session.projectId, inboundDeliveryMode }
      })
    )
  }

  async listBrokerDetails(): Promise<BrokerDetails[]> {
    const sessions = Array.from(this.sessions.values())

    const details = await Promise.all(
      sessions.map(async (session) => {
        const baseUrl = getClientBaseUrl(session.client)
        const apiKey = getClientApiKey(session.client)
        const brokerPid = session.client.brokerPid
        const connectionFile = getBrokerConnectionFileInfo(session.cwd, baseUrl, brokerPid)
        const sessionResult = await Promise.allSettled([
          withBrokerDetailsTimeout(session.client.getSession(), 'Broker metadata'),
          this.getBrokerStateSnapshot(session)
        ])
        const [metadata, state] = sessionResult
        const agents = state.status === 'fulfilled' ? state.value.agents : []
        const auth = state.status === 'fulfilled' ? state.value.auth : undefined
        const workspaceKey = metadata.status === 'fulfilled' ? metadata.value.workspace_key : undefined
        const defaultWorkspaceId = metadata.status === 'fulfilled' ? metadata.value.default_workspace_id : undefined
        const relaycast = workspaceKey || defaultWorkspaceId || auth
          ? {
              workspaceKey,
              defaultWorkspaceId,
              authenticated: auth?.authenticated,
              workspaceCount: auth?.workspace_count,
              workspaces: (auth?.workspaces || []).map((workspace) => ({
                workspaceId: workspace.workspace_id,
                workspaceAlias: workspace.workspace_alias,
                selfName: workspace.self_name,
                selfAgentId: workspace.self_agent_id,
                authenticated: workspace.authenticated,
                default: workspace.default
              }))
            }
          : undefined
        const errors = sessionResult
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => toErrorMessage(result.reason))

        return {
          projectId: session.projectId,
          name: session.name,
          cwd: session.cwd,
          channels: session.channels,
          kind: session.cloudSandboxId ? 'cloud' : 'local',
          url: baseUrl,
          port: parsePortFromUrl(baseUrl),
          apiKey: apiKey || connectionFile.apiKey,
          brokerPid,
          cloudSandboxId: session.cloudSandboxId,
          connectionPath: connectionFile.path,
          connectionFileStatus: connectionFile.status,
          apiKeyAvailable: !!apiKey || connectionFile.hasApiKey,
          health: errors.length === 0 ? 'connected' : 'unreachable',
          session: metadata.status === 'fulfilled'
            ? {
                brokerVersion: metadata.value.broker_version,
                protocolVersion: metadata.value.protocol_version,
                workspaceKey: metadata.value.workspace_key,
                defaultWorkspaceId: metadata.value.default_workspace_id,
                mode: metadata.value.mode,
                uptimeSecs: metadata.value.uptime_secs
              }
            : undefined,
          relaycast,
          agentCount: agents.length,
          pendingDeliveryCount: state.status === 'fulfilled' ? state.value.pendingDeliveryCount : 0,
          agents: agents.map((agent) => ({
            name: agent.name,
            runtime: agent.runtime,
            cli: agent.cli,
            model: agent.model,
            channels: agent.channels,
            parent: agent.parent,
            pid: agent.pid,
            currentState: agent.current_state
          })),
          error: errors.length > 0 ? errors.join('\n') : undefined
        } satisfies BrokerDetails
      })
    )

    return details
  }

  listBrokerEvents(): BrokerEventRecord[] {
    this.pruneBrokerEventHistory()
    return this.eventHistory.map((entry) => ({
      ...entry,
      event: { ...(entry.event as Record<string, unknown>) } as BrokerEventRecordPayload
    }))
  }

  private async getBrokerStateSnapshot(session: BrokerSession): Promise<BrokerStateSnapshot> {
    try {
      const status: BrokerStatus = await withBrokerDetailsTimeout(
        session.client.getStatus(),
        'Broker status'
      )
      return {
        agents: status.agents,
        pendingDeliveryCount: status.pending_delivery_count,
        auth: status.auth
      }
    } catch (statusErr) {
      try {
        return {
          agents: await withBrokerDetailsTimeout(session.client.listAgents(), 'Agent list'),
          pendingDeliveryCount: 0
        }
      } catch (listErr) {
        throw new Error(
          `Failed to read broker state: ${toErrorMessage(statusErr)}; ${toErrorMessage(listErr)}`
        )
      }
    }
  }

  async shutdown(projectId?: string): Promise<void> {
    const targetProjectIds = projectId
      ? [projectId]
      : Array.from(new Set([
          ...Array.from(this.sessions.keys()),
          ...Array.from(this.revivePromises.keys())
        ]))
    for (const targetProjectId of targetProjectIds) {
      this.revivePromises.delete(targetProjectId)
      const session = this.sessions.get(targetProjectId)
      try {
        await session?.client.shutdown()
      } catch {
        // Ignore shutdown errors.
      }
      this.dropSession(targetProjectId, { disconnectOnly: false })
    }
  }

  private clearBrokerTimeoutCountsForProject(projectId: string): void {
    for (const key of Array.from(this.brokerTimeoutCounts.keys())) {
      if (key.startsWith(`${projectId}:`)) {
        this.brokerTimeoutCounts.delete(key)
      }
    }
  }

  private dropSession(projectId: string, options: { disconnectOnly: boolean }): void {
    this.closeInputStreamsForProject(projectId)
    this.clearBrokerTimeoutCountsForProject(projectId)

    const session = this.sessions.get(projectId)
    if (!session) return

    session.unsubEvent()
    if (session.leaseTimer) clearInterval(session.leaseTimer)
    if (options.disconnectOnly) {
      const disconnect = (session.client as { disconnect?: () => void }).disconnect
      if (typeof disconnect === 'function') {
        disconnect.call(session.client)
      }
    }
    this.sessions.delete(projectId)
    for (const [agentName, mappedProjectIds] of Array.from(this.agentProjects.entries())) {
      mappedProjectIds.delete(projectId)
      if (mappedProjectIds.size === 0) {
        this.agentProjects.delete(agentName)
      }
    }
  }

  async detachCloudSandbox(projectId: string): Promise<void> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return
    const session = this.sessions.get(normalizedProjectId)
    this.sendStatusToWindow(session?.window, normalizedProjectId, 'disconnected')
    await this.shutdown(normalizedProjectId)
  }

  private sendStatus(projectId: string, status: string, error?: string): void {
    const session = this.sessions.get(projectId)
    this.sendStatusToWindow(session?.window, projectId, status, error)
  }

  private sendStatusToWindow(
    win: BrowserWindow | undefined,
    projectId: string,
    status: string,
    error?: string
  ): void {
    if (win && !win.isDestroyed()) {
      win.webContents.send('broker:status', { projectId, status, error })
    }
  }
}

export const brokerManager = new BrokerManager()
