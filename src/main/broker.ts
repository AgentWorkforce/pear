import { existsSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { delimiter, basename, isAbsolute, join } from 'path'
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
import { AgentRelay, type RelayMessage } from '@agent-relay/sdk'
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
import type {
  BrokerEventStreamDiagnostic,
  BrokerReconciledChatMessage,
  BrokerReconcileMessagesInput,
  WorkforcePersona
} from '../shared/types/ipc'
import {
  canExecute,
  resolveAgentRelayMcpCommand as resolveAgentRelayMcpCommandForOptions,
  resolveCommandOnPath,
  resolvePackageBin
} from './mcp-command'

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

function executableCliPath(input: SpawnPtyInput): string {
  return isAbsolute(input.cli)
    ? input.cli
    : join(input.cwd || process.cwd(), input.cli)
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

export function resolveAgentRelayMcpCommand(): string | undefined {
  return resolveAgentRelayMcpCommandForOptions({
    configuredCommand: process.env.AGENT_RELAY_MCP_COMMAND,
    env: process.env,
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  })
}

// Strict-join failures from the broker (#125): an explicitly pinned workspace
// key never falls back to creating a fresh workspace. Auth rejection (401/403,
// "was rejected") is fatal — the key is bad or revoked; rate limiting (429,
// "was rate-limited") is retryable. Contract strings from agent-relay-broker
// relaycast/auth.rs, verified in the T3 review.
export function classifyWorkspaceJoinFailure(err: unknown): 'rejected' | 'rate-limited' | null {
  const message = toErrorMessage(err)
  if (/explicit workspace key .* was rate-limited/iu.test(message)) return 'rate-limited'
  if (/explicit workspace key .* was rejected/iu.test(message)) return 'rejected'
  return null
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

type DeliveryConfirmationResult = {
  eventId: string
  targets: string[]
}

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
const DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS = 15_000
const DEFAULT_RECONCILE_MESSAGE_LIMIT = 50
const MAX_RECONCILE_MESSAGE_LIMIT = 100
const EVENT_STREAM_REBIND_COOLDOWN_MS = 5_000
const PTY_CHUNK_IDENTITY_DEDUPE_TTL_MS = 60_000
const PTY_CHUNK_CONTENT_DEDUPE_TTL_MS = 1_000
const MAX_PTY_CHUNK_DEDUPE_ENTRIES = 2_000
// After this many consecutive failures to open a PTY input stream, give up on
// the WS fast path for that agent briefly and send over HTTP while it cools down.
const MAX_INPUT_STREAM_OPEN_FAILURES = 3
const INPUT_STREAM_FALLBACK_RETRY_MS = 15_000
// A single broker read timeout can be a one-off slow response; a run of them
// means that endpoint is wedged (alive, accepting TCP, never answering).
// After this many consecutive timeouts for one project/operation we respawn it
// rather than time out every poll forever. A successful request for that same
// operation resets the streak.
const MAX_BROKER_TIMEOUTS_BEFORE_REVIVE = 2
const BROKER_REVIVE_TERM_GRACE_MS = 1_500
const PERSONA_REGISTRATION_TIMEOUT_MS = 5_000
const PERSONA_REGISTRATION_STABILITY_MS = 1_000
const AGENTWORKFORCE_CLI_VERSION = '3.0.50'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnRequestKey(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function brokerEventString(event: BrokerEvent, key: string): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function isDeliveryEventForMessage(event: BrokerEvent, eventId: string, targets: string[]): boolean {
  const kind = brokerEventString(event, 'kind')
  if (![
    'delivery_ack',
    'delivery_verified',
    'delivery_failed',
    'message_delivery_confirmed',
    'message_delivery_failed'
  ].includes(kind || '')) {
    return false
  }
  if (brokerEventString(event, 'event_id') !== eventId) return false
  const name = brokerEventString(event, 'name')
  return !name || targets.length === 0 || targets.includes(name)
}

function deliveryFailureMessage(event: BrokerEvent): string {
  if (!isRecord(event)) return 'Broker delivery failed'
  const reason = typeof event.reason === 'string' ? event.reason : undefined
  const lastError = typeof event.lastError === 'string' ? event.lastError : undefined
  return reason || lastError || 'Broker delivery failed'
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

function isBrokerDebugEnabled(): boolean {
  return process.env.PEAR_BROKER_DEBUG === '1' || process.env.PEAR_BROKER_DEBUG === 'true'
}

function normalizeReconcileLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_RECONCILE_MESSAGE_LIMIT
  return Math.min(Math.floor(limit), MAX_RECONCILE_MESSAGE_LIMIT)
}

function normalizeChatChannelTarget(channelName: string): string {
  const normalized = channelName.trim().replace(/^#/, '')
  return normalized ? `#${normalized}` : '#general'
}

function normalizeRelayTimestamp(value: string | undefined): number {
  if (!value) return Date.now()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function isHumanSenderName(sender: string): boolean {
  return sender.trim().toLowerCase() === 'human'
}

function senderNameFromRelayMessage(message: RelayMessage): string {
  return message.from?.name || message.from?.id || 'unknown'
}

function directMessageTargetFromRelayMessage(
  message: RelayMessage,
  participants: string[] | undefined
): string {
  const from = senderNameFromRelayMessage(message)
  const normalizedParticipants = (participants || [])
    .map((participant) => participant.trim().replace(/^@+/, ''))
    .filter(Boolean)
  const target = message.target

  if (target?.kind === 'agent' && target.agentName) return target.agentName
  if (target?.kind === 'channel' && target.channelName) return normalizeChatChannelTarget(target.channelName)

  if (normalizedParticipants.length > 0) {
    const otherParticipants = normalizedParticipants.filter((participant) =>
      participant.toLowerCase() !== from.toLowerCase()
    )
    if (otherParticipants.length > 0) return otherParticipants.join(', ')
  }

  const targetConversationId = target && 'conversationId' in target && typeof target.conversationId === 'string'
    ? target.conversationId
    : undefined
  return message.conversationId || targetConversationId || 'direct-message'
}

function normalizeRelayMessageForChat(
  message: RelayMessage,
  input: BrokerReconcileMessagesInput
): BrokerReconciledChatMessage | null {
  const id = message.id || message.messageId
  const body = message.text
  if (!id || !body) return null

  const from = senderNameFromRelayMessage(message)
  const to = input.kind === 'channel'
    ? normalizeChatChannelTarget(input.channelName || message.channel?.name || 'general')
    : directMessageTargetFromRelayMessage(message, input.dmParticipants)

  return {
    id,
    kind: 'message',
    from,
    to,
    body,
    timestamp: normalizeRelayTimestamp(message.createdAt || message.updatedAt),
    isHuman: isHumanSenderName(from),
    projectId: input.projectId,
    ...(message.conversationId ? { conversationId: message.conversationId } : {}),
    reactions: message.reactions?.map((reaction) => ({
      emoji: reaction.emoji,
      count: reaction.count,
      reactedByHuman: Array.isArray(reaction.agents) && reaction.agents.some(isHumanSenderName)
    }))
  }
}

function brokerEventSeq(event: BrokerEvent): number | undefined {
  const seq = (event as Record<string, unknown>).seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined
}

function brokerEventId(event: BrokerEvent): string | undefined {
  const eventId = (event as Record<string, unknown>).event_id
  return typeof eventId === 'string' && eventId.trim() ? eventId : undefined
}

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
    if (code === 'UND_ERR_SOCKET') {
      const message = node.message
      return typeof message === 'string' && /other side closed|socket closed/i.test(message)
    }
    const message = node.message
    return typeof message === 'string' && /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET/.test(message)
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

  const candidates = brokerConnectionPathCandidates(cwd)
  let firstExisting: BrokerConnectionFileInfo | undefined

  for (const connectionPath of candidates) {
    if (!existsSync(connectionPath)) continue

    const info = readBrokerConnectionFileInfo(connectionPath, baseUrl, brokerPid)
    if (info.status === 'matches') return info
    firstExisting ??= info
  }

  return firstExisting ?? { path: candidates[0], status: 'missing', hasApiKey: false }
}

function readBrokerConnectionFileInfo(
  connectionPath: string,
  baseUrl: string | undefined,
  brokerPid: number | undefined
): BrokerConnectionFileInfo {
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

function brokerConnectionPathCandidates(cwd: string): string[] {
  return [
    join(cwd, '.agentworkforce', 'relay', 'connection.json'),
    join(cwd, '.agent-relay', 'connection.json')
  ]
}

function resolveBrokerConnectionPath(cwd: string): string {
  const candidates = brokerConnectionPathCandidates(cwd)
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
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
  const legacyRoot = join(cwd, '.agent-relay')
  const currentRoot = join(cwd, '.agentworkforce', 'relay')
  const safeName = getBrokerRuntimeSafeName(brokerName)

  return [
    join(currentRoot, 'connection.json'),
    join(currentRoot, `broker-${safeName}.lock`),
    join(currentRoot, `state-${safeName}.json`),
    join(currentRoot, `pending-${safeName}.json`),
    join(legacyRoot, 'connection.json'),
    join(legacyRoot, `broker-${safeName}.lock`),
    join(legacyRoot, `state-${safeName}.json`),
    join(legacyRoot, `pending-${safeName}.json`)
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
    if (!canExecute(executableCliPath(input))) {
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
  lastEventSeq?: number
  lastEventAt?: number
  lastEventId?: string
  eventStreamGeneration: number
  lastEventStreamRebindAt?: number
  eventStreamRebinds?: number
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

// A project can run a local broker and a cloud-sandbox broker side by side.
// Local sessions are keyed by the bare projectId (keeping input-stream and
// timeout keys back-compatible); the cloud session lives under a suffixed key
// so the two coexist instead of clobbering each other in the sessions map.
// '\0' cannot appear in a project id, so the keys can't collide.
const CLOUD_SESSION_KEY_SUFFIX = '\0cloud'

function cloudSessionKey(projectId: string): string {
  return `${projectId}${CLOUD_SESSION_KEY_SUFFIX}`
}

function projectIdFromSessionKey(sessionKey: string): string {
  return sessionKey.endsWith(CLOUD_SESSION_KEY_SUFFIX)
    ? sessionKey.slice(0, -CLOUD_SESSION_KEY_SUFFIX.length)
    : sessionKey
}

function sessionKeyFor(session: BrokerSession): string {
  return session.cloudSandboxId ? cloudSessionKey(session.projectId) : session.projectId
}

export class BrokerManager {
  private sessions = new Map<string, BrokerSession>()
  private startPromises = new Map<string, Promise<boolean | void>>()
  private revivePromises = new Map<string, Promise<boolean>>()
  private inFlightSpawnRequests = new Map<string, Promise<{ name: string; runtime: string }>>()
  // Which broker sessions (by session key) an agent name is registered on.
  // Both a project's local and cloud brokers join the same relay workspace,
  // so agent names are project-unique in practice — the set tracks which
  // session actually owns the worker so agent-scoped calls route correctly.
  private agentSessions = new Map<string, Set<string>>()
  private inputStreams = new Map<string, PtyInputStream>()
  private inputStreamFallbacks = new Set<string>()
  private inputStreamFallbackRetryAt = new Map<string, number>()
  // Keys whose WS input stream has completed the broker's pty_input_ready
  // handshake — only these are safe to send on without blocking. Everything
  // else routes over HTTP until the stream is confirmed open.
  private inputStreamReady = new Set<string>()
  // Consecutive background open failures per key; after MAX we pause WS retries
  // for this agent briefly and keep HTTP input flowing.
  private inputStreamOpenFailures = new Map<string, number>()
  // Consecutive broker read timeouts per project/operation; after MAX we
  // respawn the wedged broker. Reset whenever that operation succeeds.
  private brokerTimeoutCounts = new Map<string, number>()
  private eventStreamGenerationCounter = 0
  private eventObservers = new Set<BrokerEventObserver>()
  private eventHistory: BrokerEventRecord[] = []
  private recentPtyChunks = new Map<string, number>()
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
  ): Promise<boolean> {
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
      await this.refreshEventStream(normalizedProjectId, 'existing-session-start', win)
      this.sendStatus(normalizedProjectId, 'connected')
      return false
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
        return false
      } catch (err) {
        this.sendStatusToWindow(win, normalizedProjectId, 'error', String(err))
        throw err
      }
    }

    const startBroker = async (): Promise<boolean> => {
      const existingClient = await this.connectExistingBroker(normalizedProjectId, cwd)
      if (existingClient) {
        const eventStreamGeneration = this.nextEventStreamGeneration()
        const unsubEvent = this.attachClient(normalizedProjectId, existingClient, win, eventStreamGeneration)
        this.sessions.set(normalizedProjectId, {
          projectId: normalizedProjectId,
          client: existingClient,
          window: win,
          unsubEvent,
          cwd,
          name,
          channels: [],
          cloudSandboxId: null,
          pearLineage: new Map(),
          eventStreamGeneration
        })
        existingClient.connectEvents()

        await this.syncChannels(normalizedProjectId, nextChannels)
        this.publishBrokerEvent(normalizedProjectId, normalizedProjectId, win, {
          kind: 'broker_initialized',
          name,
          cwd,
          url: getClientBaseUrl(existingClient),
          channels: nextChannels,
          source: 'local'
        })
        this.sendStatus(normalizedProjectId, 'connected')
        return true
      }

      const agentRelayMcpCommand = resolveAgentRelayMcpCommand()
      if (agentRelayMcpCommand) {
        console.log('[broker] Using Agent Relay MCP command:', agentRelayMcpCommand)
      } else {
        console.warn('[broker] Agent Relay MCP command could not be resolved; broker will use its default MCP command')
      }

      // Phase 1 of #125: the local broker stays the workspace creator, so the
      // key is only threaded when explicitly pinned via env. The intersection
      // type is the single cast site until @agent-relay/harness-driver
      // PUBLISHES workspaceKey in RuntimeSpawnOptions (landed relay-side in
      // 6419d59c; verified against the built 8.3.0+T3 dist locally) — the
      // intersection erases to a no-op then and drops with the version bump.
      const explicitWorkspaceKey = process.env.AGENT_RELAY_WORKSPACE_KEY?.trim() || undefined
      const opts: AgentRelaySpawnOptions & { workspaceKey?: string } = {
        cwd,
        brokerName: name,
        channels: nextChannels,
        binaryArgs: { persist: true },
        binaryPath: resolveBundledBrokerBinary(),
        ...(explicitWorkspaceKey ? { workspaceKey: explicitWorkspaceKey } : {}),
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
      const eventStreamGeneration = this.nextEventStreamGeneration()
      const unsubEvent = this.attachClient(normalizedProjectId, client, win, eventStreamGeneration)
      this.sessions.set(normalizedProjectId, {
        projectId: normalizedProjectId,
        client,
        window: win,
        unsubEvent,
        cwd,
        name,
        channels: nextChannels,
        cloudSandboxId: null,
        pearLineage: new Map(),
        eventStreamGeneration
      })

      this.publishBrokerEvent(normalizedProjectId, normalizedProjectId, win, {
        kind: 'broker_initialized',
        name,
        cwd,
        url: getClientBaseUrl(client),
        brokerPid: client.brokerPid,
        channels: nextChannels,
        source: 'local'
      })
      this.sendStatus(normalizedProjectId, 'connected')
      return true
    }

    const startPromise = startBroker()
    this.startPromises.set(normalizedProjectId, startPromise)
    try {
      return await startPromise
    } catch (err) {
      console.error(`[broker] Failed to start for project ${normalizedProjectId}:`, err)
      const joinFailure = classifyWorkspaceJoinFailure(err)
      const statusMessage = joinFailure === 'rate-limited'
        ? `Workspace join rate-limited (retryable): ${String(err)}`
        : joinFailure === 'rejected'
          ? `Workspace key rejected — broker refused to create a fresh workspace: ${String(err)}`
          : String(err)
      this.sendStatusToWindow(win, normalizedProjectId, 'error', statusMessage)
      throw err
    } finally {
      if (this.startPromises.get(normalizedProjectId) === startPromise) {
        this.startPromises.delete(normalizedProjectId)
      }
    }
  }

  private async connectExistingBroker(projectId: string, cwd: string): Promise<AgentRelayClient | null> {
    const connectionPaths = brokerConnectionPathCandidates(cwd).filter((candidate) => existsSync(candidate))
    if (connectionPaths.length === 0) {
      return null
    }

    for (const connectionPath of connectionPaths) {
      let client: AgentRelayClient | undefined
      try {
        client = AgentRelayClient.connect({ cwd, connectionPath })
        await client.getSession()
        console.log(`[broker] Reusing existing broker for project ${projectId}: ${connectionPath}`)
        return client
      } catch (err) {
        client?.disconnect()
        console.warn(`[broker] Existing broker connection is not reusable for project ${projectId}:`, err)
      }
    }

    return null
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
   * The local broker creates the project's relay workspace; its workspace_key
   * is what cloud sandbox brokers must join so local and cloud agents share
   * one workspace (#125). Non-throwing: resolves undefined until a local
   * session exists and exposes a key, so provisioning can proceed without it.
   */
  async workspaceKeyForProject(projectId: string): Promise<string | undefined> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return undefined
    const startPromise = this.startPromises.get(normalizedProjectId)
    if (startPromise) await startPromise.catch(() => undefined)
    const session = this.sessions.get(normalizedProjectId)
    if (!session) return undefined
    try {
      const metadata = await session.client.getSession()
      return metadata.workspace_key || undefined
    } catch {
      return undefined
    }
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

    // The cloud session lives under its own key, so it coexists with the
    // project's local broker instead of replacing it. The gate (registered in
    // startPromises under the cloud key) serializes concurrent attaches and
    // lets getOrAwaitSessionsForProject await an in-flight attach.
    const sessionKey = cloudSessionKey(normalizedProjectId)
    const inFlightAttach = this.startPromises.get(sessionKey)
    if (inFlightAttach) await inFlightAttach.catch(() => undefined)
    let releaseAttachGate!: () => void
    const attachGate = new Promise<void>((resolve) => {
      releaseAttachGate = resolve
    })
    this.startPromises.set(sessionKey, attachGate)

    try {
      // Replace only a previous cloud session — a running local broker for the
      // same project keeps serving its agents.
      const previous = this.sessions.get(sessionKey)
      if (previous) {
        try {
          await previous.client.shutdown()
        } catch {
          // Ignore shutdown errors.
        }
        this.dropSession(sessionKey, { disconnectOnly: false })
      }

      console.log('[broker] Connecting to cloud broker via SDK:', execUrl)
      const client = new AgentRelayClient({
        baseUrl: execUrl,
        ...(apiKey ? { apiKey } : {})
      })
      await client.getSession()

      const eventStreamGeneration = this.nextEventStreamGeneration()
      const unsubEvent = this.attachClient(sessionKey, client, win, eventStreamGeneration)
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
      this.sessions.set(sessionKey, {
        projectId: normalizedProjectId,
        client,
        window: win,
        unsubEvent,
        cwd: '',
        name: `cloud-${normalizedProjectId}`,
        channels: [],
        cloudSandboxId: sandboxId,
        pearLineage: new Map(),
        eventStreamGeneration,
        leaseTimer
      })
      client.connectEvents()

      this.publishBrokerEvent(sessionKey, normalizedProjectId, win, {
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
    } finally {
      releaseAttachGate()
      if (this.startPromises.get(sessionKey) === attachGate) {
        this.startPromises.delete(sessionKey)
      }
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

  // Local session first, then the cloud session — local stays the default
  // target for project-scoped operations when both brokers are running.
  private sessionsForProject(projectId: string): BrokerSession[] {
    const normalizedProjectId = projectId.trim()
    const local = this.sessions.get(normalizedProjectId)
    const cloud = this.sessions.get(cloudSessionKey(normalizedProjectId))
    return [local, cloud].filter((session): session is BrokerSession => !!session)
  }

  private getSessionForProject(projectId: string): BrokerSession {
    const [session] = this.sessionsForProject(projectId)
    if (!session) {
      throw new Error('Relay workspace not started — select the project first')
    }
    return session
  }

  private async getOrAwaitSessionsForProject(projectId: string): Promise<BrokerSession[]> {
    const normalizedProjectId = projectId.trim()
    const revivePromise = this.revivePromises.get(normalizedProjectId)
    if (revivePromise) {
      await revivePromise.catch(() => undefined)
    }
    const startPromise = this.startPromises.get(normalizedProjectId)
    if (startPromise) {
      await startPromise.catch(() => undefined)
    }
    const attachPromise = this.startPromises.get(cloudSessionKey(normalizedProjectId))
    if (attachPromise) {
      await attachPromise.catch(() => undefined)
    }
    const sessions = this.sessionsForProject(normalizedProjectId)
    if (!sessions.length) {
      throw new Error('Relay workspace not started — select the project first')
    }
    return sessions
  }

  private getSessionForBroker(projectId: string, broker: 'local' | 'cloud'): BrokerSession {
    const normalizedProjectId = projectId.trim()
    const session = broker === 'cloud'
      ? this.sessions.get(cloudSessionKey(normalizedProjectId))
      : this.sessions.get(normalizedProjectId)
    if (!session) {
      throw new Error(
        broker === 'cloud'
          ? 'Cloud sandbox is not attached for this project'
          : 'Relay workspace not started — select the project first'
      )
    }
    return session
  }

  private getSessionForAgent(name: string, projectId?: string): BrokerSession {
    const sessionKeys = this.agentSessions.get(name)

    if (projectId?.trim()) {
      const candidates = this.sessionsForProject(projectId)
      if (!candidates.length) {
        throw new Error('Relay workspace not started — select the project first')
      }
      // Route to the session that actually owns the worker; default to the
      // local session for agents we haven't observed yet.
      const owned = candidates.find((session) => sessionKeys?.has(sessionKeyFor(session)))
      return owned ?? candidates[0]
    }

    if (sessionKeys && sessionKeys.size > 0) {
      const sessions = Array.from(sessionKeys)
        .map((key) => this.sessions.get(key))
        .filter((session): session is BrokerSession => !!session)
      const projectIds = new Set(sessions.map((session) => session.projectId))
      if (projectIds.size > 1) {
        throw new Error(`Agent name exists in multiple projects; project id is required: ${name}`)
      }
      if (sessions.length > 0) {
        return sessions.find((session) => !session.cloudSandboxId) ?? sessions[0]
      }
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
    sessionKey: string,
    event: Extract<BrokerEvent, { kind: 'agent_spawned' }>
  ): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session || !event.parent) return
    const entry = this.recordLineageChild(session, event.name, event.parent, undefined, event.cli)
    if (!entry) return

    const enrichment = getPearBurnSpawnEnrichment(
      session.projectId,
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

  private windowForSession(sessionKey: string, fallback?: BrowserWindow): BrowserWindow | undefined {
    const win = this.sessions.get(sessionKey)?.window || fallback
    if (!win || win.isDestroyed()) return undefined
    return win
  }

  private emitEventStreamDiagnostic(
    sessionKey: string,
    fallback: BrowserWindow | undefined,
    diagnostic: BrokerEventStreamDiagnostic
  ): void {
    if (diagnostic.status === 'received' && !isBrokerDebugEnabled()) return

    if (isBrokerDebugEnabled()) {
      console.info('[broker:event-stream]', diagnostic)
    }

    const win = this.windowForSession(sessionKey, fallback)
    if (win) {
      win.webContents.send('broker:event-stream-diagnostic', diagnostic)
    }
  }

  private noteBrokerEventReceipt(sessionKey: string, event: BrokerEvent): void {
    const session = this.sessions.get(sessionKey)
    const seq = brokerEventSeq(event)
    const eventId = brokerEventId(event)
    if (session) {
      session.lastEventAt = Date.now()
      if (seq !== undefined) session.lastEventSeq = seq
      if (eventId) session.lastEventId = eventId
    }

    this.emitEventStreamDiagnostic(sessionKey, session?.window, {
      projectId: projectIdFromSessionKey(sessionKey),
      status: 'received',
      at: Date.now(),
      eventKind: event.kind,
      ...(eventId ? { eventId } : {}),
      ...(seq !== undefined ? { seq } : {})
    })
  }

  async refreshEventStream(projectId?: string, reason = 'manual', win?: BrowserWindow): Promise<void> {
    const normalizedProjectId = projectId?.trim()
    let sessions: BrokerSession[]
    if (normalizedProjectId) {
      try {
        sessions = await this.getOrAwaitSessionsForProject(normalizedProjectId)
      } catch (err) {
        if (err instanceof Error && err.message === 'Relay workspace not started — select the project first') {
          return
        }
        throw err
      }
    } else {
      sessions = Array.from(this.sessions.values())
    }
    const rebindWindow = normalizedProjectId ? win : undefined

    for (const session of sessions) {
      await this.rebindSessionEventStream(sessionKeyFor(session), session, reason, rebindWindow)
    }
  }

  private async rebindSessionEventStream(
    sessionKey: string,
    session: BrokerSession,
    reason: string,
    win?: BrowserWindow
  ): Promise<void> {
    const now = Date.now()
    if (win && !win.isDestroyed()) {
      session.window = win
    }

    if (
      session.lastEventStreamRebindAt &&
      now - session.lastEventStreamRebindAt < EVENT_STREAM_REBIND_COOLDOWN_MS
    ) {
      this.emitEventStreamDiagnostic(sessionKey, session.window, {
        projectId: session.projectId,
        status: 'rebind-skipped',
        reason,
        at: now,
        reconnects: session.eventStreamRebinds || 0,
        ...(session.lastEventSeq !== undefined ? { seq: session.lastEventSeq } : {}),
        ...(session.lastEventId ? { eventId: session.lastEventId } : {})
      })
      return
    }

    this.emitEventStreamDiagnostic(sessionKey, session.window, {
      projectId: session.projectId,
      status: 'rebind-started',
      reason,
      at: now,
      reconnects: session.eventStreamRebinds || 0,
      ...(session.lastEventSeq !== undefined ? { seq: session.lastEventSeq } : {}),
      ...(session.lastEventId ? { eventId: session.lastEventId } : {})
    })

    const previousUnsubEvent = session.unsubEvent
    const previousEventStreamGeneration = session.eventStreamGeneration
    let nextUnsubEvent: (() => void) | undefined

    try {
      session.client.disconnectEvents()
      const nextEventStreamGeneration = this.nextEventStreamGeneration()
      session.eventStreamGeneration = nextEventStreamGeneration
      nextUnsubEvent = this.attachClient(sessionKey, session.client, session.window, nextEventStreamGeneration)
      session.unsubEvent = nextUnsubEvent
      previousUnsubEvent()
      session.client.connectEvents(session.lastEventSeq)
      session.lastEventStreamRebindAt = now
      session.eventStreamRebinds = (session.eventStreamRebinds || 0) + 1

      this.emitEventStreamDiagnostic(sessionKey, session.window, {
        projectId: session.projectId,
        status: 'rebound',
        reason,
        at: Date.now(),
        reconnects: session.eventStreamRebinds,
        ...(session.lastEventSeq !== undefined ? { seq: session.lastEventSeq } : {}),
        ...(session.lastEventId ? { eventId: session.lastEventId } : {})
      })
    } catch (err) {
      this.emitEventStreamDiagnostic(sessionKey, session.window, {
        projectId: session.projectId,
        status: 'rebind-error',
        reason,
        at: Date.now(),
        error: toErrorMessage(err),
        reconnects: session.eventStreamRebinds || 0
      })
      if (!nextUnsubEvent) {
        session.eventStreamGeneration = previousEventStreamGeneration
        session.unsubEvent = previousUnsubEvent
      }
    }
  }

  async reconcileMessages(input: BrokerReconcileMessagesInput): Promise<BrokerReconciledChatMessage[]> {
    const projectId = input.projectId.trim()
    if (!projectId) throw new Error('Project id is required')
    if (input.kind === 'channel' && !input.channelName?.trim()) {
      throw new Error('Channel name is required for channel reconciliation')
    }
    if (input.kind === 'dm' && !input.conversationId?.trim()) {
      throw new Error('Conversation id is required for DM reconciliation')
    }

    const [session] = await this.getOrAwaitSessionsForProject(projectId)
    if (!session) return []

    const metadata = await session.client.getSession()
    const workspaceKey = metadata.workspace_key
    if (!workspaceKey) {
      throw new Error('Broker session does not expose a Relay workspace key')
    }

    const relay = new AgentRelay({
      workspaceKey,
      ...(process.env.RELAY_BASE_URL ? { baseUrl: process.env.RELAY_BASE_URL } : {})
    })
    const limit = normalizeReconcileLimit(input.limit)
    const messages = input.kind === 'channel'
      ? await relay.messages.list(input.channelName!, { limit })
      : await relay.messages.listDirect({ conversationId: input.conversationId!, limit })

    const normalized = messages
      .map((message) => normalizeRelayMessageForChat(message, input))
      .filter((message): message is BrokerReconciledChatMessage => message !== null)
      .sort((left, right) => left.timestamp - right.timestamp)

    if (isBrokerDebugEnabled()) {
      console.info('[broker:reconcile]', {
        projectId,
        kind: input.kind,
        channelName: input.channelName,
        conversationId: input.conversationId,
        requested: limit,
        returned: normalized.length
      })
    }

    return normalized
  }

  private attachClient(
    sessionKey: string,
    client: AgentRelayClient,
    win: BrowserWindow | undefined,
    eventStreamGeneration: number
  ): () => void {
    const projectId = projectIdFromSessionKey(sessionKey)
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
        const session = this.sessions.get(sessionKey)
        const lineage = session ? this.resolveLineageEntry(session, ctx.input) : undefined
        return getPearBurnSpawnEnrichment(projectId, ctx.input, lineage)
      }
    }) as Parameters<typeof client.addListener<'beforeAgentSpawn'>>[1]
    const unsubBurn = client.addListener('beforeAgentSpawn', burnHandler)

    const unsubEvent = client.onEvent((event: BrokerEvent) => {
      const session = this.sessions.get(sessionKey)
      if (!session || session.eventStreamGeneration !== eventStreamGeneration) {
        return
      }
      this.noteBrokerEventReceipt(sessionKey, event)
      // Fast path for PTY chunks: ship just (projectId, name, chunk) over a
      // dedicated channel so typing latency doesn't pay for compactBrokerEvent,
      // the broker:event metadata spread, or pushing into eventHistory per
      // character. Activity bookkeeping (rememberAgentSession + cloud sandbox
      // observers) still runs.
      if (
        event.kind === 'worker_stream' &&
        'name' in event && typeof event.name === 'string' &&
        'chunk' in event && typeof event.chunk === 'string'
      ) {
        if (this.isDuplicatePtyChunk(sessionKey, event.name, event)) {
          return
        }
        const targetWindow = this.windowForSession(sessionKey, win)
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('broker:pty-chunk', projectId, event.name, event.chunk)
        }
        this.rememberAgentSession(event.name, sessionKey)
        if (this.sessions.get(sessionKey)?.cloudSandboxId) {
          for (const observer of Array.from(this.eventObservers)) {
            observer(projectId, event)
          }
        }
        return
      }

      this.publishBrokerEvent(sessionKey, projectId, win, event as unknown as BrokerEventRecordPayload)

      if (event.kind === 'agent_spawned' && event.name) {
        this.rememberAgentSession(event.name, sessionKey)
        if (event.parent) {
          void this.handleSpawnedChildLineage(sessionKey, event)
        }
      } else if (event.kind === 'agent_exit' && event.name) {
        this.closeInputStream(this.getInputStreamKey(sessionKey, event.name), 1000, 'agent closed')
        this.forgetAgentSession(event.name, sessionKey)
        void client.release(event.name, 'agent exit').catch((err) => {
          if (!isMissingAgentError(err)) {
            console.warn(`[broker] Failed to release exited agent ${event.name}:`, err)
          }
        })
      } else if ((event.kind === 'agent_exited' || event.kind === 'agent_released') && event.name) {
        this.closeInputStream(this.getInputStreamKey(sessionKey, event.name), 1000, 'agent closed')
        this.forgetAgentSession(event.name, sessionKey)
      } else if ('name' in event && typeof event.name === 'string') {
        this.rememberAgentSession(event.name, sessionKey)
      } else if ('from' in event && typeof event.from === 'string') {
        this.rememberAgentSession(event.from, sessionKey)
      }

      // Fan out cloud-sandbox events to CloudAgentManager (which observes them
      // to track sandbox/agent activity for its mount + restart logic).
      if (this.sessions.get(sessionKey)?.cloudSandboxId) {
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

  private nextEventStreamGeneration(): number {
    this.eventStreamGenerationCounter += 1
    return this.eventStreamGenerationCounter
  }

  private isDuplicatePtyChunk(sessionKey: string, name: string, event: BrokerEvent): boolean {
    const now = Date.now()
    for (const [key, seenAt] of this.recentPtyChunks) {
      const ttl = key.startsWith('chunk:')
        ? PTY_CHUNK_CONTENT_DEDUPE_TTL_MS
        : PTY_CHUNK_IDENTITY_DEDUPE_TTL_MS
      if (
        now - seenAt > ttl ||
        this.recentPtyChunks.size > MAX_PTY_CHUNK_DEDUPE_ENTRIES
      ) {
        this.recentPtyChunks.delete(key)
      }
    }

    const eventRecord = event as Record<string, unknown>
    const seq = typeof eventRecord.seq === 'number' || typeof eventRecord.seq === 'string'
      ? String(eventRecord.seq)
      : ''
    const eventId = typeof eventRecord.event_id === 'string'
      ? eventRecord.event_id
      : typeof eventRecord.id === 'string'
        ? eventRecord.id
        : ''
    const identity = eventId || (seq ? `seq:${seq}` : '')
    const chunk = typeof eventRecord.chunk === 'string' ? eventRecord.chunk : ''
    if (!identity && !chunk) return false

    const contentKeyPrefix = `chunk:${sessionKey}:${name}:`
    const key = identity
      ? `identity:${sessionKey}:${name}:${identity}`
      : `${contentKeyPrefix}${chunk}`
    const ttl = identity
      ? PTY_CHUNK_IDENTITY_DEDUPE_TTL_MS
      : PTY_CHUNK_CONTENT_DEDUPE_TTL_MS
    const previous = this.recentPtyChunks.get(key)
    if (previous !== undefined && now - previous <= ttl) {
      return true
    }

    if (!identity) {
      for (const previousKey of this.recentPtyChunks.keys()) {
        if (previousKey.startsWith(contentKeyPrefix)) {
          this.recentPtyChunks.delete(previousKey)
        }
      }
    }
    this.recentPtyChunks.set(key, now)
    return false
  }

  private publishBrokerEvent(
    sessionKey: string,
    projectId: string,
    win: BrowserWindow | undefined,
    event: BrokerEventRecordPayload
  ): BrokerEventRecord {
    const record = this.recordBrokerEvent(projectId, event)
    const targetWindow = this.windowForSession(sessionKey, win)
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send('broker:event', {
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

  private rememberAgentSession(name: string, sessionKey: string): void {
    const sessionKeys = this.agentSessions.get(name) || new Set<string>()
    sessionKeys.add(sessionKey)
    this.agentSessions.set(name, sessionKeys)
  }

  private forgetAgentSession(name: string, sessionKey: string): void {
    const sessionKeys = this.agentSessions.get(name)
    if (!sessionKeys) return
    sessionKeys.delete(sessionKey)
    if (sessionKeys.size === 0) {
      this.agentSessions.delete(name)
    }
  }

  private getInputStreamKey(sessionKey: string, name: string): string {
    return `${sessionKey}:${name}`
  }

  // Returns the input stream for an agent plus whether it is *ready* to send on
  // (the broker has acked pty_input_ready). The WS handshake runs in the
  // background and is never awaited here, so a keystroke is never blocked on the
  // up-to-10s open timeout — callers send over HTTP until `ready` flips true.
  private ensureInputStream(
    session: BrokerSession,
    name: string
  ): { stream: PtyInputStream; ready: boolean } {
    const key = this.getInputStreamKey(sessionKeyFor(session), name)
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
          this.inputStreamFallbacks.delete(key)
          this.inputStreamFallbackRetryAt.delete(key)
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
        // after a few failures, ride HTTP briefly, then retry. Cloud terminals
        // can stay mounted across focus changes, so attachTerminal is not the
        // only reliable signal that the fast path should get another chance.
        // This is the one case worth surfacing: transient not-ready is normal,
        // but a *persistently* unopenable stream means the low-latency fast path
        // is off for this agent — log it once rather than hiding it.
        if (failures >= MAX_INPUT_STREAM_OPEN_FAILURES && !this.inputStreamFallbacks.has(key)) {
          console.warn(
            `[broker] PTY input stream for ${name} failed to open ${failures}x; ` +
            `routing input over HTTP for this agent and retrying PTY stream shortly`
          )
        }
        if (failures >= MAX_INPUT_STREAM_OPEN_FAILURES) {
          this.inputStreamFallbacks.add(key)
          this.inputStreamFallbackRetryAt.set(key, Date.now() + INPUT_STREAM_FALLBACK_RETRY_MS)
        }
      }
    )
    return { stream, ready: false }
  }

  private refreshExpiredInputStreamFallback(key: string): void {
    const retryAt = this.inputStreamFallbackRetryAt.get(key)
    if (retryAt === undefined || Date.now() < retryAt) return
    this.inputStreamFallbacks.delete(key)
    this.inputStreamFallbackRetryAt.delete(key)
    this.inputStreamOpenFailures.delete(key)
  }

  private closeInputStream(key: string, code = 1000, reason = 'closed'): void {
    const stream = this.inputStreams.get(key)
    this.inputStreams.delete(key)
    this.inputStreamReady.delete(key)
    this.inputStreamFallbacks.delete(key)
    this.inputStreamFallbackRetryAt.delete(key)
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
    this.inputStreamFallbackRetryAt.delete(key)
    this.inputStreamOpenFailures.delete(key)
  }

  private closeInputStreamsForSession(sessionKey: string): void {
    const prefix = `${sessionKey}:`
    for (const key of Array.from(this.inputStreams.keys())) {
      if (key.startsWith(prefix)) {
        this.closeInputStream(key, 1000, 'project closed')
      }
    }
    for (const key of Array.from(this.inputStreamFallbacks)) {
      if (key.startsWith(prefix)) this.inputStreamFallbacks.delete(key)
    }
    for (const key of Array.from(this.inputStreamFallbackRetryAt.keys())) {
      if (key.startsWith(prefix)) this.inputStreamFallbackRetryAt.delete(key)
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
    spawnInput: SpawnPtyInput & { broker?: 'local' | 'cloud' },
    options: { parentAgentName?: string } = {}
  ): Promise<{ name: string; runtime: string }> {
    const requestKey = spawnRequestKey(projectId, spawnInput, options)
    const inFlight = this.inFlightSpawnRequests.get(requestKey)
    if (inFlight) return inFlight

    let promise!: Promise<{ name: string; runtime: string }>
    promise = this.spawnAgentOnce(projectId, spawnInput, options).finally(() => {
      if (this.inFlightSpawnRequests.get(requestKey) === promise) {
        this.inFlightSpawnRequests.delete(requestKey)
      }
    })
    this.inFlightSpawnRequests.set(requestKey, promise)
    return promise
  }

  private async spawnAgentOnce(
    projectId: string,
    spawnInput: SpawnPtyInput & { broker?: 'local' | 'cloud' },
    options: { parentAgentName?: string } = {}
  ): Promise<{ name: string; runtime: string }> {
    // `broker` selects which of the project's sessions the agent spawns on.
    // Default: local-first via getSessionForProject (cloud only when no local
    // broker is running, preserving the cloud-only flow).
    const { broker: requestedBroker, ...input } = spawnInput
    const session = requestedBroker
      ? this.getSessionForBroker(projectId, requestedBroker)
      : this.getSessionForProject(projectId)
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

    // Dedupe names across BOTH of the project's sessions — local and cloud
    // brokers join the same relay workspace, so a name collision between them
    // would collide on the relay even though each broker accepts it locally.
    const existingNames = new Set(
      (await session.client.listAgents()).map((agent) => agent.name)
    )
    for (const sibling of this.sessionsForProject(session.projectId)) {
      if (sibling === session) continue
      const siblingAgents = await sibling.client.listAgents().catch(() => [])
      for (const agent of siblingAgents) existingNames.add(agent.name)
    }
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
        this.rememberAgentSession(spawnedName, sessionKeyFor(session))
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
        this.rememberAgentSession(spawned.name || nextInput.name, sessionKeyFor(session))
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

  // Resolve which of the project's sessions actually has `name` registered,
  // polling every candidate until the registration deadline. With a local +
  // cloud session pair the ownership map may not know a freshly-spawned agent
  // yet, and defaulting to the wrong broker makes every downstream call burn
  // its full agent_not_found retry budget (~7.5s each) before failing — the
  // "switching to a cloud agent terminal is painfully slow" symptom. Probing
  // both brokers up front attaches to the right one in a single round-trip.
  private async locateSessionForAgent(
    name: string,
    projectId?: string
  ): Promise<{ session: BrokerSession; registered: boolean }> {
    const fallback = this.getSessionForAgent(name, projectId)
    const candidates = projectId?.trim() ? this.sessionsForProject(projectId) : [fallback]
    if (candidates.length <= 1) {
      return { session: fallback, registered: await this.waitForAgentRegistration(fallback, name) }
    }

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      for (const candidate of candidates) {
        const agents = await candidate.client.listAgents().catch(() => null)
        if (agents?.some((agent) => agent.name === name)) {
          this.rememberAgentSession(name, sessionKeyFor(candidate))
          return { session: candidate, registered: true }
        }
      }
      await delay(250)
    }
    return { session: fallback, registered: false }
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

    this.rememberAgentSession(stableAgent.name, sessionKeyFor(session))
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

    // Wait for the broker to register the worker — and resolve WHICH broker
    // owns it when the project runs local + cloud sessions side by side.
    // spawnAgent (used by the Conversations panel's Resume flow and Add Agent
    // dialog) returns as soon as the CLI process is forked, before the worker
    // has connected to the broker, so the renderer races: spawn → mount
    // terminal → attach → broker 404. claude --resume in particular reads
    // session history first and can take 10+ seconds to register.
    const { session, registered } = await this.locateSessionForAgent(name, projectId)
    const client = session.client
    // A re-attach (window reload, restart, tab re-open) is a fresh start for
    // this terminal — clear any stale HTTP-only fallback so the WS fast path
    // gets retried instead of being stuck on HTTP for the agent's lifetime.
    this.resetInputStreamFallback(this.getInputStreamKey(sessionKeyFor(session), name))
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
    const key = this.getInputStreamKey(sessionKeyFor(session), trimmedName)
    this.refreshExpiredInputStreamFallback(key)
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
      if (isBrokerUnreachableError(err)) return
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
      const key = this.getInputStreamKey(sessionKeyFor(session), trimmedName)
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
      if (projectId?.trim()) {
        await this.getOrAwaitSessionsForProject(projectId)
      }
      session = this.getSessionForAgent(trimmedName, projectId)
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

  async sendMessageAndWaitForDelivery(
    projectId: string | undefined,
    input: SendMessageInput,
    options: { timeoutMs?: number } = {}
  ): Promise<DeliveryConfirmationResult> {
    const session = input.to.startsWith('#')
      ? this.getSessionForProject(projectId || '')
      : this.getSessionForAgent(input.to, projectId)
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS)
    const observedEvents: BrokerEvent[] = []
    let eventId: string | undefined
    let targets: string[] = []
    let pendingTargets = new Set<string>()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveWait: (() => void) | undefined
    let rejectWait: ((error: Error) => void) | undefined

    const waitForConfirmation = new Promise<void>((resolve, reject) => {
      resolveWait = resolve
      rejectWait = reject
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        const pending = Array.from(pendingTargets)
        const targetSummary = pending.length > 0 ? ` (${pending.join(', ')})` : ''
        reject(new Error(`Timed out waiting for delivery confirmation for ${eventId || input.to}${targetSummary}`))
      }, timeoutMs)
    })

    const maybeComplete = (event: BrokerEvent): void => {
      if (settled || !eventId) return
      if (!isDeliveryEventForMessage(event, eventId, targets)) return
      const name = brokerEventString(event, 'name')

      if (
        event.kind === 'delivery_ack' ||
        event.kind === 'delivery_verified' ||
        event.kind === 'message_delivery_confirmed'
      ) {
        if (!name || pendingTargets.size === 0) {
          settled = true
          resolveWait?.()
          return
        }
        pendingTargets.delete(name)
        if (pendingTargets.size === 0) {
          settled = true
          resolveWait?.()
        }
        return
      }

      if (event.kind === 'delivery_failed' || event.kind === 'message_delivery_failed') {
        settled = true
        rejectWait?.(new Error(deliveryFailureMessage(event)))
      }
    }

    const unsubscribe = session.client.onEvent((event) => {
      observedEvents.push(event)
      maybeComplete(event)
    })

    try {
      const rawResult = await session.client.sendMessage(input) as unknown
      const result = isRecord(rawResult) ? rawResult : {}
      eventId = typeof result.event_id === 'string' ? result.event_id : 'unsupported_operation'
      const reportedTargets = Array.isArray(result.targets)
        ? result.targets.filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
        : []
      targets = reportedTargets.length > 0 || input.to.startsWith('#')
        ? reportedTargets
        : [input.to]
      pendingTargets = new Set(targets)
      if (targets.length === 0 || eventId === 'unsupported_operation') {
        settled = true
        return { eventId, targets }
      }
      for (const event of observedEvents) {
        maybeComplete(event)
        if (settled) break
      }
      await waitForConfirmation
      return { eventId, targets }
    } finally {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
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
    this.closeInputStream(this.getInputStreamKey(sessionKeyFor(session), trimmedName), 1000, 'agent released')
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
    brokerKind?: 'local' | 'cloud'
  }>> {
    const sessions = projectId
      ? await this.getOrAwaitSessionsForProject(projectId)
      : (await Promise.all(
          Array.from(new Set([
            ...Array.from(this.sessions.keys()),
            ...Array.from(this.revivePromises.keys()),
            ...Array.from(this.startPromises.keys())
          ].map(projectIdFromSessionKey))).map((id) =>
            this.getOrAwaitSessionsForProject(id).catch(() => [] as BrokerSession[])
          )
        )).flat()
    // degradeOnTimeout stays false: a below-threshold timeout rethrows so the
    // renderer keeps its stale agent list rather than flickering to empty. A
    // dead/unrecoverable broker still degrades to [] for that one project so a
    // single bad session can't fail the whole call.
    const results = await Promise.all(
      sessions.map((session) =>
        this.withWedgeRecovery<Array<ListAgent & {
          projectId: string
          inboundDeliveryMode?: InboundDeliveryMode
          brokerKind?: 'local' | 'cloud'
        }>>(
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
    brokerKind?: 'local' | 'cloud'
  }>> {
    const agents = await session.client.listAgents()
    // A successful poll means the broker is answering again — clear any wedge
    // streak so a future timeout starts counting from zero.
    this.brokerTimeoutCounts.delete(`${session.projectId}:listAgents`)
    const sessionKey = sessionKeyFor(session)
    for (const agent of agents) {
      this.rememberAgentSession(agent.name, sessionKey)
    }
    const brokerKind = session.cloudSandboxId ? ('cloud' as const) : ('local' as const)
    return Promise.all(
      agents.map(async (agent) => {
        const inboundDeliveryMode = await session.client.getInboundDeliveryMode(agent.name).catch(() => undefined)
        return { ...agent, projectId: session.projectId, inboundDeliveryMode, brokerKind }
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
          ...Array.from(this.sessions.values()).map((session) => session.projectId),
          ...Array.from(this.revivePromises.keys())
        ]))
    for (const targetProjectId of targetProjectIds) {
      this.revivePromises.delete(targetProjectId)
      const sessions = this.sessionsForProject(targetProjectId)
      for (const session of sessions) {
        try {
          await session.client.shutdown()
        } catch {
          // Ignore shutdown errors.
        }
        this.dropSession(sessionKeyFor(session), { disconnectOnly: false })
      }
      if (!sessions.length) {
        // No live session — still clear any residual stream/timeout state.
        this.dropSession(targetProjectId, { disconnectOnly: false })
      }
    }
  }

  private clearBrokerTimeoutCountsForProject(projectId: string): void {
    for (const key of Array.from(this.brokerTimeoutCounts.keys())) {
      if (key.startsWith(`${projectId}:`)) {
        this.brokerTimeoutCounts.delete(key)
      }
    }
  }

  private dropSession(sessionKey: string, options: { disconnectOnly: boolean }): void {
    this.closeInputStreamsForSession(sessionKey)
    this.clearBrokerTimeoutCountsForProject(projectIdFromSessionKey(sessionKey))

    const session = this.sessions.get(sessionKey)
    if (!session) return

    session.unsubEvent()
    if (session.leaseTimer) clearInterval(session.leaseTimer)
    if (options.disconnectOnly) {
      const disconnect = (session.client as { disconnect?: () => void }).disconnect
      if (typeof disconnect === 'function') {
        disconnect.call(session.client)
      }
    }
    this.sessions.delete(sessionKey)
    for (const [agentName, sessionKeys] of Array.from(this.agentSessions.entries())) {
      sessionKeys.delete(sessionKey)
      if (sessionKeys.size === 0) {
        this.agentSessions.delete(agentName)
      }
    }
  }

  async detachCloudSandbox(projectId: string): Promise<void> {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return
    const sessionKey = cloudSessionKey(normalizedProjectId)
    const session = this.sessions.get(sessionKey)
    if (!session) return
    try {
      await session.client.shutdown()
    } catch {
      // Ignore shutdown errors.
    }
    this.dropSession(sessionKey, { disconnectOnly: false })
    // Only report the project as disconnected when nothing is left serving
    // it — a still-running local broker keeps the project connected.
    if (!this.sessionsForProject(normalizedProjectId).length) {
      this.sendStatusToWindow(session.window, normalizedProjectId, 'disconnected')
    }
  }

  private sendStatus(projectId: string, status: string, error?: string): void {
    const session = this.sessionsForProject(projectId).find((candidate) => candidate.window)
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
