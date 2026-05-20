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
    mode: string
    uptimeSecs: number
  }
  agentCount: number
  pendingDeliveryCount: number
  agents: BrokerAgentDetails[]
  error?: string
}

export interface GitSummary {
  branch: string
  additions: number
  deletions: number
}

export interface PearAPI {
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
    connectCloud: () => Promise<string>
    spawnAgent: (projectId: string, input: {
      name: string
      cli: string
      model?: string
      task?: string
      channels?: string[]
      cwd?: string
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
    sendInput: (projectId: string | undefined, name: string, data: string) => Promise<{ name: string; bytes_written: number }>
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
    shutdown: () => Promise<void>
    onEvent: (callback: (event: unknown) => void) => () => void
    onStatus: (callback: (status: { projectId?: string; status: string; error?: string }) => void) => () => void
  }
  git: {
    status: (path: string) => Promise<{ path: string; status: string; staged: boolean }[]>
    diff: (path: string, file?: string) => Promise<string>
    summary: (path: string) => Promise<GitSummary | null>
    branches: (root: string) => Promise<string[]>
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
  }
  auth: {
    login: () => Promise<{ loggedIn: boolean; apiUrl?: string; user?: { name?: string; email?: string; organizationName?: string; projectName?: string } }>
    logout: () => Promise<void>
    status: () => Promise<{ loggedIn: boolean; apiUrl?: string; user?: { name?: string; email?: string; organizationName?: string; projectName?: string } }>
  }
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => () => void
}

declare global {
  interface Window {
    pear: PearAPI
  }
}

export const pear = window.pear
