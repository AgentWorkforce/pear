import {
  classifyBrokerEvent,
  type AgentReleasedEvent,
  type AgentSpawnedEvent,
  type RelayInboundEvent
} from '@shared/schemas/broker-events'
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
  FactoryNodeConfig,
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
  ObserverTokenResult,
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
import { getTerminalRuntime } from '@/lib/terminal-runtime-registry'

type BrokerEventLike = Record<string, unknown> & {
  kind: string
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
  ptyChunkListeners: Set<(
    projectId: string,
    name: string,
    chunk: string,
    offset?: number,
    generation?: number
  ) => void>
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
  injectPtyChunk: (
    projectId: string,
    name: string,
    chunk: string,
    offset?: number,
    generation?: number
  ) => void
  // Rendering-harness knobs: force the input SRTT the renderer polls (so the
  // predictive-echo engine route engages) and echo typed bytes back through
  // the PTY stream after a delay (so predictions reconcile end-to-end).
  setInputSrtt: (ms: number | null) => void
  setInputEcho: (options: { delayMs: number } | null) => void
  // Model a DECSET ?1004 (focus-reporting) TUI like Claude Code's Ink UI:
  // when set, every focus report the renderer emits to the PTY (\x1b[I focus-in
  // or \x1b[O focus-out) makes the program re-commit `frame` to the stream.
  // Spurious focus reports therefore stack duplicate frames — the exact
  // terminal-duplication vector under test. Pass null to disable.
  setFocusRedraw: (frame: string | null) => void
  spawnAgents: (count: number, options?: { projectId?: string; channel?: string; namePrefix?: string }) => void
  openChannel: (projectId: string, channelName: string) => void
  openAgents: (projectId?: string) => void
  getTerminalBufferText: (projectId: string, name: string) => string | null
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
    agents: [
      {
        name: 'implementer',
        projectId: defaultProject.id,
        runtime: 'mock',
        cli: 'codex',
        model: 'gpt-5',
        channels: ['general'],
        current_state: 'working',
        inboundDeliveryMode: 'auto_inject',
        last_activity_ms: 90_000
      },
      {
        name: 'claude-1',
        projectId: defaultProject.id,
        runtime: 'mock',
        cli: 'claude',
        model: 'claude-sonnet',
        channels: ['general'],
        current_state: 'working',
        inboundDeliveryMode: 'auto_inject',
        last_activity_ms: 180_000
      },
      {
        name: 'codex-2',
        projectId: defaultProject.id,
        runtime: 'mock',
        cli: 'codex',
        model: 'gpt-5',
        channels: ['general'],
        current_state: 'working',
        inboundDeliveryMode: 'auto_inject',
        last_activity_ms: 260_000
      }
    ],
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
// Rendering-harness knobs (setInputSrtt / setInputEcho): survive reset() so
// a spec can configure them before booting agents.
let mockInputSrttMs: number | null = null
let mockInputEchoDelayMs: number | null = null
// See PearMockHarness.setFocusRedraw. Null = no focus-reactive TUI modeled.
let mockFocusRedrawFrame: string | null = null

const mockNow = new Date('2026-06-09T09:42:00.000Z').getTime()

function isoMinutesAgo(minutes: number): string {
  return new Date(mockNow - minutes * 60_000).toISOString()
}

const mockLinearIssues: Array<Record<string, unknown>> = [
  {
    id: 'lin-pear-145',
    identifier: 'PEAR-145',
    title: 'Review writeMount IPC contract before renderer actions',
    description: 'Phase 2 can only land once the renderer write primitive is narrow, schema-aware, and safe for integration writeback files.',
    priority: 1,
    url: 'https://linear.app/agent-workforce/issue/PEAR-145/review-writemount-ipc-contract',
    stateId: 'state-in-review',
    state: { id: 'state-in-review', name: 'In review', type: 'started', color: '#e6d78d' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center', url: 'https://linear.app/agent-workforce/project/issue-control-center' },
    labels: [
      { id: 'label-human', name: 'human', color: '#f0727f' },
      { id: 'label-review', name: 'review gate', color: '#e6d78d' }
    ],
    labelIds: ['label-human', 'label-review'],
    assigneeId: 'agent-implementer',
    assignee: { id: 'agent-implementer', name: 'implementer', email: 'implementer@agents.local' },
    syncedWith: [
      { id: 'gh-pr-182', service: 'github', metadata: { owner: 'AgentWorkforce', repo: 'pear', number: 182, type: 'pull_request' } }
    ],
    updatedAt: isoMinutesAgo(4),
    attention: { kind: 'review', label: 'Review PR #182', action: 'Approve or reject' },
    agentSession: {
      agentName: 'implementer',
      trajectoryId: 'traj_issue_control_write_mount',
      latestMessage: 'I narrowed writeMount to selected mount roots; one preload type mismatch is left.',
      recentMessages: [
        'I narrowed writeMount to selected mount roots; one preload type mismatch is left.',
        'The action buttons are still inert in Phase 1, so this is read-path only.',
        'I am checking schema readOnly fields before proposing the write payload.'
      ]
    }
  },
  {
    id: 'lin-pear-149',
    identifier: 'PEAR-149',
    title: 'Choose auth recovery wording for stalled integration mounts',
    description: 'The agent needs the human-facing copy for a cloud auth recovery banner that appears when writebacks are queued behind expired credentials.',
    priority: 2,
    url: 'https://linear.app/agent-workforce/issue/PEAR-149/auth-recovery-wording',
    stateId: 'state-planning',
    state: { id: 'state-planning', name: 'Planning', type: 'unstarted', color: '#94cbef' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center' },
    labels: [
      { id: 'label-human', name: 'human', color: '#f0727f' },
      { id: 'label-question', name: 'agent question', color: '#c9a7ff' }
    ],
    labelIds: ['label-human', 'label-question'],
    assigneeId: 'agent-claude-1',
    assignee: { id: 'agent-claude-1', name: 'claude-1', email: 'claude-1@agents.local' },
    syncedWith: [],
    updatedAt: isoMinutesAgo(8),
    attention: { kind: 'question', label: 'Which auth flow?', action: 'Reply' },
    agentSession: {
      agentName: 'claude-1',
      trajectoryId: 'traj_auth_copy',
      latestMessage: 'I have two banner variants ready; I need the product voice call before wiring copy.',
      recentMessages: [
        'I have two banner variants ready; I need the product voice call before wiring copy.',
        'Short copy fits the status bar, long copy explains queued writebacks.',
        'I am holding implementation until wording is picked.'
      ]
    }
  },
  {
    id: 'lin-pear-152',
    identifier: 'PEAR-152',
    title: 'Unblock Linear issue mount selection for inbox prototype',
    description: 'The current project scope exposes Linear teams but not /linear/issues, so the real mount proof is blocked until the issue resource is selected.',
    priority: 1,
    url: 'https://linear.app/agent-workforce/issue/PEAR-152/linear-issue-mount-selection',
    stateId: 'state-in-progress',
    state: { id: 'state-in-progress', name: 'In Progress', type: 'started', color: '#6bd4bc' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center' },
    labels: [
      { id: 'label-human', name: 'human', color: '#f0727f' },
      { id: 'label-blocked', name: 'blocked', color: '#f0727f' }
    ],
    labelIds: ['label-human', 'label-blocked'],
    assigneeId: 'agent-implementer',
    assignee: { id: 'agent-implementer', name: 'implementer', email: 'implementer@agents.local' },
    syncedWith: [],
    updatedAt: isoMinutesAgo(12),
    attention: { kind: 'block', label: 'Mount scope blocked', action: 'Fork or unblock' },
    agentSession: {
      agentName: 'implementer',
      trajectoryId: 'traj_linear_mount_scope',
      latestMessage: 'I can render from mocks now; real Linear records need /linear/issues added to scope.',
      recentMessages: [
        'I can render from mocks now; real Linear records need /linear/issues added to scope.',
        'The read IPC is wired, but the current scope guard rejects the issue path.',
        'I am keeping the component API identical so the real mount drops in later.'
      ]
    }
  },
  {
    id: 'lin-pear-160',
    identifier: 'PEAR-160',
    title: 'Implement broker webhook retry queue for writeback failures',
    description: 'Build a relay-side retry queue that re-delivers failed webhook writeback commands after transient broker errors clear.',
    priority: 2,
    url: 'https://linear.app/agent-workforce/issue/PEAR-160/writeback-retry-queue',
    stateId: 'state-ready-for-agent',
    state: { id: 'state-ready-for-agent', name: 'Ready for Agent', type: 'unstarted', color: '#c9a7ff' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center' },
    labels: [
      { id: 'label-agent', name: 'agent', color: '#6bd4bc' },
      { id: 'label-ready-for-agent', name: 'ready-for-agent', color: '#c9a7ff' }
    ],
    labelIds: ['label-agent', 'label-ready-for-agent'],
    syncedWith: [],
    updatedAt: isoMinutesAgo(15),
    agentSession: {}
  },
  {
    id: 'lin-pear-162',
    identifier: 'PEAR-162',
    title: 'Add schema validation for mount writeback payloads',
    description: 'Validate every writeback payload against the provider schema before queueing, rejecting malformed writes at the edge.',
    priority: 1,
    url: 'https://linear.app/agent-workforce/issue/PEAR-162/schema-validation-writeback',
    stateId: 'state-to-do',
    state: { id: 'state-to-do', name: 'To do', type: 'unstarted', color: '#94cbef' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center' },
    labels: [
      { id: 'label-agent', name: 'agent', color: '#6bd4bc' },
      { id: 'label-ready-for-agent', name: 'ready-for-agent', color: '#c9a7ff' }
    ],
    labelIds: ['label-agent', 'label-ready-for-agent'],
    syncedWith: [],
    updatedAt: isoMinutesAgo(20),
    agentSession: {}
  },
  {
    id: 'lin-pear-148',
    identifier: 'PEAR-148',
    title: 'Build Attention Inbox web prototype',
    description: 'Ship the web-first read-only Attention Inbox backed by mock Linear and GitHub records.',
    priority: 1,
    url: 'https://linear.app/agent-workforce/issue/PEAR-148/attention-inbox-web-prototype',
    stateId: 'state-in-progress',
    state: { id: 'state-in-progress', name: 'In Progress', type: 'started', color: '#6bd4bc' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center' },
    labels: [
      { id: 'label-agent', name: 'agent', color: '#6bd4bc' }
    ],
    labelIds: ['label-agent'],
    assigneeId: 'agent-implementer',
    assignee: { id: 'agent-implementer', name: 'implementer', email: 'implementer@agents.local' },
    syncedWith: [
      { id: 'gh-issue-184', service: 'github', metadata: { owner: 'AgentWorkforce', repo: 'pear', number: 184, type: 'issue' } }
    ],
    updatedAt: isoMinutesAgo(2),
    agentSession: {
      agentName: 'implementer',
      trajectoryId: 'traj_attention_inbox',
      latestMessage: 'I am wiring the inbox into the existing shell and keeping the L1 cards down to one line.',
      recentMessages: [
        'I am wiring the inbox into the existing shell and keeping the L1 cards down to one line.',
        'Mock fixtures are realistic enough to exercise the browser build.',
        'Next I am checking the collapsed in-motion band and detail panel.'
      ]
    }
  },
  {
    id: 'lin-pear-151',
    identifier: 'PEAR-151',
    title: 'Add renderer refresh guard for replayed integration events',
    description: 'The issue store should coalesce duplicate relayfile-change callbacks and ignore stale subscription generations.',
    priority: 2,
    url: 'https://linear.app/agent-workforce/issue/PEAR-151/renderer-refresh-guard',
    stateId: 'state-to-do',
    state: { id: 'state-to-do', name: 'To do', type: 'unstarted', color: '#94cbef' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center' },
    labels: [
      { id: 'label-agent', name: 'agent', color: '#6bd4bc' }
    ],
    labelIds: ['label-agent'],
    assigneeId: 'agent-codex-2',
    assignee: { id: 'agent-codex-2', name: 'codex-2', email: 'codex-2@agents.local' },
    syncedWith: [],
    updatedAt: isoMinutesAgo(26),
    agentSession: {
      agentName: 'codex-2',
      trajectoryId: 'traj_refresh_guard',
      latestMessage: 'I am adding a generation token so stale refresh callbacks cannot repaint old issue data.',
      recentMessages: [
        'I am adding a generation token so stale refresh callbacks cannot repaint old issue data.',
        'The store will debounce path-level events into one reload.',
        'I am leaving telemetry for suppressed duplicates to Phase 2.'
      ]
    }
  },
  {
    id: 'lin-pear-153',
    identifier: 'PEAR-153',
    title: 'Normalize GitHub sync metadata for PR health chips',
    description: 'Use Linear syncedWith metadata to read linked GitHub records and surface PR state without making GitHub the issue source of truth.',
    priority: 3,
    url: 'https://linear.app/agent-workforce/issue/PEAR-153/github-sync-health',
    stateId: 'state-in-review',
    state: { id: 'state-in-review', name: 'In review', type: 'started', color: '#e6d78d' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-control-center',
    project: { id: 'project-control-center', name: 'Issue Control Center' },
    labels: [
      { id: 'label-agent', name: 'agent', color: '#6bd4bc' }
    ],
    labelIds: ['label-agent'],
    assigneeId: 'agent-codex-2',
    assignee: { id: 'agent-codex-2', name: 'codex-2', email: 'codex-2@agents.local' },
    syncedWith: [
      { id: 'gh-pr-186', service: 'github', metadata: { owner: 'AgentWorkforce', repo: 'pear', number: 186, type: 'pull_request' } }
    ],
    updatedAt: isoMinutesAgo(31),
    agentSession: {
      agentName: 'codex-2',
      trajectoryId: 'traj_github_sync',
      latestMessage: 'I found the GitHub join path and I am making missing PR records degrade quietly.',
      recentMessages: [
        'I found the GitHub join path and I am making missing PR records degrade quietly.',
        'The card gets a PR chip only after readRemoteFile returns text.',
        'CI state stays in detail so the overview does not turn into a dashboard.'
      ]
    }
  },
  {
    id: 'lin-pear-140',
    identifier: 'PEAR-140',
    title: 'Ship duplicate PTY chunk suppression',
    description: 'Main and renderer both suppress repeated worker_stream chunks before they reach terminal buffers.',
    priority: 2,
    url: 'https://linear.app/agent-workforce/issue/PEAR-140/pty-duplicate-suppression',
    stateId: 'state-merged',
    state: { id: 'state-merged', name: 'Merged', type: 'completed', color: '#6ee7a8' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-pty-hardening',
    project: { id: 'project-pty-hardening', name: 'PTY Hardening' },
    labels: [
      { id: 'label-agent', name: 'agent', color: '#6bd4bc' }
    ],
    labelIds: ['label-agent'],
    assigneeId: 'agent-claude-1',
    assignee: { id: 'agent-claude-1', name: 'claude-1', email: 'claude-1@agents.local' },
    syncedWith: [
      { id: 'gh-pr-177', service: 'github', metadata: { owner: 'AgentWorkforce', repo: 'pear', number: 177, type: 'pull_request' } }
    ],
    updatedAt: isoMinutesAgo(74),
    completedAt: isoMinutesAgo(72),
    agentSession: {
      agentName: 'claude-1',
      trajectoryId: 'traj_pty_dedupe',
      latestMessage: 'Merged with renderer guardrails intact; the remaining work is telemetry polish.',
      recentMessages: [
        'Merged with renderer guardrails intact; the remaining work is telemetry polish.',
        'The replay case is covered in the broker tests.',
        'I moved the follow-up into the inbox instead of expanding this PR.'
      ]
    }
  },
  {
    id: 'lin-pear-136',
    identifier: 'PEAR-136',
    title: 'Document integration writeback discovery rules',
    description: 'Clarify that agents read schemas in discovery but create command files only under provider writeback roots.',
    priority: 3,
    url: 'https://linear.app/agent-workforce/issue/PEAR-136/writeback-discovery-rules',
    stateId: 'state-done',
    state: { id: 'state-done', name: 'Done', type: 'completed', color: '#6ee7a8' },
    teamId: 'team-pear',
    team: { id: 'team-pear', key: 'PEAR', name: 'Pear' },
    projectId: 'project-integrations',
    project: { id: 'project-integrations', name: 'Integrations' },
    labels: [
      { id: 'label-human', name: 'human', color: '#f0727f' }
    ],
    labelIds: ['label-human'],
    assigneeId: 'agent-docs',
    assignee: { id: 'agent-docs', name: 'docs-agent', email: 'docs-agent@agents.local' },
    syncedWith: [],
    updatedAt: isoMinutesAgo(190),
    completedAt: isoMinutesAgo(188),
    agentSession: {
      agentName: 'docs-agent',
      trajectoryId: 'traj_writeback_docs',
      latestMessage: 'Settled: discovery stays schema-only, provider roots carry the writeback files.',
      recentMessages: [
        'Settled: discovery stays schema-only, provider roots carry the writeback files.',
        'The examples now call out readOnly fields explicitly.'
      ]
    }
  }
]

const mockGithubRecords: Record<string, Record<string, unknown>> = {
  '/github/repos/AgentWorkforce/pear/issues/182.json': {
    id: 182,
    number: 182,
    title: 'Review writeMount IPC contract before renderer actions',
    html_url: 'https://github.com/AgentWorkforce/pear/pull/182',
    state: 'open',
    pull_request: { url: 'https://api.github.com/repos/AgentWorkforce/pear/pulls/182' },
    labels: [{ name: 'integration' }, { name: 'needs-review' }],
    checks: { conclusion: 'pending', summary: '2 checks running' }
  },
  '/github/repos/AgentWorkforce/pear/issues/184.json': {
    id: 184,
    number: 184,
    title: 'Attention Inbox browser prototype',
    html_url: 'https://github.com/AgentWorkforce/pear/issues/184',
    state: 'open',
    labels: [{ name: 'prototype' }, { name: 'frontend' }],
    checks: { conclusion: 'success', summary: 'mock issue' }
  },
  '/github/repos/AgentWorkforce/pear/issues/186.json': {
    id: 186,
    number: 186,
    title: 'Normalize GitHub sync metadata for PR health chips',
    html_url: 'https://github.com/AgentWorkforce/pear/pull/186',
    state: 'open',
    pull_request: { url: 'https://api.github.com/repos/AgentWorkforce/pear/pulls/186' },
    labels: [{ name: 'github' }],
    checks: { conclusion: 'failure', summary: '1 check failing' }
  },
  '/github/repos/AgentWorkforce/pear/issues/177.json': {
    id: 177,
    number: 177,
    title: 'Ship duplicate PTY chunk suppression',
    html_url: 'https://github.com/AgentWorkforce/pear/pull/177',
    state: 'closed',
    pull_request: { merged_at: isoMinutesAgo(72) },
    labels: [{ name: 'duplicate-hardening' }],
    checks: { conclusion: 'success', summary: 'all checks passed' }
  }
}

// Mirrors the materialized `/linear/states` resource (adapter-linear `states`).
const mockLinearStates: Array<Record<string, unknown>> = [
  { id: 'state-planning', name: 'Planning', type: 'unstarted', color: '#9aa0aa', position: 0 },
  { id: 'state-to-do', name: 'To do', type: 'unstarted', color: '#9aa0aa', position: 1 },
  { id: 'state-ready-for-agent', name: 'Ready for Agent', type: 'unstarted', color: '#b083f0', position: 2 },
  { id: 'state-in-progress', name: 'In Progress', type: 'started', color: '#5a8de6', position: 3 },
  { id: 'state-in-review', name: 'In review', type: 'started', color: '#e6d78d', position: 4 },
  { id: 'state-merged', name: 'Merged', type: 'completed', color: '#6cc36c', position: 5 },
  { id: 'state-done', name: 'Done', type: 'completed', color: '#6cc36c', position: 6 }
]

const mockRemoteFiles: Record<string, Record<string, unknown> | string> = Object.fromEntries([
  ...mockLinearIssues.map((issue) => [
    `/linear/issues/${String(issue.identifier)}.json`,
    issue
  ]),
  ...mockLinearStates.map((state) => [`/linear/states/${String(state.id)}.json`, state]),
  ...Object.entries(mockGithubRecords)
])

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T
}

function noopUnsubscribe<T>(set: Set<T>, item: T): () => void {
  set.add(item)
  return () => set.delete(item)
}

function normalizeMockRemotePath(path: string): string {
  const segments = path.split('/').map((segment) => segment.trim()).filter(Boolean)
  return `/${segments.join('/')}`
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
  const classification = classifyBrokerEvent(normalized)
  if (classification.status === 'malformed') {
    throw new Error(`ipc-mock: malformed broker event (kind=${classification.kind ?? 'none'}): ${classification.reason}`)
  }
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
    joinWorkspace: async (
      projectId: string,
      _cwd: string,
      _name: string,
      _channels: string[] | undefined,
      workspaceKey: string
    ) => {
      if (!workspaceKey.trim()) {
        throw new Error('Workspace key is required')
      }
      emitBrokerStatus({ projectId, status: 'connected' })
      return true
    },
    mintObserverToken: async (projectId: string): Promise<ObserverTokenResult> => ({
      token: `ot_live_mock_${projectId}`,
      id: `mock-observer-token-${projectId}`
    }),
    autoFixRuntime: async () => ({ removed: [] }),
    connectCloud: async () => 'mock-cloud',
    spawnAgent: async (projectId: string, input: BrokerSpawnAgentInput): Promise<BrokerSpawnAgentResult> => {
      const agent = upsertAgent({ ...input, projectId, runtime: 'mock', current_state: 'idle' })
      handleInjectedBrokerEvent({
        kind: 'agent_spawned',
        name: agent.name,
        runtime: agent.runtime || 'mock',
        cli: agent.cli,
        model: agent.model,
        projectId,
        channels: agent.channels,
        event_id: `${projectId}:agent:${agent.name}`
      } satisfies AgentSpawnedEvent)
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
    sendInputFast: (projectId: string | undefined, name: string, data: string) => {
      const resolvedProject = projectId || state.activeId || defaultProject.id
      // Focus-reactive TUI model (setFocusRedraw): re-commit the frame on every
      // focus report the renderer emits. Synchronous so the stacked frame is in
      // the buffer by the time the harness reads it; faithful to a ?1004 TUI
      // that redraws when told "the user just looked at me / away".
      if (mockFocusRedrawFrame !== null && (data.includes('\x1b[I') || data.includes('\x1b[O'))) {
        pearMockHarness.injectPtyChunk(resolvedProject, name, mockFocusRedrawFrame)
      }
      // Optional raw echo back through the PTY stream (setInputEcho) so the
      // rendering harnesses can exercise predictive echo end-to-end: type →
      // optimistic glyph → delayed authoritative echo → reconcile.
      if (mockInputEchoDelayMs === null) return
      setTimeout(() => {
        pearMockHarness.injectPtyChunk(resolvedProject, name, data)
      }, mockInputEchoDelayMs)
    },
    setTerminalMode: async (projectId: string | undefined, name: string, mode: TerminalAttachMode): Promise<BrokerSetTerminalModeResult> => {
      state.terminalModes.set(key(projectId, name), mode)
      return { name, mode: mode === 'drive' ? 'manual_flush' : 'auto_inject', flushed: 0, pending: 0 }
    },
    getPending: async (): Promise<PendingRelayMessage[]> => [],
    flushPending: async () => ({ flushed: 0 }),
    resizePty: async () => undefined,
    // No authoritative PTY emulation behind the mock: the reconciler treats
    // null as "skip this check", so it stays dormant in web/harness builds.
    snapshotTerminal: async () => null,
    inputSrtt: async () => mockInputSrttMs,
    sendMessage: async (projectId: string | undefined, input: BrokerSendMessageInput) => {
      handleInjectedBrokerEvent({
        kind: 'relay_inbound',
        event_id: `${projectId || 'mock'}:human:${++seq}`,
        from: input.from || 'human',
        target: input.to,
        body: input.text,
        projectId
      } satisfies RelayInboundEvent)
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
      handleInjectedBrokerEvent({ kind: 'agent_released', name, projectId, event_id: `${projectId || 'mock'}:released:${name}` } satisfies AgentReleasedEvent)
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
    onPtyChunk: (callback: (
      projectId: string,
      name: string,
      chunk: string,
      offset?: number,
      generation?: number
    ) => void) =>
      noopUnsubscribe(state.ptyChunkListeners, callback),
    onStatus: (callback: (status: BrokerStatusEvent) => void) => noopUnsubscribe(state.brokerStatusListeners, callback),
    checkCliAvailable: async (_cli: string) => true
  },
  factory: {
    status: async () => ({
      source: 'cloud' as const,
      state: 'empty' as const,
      connected: true,
      workspaceId: 'mock',
      cloudUrl: 'https://agentrelay.com/cloud',
      updatedAt: new Date().toISOString(),
      message: 'Mock cloud factory has no active work',
      agents: [],
      issues: []
    }),
    readConfig: async (configPath?: string) => ({
      configPath: configPath || 'factory.config.json',
      exists: true,
      config: {
        workspaceId: 'mock',
        capabilities: ['spawn:claude', 'spawn:codex'],
        cloneRoot: '/mock/workspaces',
        clonePaths: {},
        dryRun: false
      },
      errors: []
    }),
    saveConfig: async (config: unknown, configPath?: string) => {
      const record = config && typeof config === 'object' && !Array.isArray(config)
        ? config as Partial<FactoryNodeConfig>
        : {}
      return {
        configPath: configPath || 'factory.config.json',
        exists: true,
        config: {
          workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : undefined,
          capabilities: Array.isArray(record.capabilities) ? record.capabilities : [],
          cloneRoot: typeof record.cloneRoot === 'string' ? record.cloneRoot : undefined,
          clonePaths: record.clonePaths && typeof record.clonePaths === 'object' ? record.clonePaths : {},
          dryRun: typeof record.dryRun === 'boolean' ? record.dryRun : false
        },
        errors: []
      }
    }
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
    generateCommitMessage: async (_projectId: string, _path: string, _input: GitGenerateCommitMessageInput): Promise<GitCommitDraft> => ({ title: 'Mock commit', body: '' })
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
      totals: { eventsReceived: 0, eventsInjected: 0, eventsCoalesced: 0, eventsDropped: 0, eventsSelfEchoSuppressed: 0, brokerSends: 0, brokerSendsDeferred: 0, queueDepth: 0, mountCount: 0, brokerSendQueueDepth: 0 },
      projects: {}
    }),
    listMountDir: async (): Promise<FsDirEntry[]> => [],
    listRemoteDir: async (_projectId: string, remotePath: string): Promise<FsDirEntry[]> => {
      const normalized = normalizeMockRemotePath(remotePath)
      if (normalized === '/linear/issues') {
        return mockLinearIssues.map((issue) => {
          const identifier = String(issue.identifier)
          return {
            name: `${identifier}.json`,
            path: `/linear/issues/${identifier}.json`,
            type: 'file'
          }
        })
      }

      if (normalized === '/linear/states') {
        return mockLinearStates.map((state) => ({
          name: `${String(state.id)}.json`,
          path: `/linear/states/${String(state.id)}.json`,
          type: 'file'
        }))
      }

      if (normalized === '/github/repos/AgentWorkforce/pear/issues') {
        return Object.keys(mockGithubRecords).map((path) => ({
          name: path.split('/').at(-1) || path,
          path,
          type: 'file'
        }))
      }

      return []
    },
    readRemoteFile: async (_projectId: string, remotePath: string): Promise<FsReadPreviewResult> => {
      const normalized = normalizeMockRemotePath(remotePath)
      const record = mockRemoteFiles[normalized]
      if (!record) return { kind: 'missing', content: '', size: 0 }
      const content = typeof record === 'string' ? record : JSON.stringify(record, null, 2)
      return { kind: 'text', content, size: content.length }
    },
    writeRemoteFile: async (_projectId: string, remotePath: string, content: string): Promise<void> => {
      const normalized = normalizeMockRemotePath(remotePath)
      console.log('[ipc-mock] writeRemoteFile', normalized, content.length, 'bytes')
      // Mirror the adapter's Edit/PATCH semantics for canonical issue records:
      // merge the included mutable fields (e.g. { stateId }) into the existing
      // record and re-derive the embedded `state` so a reload reflects the move.
      const existing = mockRemoteFiles[normalized]
      const issueMatch = /^\/linear\/issues\/[^/]+\.json$/.test(normalized)
      if (issueMatch && existing && typeof existing !== 'string') {
        try {
          const patch = JSON.parse(content) as Record<string, unknown>
          const merged = { ...existing, ...patch }
          if (typeof patch.stateId === 'string') {
            const state = mockLinearStates.find((candidate) => candidate.id === patch.stateId)
            if (state) merged.state = state
          }
          mockRemoteFiles[normalized] = merged
          return
        } catch {
          // fall through to raw write on unparseable payloads
        }
      }
      mockRemoteFiles[normalized] = content
    },
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
  injectPtyChunk: (projectId, name, chunk, offset, generation) => {
    const ptyKey = key(projectId, name)
    state.ptyChunks[ptyKey] = [...(state.ptyChunks[ptyKey] || []), chunk]
    for (const listener of [...state.ptyChunkListeners]) {
      listener(projectId, name, chunk, offset, generation)
    }
  },
  setInputSrtt: (ms: number | null) => {
    mockInputSrttMs = ms
  },
  setInputEcho: (options: { delayMs: number } | null) => {
    mockInputEchoDelayMs = options ? options.delayMs : null
  },
  setFocusRedraw: (frame: string | null) => {
    mockFocusRedrawFrame = frame
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
        name,
        runtime: 'mock',
        cli: index % 2 === 0 ? 'codex' : 'claude',
        projectId,
        channels: [channel],
        event_id: `${projectId}:agent_spawned:${name}`,
        seq: ++seq
      } satisfies AgentSpawnedEvent)
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
  getTerminalBufferText: (projectId: string, name: string) => {
    const runtime = getTerminalRuntime(key(projectId, name))
    if (!runtime) return null

    const buffer = runtime.term.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  },
  getState: () => ({
    activeId: state.activeId,
    agents: clone(state.agents),
    events: clone(state.events),
    messages: clone(state.messages),
    ptyChunks: clone(state.ptyChunks)
  })
}
