import type {
  AiHistEntry,
  AiHistRecentOptions,
  AiHistResumeEntry,
  AiHistSession,
  AiHistStats,
  AiHistStatusResponse,
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
  ProjectIntegrationResult,
  ProjectListResult,
  ProjectRootRecord,
  TerminalAttachMode,
  UpdaterState,
  WorkforcePersona
} from '@shared/types/ipc'

type BrokerEventLike = Record<string, unknown> & {
  kind?: string
  projectId?: string
  name?: string
  from?: string
  target?: string
  body?: string
  event_id?: string
  seq?: number
}

type Listener<T> = (payload: T) => void

interface MockProject {
  id: string
  name: string
  relayWorkspaceId: string
  rootPath: string
  roots: Array<ProjectRootRecord & { pathExists?: boolean }>
  channels: string[]
  channelPeople: Record<string, string[]>
  integrations: ProjectIntegrationResult[]
}

interface MockState {
  projects: MockProject[]
  activeId: string | null
  agents: BrokerListAgent[]
  events: BrokerEventRecord[]
  messages: BrokerReconciledChatMessage[]
  ptyChunks: Record<string, string[]>
  startedProjects: Set<string>
  terminalModes: Map<string, TerminalAttachMode>
  brokerEventListeners: Set<Listener<unknown>>
  brokerStatusListeners: Set<Listener<BrokerStatusEvent>>
  brokerDiagnosticListeners: Set<Listener<BrokerEventStreamDiagnostic>>
  ptyChunkListeners: Set<(projectId: string, name: string, chunk: string) => void>
  menuListeners: Map<string, Set<(...args: unknown[]) => void>>
  cloudAgentListeners: Set<Listener<CloudAgentEvent>>
  proactiveAgentListeners: Set<Listener<ProactiveAgentEvent>>
  integrationListeners: Set<Listener<IntegrationsEvent>>
  updateAvailableListeners: Set<Listener<{ version: string }>>
  updateProgressListeners: Set<Listener<{ percent: number }>>
  updateDownloadedListeners: Set<Listener<{ version: string }>>
  updateErrorListeners: Set<Listener<{ message: string }>>
}

export interface PearMockHarness {
  reset: () => void
  injectBrokerEvent: (event: BrokerEventLike) => void
  injectBrokerEvents: (events: BrokerEventLike[]) => void
  injectPtyChunk: (projectId: string, name: string, chunk: string) => void
  spawnAgents: (count: number, options?: { projectId?: string; channel?: string; namePrefix?: string }) => void
  openChannel: (projectId: string, channelName: string) => void
  openAgents: (projectId?: string) => void
  getState: () => {
    activeId: string | null
    agents: BrokerListAgent[]
    events: BrokerEventRecord[]
    messages: BrokerReconciledChatMessage[]
    ptyChunks: Record<string, string[]>
  }
}

declare global {
  interface Window {
    __pearMock?: PearMockHarness
  }
}

const defaultProject: MockProject = {
  id: 'mock-project',
  name: 'Mock Project',
  relayWorkspaceId: 'mock-project',
  rootPath: '/mock/project',
  roots: [{ id: 'mock-root', name: 'Mock Project', path: '/mock/project', pathExists: true }],
  channels: ['general'],
  channelPeople: {},
  integrations: []
}

function createState(): MockState {
  return {
    projects: [{
      ...defaultProject,
      roots: [...defaultProject.roots],
      channels: [...defaultProject.channels],
      // Clone nested mutable maps. Shallow spread above would share the
      // channelPeople object reference across resets, leaking stale state
      // between stress test runs.
      channelPeople: { ...defaultProject.channelPeople },
      integrations: []
    }],
    activeId: defaultProject.id,
    agents: [],
    events: [],
    messages: [],
    ptyChunks: {},
    startedProjects: new Set(),
    terminalModes: new Map(),
    brokerEventListeners: new Set(),
    brokerStatusListeners: new Set(),
    brokerDiagnosticListeners: new Set(),
    ptyChunkListeners: new Set(),
    menuListeners: new Map(),
    cloudAgentListeners: new Set(),
    proactiveAgentListeners: new Set(),
    integrationListeners: new Set(),
    updateAvailableListeners: new Set(),
    updateProgressListeners: new Set(),
    updateDownloadedListeners: new Set(),
    updateErrorListeners: new Set()
  }
}

let state = createState()
let seq = 0

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T
}

function noopUnsubscribe<T>(set: Set<T>, item: T): () => void {
  set.add(item)
  return () => set.delete(item)
}

function key(projectId: string | undefined, name: string): string {
  return `${projectId || 'unknown'}:${name}`
}

function emit<T>(listeners: Set<Listener<T>>, payload: T): void {
  for (const listener of [...listeners]) listener(payload)
}

function emitBrokerStatus(status: BrokerStatusEvent): void {
  emit(state.brokerStatusListeners, status)
}

function recordBrokerEvent(event: BrokerEventLike): void {
  const projectId = event.projectId || state.activeId || 'mock-project'
  const id = typeof event.event_id === 'string' && event.event_id
    ? event.event_id
    : `${projectId}:${event.seq ?? ++seq}`
  state.events.push({
    id,
    projectId,
    timestamp: Date.now(),
    event: { ...event, projectId }
  })
}

function upsertAgent(input: Partial<BrokerListAgent> & { name: string; projectId?: string }): BrokerListAgent {
  const projectId = input.projectId || state.activeId || defaultProject.id
  const existingIndex = state.agents.findIndex((agent) => agent.projectId === projectId && agent.name === input.name)
  const next: BrokerListAgent = {
    name: input.name,
    projectId,
    runtime: input.runtime || 'mock',
    cli: input.cli || 'codex',
    model: input.model,
    channels: input.channels || ['general'],
    parent: input.parent,
    pid: input.pid,
    current_state: input.current_state || 'idle',
    inboundDeliveryMode: input.inboundDeliveryMode || 'auto_inject',
    last_activity_ms: input.last_activity_ms ?? 0
  }
  if (existingIndex >= 0) {
    state.agents[existingIndex] = { ...state.agents[existingIndex], ...next }
    return state.agents[existingIndex]
  }
  state.agents.push(next)
  return next
}

function removeAgent(projectId: string | undefined, name: string): void {
  state.agents = state.agents.filter((agent) => !(agent.name === name && (!projectId || agent.projectId === projectId)))
}

function addReconciledMessage(event: BrokerEventLike): void {
  if (!event.from || !event.target || !event.body) return
  const id = event.event_id || `${event.projectId || state.activeId || defaultProject.id}:message:${++seq}`
  if (state.messages.some((message) => message.id === id)) return
  state.messages.push({
    id,
    kind: 'message',
    from: event.from,
    to: event.target,
    body: event.body,
    timestamp: Date.now(),
    isHuman: event.from.trim().toLowerCase() === 'human',
    projectId: event.projectId || state.activeId || defaultProject.id
  })
}

function handleInjectedBrokerEvent(event: BrokerEventLike): void {
  const projectId = event.projectId || state.activeId || defaultProject.id
  const normalized: BrokerEventLike = { ...event, projectId }
  if (normalized.kind === 'agent_spawned' && normalized.name) {
    upsertAgent({
      name: normalized.name,
      projectId,
      cli: typeof normalized.cli === 'string' ? normalized.cli : 'codex',
      model: typeof normalized.model === 'string' ? normalized.model : undefined,
      channels: Array.isArray(normalized.channels)
        ? normalized.channels.filter((entry: unknown): entry is string => typeof entry === 'string')
        : ['general'],
      parent: typeof normalized.parent === 'string' ? normalized.parent : undefined
    })
  } else if ((normalized.kind === 'agent_exited' || normalized.kind === 'agent_released') && normalized.name) {
    removeAgent(projectId, normalized.name)
  } else if (normalized.kind === 'relay_inbound') {
    addReconciledMessage(normalized)
  }
  recordBrokerEvent(normalized)
  emit(state.brokerEventListeners, normalized)
}

function makeBrokerDetails(project: MockProject): BrokerDetails {
  const agents = state.agents.filter((agent) => agent.projectId === project.id)
  return {
    projectId: project.id,
    name: `pear-${project.relayWorkspaceId}`,
    cwd: project.rootPath,
    channels: project.channels,
    kind: 'local',
    apiKeyAvailable: true,
    health: state.startedProjects.has(project.id) ? 'connected' : 'unreachable',
    agentCount: agents.length,
    pendingDeliveryCount: 0,
    agents: agents.map((agent) => ({
      name: agent.name,
      runtime: agent.runtime || 'mock',
      cli: agent.cli,
      model: agent.model,
      channels: agent.channels || [],
      parent: agent.parent,
      pid: agent.pid,
      currentState: agent.current_state
    }))
  }
}

function emptyBurnSummary(agent: BurnAgentInput): BurnAgentSummary {
  const agentKey = `${agent.projectId || 'unknown'}:${agent.name}`
  return {
    projectId: agent.projectId,
    name: agent.name,
    agentKey,
    totalTokens: 0,
    totalCost: 0,
    turnCount: 0,
    byModel: [],
    byTool: [],
    sessionIds: [],
    updatedAt: Date.now(),
    status: 'ok'
  }
}

const authStatus: AuthStatus = {
  loggedIn: true,
  user: { name: 'Mock User', email: 'mock@example.test' }
}

export const pearMock: PearAPI = {
  app: {
    confirmQuit: async () => true,
    notifyCliReady: () => undefined
  },
  project: {
    list: async (): Promise<ProjectListResult> => ({ projects: clone(state.projects), activeId: state.activeId }),
    add: async (name: string, rootPath?: string): Promise<unknown> => {
      const id = `mock-project-${state.projects.length + 1}`
      const path = rootPath || `/mock/${id}`
      const project: MockProject = {
        id,
        name,
        relayWorkspaceId: id,
        rootPath: path,
        roots: [{ id: `${id}-root`, name, path, pathExists: true }],
        channels: ['general'],
        channelPeople: {},
        integrations: []
      }
      state.projects.push(project)
      return clone(project)
    },
    remove: async (id: string) => {
      state.projects = state.projects.filter((project) => project.id !== id)
      if (state.activeId === id) state.activeId = state.projects[0]?.id || null
    },
    setActive: async (id: string | null) => {
      state.activeId = id
    },
    update: async (id: string, update: Record<string, unknown>) => {
      state.projects = state.projects.map((project) => project.id === id ? { ...project, ...update } : project)
    },
    addChannel: async (projectId: string, name: string) => {
      const project = state.projects.find((entry) => entry.id === projectId)
      if (project && !project.channels.includes(name)) project.channels.push(name)
    },
    removeChannel: async (projectId: string, name: string) => {
      const project = state.projects.find((entry) => entry.id === projectId)
      if (project) project.channels = project.channels.filter((channel) => channel !== name)
    },
    setChannelPeople: async (projectId: string, channelName: string, people: string[]) => {
      const project = state.projects.find((entry) => entry.id === projectId)
      if (!project) return []
      project.channelPeople[channelName] = people
      return people
    },
    addRoot: async (projectId: string, name?: string, rootPath?: string) => {
      const project = state.projects.find((entry) => entry.id === projectId)
      if (!project || !rootPath) return null
      const root = { id: `${projectId}-root-${project.roots.length + 1}`, name: name || rootPath, path: rootPath, pathExists: true }
      project.roots.push(root)
      return { kind: 'added', root }
    },
    removeRoot: async (projectId: string, rootId: string) => {
      const project = state.projects.find((entry) => entry.id === projectId)
      if (project) project.roots = project.roots.filter((root) => root.id !== rootId)
    },
    createWorktreeRoot: async (projectId: string, repoPath: string, projectName: string, name?: string) => ({
      id: `${projectId}-worktree`,
      name: name || projectName,
      path: repoPath,
      pathExists: true
    }),
    addIntegration: async (_projectId: string, name: string, type?: string) => ({
      id: `integration-${Date.now()}`,
      name,
      type: type || 'custom'
    }),
    removeIntegration: async () => undefined
  },
  broker: {
    start: async (projectId: string) => {
      const changed = !state.startedProjects.has(projectId)
      state.startedProjects.add(projectId)
      emitBrokerStatus({ projectId, status: 'connected' })
      return changed
    },
    syncChannels: async (projectId: string, channels: string[]) => {
      const project = state.projects.find((entry) => entry.id === projectId)
      if (project) project.channels = Array.from(new Set(channels))
    },
    autoFixRuntime: async () => ({ removed: [] }),
    connectCloud: async () => 'mock-cloud',
    spawnAgent: async (projectId: string, input: BrokerSpawnAgentInput): Promise<BrokerSpawnAgentResult> => {
      const agent = upsertAgent({ ...input, projectId, runtime: 'mock', current_state: 'idle' })
      handleInjectedBrokerEvent({
        kind: 'agent_spawned',
        projectId,
        name: agent.name,
        cli: agent.cli,
        model: agent.model,
        channels: agent.channels,
        event_id: `${projectId}:agent:${agent.name}`
      })
      return { name: agent.name, runtime: agent.runtime || 'mock', cli: agent.cli }
    },
    listPersonas: async (): Promise<WorkforcePersona[]> => [],
    spawnPersona: async (projectId: string, personaId: string) =>
      pearMock.broker.spawnAgent(projectId, { name: personaId, cli: 'codex' }),
    attachTerminal: async (input: BrokerAttachTerminalInput): Promise<BrokerAttachTerminalResult> => ({
      name: input.name,
      mode: 'auto_inject',
      pending: 0,
      snapshot: { rows: input.rows || 24, cols: input.cols || 80, cursor: [0, 0], screen: '' }
    }),
    sendInput: async (_projectId: string | undefined, name: string, data: string) => ({ name, bytes_written: data.length }),
    sendInputFast: () => undefined,
    setTerminalMode: async (projectId: string | undefined, name: string, mode: TerminalAttachMode): Promise<BrokerSetTerminalModeResult> => {
      state.terminalModes.set(key(projectId, name), mode)
      return { name, mode: mode === 'drive' ? 'manual_flush' : 'auto_inject', flushed: 0, pending: 0 }
    },
    getPending: async (): Promise<PendingRelayMessage[]> => [],
    flushPending: async () => ({ flushed: 0 }),
    resizePty: async () => undefined,
    inputSrtt: async () => null,
    sendMessage: async (projectId: string | undefined, input: BrokerSendMessageInput) => {
      handleInjectedBrokerEvent({
        kind: 'relay_inbound',
        projectId,
        from: input.from || 'human',
        target: input.to,
        body: input.text,
        event_id: `${projectId || 'mock'}:human:${++seq}`
      })
    },
    reconcileMessages: async (input: BrokerReconcileMessagesInput) =>
      clone(state.messages.filter((message) => message.projectId === input.projectId)),
    refreshEventStream: async (projectId?: string, reason?: string) => {
      emit(state.brokerDiagnosticListeners, {
        projectId: projectId || state.activeId || defaultProject.id,
        status: 'rebound',
        reason,
        at: Date.now()
      })
    },
    subscribeAgentChannel: async () => undefined,
    unsubscribeAgentChannel: async () => undefined,
    releaseAgent: async (projectId: string | undefined, name: string) => {
      handleInjectedBrokerEvent({ kind: 'agent_released', projectId, name, event_id: `${projectId || 'mock'}:released:${name}` })
    },
    listAgents: async (projectId?: string) =>
      clone(projectId ? state.agents.filter((agent) => agent.projectId === projectId) : state.agents),
    listDetails: async () => clone(state.projects.map(makeBrokerDetails)),
    listEvents: async () => clone(state.events),
    shutdown: async () => {
      state.startedProjects.clear()
      emitBrokerStatus({ status: 'disconnected' })
    },
    onEvent: (callback: (event: unknown) => void) => noopUnsubscribe(state.brokerEventListeners, callback),
    onEventStreamDiagnostic: (callback: (event: BrokerEventStreamDiagnostic) => void) =>
      noopUnsubscribe(state.brokerDiagnosticListeners, callback),
    onPtyChunk: (callback: (projectId: string, name: string, chunk: string) => void) =>
      noopUnsubscribe(state.ptyChunkListeners, callback),
    onStatus: (callback: (status: BrokerStatusEvent) => void) => noopUnsubscribe(state.brokerStatusListeners, callback)
  },
  burn: {
    listAgentSummaries: async (agents: BurnAgentInput[]) => agents.map(emptyBurnSummary),
    getAgentBreakdown: async (agent: BurnAgentInput): Promise<BurnAgentBreakdown> => ({ ...emptyBurnSummary(agent), byModel: [], byTool: [] }),
    getProjectBreakdown: async (input: BurnProjectInput): Promise<BurnProjectBreakdown> => ({
      projectId: input.projectId,
      totalTokens: 0,
      totalCost: 0,
      turnCount: 0,
      byModel: [],
      byTool: [],
      byAgent: [],
      sessionIds: [],
      updatedAt: Date.now(),
      status: 'ok'
    }),
    lookupSessions: async (sessionIds: string[]): Promise<Record<string, BurnSessionLookup>> =>
      Object.fromEntries(sessionIds.map((sessionId) => [sessionId, { sessionId, totalTokens: 0, totalCost: 0, turnCount: 0, status: 'ok' }])),
    getSessionBreakdown: async (input: BurnSessionBreakdownInput): Promise<BurnSessionBreakdown> => ({
      sessionId: input.sessionId,
      totalTokens: 0,
      totalCost: 0,
      turnCount: 0,
      models: [],
      insights: [],
      updatedAt: Date.now(),
      status: 'ok'
    }),
    fingerprint: async () => ({ fingerprint: 'mock' }),
    getProjectOverhead: async (input: { projectId: string }): Promise<BurnProjectOverhead> => ({
      projectId: input.projectId,
      grandTotal: 0,
      perSessionTotal: 0,
      recommendations: [],
      updatedAt: Date.now(),
      status: 'ok'
    })
  },
  git: {
    status: async (): Promise<GitFileStatus[]> => [],
    diff: async () => '',
    fileContent: async () => '',
    summary: async (): Promise<GitSummary | null> => null,
    branches: async () => [],
    branchDetails: async (): Promise<GitBranchInfo[]> => [],
    checkoutBranch: async (root: string, branch: string, _options?: GitCheckoutBranchOptions): Promise<GitBranchSyncStatus> => ({
      branch,
      remote: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: false
    }),
    branchSyncStatus: async (): Promise<GitBranchSyncStatus> => ({ branch: 'main', remote: null, upstream: null, ahead: 0, behind: 0, hasRemote: false }),
    fetchRemote: async (): Promise<GitBranchSyncStatus> => ({ branch: 'main', remote: null, upstream: null, ahead: 0, behind: 0, hasRemote: false }),
    pullCurrentBranch: async (): Promise<GitBranchSyncStatus> => ({ branch: 'main', remote: null, upstream: null, ahead: 0, behind: 0, hasRemote: false }),
    pushCurrentBranch: async (): Promise<GitBranchSyncStatus> => ({ branch: 'main', remote: null, upstream: null, ahead: 0, behind: 0, hasRemote: false }),
    activePullRequests: async (): Promise<GitPullRequest[]> => [],
    history: async (): Promise<GitHistoryCommit[]> => [],
    show: async () => '',
    discardFiles: async () => undefined,
    addGitignorePatterns: async () => undefined,
    commitSelection: async (_path: string, _input: GitCommitSelectionInput) => ({ hash: 'mock' }),
    generateCommitMessage: async (_path: string, _input: GitGenerateCommitMessageInput): Promise<GitCommitDraft> => ({ title: 'Mock commit', body: '' })
  },
  fs: {
    listDir: async (): Promise<FsDirEntry[]> => [],
    readPreview: async (): Promise<FsReadPreviewResult> => ({ kind: 'missing', content: '', size: 0 }),
    revealPath: async () => undefined
  },
  auth: {
    login: async (_input?: AuthLoginInput) => authStatus,
    logout: async () => undefined,
    status: async () => authStatus
  },
  cloudAgent: {
    list: async (): Promise<CloudAgentRecord[]> => [],
    create: async (input: CreateCloudAgentInput): Promise<CloudAgentRecord> => ({
      id: `cloud-${Date.now()}`,
      name: input.name,
      harness: input.harness,
      defaultModel: input.model,
      status: 'ready'
    }),
    delete: async () => undefined,
    prewarm: async () => undefined,
    cancelPrewarm: async () => undefined,
    attach: async (projectId: string, cloudAgentId: string): Promise<CloudAgentBinding> => ({
      projectId,
      cloudAgentId,
      sandboxId: 'mock-sandbox',
      relayfileMountPath: '/mock/mount',
      attachedAt: new Date().toISOString()
    }),
    detach: async () => undefined,
    status: async (): Promise<CloudAgentStatus | null> => null,
    onEvent: (callback: (event: CloudAgentEvent) => void) => noopUnsubscribe(state.cloudAgentListeners, callback)
  },
  proactiveAgent: {
    list: async (): Promise<ProactiveAgentBinding[]> => [],
    create: async (projectId: string, draft: ProactiveAgentDraft): Promise<ProactiveAgentBinding> => ({
      projectId,
      personaId: draft.id,
      cloudAgentId: draft.cloudAgentId,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      draft
    }),
    update: async (projectId: string, personaId: string, draft: ProactiveAgentDraft): Promise<ProactiveAgentBinding> => ({
      projectId,
      personaId,
      cloudAgentId: draft.cloudAgentId,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      draft
    }),
    deploy: async (): Promise<ProactiveAgentDeployResult> => ({ status: 'active' }),
    pause: async () => undefined,
    resume: async () => undefined,
    undeploy: async () => undefined,
    runs: async (_projectId: string, _personaId: string, _opts?: ProactiveAgentRunsOptions): Promise<ProactiveAgentRunsPage> => ({ runs: [] }),
    runTranscript: async (): Promise<ProactiveAgentTranscript> => ({ runId: 'mock', messages: [] }),
    onEvent: (callback: (event: ProactiveAgentEvent) => void) => noopUnsubscribe(state.proactiveAgentListeners, callback)
  },
  integrations: {
    catalog: async (): Promise<IntegrationAdapter[]> => [],
    list: async (): Promise<ConnectedIntegration[]> => [],
    authRecoveryState: async (): Promise<IntegrationAuthRecoveryState | null> => null,
    telemetry: async (): Promise<IntegrationEventTelemetrySnapshot> => ({
      totals: { eventsReceived: 0, eventsInjected: 0, eventsCoalesced: 0, eventsDropped: 0, brokerSends: 0, brokerSendsDeferred: 0, queueDepth: 0, mountCount: 0, brokerSendQueueDepth: 0 },
      projects: {}
    }),
    listMountDir: async (): Promise<FsDirEntry[]> => [],
    listRemoteDir: async (): Promise<FsDirEntry[]> => [],
    readRemoteFile: async (): Promise<FsReadPreviewResult> => ({ kind: 'missing', content: '', size: 0 }),
    readMountPreview: async (): Promise<FsReadPreviewResult> => ({ kind: 'missing', content: '', size: 0 }),
    listOptions: async (): Promise<IntegrationOption[]> => [],
    startConnect: async (_projectId: string, provider: string): Promise<IntegrationConnectSession> => ({ sessionId: `mock-${provider}`, provider, status: 'completed' }),
    pollConnect: async (sessionId: string): Promise<IntegrationConnectSession> => ({ sessionId, provider: 'mock', status: 'completed' }),
    completeConnect: async (_projectId: string, _sessionId: string, scope: Record<string, unknown>, mountPaths: string[]): Promise<ConnectedIntegration> => ({
      provider: 'mock',
      integrationId: `mock-${Date.now()}`,
      scope,
      mountPaths,
      connectedAt: new Date().toISOString(),
      notifyAgent: false
    }),
    updateScope: async (_projectId: string, integrationId: string, scope: Record<string, unknown>, mountPaths: string[]): Promise<ConnectedIntegration> => ({
      provider: 'mock',
      integrationId,
      scope,
      mountPaths,
      connectedAt: new Date().toISOString(),
      notifyAgent: false
    }),
    updateSubscription: async (_projectId: string, integrationId: string, subscribeAgent: boolean): Promise<ConnectedIntegration> => ({
      provider: 'mock',
      integrationId,
      scope: {},
      mountPaths: [],
      connectedAt: new Date().toISOString(),
      notifyAgent: false,
      subscribeAgent
    }),
    updateHistoricalDownload: async (_projectId: string, integrationId: string, downloadHistoricalData: boolean): Promise<ConnectedIntegration> => ({
      provider: 'mock',
      integrationId,
      scope: {},
      mountPaths: [],
      connectedAt: new Date().toISOString(),
      notifyAgent: false,
      downloadHistoricalData
    }),
    disconnect: async () => undefined,
    onEvent: (callback: (event: IntegrationsEvent) => void) => noopUnsubscribe(state.integrationListeners, callback)
  },
  aiHist: {
    status: async (): Promise<AiHistStatusResponse> => ({ ok: true, dbPath: '/mock/ai-hist.db' }),
    recent: async (_opts?: AiHistRecentOptions): Promise<AiHistEntry[]> => [],
    listSessions: async (_opts?: AiHistRecentOptions): Promise<AiHistSession[]> => [],
    getSession: async (): Promise<AiHistEntry[]> => [],
    search: async (): Promise<AiHistEntry[]> => [],
    searchSessions: async (): Promise<AiHistSession[]> => [],
    stats: async (): Promise<AiHistStats | null> => null,
    resumeCommand: async (_entry: AiHistResumeEntry) => null,
    reload: async () => undefined
  },
  update: {
    getState: async (): Promise<UpdaterState | null> => null,
    download: async () => undefined,
    install: async () => undefined,
    onAvailable: (callback: (info: { version: string }) => void) => noopUnsubscribe(state.updateAvailableListeners, callback),
    onProgress: (callback: (info: { percent: number }) => void) => noopUnsubscribe(state.updateProgressListeners, callback),
    onDownloaded: (callback: (info: { version: string }) => void) => noopUnsubscribe(state.updateDownloadedListeners, callback),
    onError: (callback: (info: { message: string }) => void) => noopUnsubscribe(state.updateErrorListeners, callback)
  },
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => {
    let listeners = state.menuListeners.get(channel)
    if (!listeners) {
      listeners = new Set()
      state.menuListeners.set(channel, listeners)
    }
    listeners.add(callback)
    return () => listeners?.delete(callback)
  }
}

export const pearMockHarness: PearMockHarness = {
  reset: () => {
    state = createState()
    seq = 0
  },
  injectBrokerEvent: handleInjectedBrokerEvent,
  injectBrokerEvents: (events: BrokerEventLike[]) => {
    for (const event of events) handleInjectedBrokerEvent(event)
  },
  injectPtyChunk: (projectId: string, name: string, chunk: string) => {
    const ptyKey = key(projectId, name)
    state.ptyChunks[ptyKey] = [...(state.ptyChunks[ptyKey] || []), chunk]
    for (const listener of [...state.ptyChunkListeners]) listener(projectId, name, chunk)
  },
  spawnAgents: (count: number, options?: { projectId?: string; channel?: string; namePrefix?: string }) => {
    const projectId = options?.projectId || state.activeId || defaultProject.id
    const channel = options?.channel || 'general'
    const prefix = options?.namePrefix || 'agent'
    const events: BrokerEventLike[] = []
    for (let index = 0; index < count; index += 1) {
      const name = `${prefix}-${String(index + 1).padStart(4, '0')}`
      events.push({
        kind: 'agent_spawned',
        projectId,
        name,
        cli: index % 2 === 0 ? 'codex' : 'claude',
        channels: [channel],
        event_id: `${projectId}:agent_spawned:${name}`,
        seq: ++seq
      })
    }
    pearMockHarness.injectBrokerEvents(events)
  },
  openChannel: (projectId: string, channelName: string) => {
    const listeners = state.menuListeners.get('mock:open-channel')
    for (const listener of listeners || []) listener(projectId, channelName)
  },
  openAgents: (projectId?: string) => {
    const listeners = state.menuListeners.get('mock:open-agents')
    for (const listener of listeners || []) listener(projectId)
  },
  getState: () => ({
    activeId: state.activeId,
    agents: clone(state.agents),
    events: clone(state.events),
    messages: clone(state.messages),
    ptyChunks: clone(state.ptyChunks)
  })
}
