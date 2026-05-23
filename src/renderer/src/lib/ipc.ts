export type TerminalAttachMode = 'view' | 'drive' | 'passthrough'
export type InboundDeliveryMode = 'auto_inject' | 'manual_flush'
export type MessageInjectionMode = 'wait' | 'steer'
export type AgentCurrentState = 'working' | 'idle' | 'blocked_on_send'

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

export type GitFileStatusKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface GitFileStatus {
  path: string
  oldPath?: string
  status: GitFileStatusKind
  staged: boolean
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
  sandbox: { id: string; status: CloudAgentSandboxStatus }
  mount: CloudAgentMountStatus
  syncMode: CloudAgentSyncMode
}

export type CloudAgentEvent =
  | { type: 'sandbox-status'; projectId: string; status: CloudAgentSandboxStatus }
  | { type: 'mount-status'; projectId: string; mount: CloudAgentMountStatus }
  | { type: 'sync-mode-changed'; projectId: string; syncMode: CloudAgentSyncMode }
  | { type: 'error'; projectId: string; message: string }

export type ProactiveAgentHarness = 'claude' | 'codex' | 'opencode'
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

export type IntegrationsEvent =
  | { type: 'session-update'; sessionId: string; session: IntegrationConnectSession }
  | { type: 'integration-added'; projectId: string; integration: ConnectedIntegration }
  | { type: 'integration-removed'; projectId: string; integrationId: string }
  | { type: 'integration-error'; projectId: string; integrationId: string; message: string }

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

export interface PearAPI {
  app: {
    confirmQuit: () => Promise<boolean>
  }
  project: {
    list: () => Promise<{ projects: unknown[]; activeId: string | null }>
    add: (name: string, rootPath?: string) => Promise<unknown>
    remove: (id: string) => Promise<void>
    setActive: (id: string | null) => Promise<void>
    update: (id: string, update: Record<string, unknown>) => Promise<void>
    addChannel: (projectId: string, name: string) => Promise<void>
    removeChannel: (projectId: string, name: string) => Promise<void>
    setChannelPeople: (projectId: string, channelName: string, people: string[]) => Promise<string[]>
    addRoot: (projectId: string, name?: string, rootPath?: string) => Promise<unknown>
    removeRoot: (projectId: string, rootId: string) => Promise<void>
    addIntegration: (projectId: string, name: string, type?: string) => Promise<unknown>
    removeIntegration: (projectId: string, integrationId: string) => Promise<void>
  }
  broker: {
    start: (projectId: string, cwd: string, name: string, channels?: string[]) => Promise<boolean>
    syncChannels: (projectId: string, channels: string[]) => Promise<void>
    autoFixRuntime: (
      projectId: string,
      cwd: string,
      name: string,
      channels?: string[],
      errorMessage?: string
    ) => Promise<{ removed: string[] }>
    connectCloud: () => Promise<string>
    spawnAgent: (projectId: string, input: {
      name: string
      cli: string
      model?: string
      task?: string
      channels?: string[]
      cwd?: string
      args?: string[]
    }) => Promise<{ name: string; runtime: string }>
    attachTerminal: (input: {
      projectId?: string
      name: string
      rows?: number
      cols?: number
      mode?: TerminalAttachMode
    }) => Promise<{
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
    }>
    sendInputFast: (projectId: string | undefined, name: string, data: string) => void
    setTerminalMode: (projectId: string | undefined, name: string, mode: TerminalAttachMode) => Promise<{
      name: string
      mode: InboundDeliveryMode
      flushed: number
      pending: number
    }>
    getPending: (projectId: string | undefined, name: string) => Promise<PendingRelayMessage[]>
    flushPending: (projectId: string | undefined, name: string) => Promise<{ flushed: number }>
    resizePty: (projectId: string | undefined, name: string, rows: number, cols: number) => Promise<void>
    sendMessage: (projectId: string | undefined, input: { to: string; text: string; from?: string }) => Promise<void>
    subscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) => Promise<void>
    unsubscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) => Promise<void>
    releaseAgent: (projectId: string | undefined, name: string) => Promise<void>
    listAgents: (projectId?: string) => Promise<BrokerListAgent[]>
    listDetails: () => Promise<BrokerDetails[]>
    listEvents: () => Promise<BrokerEventRecord[]>
    shutdown: () => Promise<void>
    onEvent: (callback: (event: unknown) => void) => () => void
    onPtyChunk: (callback: (projectId: string, name: string, chunk: string) => void) => () => void
    onStatus: (callback: (status: { projectId?: string; status: string; error?: string }) => void) => () => void
  }
  git: {
    status: (path: string) => Promise<GitFileStatus[]>
    diff: (path: string, file?: string) => Promise<string>
    fileContent: (path: string, file: string, revision?: string) => Promise<string>
    summary: (path: string) => Promise<GitSummary | null>
    branches: (root: string) => Promise<string[]>
    branchDetails: (root: string) => Promise<GitBranchInfo[]>
    checkoutBranch: (root: string, branch: string, options?: GitCheckoutBranchOptions) => Promise<GitBranchSyncStatus>
    branchSyncStatus: (root: string) => Promise<GitBranchSyncStatus>
    fetchRemote: (root: string) => Promise<GitBranchSyncStatus>
    pullCurrentBranch: (root: string) => Promise<GitBranchSyncStatus>
    pushCurrentBranch: (root: string) => Promise<GitBranchSyncStatus>
    history: (path: string, limit?: number) => Promise<GitHistoryCommit[]>
    show: (path: string, hash: string, file?: string) => Promise<string>
    discardFiles: (path: string, files: string[]) => Promise<void>
    addGitignorePatterns: (path: string, patterns: string[]) => Promise<void>
    commitSelection: (path: string, input: GitCommitSelectionInput) => Promise<{ hash: string }>
    generateCommitMessage: (
      path: string,
      input: { wholeFiles: string[]; patch?: string }
    ) => Promise<GitCommitDraft>
  }
  fs: {
    listDir: (dirPath: string) => Promise<
      { name: string; path: string; type: 'file' | 'directory' }[]
    >
    readPreview: (filePath: string) => Promise<{
      kind: 'text' | 'binary' | 'too-large' | 'missing'
      content: string
      size: number
    }>
    revealPath: (filePath: string) => Promise<void>
  }
  auth: {
    login: (input?: { apiUrl?: string }) => Promise<AuthStatus>
    logout: () => Promise<void>
    status: () => Promise<AuthStatus>
  }
  cloudAgent: {
    list: () => Promise<CloudAgentRecord[]>
    create: (input: CreateCloudAgentInput) => Promise<CloudAgentRecord>
    delete: (id: string) => Promise<void>
    attach: (projectId: string, cloudAgentId: string) => Promise<CloudAgentBinding>
    detach: (projectId: string) => Promise<void>
    status: (projectId: string) => Promise<CloudAgentStatus | null>
    onEvent: (callback: (event: CloudAgentEvent) => void) => () => void
  }
  proactiveAgent: {
    list: (projectId: string) => Promise<ProactiveAgentBinding[]>
    create: (projectId: string, draft: ProactiveAgentDraft) => Promise<ProactiveAgentBinding>
    update: (projectId: string, personaId: string, draft: ProactiveAgentDraft) => Promise<ProactiveAgentBinding>
    deploy: (projectId: string, personaId: string) => Promise<ProactiveAgentDeployResult>
    pause: (projectId: string, personaId: string) => Promise<void>
    resume: (projectId: string, personaId: string) => Promise<void>
    undeploy: (projectId: string, personaId: string) => Promise<void>
    runs: (
      projectId: string,
      personaId: string,
      opts?: { limit?: number; cursor?: string }
    ) => Promise<ProactiveAgentRunsPage>
    runTranscript: (runId: string) => Promise<ProactiveAgentTranscript>
    onEvent: (callback: (event: ProactiveAgentEvent) => void) => () => void
  }
  integrations: {
    catalog: () => Promise<IntegrationAdapter[]>
    list: (projectId: string) => Promise<ConnectedIntegration[]>
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
    disconnect: (projectId: string, integrationId: string) => Promise<void>
    onEvent: (callback: (event: IntegrationsEvent) => void) => () => void
  }
  aiHist: {
    status: () => Promise<{ ok: true; dbPath: string } | { ok: false; reason: string }>
    recent: (opts?: { source?: string; project?: string; limit?: number; beforeMs?: number }) => Promise<AiHistEntry[]>
    listSessions: (opts?: { source?: string; project?: string; limit?: number; beforeMs?: number }) => Promise<AiHistSession[]>
    getSession: (sessionId: string) => Promise<AiHistEntry[]>
    search: (
      query: string,
      opts?: { source?: string; project?: string; limit?: number; beforeMs?: number }
    ) => Promise<AiHistEntry[]>
    searchSessions: (
      query: string,
      opts?: { source?: string; project?: string; limit?: number; beforeMs?: number }
    ) => Promise<AiHistSession[]>
    stats: () => Promise<AiHistStats | null>
    resumeCommand: (entry: { source: string; sessionId: string | null; project: string | null }) => Promise<string | null>
    reload: () => Promise<void>
  }
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => () => void
}

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

declare global {
  interface Window {
    pear: PearAPI
  }
}

export const pear = window.pear
