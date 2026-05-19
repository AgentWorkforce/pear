export type TerminalAttachMode = 'view' | 'drive' | 'passthrough'
export type InboundDeliveryMode = 'auto_inject' | 'manual_flush'
export type MessageInjectionMode = 'wait' | 'steer'

export interface PendingRelayMessage {
  from: string
  body: string
  target: string
  thread_id?: string
  workspace_id?: string
  workspace_alias?: string
  priority: number
  mode: MessageInjectionMode
  queued_at_ms: number
  event_id?: string
}

export interface PearAPI {
  workspace: {
    list: () => Promise<{ workspaces: unknown[]; activeId: string | null }>
    add: (name: string, rootPath?: string) => Promise<unknown>
    remove: (id: string) => Promise<void>
    setActive: (id: string | null) => Promise<void>
    update: (id: string, update: Record<string, unknown>) => Promise<void>
    addChannel: (workspaceId: string, name: string) => Promise<void>
    removeChannel: (workspaceId: string, name: string) => Promise<void>
  }
  broker: {
    start: (cwd: string, name: string, channels?: string[]) => Promise<boolean>
    syncChannels: (channels: string[]) => Promise<void>
    connectCloud: () => Promise<string>
    spawnAgent: (input: {
      name: string
      cli: string
      model?: string
      task?: string
      channels?: string[]
      cwd?: string
    }) => Promise<{ name: string; runtime: string }>
    attachTerminal: (input: {
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
    sendInput: (name: string, data: string) => Promise<{ name: string; bytes_written: number }>
    setTerminalMode: (name: string, mode: TerminalAttachMode) => Promise<{
      name: string
      mode: InboundDeliveryMode
      flushed: number
      pending: number
    }>
    getPending: (name: string) => Promise<PendingRelayMessage[]>
    flushPending: (name: string) => Promise<{ flushed: number }>
    resizePty: (name: string, rows: number, cols: number) => Promise<void>
    sendMessage: (input: { to: string; text: string; from?: string }) => Promise<void>
    releaseAgent: (name: string) => Promise<void>
    listAgents: () => Promise<string[]>
    shutdown: () => Promise<void>
    onEvent: (callback: (event: unknown) => void) => () => void
    onStatus: (callback: (status: { status: string; error?: string }) => void) => () => void
  }
  git: {
    listWorktrees: (root: string) => Promise<{ path: string; branch: string; head: string }[]>
    addWorktree: (root: string, branch: string, baseBranch?: string) => Promise<string>
    removeWorktree: (root: string, path: string) => Promise<void>
    status: (path: string) => Promise<{ path: string; status: string; staged: boolean }[]>
    diff: (path: string, file?: string) => Promise<string>
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
    login: () => Promise<{ loggedIn: boolean; apiUrl?: string; user?: { name?: string; email?: string; organizationName?: string; workspaceName?: string } }>
    logout: () => Promise<void>
    status: () => Promise<{ loggedIn: boolean; apiUrl?: string; user?: { name?: string; email?: string; organizationName?: string; workspaceName?: string } }>
  }
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => () => void
}

declare global {
  interface Window {
    pear: PearAPI
  }
}

export const pear = window.pear
