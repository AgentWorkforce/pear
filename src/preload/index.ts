import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiHistEntry,
  AiHistRecentOptions,
  AiHistResumeEntry,
  AiHistSession,
  AiHistStats,
  AiHistStatusResponse,
  AddRootResult,
  AuthLoginInput,
  AuthStatus,
  BrokerAttachTerminalInput,
  BrokerAttachTerminalResult,
  BrokerDetails,
  BrokerEventRecord,
  BrokerEventStreamDiagnostic,
  BrokerListAgent,
  BrokerReconciledChatMessage,
  BrokerReconcileMessagesInput,
  BrokerSendMessageInput,
  BrokerSetTerminalModeResult,
  BrokerSpawnAgentInput,
  BrokerSpawnAgentResult,
  BrokerStatusEvent,
  BurnAgentBreakdown,
  BurnAgentInput,
  BurnAgentSummary,
  BurnFingerprintInput,
  BurnHotspotInsight,
  BurnHotspotMcpServer,
  BurnProjectBreakdown,
  BurnProjectInput,
  BurnProjectOverhead,
  BurnSessionBreakdown,
  BurnSessionBreakdownInput,
  BurnSessionLookup,
  CloudAgentBinding,
  CloudAgentEvent,
  CloudAgentRecord,
  CloudAgentStatus,
  ConnectedIntegration,
  CreateCloudAgentInput,
  FsDirEntry,
  FsReadPreviewResult,
  GitBranchInfo,
  GitBranchSyncStatus,
  GitCheckoutBranchOptions,
  GitCommitDraft,
  GitCommitSelectionInput,
  GitFileStatus,
  GitGenerateCommitMessageInput,
  GitHistoryCommit,
  GitPullRequest,
  GitSummary,
  IntegrationAdapter,
  IntegrationAuthRecoveryState,
  IntegrationConnectSession,
  IntegrationEventTelemetrySnapshot,
  IntegrationOption,
  IntegrationsEvent,
  PearAPI,
  PendingRelayMessage,
  ProactiveAgentBinding,
  ProactiveAgentDeployResult,
  ProactiveAgentDraft,
  ProactiveAgentEvent,
  ProactiveAgentRunsOptions,
  ProactiveAgentRunsPage,
  ProactiveAgentTranscript,
  ProjectListResult,
  ProjectIntegrationResult,
  ProjectRootRecord,
  TerminalAttachMode,
  UpdaterState,
  WorkforcePersona
} from '../shared/types/ipc'

export type {
  AiHistEntry,
  AiHistRecentOptions,
  AiHistResumeEntry,
  AiHistSession,
  AiHistSource,
  AddRootResult,
  AiHistStats,
  AiHistStatusResponse,
  AgentCurrentState,
  AuthLoginInput,
  AuthStatus,
  AuthUser,
  BrokerAgentDetails,
  BrokerAttachTerminalInput,
  BrokerAttachTerminalResult,
  BrokerDetails,
  BrokerEventRecord,
  BrokerEventStreamDiagnostic,
  BrokerListAgent,
  BrokerReconciledChatMessage,
  BrokerReconcileMessagesInput,
  BrokerSendMessageInput,
  BrokerSetTerminalModeResult,
  BrokerSpawnAgentInput,
  BrokerSpawnAgentResult,
  BrokerStatusEvent,
  BurnAgentBreakdown,
  BurnAgentInput,
  BurnAgentSummary,
  BurnFingerprintInput,
  BurnHotspotInsight,
  BurnHotspotMcpServer,
  BurnProjectAgentRollup,
  BurnProjectBreakdown,
  BurnProjectInput,
  BurnProjectOverhead,
  BurnSessionAgentRef,
  BurnSessionBreakdown,
  BurnSessionBreakdownInput,
  BurnSessionLookup,
  CloudAgentBinding,
  CloudAgentEvent,
  CloudAgentMountStatus,
  CloudAgentRecord,
  CloudAgentSandboxStatus,
  CloudAgentStatus,
  CloudAgentSyncMode,
  ConnectedIntegration,
  CreateCloudAgentInput,
  FsDirEntry,
  FsReadPreviewResult,
  GitBranchInfo,
  GitBranchSyncStatus,
  GitCheckoutBranchOptions,
  GitCommitDraft,
  GitCommitSelectionInput,
  GitFileStatus,
  GitFileStatusKind,
  GitGenerateCommitMessageInput,
  GitHistoryCoAuthor,
  GitHistoryCommit,
  GitHistoryFile,
  GitPullRequest,
  GitSummary,
  InboundDeliveryMode,
  IntegrationAdapter,
  IntegrationAuthMethod,
  IntegrationAuthRecoveryState,
  IntegrationCapabilities,
  IntegrationConnectSession,
  IntegrationConnectStatus,
  IntegrationEventTelemetrySnapshot,
  IntegrationsEvent,
  MessageInjectionMode,
  PearAPI,
  PendingRelayMessage,
  ProactiveAgentBinding,
  ProactiveAgentDeployResult,
  ProactiveAgentDraft,
  ProactiveAgentEvent,
  ProactiveAgentHarness,
  ProactiveAgentRun,
  ProactiveAgentRunMode,
  ProactiveAgentRunStatus,
  ProactiveAgentRunsOptions,
  ProactiveAgentRunsPage,
  ProactiveAgentStatus,
  ProactiveAgentTranscript,
  ProactiveAgentWatchEventKind,
  ProjectListResult,
  ProjectIntegrationResult,
  ProjectRootConflict,
  ProjectRootRecord,
  TerminalAttachMode,
  ViewMode,
  WorkforcePersona
} from '../shared/types/ipc'

// Thin generic wrappers so each handler binds an IPC channel + return type without
// repeating the `as Promise<T>` cast on every call site.
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  app: {
    confirmQuit: () => invoke<boolean>('app:confirm-quit'),
    notifyCliReady: () => {
      ipcRenderer.send('cli:renderer-ready')
    }
  },
  project: {
    list: () => invoke<ProjectListResult>('project:list'),
    add: (name: string, rootPath?: string) => invoke<unknown>('project:add', name, rootPath),
    remove: (id: string) => invoke<void>('project:remove', id),
    setActive: (id: string | null) => invoke<void>('project:set-active', id),
    update: (id: string, update: Record<string, unknown>) =>
      invoke<void>('project:update', id, update),
    addChannel: (projectId: string, name: string) =>
      invoke<void>('project:add-channel', projectId, name),
    removeChannel: (projectId: string, name: string) =>
      invoke<void>('project:remove-channel', projectId, name),
    setChannelPeople: (projectId: string, channelName: string, people: string[]) =>
      invoke<string[]>('project:set-channel-people', projectId, channelName, people),
    addRoot: (projectId: string, name?: string, rootPath?: string) =>
      invoke<AddRootResult | null>('project:add-root', projectId, name, rootPath),
    removeRoot: (projectId: string, rootId: string) =>
      invoke<void>('project:remove-root', projectId, rootId),
    createWorktreeRoot: (projectId: string, repoPath: string, projectName: string, name?: string) =>
      invoke<ProjectRootRecord>('project:create-worktree-root', projectId, repoPath, projectName, name),
    addIntegration: (projectId: string, name: string, type?: string) =>
      invoke<ProjectIntegrationResult>('project:add-integration', projectId, name, type),
    removeIntegration: (projectId: string, integrationId: string) =>
      invoke<void>('project:remove-integration', projectId, integrationId)
  },
  broker: {
    start: (projectId: string, cwd: string, name: string, channels?: string[]) =>
      invoke<boolean>('broker:start', projectId, cwd, name, channels),
    syncChannels: (projectId: string, channels: string[]) =>
      invoke<void>('broker:sync-channels', projectId, channels),
    autoFixRuntime: (
      projectId: string,
      cwd: string,
      name: string,
      channels?: string[],
      errorMessage?: string
    ) =>
      invoke<{ removed: string[] }>(
        'broker:auto-fix-runtime',
        projectId,
        cwd,
        name,
        channels,
        errorMessage
      ),
    connectCloud: () => invoke<string>('broker:connect-cloud'),
    spawnAgent: (projectId: string, input: BrokerSpawnAgentInput) =>
      invoke<BrokerSpawnAgentResult>('broker:spawn-agent', projectId, input),
    listPersonas: (projectId: string, cwd?: string) =>
      invoke<WorkforcePersona[]>('broker:list-personas', projectId, cwd),
    spawnPersona: (projectId: string, personaId: string) =>
      invoke<BrokerSpawnAgentResult>('broker:spawn-persona', projectId, personaId),
    attachTerminal: (input: BrokerAttachTerminalInput) =>
      invoke<BrokerAttachTerminalResult>('broker:attach-terminal', input),
    sendInput: (projectId: string | undefined, name: string, data: string) =>
      invoke<{ name: string; bytes_written: number }>('broker:send-input', projectId, name, data),
    sendInputFast: (projectId: string | undefined, name: string, data: string): void => {
      ipcRenderer.send('broker:send-input-fast', projectId, name, data)
    },
    setTerminalMode: (projectId: string | undefined, name: string, mode: TerminalAttachMode) =>
      invoke<BrokerSetTerminalModeResult>('broker:set-terminal-mode', projectId, name, mode),
    getPending: (projectId: string | undefined, name: string) =>
      invoke<PendingRelayMessage[]>('broker:get-pending', projectId, name),
    flushPending: (projectId: string | undefined, name: string) =>
      invoke<{ flushed: number }>('broker:flush-pending', projectId, name),
    resizePty: (projectId: string | undefined, name: string, rows: number, cols: number) =>
      invoke<void>('broker:resize-pty', projectId, name, rows, cols),
    inputSrtt: (projectId: string | undefined, name: string) =>
      invoke<number | null>('broker:input-srtt', projectId, name),
    sendMessage: (projectId: string | undefined, input: BrokerSendMessageInput) =>
      invoke<void>('broker:send-message', projectId, input),
    reconcileMessages: (input: BrokerReconcileMessagesInput) =>
      invoke<BrokerReconciledChatMessage[]>('broker:reconcile-messages', input),
    refreshEventStream: (projectId?: string, reason?: string) =>
      invoke<void>('broker:refresh-event-stream', projectId, reason),
    subscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) =>
      invoke<void>('broker:subscribe-agent-channel', projectId, name, channel),
    unsubscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) =>
      invoke<void>('broker:unsubscribe-agent-channel', projectId, name, channel),
    releaseAgent: (projectId: string | undefined, name: string) =>
      invoke<void>('broker:release-agent', projectId, name),
    listAgents: (projectId?: string) =>
      invoke<BrokerListAgent[]>('broker:list-agents', projectId),
    listDetails: () => invoke<BrokerDetails[]>('broker:list-details'),
    listEvents: () => invoke<BrokerEventRecord[]>('broker:list-events'),
    shutdown: () => invoke<void>('broker:shutdown'),
    onEvent: (callback: (event: unknown) => void) => subscribe<unknown>('broker:event', callback),
    onEventStreamDiagnostic: (callback: (event: BrokerEventStreamDiagnostic) => void) =>
      subscribe<BrokerEventStreamDiagnostic>('broker:event-stream-diagnostic', callback),
    onPtyChunk: (callback: (projectId: string, name: string, chunk: string) => void) => {
      const handler = (_: unknown, projectId: string, name: string, chunk: string): void =>
        callback(projectId, name, chunk)
      ipcRenderer.on('broker:pty-chunk', handler)
      return () => ipcRenderer.removeListener('broker:pty-chunk', handler)
    },
    onStatus: (callback: (status: BrokerStatusEvent) => void) =>
      subscribe<BrokerStatusEvent>('broker:status', callback)
  },
  burn: {
    listAgentSummaries: (agents: BurnAgentInput[]) =>
      invoke<BurnAgentSummary[]>('burn:list-agent-summaries', agents),
    getAgentBreakdown: (agent: BurnAgentInput) =>
      invoke<BurnAgentBreakdown>('burn:get-agent-breakdown', agent),
    getProjectBreakdown: (input: BurnProjectInput) =>
      invoke<BurnProjectBreakdown>('burn:get-project-breakdown', input),
    lookupSessions: (sessionIds: string[]) =>
      invoke<Record<string, BurnSessionLookup>>('burn:lookup-sessions', sessionIds),
    getSessionBreakdown: (input: BurnSessionBreakdownInput) =>
      invoke<BurnSessionBreakdown>('burn:get-session-breakdown', input),
    fingerprint: (input: BurnFingerprintInput) =>
      invoke<{ fingerprint: string }>('burn:fingerprint', input),
    getProjectOverhead: (input: { projectId: string }) =>
      invoke<BurnProjectOverhead>('burn:get-project-overhead', input)
  },
  git: {
    status: (path: string) => invoke<GitFileStatus[]>('git:status', path),
    diff: (path: string, file?: string) => invoke<string>('git:diff', path, file),
    fileContent: (path: string, file: string, revision?: string) =>
      invoke<string>('git:file-content', path, file, revision),
    summary: (path: string) => invoke<GitSummary | null>('git:summary', path),
    branches: (root: string) => invoke<string[]>('git:branches', root),
    branchDetails: (root: string) => invoke<GitBranchInfo[]>('git:branch-details', root),
    checkoutBranch: (root: string, branch: string, options?: GitCheckoutBranchOptions) =>
      invoke<GitBranchSyncStatus>('git:checkout-branch', root, branch, options),
    branchSyncStatus: (root: string) => invoke<GitBranchSyncStatus>('git:branch-sync-status', root),
    fetchRemote: (root: string) => invoke<GitBranchSyncStatus>('git:fetch-remote', root),
    pullCurrentBranch: (root: string) =>
      invoke<GitBranchSyncStatus>('git:pull-current-branch', root),
    pushCurrentBranch: (root: string) =>
      invoke<GitBranchSyncStatus>('git:push-current-branch', root),
    activePullRequests: (roots: string[]) =>
      invoke<GitPullRequest[]>('git:active-pull-requests', roots),
    history: (path: string, limit?: number) =>
      invoke<GitHistoryCommit[]>('git:history', path, limit),
    show: (path: string, hash: string, file?: string) =>
      invoke<string>('git:show', path, hash, file),
    discardFiles: (path: string, files: string[]) =>
      invoke<void>('git:discard-files', path, files),
    addGitignorePatterns: (path: string, patterns: string[]) =>
      invoke<void>('git:add-gitignore-patterns', path, patterns),
    commitSelection: (path: string, input: GitCommitSelectionInput) =>
      invoke<{ hash: string }>('git:commit-selection', path, input),
    generateCommitMessage: (projectId: string, path: string, input: GitGenerateCommitMessageInput) =>
      invoke<GitCommitDraft>('git:generate-commit-message', projectId, path, input)
  },
  fs: {
    listDir: (dirPath: string) => invoke<FsDirEntry[]>('fs:list-dir', dirPath),
    readPreview: (filePath: string) => invoke<FsReadPreviewResult>('fs:read-preview', filePath),
    revealPath: (filePath: string) => invoke<void>('fs:reveal-path', filePath)
  },
  auth: {
    login: (input?: AuthLoginInput) => invoke<AuthStatus>('auth:login', input),
    logout: () => invoke<void>('auth:logout'),
    status: () => invoke<AuthStatus>('auth:status')
  },
  cloudAgent: {
    list: () => invoke<CloudAgentRecord[]>('cloud-agent:list'),
    create: (input: CreateCloudAgentInput) =>
      invoke<CloudAgentRecord>('cloud-agent:create', input),
    delete: (id: string) => invoke<void>('cloud-agent:delete', id),
    prewarm: (projectId: string, cloudAgentId: string) =>
      invoke<void>('cloud-agent:prewarm', projectId, cloudAgentId),
    cancelPrewarm: (projectId: string, cloudAgentId?: string) =>
      invoke<void>('cloud-agent:cancel-prewarm', projectId, cloudAgentId),
    attach: (projectId: string, cloudAgentId: string) =>
      invoke<CloudAgentBinding>('cloud-agent:attach', projectId, cloudAgentId),
    detach: (projectId: string) => invoke<void>('cloud-agent:detach', projectId),
    status: (projectId: string) =>
      invoke<CloudAgentStatus | null>('cloud-agent:status', projectId),
    onEvent: (callback: (event: CloudAgentEvent) => void) =>
      subscribe<CloudAgentEvent>('cloud-agent:event', callback)
  },
  proactiveAgent: {
    list: (projectId: string) =>
      invoke<ProactiveAgentBinding[]>('proactive-agent:list', projectId),
    create: (projectId: string, draft: ProactiveAgentDraft) =>
      invoke<ProactiveAgentBinding>('proactive-agent:create', projectId, draft),
    update: (projectId: string, personaId: string, draft: ProactiveAgentDraft) =>
      invoke<ProactiveAgentBinding>('proactive-agent:update', projectId, personaId, draft),
    deploy: (projectId: string, personaId: string) =>
      invoke<ProactiveAgentDeployResult>('proactive-agent:deploy', projectId, personaId),
    pause: (projectId: string, personaId: string) =>
      invoke<void>('proactive-agent:pause', projectId, personaId),
    resume: (projectId: string, personaId: string) =>
      invoke<void>('proactive-agent:resume', projectId, personaId),
    undeploy: (projectId: string, personaId: string) =>
      invoke<void>('proactive-agent:undeploy', projectId, personaId),
    runs: (projectId: string, personaId: string, opts?: ProactiveAgentRunsOptions) =>
      invoke<ProactiveAgentRunsPage>('proactive-agent:runs', projectId, personaId, opts),
    runTranscript: (runId: string) =>
      invoke<ProactiveAgentTranscript>('proactive-agent:run-transcript', runId),
    onEvent: (callback: (event: ProactiveAgentEvent) => void) =>
      subscribe<ProactiveAgentEvent>('proactive-agent:event', callback)
  },
  integrations: {
    catalog: () => invoke<IntegrationAdapter[]>('integrations:catalog'),
    list: (projectId: string) => invoke<ConnectedIntegration[]>('integrations:list', projectId),
    authRecoveryState: () => invoke<IntegrationAuthRecoveryState | null>('integrations:auth-recovery-state'),
    telemetry: () => invoke<IntegrationEventTelemetrySnapshot>('integrations:telemetry'),
    listMountDir: (projectId: string, integrationId: string, dirPath: string) =>
      invoke<FsDirEntry[]>('integrations:list-mount-dir', projectId, integrationId, dirPath),
    listRemoteDir: (projectId: string, remotePath: string) =>
      invoke<FsDirEntry[]>('integrations:list-remote-dir', projectId, remotePath),
    readRemoteFile: (projectId: string, remotePath: string) =>
      invoke<FsReadPreviewResult>('integrations:read-remote-file', projectId, remotePath),
    readMountPreview: (projectId: string, integrationId: string, filePath: string) =>
      invoke<FsReadPreviewResult>('integrations:read-mount-preview', projectId, integrationId, filePath),
    listOptions: (projectId: string, provider: string, resource: string) =>
      invoke<IntegrationOption[]>('integrations:list-options', projectId, provider, resource),
    startConnect: (projectId: string, provider: string) =>
      invoke<IntegrationConnectSession>('integrations:start-connect', projectId, provider),
    pollConnect: (sessionId: string) =>
      invoke<IntegrationConnectSession>('integrations:poll-connect', sessionId),
    completeConnect: (
      projectId: string,
      sessionId: string,
      scope: Record<string, unknown>,
      mountPaths: string[],
      notifyAgent: boolean
    ) =>
      invoke<ConnectedIntegration>(
        'integrations:complete-connect',
        projectId,
        sessionId,
        scope,
        mountPaths,
        notifyAgent
      ),
    updateScope: (
      projectId: string,
      integrationId: string,
      scope: Record<string, unknown>,
      mountPaths: string[]
    ) =>
      invoke<ConnectedIntegration>(
        'integrations:update-scope',
        projectId,
        integrationId,
        scope,
        mountPaths
      ),
    updateSubscription: (projectId: string, integrationId: string, subscribeAgent: boolean) =>
      invoke<ConnectedIntegration>(
        'integrations:update-subscription',
        projectId,
        integrationId,
        subscribeAgent
      ),
    updateHistoricalDownload: (projectId: string, integrationId: string, downloadHistoricalData: boolean) =>
      invoke<ConnectedIntegration>(
        'integrations:update-historical-download',
        projectId,
        integrationId,
        downloadHistoricalData
      ),
    disconnect: (projectId: string, integrationId: string) =>
      invoke<void>('integrations:disconnect', projectId, integrationId),
    onEvent: (callback: (event: IntegrationsEvent) => void) =>
      subscribe<IntegrationsEvent>('integrations:event', callback)
  },
  aiHist: {
    status: () => invoke<AiHistStatusResponse>('ai-hist:status'),
    recent: (opts?: AiHistRecentOptions) => invoke<AiHistEntry[]>('ai-hist:recent', opts),
    listSessions: (opts?: AiHistRecentOptions) =>
      invoke<AiHistSession[]>('ai-hist:list-sessions', opts),
    getSession: (sessionId: string) => invoke<AiHistEntry[]>('ai-hist:get-session', sessionId),
    search: (query: string, opts?: AiHistRecentOptions) =>
      invoke<AiHistEntry[]>('ai-hist:search', query, opts),
    searchSessions: (query: string, opts?: AiHistRecentOptions) =>
      invoke<AiHistSession[]>('ai-hist:search-sessions', query, opts),
    stats: () => invoke<AiHistStats | null>('ai-hist:stats'),
    resumeCommand: (entry: AiHistResumeEntry) =>
      invoke<string | null>('ai-hist:resume-command', entry),
    reload: () => invoke<void>('ai-hist:reload')
  },
  update: {
    getState: () => invoke<UpdaterState | null>('update:get-state'),
    download: () => invoke<void>('update:download'),
    install: () => invoke<void>('update:install'),
    onAvailable: (callback) => subscribe<{ version: string }>('update:available', callback),
    onProgress: (callback) => subscribe<{ percent: number }>('update:progress', callback),
    onDownloaded: (callback) => subscribe<{ version: string }>('update:downloaded', callback),
    onError: (callback) => subscribe<{ message: string }>('update:error', callback)
  },
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_: unknown, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
} satisfies PearAPI

contextBridge.exposeInMainWorld('pear', api)
