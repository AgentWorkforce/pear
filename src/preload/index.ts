import { contextBridge, ipcRenderer } from 'electron'

export type ViewMode = 'terminal' | 'chat' | 'graph'

const api = {
  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    add: (name: string, rootPath?: string) => ipcRenderer.invoke('workspace:add', name, rootPath),
    remove: (id: string) => ipcRenderer.invoke('workspace:remove', id),
    setActive: (id: string | null) => ipcRenderer.invoke('workspace:set-active', id),
    update: (id: string, update: Record<string, unknown>) =>
      ipcRenderer.invoke('workspace:update', id, update),
    addChannel: (workspaceId: string, name: string) =>
      ipcRenderer.invoke('workspace:add-channel', workspaceId, name),
    removeChannel: (workspaceId: string, name: string) =>
      ipcRenderer.invoke('workspace:remove-channel', workspaceId, name)
  },
  broker: {
    start: (cwd: string, name: string, channels?: string[]) =>
      ipcRenderer.invoke('broker:start', cwd, name, channels) as Promise<boolean>,
    syncChannels: (channels: string[]) => ipcRenderer.invoke('broker:sync-channels', channels),
    connectCloud: () => ipcRenderer.invoke('broker:connect-cloud') as Promise<string>,
    spawnAgent: (input: {
      name: string
      cli: string
      model?: string
      task?: string
      channels?: string[]
      cwd?: string
    }) => ipcRenderer.invoke('broker:spawn-agent', input),
    attachTerminal: (input: {
      name: string
      rows?: number
      cols?: number
      mode?: 'view' | 'drive' | 'passthrough'
    }) => ipcRenderer.invoke('broker:attach-terminal', input),
    sendInput: (name: string, data: string) => ipcRenderer.invoke('broker:send-input', name, data),
    resizePty: (name: string, rows: number, cols: number) =>
      ipcRenderer.invoke('broker:resize-pty', name, rows, cols),
    sendMessage: (input: { to: string; text: string; from?: string }) =>
      ipcRenderer.invoke('broker:send-message', input),
    releaseAgent: (name: string) => ipcRenderer.invoke('broker:release-agent', name),
    listAgents: () => ipcRenderer.invoke('broker:list-agents'),
    shutdown: () => ipcRenderer.invoke('broker:shutdown'),
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown): void => callback(event)
      ipcRenderer.on('broker:event', handler)
      return () => ipcRenderer.removeListener('broker:event', handler)
    },
    onStatus: (callback: (status: { status: string; error?: string }) => void) => {
      const handler = (_: unknown, status: { status: string; error?: string }): void =>
        callback(status)
      ipcRenderer.on('broker:status', handler)
      return () => ipcRenderer.removeListener('broker:status', handler)
    }
  },
  git: {
    listWorktrees: (root: string) => ipcRenderer.invoke('git:list-worktrees', root),
    addWorktree: (root: string, branch: string, baseBranch?: string) =>
      ipcRenderer.invoke('git:add-worktree', root, branch, baseBranch),
    removeWorktree: (root: string, path: string) =>
      ipcRenderer.invoke('git:remove-worktree', root, path),
    status: (path: string) => ipcRenderer.invoke('git:status', path),
    diff: (path: string, file?: string) => ipcRenderer.invoke('git:diff', path, file),
    branches: (root: string) => ipcRenderer.invoke('git:branches', root)
  },
  fs: {
    listDir: (dirPath: string) => ipcRenderer.invoke('fs:list-dir', dirPath),
    readPreview: (filePath: string) => ipcRenderer.invoke('fs:read-preview', filePath)
  },
  auth: {
    login: () => ipcRenderer.invoke('auth:login') as Promise<{ loggedIn: boolean; apiUrl?: string }>,
    logout: () => ipcRenderer.invoke('auth:logout'),
    status: () => ipcRenderer.invoke('auth:status') as Promise<{ loggedIn: boolean; apiUrl?: string }>
  },
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_: unknown, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('pear', api)

export type PearAPI = typeof api
