// Shared IPC types — the single source of truth for what crosses the
// preload bridge. Both src/preload/index.ts (the implementation) and
// src/renderer/src/lib/ipc.ts (the consumer-facing re-export) import from
// here. The preload uses `satisfies PearAPI` to enforce that the
// implementation matches this surface.
import type { FactoryConfig } from '@agent-relay/factory'

export type ViewMode =
  | 'terminal'
  | 'chat'
  | 'project-settings'
  | 'account-settings'
  | 'broker-details'
  | 'source-control'
  | 'ai-hist'
  | 'burn-session'
  | 'burn-project'
  | 'burn-session-detail'
  | 'factory'

export type TerminalAttachMode = 'view' | 'drive' | 'passthrough'
export type InboundDeliveryMode = 'auto_inject' | 'manual_flush'
export type MessageInjectionMode = 'wait' | 'steer'
export type AgentCurrentState = 'working' | 'idle' | 'blocked_on_send'

export type AiHistSource = 'claude' | 'codex' | 'cursor' | 'relay'

export interface AiHistEntry {
  id: number
  source: AiHistSource
  sessionId: string | null
  project: string | null
  prompt: string
  timestampMs: number
}

export interface AiHistSession {
  sessionId: string
  source: AiHistSource
  project: string | null
  firstPrompt: string
  firstActivityMs: number
  lastActivityMs: number
  promptCount: number
}

export interface AiHistStats {
  total: number
  bySource: Partial<Record<AiHistSource, number>>
  byProject: Array<{ project: string; count: number }>
  firstTimestampMs: number | null
  lastTimestampMs: number | null
}

export interface BurnAgentInput {
  projectId?: string
  name: string
  cwd?: string
  cli?: string
  force?: boolean
}

export interface BurnAgentSummary {
  projectId?: string
  name: string
  agentKey: string
  totalTokens: number
  totalCost: number
  turnCount: number
  byModel: Array<{ model: string; tokens: number; cost: number }>
  byTool: Array<{ tool: string; tokens: number; cost: number; count: number }>
  sessionIds: Array<{ sessionId: string; ts?: string }>
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnHotspotMcpServer {
  server: string
  callCount: number
  initialTokens: number
  persistenceTokens: number
  ridingTurns: number
  totalCost: number
  topTools: string[]
}

export interface BurnHotspotsBreakdown {
  sessionId?: string
  grandTotal: number
  attributedTotal: number
  unattributedTotal: number
  attributionDegraded: boolean
  files: Array<{ path: string; initialTokens: number; persistenceTokens: number; ridingTurns: number; totalCost: number }>
  bashVerbs: Array<{ verb: string; callCount: number; distinctCommands: number; initialTokens: number; persistenceTokens: number; avgPersistenceTurns: number; totalCost: number; topExamples: string[] }>
  bash: Array<{ command?: string; callCount: number; initialTokens: number; persistenceTokens: number; totalCost: number }>
  subagents: Array<{ subagentType: string; callCount: number; initialTokens: number; persistenceTokens: number; totalCost: number }>
  mcpServers: BurnHotspotMcpServer[]
}

export interface BurnHotspotInsight {
  kind: 'file' | 'bash' | 'mcp' | 'subagent'
  label: string
  totalCost: number
  ridingTurns?: number
  detail?: string
}

export interface BurnAgentBreakdown extends BurnAgentSummary {
  primarySessionId?: string
  hotspots?: BurnHotspotsBreakdown
}

export interface BurnSessionBreakdownInput { sessionId: string; force?: boolean }

export interface BurnSessionBreakdown {
  sessionId: string
  agent?: BurnSessionAgentRef
  totalTokens: number
  totalCost: number
  turnCount: number
  models: string[]
  hotspots?: BurnHotspotsBreakdown
  insights: BurnHotspotInsight[]
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnFingerprintInput { sessionId?: string; projectId?: string }

export interface BurnProjectOverhead {
  projectId: string
  project?: string
  grandTotal: number
  perSessionTotal: number
  recommendations: Array<{ file: string; heading: string; perSessionUsd: number; tokens: number }>
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnSessionAgentRef {
  projectId?: string
  name: string
  agentKey: string
  cli?: string
  cwd?: string
}

export interface BurnSessionLookup {
  sessionId: string
  totalTokens: number
  totalCost: number
  turnCount: number
  agent?: BurnSessionAgentRef
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnProjectInput {
  projectId: string
  force?: boolean
}

export interface BurnProjectAgentRollup {
  name: string
  agentKey: string
  totalTokens: number
  totalCost: number
  turnCount: number
  sessionCount: number
  cli?: string
  cwd?: string
  lastTs?: string
}

export interface BurnProjectBreakdown {
  projectId: string
  totalTokens: number
  totalCost: number
  turnCount: number
  byModel: Array<{ model: string; tokens: number; cost: number }>
  byTool: Array<{ tool: string; tokens: number; cost: number; count: number }>
  byAgent: BurnProjectAgentRollup[]
  sessionIds: Array<{ sessionId: string; ts?: string }>
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

export interface PendingRelayMessage {
  from: string
  body: string
  target: string
  thread_id?: string
  project_id?: string
  project_alias?: string
  priority: number
  mode: MessageInjectionMode
  queued_at_ms: number
  event_id?: string
}

export interface BrokerReconciledChatMessage {
  id: string
  kind?: 'message' | 'notice'
  from: string
  to: string
  body: string
  timestamp: number
  isHuman: boolean
  projectId?: string
  conversationId?: string
  reactions?: Array<{
    emoji: string
    count: number
    reactedByHuman: boolean
  }>
  threadReplies?: Array<{
    id: string
    from: string
    body: string
    timestamp: number
    isHuman: boolean
    projectId?: string
  }>
}

export interface BrokerReconcileMessagesInput {
  projectId: string
  kind: 'channel' | 'dm'
  channelName?: string
  conversationId?: string
  dmParticipants?: string[]
  limit?: number
}

export interface BrokerEventStreamDiagnostic {
  projectId: string
  status: 'received' | 'rebind-started' | 'rebound' | 'rebind-skipped' | 'rebind-error'
  reason?: string
  at: number
  eventKind?: string
  eventId?: string
  seq?: number
  reconnects?: number
  error?: string
}

export interface BrokerListAgent {
  name: string
  projectId: string
  runtime?: string
  cli?: string
  model?: string
  channels?: string[]
  parent?: string
  pid?: number
  last_activity_at?: string
  last_activity_ms?: number
  current_state?: AgentCurrentState
  inboundDeliveryMode?: InboundDeliveryMode
}

export interface BrokerAgentDetails {
  name: string
  runtime: string
  cli?: string
  model?: string
  channels: string[]
  parent?: string
  pid?: number
  currentState?: AgentCurrentState
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
  event: Record<string, unknown> & {
    kind?: string
    projectId?: string
  }
}

export interface BrokerSpawnAgentInput {
  name: string
  cli: string
  model?: string
  task?: string
  channels?: string[]
  cwd?: string
  args?: string[]
  /**
   * Which of the project's broker sessions to spawn on when both a local
   * broker and a cloud sandbox are attached. Defaults to the local broker
   * (or the cloud session when it is the only one running).
   */
  broker?: 'local' | 'cloud'
}

export interface BrokerSpawnAgentResult {
  name: string
  runtime: string
  cli?: string
}

export interface WorkforcePersona {
  id: string
  description?: string
  harness?: string
  tags?: string[]
  source?: string
}

export interface BrokerAttachTerminalInput {
  projectId?: string
  name: string
  rows?: number
  cols?: number
  mode?: TerminalAttachMode
}

export interface BrokerAttachTerminalResult {
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

export interface BrokerSetTerminalModeResult {
  name: string
  mode: InboundDeliveryMode
  flushed: number
  pending: number
}

export type BrokerTerminalSnapshotFormat = 'plain' | 'ansi'

export interface BrokerTerminalSnapshot {
  rows: number
  cols: number
  cursor: [number, number]
  /** Row text for `plain`; decoded ANSI reproduction byte stream for `ansi`. */
  screen: string
}

export interface BrokerSendMessageInput {
  to: string
  text: string
  from?: string
}

export interface BrokerStatusEvent {
  projectId?: string
  status: string
  error?: string
}

export type FactoryNodeConfig = Pick<
  FactoryConfig,
  'capabilities' | 'clonePaths' | 'dryRun'
> & Partial<Pick<FactoryConfig, 'workspaceId' | 'cloneRoot'>>

export interface FactoryConfigReadResult {
  configPath: string
  exists: boolean
  config: FactoryNodeConfig | null
  errors: string[]
  warning?: string
}

export interface FactoryAgentStatus {
  id?: string
  name: string
  role?: string
  status?: string
  issue?: {
    key: string
    path?: string
    title?: string
    url?: string
  }
}

export interface FactoryIssueStatus {
  key: string
  title?: string
  url?: string
  state?: string
  repo?: string
  assignee?: string
  updatedAt?: string
}

export interface FactoryStatus {
  source: 'cloud'
  state: 'unauthenticated' | 'unconfigured' | 'online' | 'empty' | 'unavailable'
  connected: boolean
  workspaceId?: string
  cloudUrl?: string
  updatedAt?: string
  message?: string
  counters?: Record<string, number>
  agents: FactoryAgentStatus[]
  issues: FactoryIssueStatus[]
}

export type GitFileStatusKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface GitFileStatus {
  path: string
  oldPath?: string
  status: GitFileStatusKind
  staged: boolean
  conflicted?: boolean
}

export interface GitSummary {
  branch: string
  additions: number
  deletions: number
}

export interface GitHistoryFile {
  path: string
  oldPath?: string
  status: string
}

export interface GitHistoryCoAuthor {
  name: string
  email: string
  avatarUrl?: string
  cachedAvatarUrl?: string
}

export interface GitHistoryCommit {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  authorAvatarUrl?: string
  authorCachedAvatarUrl?: string
  coAuthors: GitHistoryCoAuthor[]
  date: string
  subject: string
  body: string
  tags: string[]
  additions: number
  deletions: number
  files: GitHistoryFile[]
}

export interface GitCommitDraft {
  title: string
  body: string
}

export interface GitCommitSelectionInput {
  title: string
  body?: string
  wholeFiles: string[]
  patch?: string
}

export interface GitGenerateCommitMessageInput {
  wholeFiles: string[]
  patch?: string
}

export interface GitBranchInfo {
  name: string
  current: boolean
  remote: boolean
  lastCommitDate: string
  defaultBranch: boolean
}

export interface GitBranchSyncStatus {
  branch: string
  remote: string | null
  upstream: string | null
  ahead: number
  behind: number
  hasRemote: boolean
}

export interface GitCheckoutBranchOptions {
  stashChanges?: boolean
}

export interface GitPullRequest {
  rootPath: string
  branch: string
  owner: string
  repo: string
  number: number
  url: string
  mergeState: 'mergeable' | 'blocked' | 'unknown'
  ciState: 'passing' | 'failing' | 'pending' | 'unknown'
  title?: string
}

export interface FsDirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

export interface FsReadPreviewResult {
  kind: 'text' | 'binary' | 'too-large' | 'missing'
  content: string
  size: number
}

export type CloudAgentRecord = {
  id: string
  name: string
  displayName?: string
  harness: string
  defaultModel: string
  status: 'ready' | 'warming' | 'error' | 'stopped'
  lastUsedAt?: string
  lastError?: string
  lastAuthenticatedAt?: string | null
}

export type CreateCloudAgentInput = {
  name: string
  harness: string
  model: string
}

export type CloudAgentSandboxStatus = 'warming' | 'ready' | 'failed' | 'stopping' | 'stopped'
export type CloudAgentSandboxPhase = 'queued' | 'pulling-image' | 'starting' | 'cloning' | 'mounting' | 'ready'

export type CloudAgentBinding = {
  projectId: string
  cloudAgentId: string
  sandboxId: string
  relayfileMountPath: string
  attachedAt: string
}

export type CloudAgentMountStatus = {
  ready: boolean
  lastReconcileAt?: string
  pendingWrites: number
  conflicts: number
}

export type CloudAgentSyncMode = 'sandbox-priority' | 'local-priority'

export type CloudAgentStatus = {
  binding: CloudAgentBinding
  sandbox: { id: string; status: CloudAgentSandboxStatus; phase?: CloudAgentSandboxPhase; etaMs?: number }
  mount: CloudAgentMountStatus
  syncMode: CloudAgentSyncMode
}

export type CloudAgentEvent =
  | { type: 'sandbox-status'; projectId: string; status: CloudAgentSandboxStatus; phase?: CloudAgentSandboxPhase; etaMs?: number }
  | { type: 'mount-status'; projectId: string; mount: CloudAgentMountStatus }
  | { type: 'sync-mode-changed'; projectId: string; syncMode: CloudAgentSyncMode }
  | { type: 'error'; projectId: string; message: string }

export type ProactiveAgentHarness = 'claude' | 'codex' | 'opencode' | 'grok'
export type ProactiveAgentStatus = 'draft' | 'warming' | 'active' | 'paused' | 'error'
export type ProactiveAgentRunStatus = 'running' | 'succeeded' | 'failed'
export type ProactiveAgentRunMode = 'cloud' | 'local'
export type ProactiveAgentWatchEventKind = 'created' | 'updated' | 'deleted'

export type ProactiveAgentDraft = {
  id: string
  name: string
  description?: string
  cloudAgentId: string
  harness: ProactiveAgentHarness
  model: string
  systemPrompt: string
  integrations: Record<string, Record<string, unknown>>
  watch: Array<{
    paths: string[]
    events: ProactiveAgentWatchEventKind[]
    debounceMs?: number
    match?: string
  }>
  handlerCode: string
  inputs?: Record<string, string>
  memory?: { enabled: boolean; scopes?: Array<'workspace' | 'project' | 'persona'>; ttlDays?: number }
  harnessSettings?: { reasoning?: 'low' | 'medium' | 'high'; timeoutSeconds?: number }
  mount?: { enabled: boolean }
  runMode?: ProactiveAgentRunMode
}

export type ProactiveAgentBinding = {
  projectId: string
  personaId: string
  cloudAgentId: string
  status: ProactiveAgentStatus
  lastError?: string
  lastFiredAt?: string
  createdAt: string
  updatedAt: string
  draft: ProactiveAgentDraft
}

export type ProactiveAgentRun = {
  runId: string
  projectId: string
  personaId: string
  firedAt: string
  trigger: {
    type: 'relayfile-change'
    path: string
    eventKind: ProactiveAgentWatchEventKind
  }
  durationMs?: number
  status: ProactiveAgentRunStatus
  summary?: string
  error?: string
}

export type ProactiveAgentTranscript = {
  runId: string
  projectId?: string
  personaId?: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    ts: string
  }>
}

export type ProactiveAgentRunsPage = {
  runs: ProactiveAgentRun[]
  nextCursor?: string
}

export type ProactiveAgentDeployResult = {
  status: 'active' | 'warming' | 'error'
  error?: string
}

export type ProactiveAgentRunsOptions = {
  limit?: number
  cursor?: string
}

export type ProactiveAgentEvent =
  | { type: 'binding-updated'; projectId: string; personaId: string; binding: ProactiveAgentBinding }
  | { type: 'binding-removed'; projectId: string; personaId: string }
  | { type: 'run-started'; projectId: string; personaId: string; run: ProactiveAgentRun }
  | { type: 'run-update'; projectId: string; personaId: string; runId: string; chunk: string }
  | { type: 'run-finished'; projectId: string; personaId: string; run: ProactiveAgentRun }

export type IntegrationAuthMethod = 'oauth' | 'token' | 'apikey'

export type IntegrationCapabilities = {
  webhook: boolean
  poll: boolean
  writeback: boolean
}

export type IntegrationAdapter = {
  provider: string
  displayName: string
  iconUrl?: string
  version: string
  capabilities: IntegrationCapabilities
  authMethod: IntegrationAuthMethod
  requiredScopes?: string[]
  defaultMountPaths: string[]
  description: string
}

export type ConnectedIntegration = {
  provider: string
  integrationId: string
  scope: Record<string, unknown>
  mountPaths: string[]
  connectedAt: string
  notifyAgent: boolean
  subscribeAgent?: boolean
  downloadHistoricalData?: boolean
  visibleInProject?: boolean
  localMountPaths?: string[]
  lastSyncAt?: string
  lastError?: string
}

export type IntegrationConnectStatus =
  | 'pending'
  | 'awaiting-user'
  | 'choosing-scope'
  | 'completed'
  | 'error'
  | 'expired'

export type IntegrationConnectSession = {
  sessionId: string
  provider: string
  status: IntegrationConnectStatus
  authUrl?: string
  scopeChoices?: Record<string, unknown>
  integrationId?: string
  error?: string
}

export type IntegrationOption = {
  value: string
  label: string
  hint?: string
}

export type IntegrationsEvent =
  | { type: 'session-update'; sessionId: string; session: IntegrationConnectSession }
  | { type: 'integration-added'; projectId: string; integration: ConnectedIntegration }
  | { type: 'integration-removed'; projectId: string; integrationId: string }
  | { type: 'integration-error'; projectId: string; integrationId: string; message: string }
  | { type: 'integrations-hydrated'; projectId: string }
  | { type: 'mount-auth-stall'; remotePath: string; status: string | null; pendingWriteback: number; message: string }
  | { type: 'integration-auth-required'; reason: 'cloud-auth-required' | 'account-workspace-required'; message: string }
  | { type: 'integration-auth-recovered' }

export type IntegrationAuthRecoveryState = {
  reason: 'cloud-auth-required' | 'account-workspace-required'
  since: number
  failureClass?: string
  message: string
}

export type IntegrationEventTelemetryCounters = {
  eventsReceived: number
  eventsInjected: number
  eventsCoalesced: number
  eventsDropped: number
  eventsSelfEchoSuppressed: number
  brokerSends: number
  brokerSendsDeferred: number
  queueDepth: number
  mountCount: number
  brokerSendQueueDepth: number
}

export type IntegrationEventTelemetrySnapshot = {
  totals: IntegrationEventTelemetryCounters
  projects: Record<string, IntegrationEventTelemetryCounters>
}

export interface AuthUser {
  name?: string
  email?: string
  githubUsername?: string
  username?: string
  avatarUrl?: string
  cachedAvatarUrl?: string
  organizationName?: string
  projectName?: string
}

export interface AuthStatus {
  loggedIn: boolean
  apiUrl?: string
  user?: AuthUser
}

export interface AuthLoginInput {
  apiUrl?: string
}

export interface AiHistRecentOptions {
  source?: string
  project?: string
  limit?: number
  beforeMs?: number
}

export interface AiHistStatusResult {
  ok: true
  dbPath: string
}

export interface AiHistStatusError {
  ok: false
  reason: string
}

export type AiHistStatusResponse = AiHistStatusResult | AiHistStatusError

export interface AiHistResumeEntry {
  source: string
  sessionId: string | null
  project: string | null
}

export interface ProjectListResult {
  projects: unknown[]
  activeId: string | null
}

/**
 * Snapshot of the main process's auto-update state, replayed to renderers that
 * subscribe after the originating event fired. `null` means idle / up to date.
 */
export type UpdaterState =
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

export interface ProjectRootConflict {
  kind: 'conflict'
  projectId: string
  existingProjectId: string
  existingProjectName: string
  path: string
}

export interface ProjectRootRecord {
  id: string
  name: string
  path: string
  pathExists?: boolean
}

export interface ProjectRootAdded {
  kind: 'added'
  root: ProjectRootRecord
}

export type AddRootResult = ProjectRootAdded | ProjectRootConflict

export interface ProjectIntegrationResult {
  id: string
  name: string
  type: string
  [key: string]: unknown
}

export interface PearAPI {
  app: {
    confirmQuit: () => Promise<boolean>
    notifyCliReady: () => void
  }
  project: {
    list: () => Promise<ProjectListResult>
    add: (name: string, rootPath?: string) => Promise<unknown>
    remove: (id: string) => Promise<void>
    setActive: (id: string | null) => Promise<void>
    update: (id: string, update: Record<string, unknown>) => Promise<void>
    addChannel: (projectId: string, name: string) => Promise<void>
    removeChannel: (projectId: string, name: string) => Promise<void>
    setChannelPeople: (projectId: string, channelName: string, people: string[]) => Promise<string[]>
    addRoot: (projectId: string, name?: string, rootPath?: string) => Promise<AddRootResult | null>
    removeRoot: (projectId: string, rootId: string) => Promise<void>
    createWorktreeRoot: (projectId: string, repoPath: string, projectName: string, name?: string) => Promise<ProjectRootRecord>
    addIntegration: (projectId: string, name: string, type?: string) => Promise<ProjectIntegrationResult>
    removeIntegration: (projectId: string, integrationId: string) => Promise<void>
  }
  broker: {
    start: (projectId: string, cwd: string, name: string, channels?: string[]) => Promise<boolean>
    syncChannels: (projectId: string, channels: string[]) => Promise<void>
    joinWorkspace: (
      projectId: string,
      cwd: string,
      name: string,
      channels: string[] | undefined,
      workspaceKey: string
    ) => Promise<void>
    autoFixRuntime: (
      projectId: string,
      cwd: string,
      name: string,
      channels?: string[],
      errorMessage?: string
    ) => Promise<{ removed: string[] }>
    connectCloud: () => Promise<string>
    spawnAgent: (projectId: string, input: BrokerSpawnAgentInput) => Promise<BrokerSpawnAgentResult>
    listPersonas: (projectId: string, cwd?: string) => Promise<WorkforcePersona[]>
    spawnPersona: (projectId: string, personaId: string) => Promise<BrokerSpawnAgentResult>
    attachTerminal: (input: BrokerAttachTerminalInput) => Promise<BrokerAttachTerminalResult>
    sendInput: (
      projectId: string | undefined,
      name: string,
      data: string
    ) => Promise<{ name: string; bytes_written: number }>
    sendInputFast: (projectId: string | undefined, name: string, data: string) => void
    setTerminalMode: (
      projectId: string | undefined,
      name: string,
      mode: TerminalAttachMode
    ) => Promise<BrokerSetTerminalModeResult>
    getPending: (projectId: string | undefined, name: string) => Promise<PendingRelayMessage[]>
    flushPending: (projectId: string | undefined, name: string) => Promise<{ flushed: number }>
    resizePty: (projectId: string | undefined, name: string, rows: number, cols: number) => Promise<void>
    snapshotTerminal: (
      projectId: string | undefined,
      name: string,
      format: BrokerTerminalSnapshotFormat
    ) => Promise<BrokerTerminalSnapshot | null>
    inputSrtt: (projectId: string | undefined, name: string) => Promise<number | null>
    sendMessage: (projectId: string | undefined, input: BrokerSendMessageInput) => Promise<void>
    reconcileMessages: (input: BrokerReconcileMessagesInput) => Promise<BrokerReconciledChatMessage[]>
    refreshEventStream: (projectId?: string, reason?: string) => Promise<void>
    subscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) => Promise<void>
    unsubscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) => Promise<void>
    releaseAgent: (projectId: string | undefined, name: string) => Promise<void>
    listAgents: (projectId?: string) => Promise<BrokerListAgent[]>
    checkCliAvailable: (cli: string) => Promise<boolean>
    listDetails: () => Promise<BrokerDetails[]>
    listEvents: () => Promise<BrokerEventRecord[]>
    shutdown: () => Promise<void>
    onEvent: (callback: (event: unknown) => void) => () => void
    onEventStreamDiagnostic: (callback: (event: BrokerEventStreamDiagnostic) => void) => () => void
    onPtyChunk: (callback: (projectId: string, name: string, chunk: string) => void) => () => void
    onStatus: (callback: (status: BrokerStatusEvent) => void) => () => void
  }
  factory: {
    status: () => Promise<FactoryStatus>
    readConfig: (configPath?: string, projectRoot?: string) => Promise<FactoryConfigReadResult>
    saveConfig: (config: unknown, configPath?: string, projectRoot?: string) => Promise<FactoryConfigReadResult>
  }
  burn: {
    listAgentSummaries: (agents: BurnAgentInput[]) => Promise<BurnAgentSummary[]>
    getAgentBreakdown: (agent: BurnAgentInput) => Promise<BurnAgentBreakdown>
    getProjectBreakdown: (input: BurnProjectInput) => Promise<BurnProjectBreakdown>
    lookupSessions: (sessionIds: string[]) => Promise<Record<string, BurnSessionLookup>>
    getSessionBreakdown: (input: BurnSessionBreakdownInput) => Promise<BurnSessionBreakdown>
    fingerprint: (input: BurnFingerprintInput) => Promise<{ fingerprint: string }>
    getProjectOverhead: (input: { projectId: string }) => Promise<BurnProjectOverhead>
  }
  git: {
    status: (path: string) => Promise<GitFileStatus[]>
    diff: (path: string, file?: string) => Promise<string>
    fileContent: (path: string, file: string, revision?: string) => Promise<string>
    summary: (path: string) => Promise<GitSummary | null>
    branches: (root: string) => Promise<string[]>
    branchDetails: (root: string) => Promise<GitBranchInfo[]>
    checkoutBranch: (
      root: string,
      branch: string,
      options?: GitCheckoutBranchOptions
    ) => Promise<GitBranchSyncStatus>
    branchSyncStatus: (root: string) => Promise<GitBranchSyncStatus>
    fetchRemote: (root: string) => Promise<GitBranchSyncStatus>
    pullCurrentBranch: (root: string) => Promise<GitBranchSyncStatus>
    pushCurrentBranch: (root: string) => Promise<GitBranchSyncStatus>
    activePullRequests: (roots: string[]) => Promise<GitPullRequest[]>
    history: (path: string, limit?: number) => Promise<GitHistoryCommit[]>
    show: (path: string, hash: string, file?: string) => Promise<string>
    discardFiles: (path: string, files: string[]) => Promise<void>
    addGitignorePatterns: (path: string, patterns: string[]) => Promise<void>
    commitSelection: (path: string, input: GitCommitSelectionInput) => Promise<{ hash: string }>
    generateCommitMessage: (
      projectId: string,
      path: string,
      input: GitGenerateCommitMessageInput
    ) => Promise<GitCommitDraft>
  }
  fs: {
    listDir: (dirPath: string) => Promise<FsDirEntry[]>
    readPreview: (filePath: string) => Promise<FsReadPreviewResult>
    revealPath: (filePath: string) => Promise<void>
  }
  auth: {
    login: (input?: AuthLoginInput) => Promise<AuthStatus>
    logout: () => Promise<void>
    status: () => Promise<AuthStatus>
  }
  cloudAgent: {
    list: () => Promise<CloudAgentRecord[]>
    create: (input: CreateCloudAgentInput) => Promise<CloudAgentRecord>
    delete: (id: string) => Promise<void>
    prewarm: (projectId: string, cloudAgentId: string) => Promise<void>
    cancelPrewarm: (projectId: string, cloudAgentId?: string) => Promise<void>
    attach: (projectId: string, cloudAgentId: string) => Promise<CloudAgentBinding>
    detach: (projectId: string) => Promise<void>
    status: (projectId: string) => Promise<CloudAgentStatus | null>
    onEvent: (callback: (event: CloudAgentEvent) => void) => () => void
  }
  proactiveAgent: {
    list: (projectId: string) => Promise<ProactiveAgentBinding[]>
    create: (projectId: string, draft: ProactiveAgentDraft) => Promise<ProactiveAgentBinding>
    update: (
      projectId: string,
      personaId: string,
      draft: ProactiveAgentDraft
    ) => Promise<ProactiveAgentBinding>
    deploy: (projectId: string, personaId: string) => Promise<ProactiveAgentDeployResult>
    pause: (projectId: string, personaId: string) => Promise<void>
    resume: (projectId: string, personaId: string) => Promise<void>
    undeploy: (projectId: string, personaId: string) => Promise<void>
    runs: (
      projectId: string,
      personaId: string,
      opts?: ProactiveAgentRunsOptions
    ) => Promise<ProactiveAgentRunsPage>
    runTranscript: (runId: string) => Promise<ProactiveAgentTranscript>
    onEvent: (callback: (event: ProactiveAgentEvent) => void) => () => void
  }
  integrations: {
    catalog: () => Promise<IntegrationAdapter[]>
    list: (projectId: string) => Promise<ConnectedIntegration[]>
    authRecoveryState: () => Promise<IntegrationAuthRecoveryState | null>
    telemetry: () => Promise<IntegrationEventTelemetrySnapshot>
    listMountDir: (projectId: string, integrationId: string, dirPath: string) => Promise<FsDirEntry[]>
    listRemoteDir: (projectId: string, remotePath: string) => Promise<FsDirEntry[]>
    readRemoteFile: (projectId: string, remotePath: string) => Promise<FsReadPreviewResult>
    writeRemoteFile: (projectId: string, remotePath: string, content: string) => Promise<void>
    readMountPreview: (projectId: string, integrationId: string, filePath: string) => Promise<FsReadPreviewResult>
    listOptions: (projectId: string, provider: string, resource: string) => Promise<IntegrationOption[]>
    startConnect: (projectId: string, provider: string) => Promise<IntegrationConnectSession>
    pollConnect: (sessionId: string) => Promise<IntegrationConnectSession>
    completeConnect: (
      projectId: string,
      sessionId: string,
      scope: Record<string, unknown>,
      mountPaths: string[],
      notifyAgent: boolean
    ) => Promise<ConnectedIntegration>
    updateScope: (
      projectId: string,
      integrationId: string,
      scope: Record<string, unknown>,
      mountPaths: string[]
    ) => Promise<ConnectedIntegration>
    updateSubscription: (
      projectId: string,
      integrationId: string,
      subscribeAgent: boolean
    ) => Promise<ConnectedIntegration>
    updateHistoricalDownload: (
      projectId: string,
      integrationId: string,
      downloadHistoricalData: boolean
    ) => Promise<ConnectedIntegration>
    disconnect: (projectId: string, integrationId: string) => Promise<void>
    onEvent: (callback: (event: IntegrationsEvent) => void) => () => void
  }
  aiHist: {
    status: () => Promise<AiHistStatusResponse>
    recent: (opts?: AiHistRecentOptions) => Promise<AiHistEntry[]>
    listSessions: (opts?: AiHistRecentOptions) => Promise<AiHistSession[]>
    getSession: (sessionId: string) => Promise<AiHistEntry[]>
    search: (query: string, opts?: AiHistRecentOptions) => Promise<AiHistEntry[]>
    searchSessions: (query: string, opts?: AiHistRecentOptions) => Promise<AiHistSession[]>
    stats: () => Promise<AiHistStats | null>
    resumeCommand: (entry: AiHistResumeEntry) => Promise<string | null>
    reload: () => Promise<void>
  }
  update: {
    getState: () => Promise<UpdaterState | null>
    download: () => Promise<void>
    install: () => Promise<void>
    onAvailable: (callback: (info: { version: string }) => void) => () => void
    onProgress: (callback: (info: { percent: number }) => void) => () => void
    onDownloaded: (callback: (info: { version: string }) => void) => () => void
    onError: (callback: (info: { message: string }) => void) => () => void
  }
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => () => void
}
