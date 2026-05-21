import { contextBridge, ipcRenderer } from 'electron'

export type ViewMode = 'terminal' | 'chat' | 'graph' | 'project-settings' | 'account-settings' | 'broker-details' | 'source-control'

const api = {
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
    readPreview: (filePath: string) => ipcRenderer.invoke('fs:read-preview', filePath)
  },
  auth: {
    login: (input?: { apiUrl?: string }) =>
      ipcRenderer.invoke('auth:login', input) as Promise<{ loggedIn: boolean; apiUrl?: string }>,
    logout: () => ipcRenderer.invoke('auth:logout'),
    status: () => ipcRenderer.invoke('auth:status') as Promise<{ loggedIn: boolean; apiUrl?: string }>
  },
  cloudAgent: {
    list: () => ipcRenderer.invoke('cloud-agent:list'),
    create: (input: { name: string; harness: string; model: string }) =>
      ipcRenderer.invoke('cloud-agent:create', input),
    delete: (id: string) => ipcRenderer.invoke('cloud-agent:delete', id),
    attach: (projectId: string, cloudAgentId: string) =>
      ipcRenderer.invoke('cloud-agent:attach', projectId, cloudAgentId),
    detach: (projectId: string) => ipcRenderer.invoke('cloud-agent:detach', projectId),
    status: (projectId: string) => ipcRenderer.invoke('cloud-agent:status', projectId),
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown): void => callback(event)
      ipcRenderer.on('cloud-agent:event', handler)
      return () => ipcRenderer.removeListener('cloud-agent:event', handler)
    }
  },
  proactiveAgent: {
    list: (projectId: string) => ipcRenderer.invoke('proactive-agent:list', projectId),
    create: (projectId: string, draft: unknown) =>
      ipcRenderer.invoke('proactive-agent:create', projectId, draft),
    update: (projectId: string, personaId: string, draft: unknown) =>
      ipcRenderer.invoke('proactive-agent:update', projectId, personaId, draft),
    deploy: (projectId: string, personaId: string) =>
      ipcRenderer.invoke('proactive-agent:deploy', projectId, personaId),
    pause: (projectId: string, personaId: string) =>
      ipcRenderer.invoke('proactive-agent:pause', projectId, personaId),
    resume: (projectId: string, personaId: string) =>
      ipcRenderer.invoke('proactive-agent:resume', projectId, personaId),
    undeploy: (projectId: string, personaId: string) =>
      ipcRenderer.invoke('proactive-agent:undeploy', projectId, personaId),
    runs: (projectId: string, personaId: string, opts?: { limit?: number; cursor?: string }) =>
      ipcRenderer.invoke('proactive-agent:runs', projectId, personaId, opts),
    runTranscript: (runId: string) =>
      ipcRenderer.invoke('proactive-agent:run-transcript', runId),
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown): void => callback(event)
      ipcRenderer.on('proactive-agent:event', handler)
      return () => ipcRenderer.removeListener('proactive-agent:event', handler)
    }
  },
  integrations: {
    catalog: () => ipcRenderer.invoke('integrations:catalog'),
    list: (projectId: string) => ipcRenderer.invoke('integrations:list', projectId),
    startConnect: (projectId: string, provider: string) =>
      ipcRenderer.invoke('integrations:start-connect', projectId, provider),
    pollConnect: (sessionId: string) =>
      ipcRenderer.invoke('integrations:poll-connect', sessionId),
    completeConnect: (
      projectId: string,
      sessionId: string,
      scope: Record<string, unknown>,
      mountPaths: string[],
      notifyAgent: boolean
    ) => ipcRenderer.invoke(
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
    ) => ipcRenderer.invoke('integrations:update-scope', projectId, integrationId, scope, mountPaths),
    disconnect: (projectId: string, integrationId: string) =>
      ipcRenderer.invoke('integrations:disconnect', projectId, integrationId),
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown): void => callback(event)
      ipcRenderer.on('integrations:event', handler)
      return () => ipcRenderer.removeListener('integrations:event', handler)
    }
  },
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_: unknown, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('pear', api)

export type PearAPI = typeof api
