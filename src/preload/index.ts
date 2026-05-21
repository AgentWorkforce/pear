import { contextBridge, ipcRenderer } from 'electron'

export type ViewMode = 'terminal' | 'chat' | 'graph' | 'project-settings' | 'broker-details' | 'source-control'

type AuthUser = {
  name?: string
  email?: string
  githubUsername?: string
  username?: string
  avatarUrl?: string
  cachedAvatarUrl?: string
  organizationName?: string
  projectName?: string
}

type AuthStatus = {
  loggedIn: boolean
  apiUrl?: string
  user?: AuthUser
}

const api = {
  app: {
    confirmQuit: () => ipcRenderer.invoke('app:confirm-quit') as Promise<boolean>
  },
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    add: (name: string, rootPath?: string) => ipcRenderer.invoke('project:add', name, rootPath),
    remove: (id: string) => ipcRenderer.invoke('project:remove', id),
    setActive: (id: string | null) => ipcRenderer.invoke('project:set-active', id),
    update: (id: string, update: Record<string, unknown>) =>
      ipcRenderer.invoke('project:update', id, update),
    addChannel: (projectId: string, name: string) =>
      ipcRenderer.invoke('project:add-channel', projectId, name),
    removeChannel: (projectId: string, name: string) =>
      ipcRenderer.invoke('project:remove-channel', projectId, name),
    setChannelPeople: (projectId: string, channelName: string, people: string[]) =>
      ipcRenderer.invoke('project:set-channel-people', projectId, channelName, people),
    addRoot: (projectId: string, name?: string, rootPath?: string) =>
      ipcRenderer.invoke('project:add-root', projectId, name, rootPath),
    removeRoot: (projectId: string, rootId: string) =>
      ipcRenderer.invoke('project:remove-root', projectId, rootId),
    addIntegration: (projectId: string, name: string, type?: string) =>
      ipcRenderer.invoke('project:add-integration', projectId, name, type),
    removeIntegration: (projectId: string, integrationId: string) =>
      ipcRenderer.invoke('project:remove-integration', projectId, integrationId)
  },
  broker: {
    start: (projectId: string, cwd: string, name: string, channels?: string[]) =>
      ipcRenderer.invoke('broker:start', projectId, cwd, name, channels) as Promise<boolean>,
    syncChannels: (projectId: string, channels: string[]) =>
      ipcRenderer.invoke('broker:sync-channels', projectId, channels),
    autoFixRuntime: (
      projectId: string,
      cwd: string,
      name: string,
      channels?: string[],
      errorMessage?: string
    ) => ipcRenderer.invoke('broker:auto-fix-runtime', projectId, cwd, name, channels, errorMessage) as Promise<{ removed: string[] }>,
    connectCloud: () => ipcRenderer.invoke('broker:connect-cloud') as Promise<string>,
    spawnAgent: (projectId: string, input: {
      name: string
      cli: string
      model?: string
      task?: string
      channels?: string[]
      cwd?: string
    }) => ipcRenderer.invoke('broker:spawn-agent', projectId, input),
    attachTerminal: (input: {
      projectId?: string
      name: string
      rows?: number
      cols?: number
      mode?: 'view' | 'drive' | 'passthrough'
    }) => ipcRenderer.invoke('broker:attach-terminal', input),
    sendInput: (projectId: string | undefined, name: string, data: string) =>
      ipcRenderer.invoke('broker:send-input', projectId, name, data),
    sendInputFast: (projectId: string | undefined, name: string, data: string) =>
      ipcRenderer.send('broker:send-input-fast', projectId, name, data),
    setTerminalMode: (projectId: string | undefined, name: string, mode: 'view' | 'drive' | 'passthrough') =>
      ipcRenderer.invoke('broker:set-terminal-mode', projectId, name, mode),
    getPending: (projectId: string | undefined, name: string) =>
      ipcRenderer.invoke('broker:get-pending', projectId, name),
    flushPending: (projectId: string | undefined, name: string) =>
      ipcRenderer.invoke('broker:flush-pending', projectId, name),
    resizePty: (projectId: string | undefined, name: string, rows: number, cols: number) =>
      ipcRenderer.invoke('broker:resize-pty', projectId, name, rows, cols),
    sendMessage: (projectId: string | undefined, input: { to: string; text: string; from?: string }) =>
      ipcRenderer.invoke('broker:send-message', projectId, input),
    subscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) =>
      ipcRenderer.invoke('broker:subscribe-agent-channel', projectId, name, channel),
    unsubscribeAgentChannel: (projectId: string | undefined, name: string, channel: string) =>
      ipcRenderer.invoke('broker:unsubscribe-agent-channel', projectId, name, channel),
    releaseAgent: (projectId: string | undefined, name: string) =>
      ipcRenderer.invoke('broker:release-agent', projectId, name),
    listAgents: (projectId?: string) => ipcRenderer.invoke('broker:list-agents', projectId),
    listDetails: () => ipcRenderer.invoke('broker:list-details'),
    listEvents: () => ipcRenderer.invoke('broker:list-events'),
    shutdown: () => ipcRenderer.invoke('broker:shutdown'),
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown): void => callback(event)
      ipcRenderer.on('broker:event', handler)
      return () => ipcRenderer.removeListener('broker:event', handler)
    },
    onStatus: (callback: (status: { projectId?: string; status: string; error?: string }) => void) => {
      const handler = (_: unknown, status: { projectId?: string; status: string; error?: string }): void =>
        callback(status)
      ipcRenderer.on('broker:status', handler)
      return () => ipcRenderer.removeListener('broker:status', handler)
    }
  },
  git: {
    status: (path: string) => ipcRenderer.invoke('git:status', path),
    diff: (path: string, file?: string) => ipcRenderer.invoke('git:diff', path, file),
    fileContent: (path: string, file: string, revision?: string) =>
      ipcRenderer.invoke('git:file-content', path, file, revision),
    summary: (path: string) => ipcRenderer.invoke('git:summary', path),
    branches: (root: string) => ipcRenderer.invoke('git:branches', root),
    branchDetails: (root: string) => ipcRenderer.invoke('git:branch-details', root),
    checkoutBranch: (root: string, branch: string, options?: { stashChanges?: boolean }) =>
      ipcRenderer.invoke('git:checkout-branch', root, branch, options),
    branchSyncStatus: (root: string) => ipcRenderer.invoke('git:branch-sync-status', root),
    fetchRemote: (root: string) => ipcRenderer.invoke('git:fetch-remote', root),
    pullCurrentBranch: (root: string) => ipcRenderer.invoke('git:pull-current-branch', root),
    pushCurrentBranch: (root: string) => ipcRenderer.invoke('git:push-current-branch', root),
    history: (path: string, limit?: number) => ipcRenderer.invoke('git:history', path, limit),
    show: (path: string, hash: string, file?: string) => ipcRenderer.invoke('git:show', path, hash, file),
    discardFiles: (path: string, files: string[]) =>
      ipcRenderer.invoke('git:discard-files', path, files),
    addGitignorePatterns: (path: string, patterns: string[]) =>
      ipcRenderer.invoke('git:add-gitignore-patterns', path, patterns),
    commitSelection: (path: string, input: {
      title: string
      body?: string
      wholeFiles: string[]
      patch?: string
    }) => ipcRenderer.invoke('git:commit-selection', path, input),
    generateCommitMessage: (path: string, input: { wholeFiles: string[]; patch?: string }) =>
      ipcRenderer.invoke('git:generate-commit-message', path, input)
  },
  fs: {
    listDir: (dirPath: string) => ipcRenderer.invoke('fs:list-dir', dirPath),
    readPreview: (filePath: string) => ipcRenderer.invoke('fs:read-preview', filePath),
    revealPath: (filePath: string) => ipcRenderer.invoke('fs:reveal-path', filePath)
  },
  auth: {
    login: () => ipcRenderer.invoke('auth:login') as Promise<AuthStatus>,
    logout: () => ipcRenderer.invoke('auth:logout'),
    status: () => ipcRenderer.invoke('auth:status') as Promise<AuthStatus>
  },
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_: unknown, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('pear', api)

export type PearAPI = typeof api
