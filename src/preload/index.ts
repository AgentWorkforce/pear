import { contextBridge, ipcRenderer } from 'electron'

export type ViewMode = 'terminal' | 'chat' | 'graph' | 'project-settings' | 'broker-details' | 'source-control'

type TerminalAttachMode = 'view' | 'drive' | 'passthrough'

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
    confirmQuit: () => ipcRenderer.invoke('app:confirm-quit') as Promise<boolean>
  },
  project: {
    list: () => invoke<{ projects: unknown[]; activeId: string | null }>('project:list'),
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
      invoke<unknown>('project:add-root', projectId, name, rootPath),
    removeRoot: (projectId: string, rootId: string) =>
      invoke<void>('project:remove-root', projectId, rootId),
    addIntegration: (projectId: string, name: string, type?: string) =>
      invoke<unknown>('project:add-integration', projectId, name, type),
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
    ) => invoke<{ removed: string[] }>('broker:auto-fix-runtime', projectId, cwd, name, channels, errorMessage),
    connectCloud: () => invoke<string>('broker:connect-cloud'),
    spawnAgent: (projectId: string, input: {
      name: string
      cli: string
      model?: string
      task?: string
      channels?: string[]
      cwd?: string
    }) => invoke<{ name: string; runtime: string }>('broker:spawn-agent', projectId, input),
    attachTerminal: (input: {
      projectId?: string
      name: string
      rows?: number
      cols?: number
      mode?: TerminalAttachMode
    }) => invoke<unknown>('broker:attach-terminal', input),
    sendInputFast: (projectId: string | undefined, name: string, data: string) =>
      ipcRenderer.send('broker:send-input-fast', projectId, name, data),
    setTerminalMode: (projectId: string | undefined, name: string, mode: TerminalAttachMode) =>
      invoke<unknown>('broker:set-terminal-mode', projectId, name, mode),
    getPending: (projectId: string | undefined, name: string) =>
      invoke<unknown[]>('broker:get-pending', projectId, name),
    flushPending: (projectId: string | undefined, name: string) =>
      invoke<{ flushed: number }>('broker:flush-pending', projectId, name),
    resizePty: (projectId: string | undefined, name: string, rows: number, cols: number) =>
      invoke<void>('broker:resize-pty', projectId, name, rows, cols),
    sendMessage: (projectId: string | undefined, input: { to: string; text: string; from?: string }) =>
      invoke<void>('broker:send-message', projectId, input),
    subscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) =>
      invoke<void>('broker:subscribe-agent-channel', projectId, name, channel),
    unsubscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) =>
      invoke<void>('broker:unsubscribe-agent-channel', projectId, name, channel),
    releaseAgent: (projectId: string | undefined, name: string) =>
      invoke<void>('broker:release-agent', projectId, name),
    listAgents: (projectId?: string) => invoke<unknown[]>('broker:list-agents', projectId),
    listDetails: () => invoke<unknown[]>('broker:list-details'),
    listEvents: () => invoke<unknown[]>('broker:list-events'),
    shutdown: () => invoke<void>('broker:shutdown'),
    onEvent: (callback: (event: unknown) => void) => subscribe<unknown>('broker:event', callback),
    onStatus: (callback: (status: { projectId?: string; status: string; error?: string }) => void) =>
      subscribe<{ projectId?: string; status: string; error?: string }>('broker:status', callback)
  },
  git: {
    status: (path: string) => invoke<unknown[]>('git:status', path),
    diff: (path: string, file?: string) => invoke<string>('git:diff', path, file),
    fileContent: (path: string, file: string, revision?: string) =>
      invoke<string>('git:file-content', path, file, revision),
    summary: (path: string) => invoke<unknown>('git:summary', path),
    branches: (root: string) => invoke<string[]>('git:branches', root),
    branchDetails: (root: string) => invoke<unknown[]>('git:branch-details', root),
    checkoutBranch: (root: string, branch: string, options?: { stashChanges?: boolean }) =>
      invoke<unknown>('git:checkout-branch', root, branch, options),
    branchSyncStatus: (root: string) => invoke<unknown>('git:branch-sync-status', root),
    fetchRemote: (root: string) => invoke<unknown>('git:fetch-remote', root),
    pullCurrentBranch: (root: string) => invoke<unknown>('git:pull-current-branch', root),
    pushCurrentBranch: (root: string) => invoke<unknown>('git:push-current-branch', root),
    history: (path: string, limit?: number) => invoke<unknown[]>('git:history', path, limit),
    show: (path: string, hash: string, file?: string) => invoke<string>('git:show', path, hash, file),
    discardFiles: (path: string, files: string[]) => invoke<void>('git:discard-files', path, files),
    addGitignorePatterns: (path: string, patterns: string[]) =>
      invoke<void>('git:add-gitignore-patterns', path, patterns),
    commitSelection: (path: string, input: {
      title: string
      body?: string
      wholeFiles: string[]
      patch?: string
    }) => invoke<{ hash: string }>('git:commit-selection', path, input),
    generateCommitMessage: (path: string, input: { wholeFiles: string[]; patch?: string }) =>
      invoke<unknown>('git:generate-commit-message', path, input)
  },
  fs: {
    listDir: (dirPath: string) => invoke<unknown[]>('fs:list-dir', dirPath),
    readPreview: (filePath: string) => invoke<unknown>('fs:read-preview', filePath),
    revealPath: (filePath: string) => invoke<void>('fs:reveal-path', filePath)
  },
  auth: {
    login: () => invoke<unknown>('auth:login'),
    logout: () => invoke<void>('auth:logout'),
    status: () => invoke<unknown>('auth:status')
  },
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_: unknown, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('pear', api)

export type PearAPI = typeof api
