import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { resolve } from 'path'
import type { SpawnPtyInput, SendMessageInput } from '@agent-relay/sdk'
import {
  loadStore,
  addProject,
  removeProject,
  setActiveProject,
  updateProject,
  addProjectChannel,
  removeProjectChannel,
  setProjectChannelPeople,
  addProjectRoot,
  removeProjectRoot,
  addProjectIntegration,
  removeProjectIntegration
} from './store'
import { brokerManager } from './broker'
import * as git from './git'
import * as filesystem from './filesystem'
import * as auth from './auth'
import { assertDirectory, isDirectory } from './path-utils'

function getProjectIdForPath(targetPath: string): string | null {
  const resolved = resolve(targetPath)
  const { projects } = loadStore()
  const project = projects.find((candidate) =>
    candidate.roots.some((root) => {
      const rootPath = resolve(root.path)
      return resolved.startsWith(rootPath + '/') || resolved === rootPath
    })
  )
  return project?.id || null
}

function assertPathWithinProjects(targetPath: string): void {
  const resolved = resolve(targetPath)
  if (!getProjectIdForPath(resolved)) {
    throw new Error(`Path is outside all known project roots: ${resolved}`)
  }
}

export function registerIpcHandlers(): void {
  // --- Project ---
  ipcMain.handle('project:list', () => {
    const data = loadStore()
    return {
      projects: data.projects.map((project) => ({
        ...project,
        rootPathExists: isDirectory(project.rootPath),
        roots: project.roots.map((root) => ({
          ...root,
          pathExists: isDirectory(root.path)
        }))
      })),
      activeId: data.activeProjectId
    }
  })

  ipcMain.handle('project:add', async (event, name: string, rootPath?: string) => {
    let path = rootPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window available')
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select project root directory'
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    return addProject(name, path)
  })

  ipcMain.handle('project:remove', (_, id: string) => {
    removeProject(id)
  })

  ipcMain.handle('project:set-active', (_, id: string | null) => {
    setActiveProject(id)
  })

  ipcMain.handle('project:update', (_, id: string, update: Record<string, unknown>) => {
    updateProject(id, update)
  })

  ipcMain.handle('project:add-channel', (_, projectId: string, name: string) => {
    addProjectChannel(projectId, name)
  })

  ipcMain.handle('project:remove-channel', (_, projectId: string, name: string) => {
    removeProjectChannel(projectId, name)
  })

  ipcMain.handle('project:set-channel-people', (_, projectId: string, channelName: string, people: string[]) => {
    return setProjectChannelPeople(projectId, channelName, people)
  })

  ipcMain.handle('project:add-root', async (event, projectId: string, name?: string, rootPath?: string) => {
    let path = rootPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window available')
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select project root directory'
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    return addProjectRoot(projectId, path, name)
  })

  ipcMain.handle('project:remove-root', (_, projectId: string, rootId: string) => {
    removeProjectRoot(projectId, rootId)
  })

  ipcMain.handle('project:add-integration', (_, projectId: string, name: string, type?: string) => {
    return addProjectIntegration(projectId, name, type)
  })

  ipcMain.handle('project:remove-integration', (_, projectId: string, integrationId: string) => {
    removeProjectIntegration(projectId, integrationId)
  })

  // --- Broker ---
  ipcMain.handle('broker:start', async (event, projectId: string, cwd: string, name: string, channels?: string[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      console.warn(`[broker] Project path no longer exists; skipping broker start: ${cwd}`)
      return false
    }
    await brokerManager.start(projectId, cwd, name, win, channels)
    return true
  })

  ipcMain.handle('broker:sync-channels', async (_, projectId: string, channels: string[]) => {
    await brokerManager.syncChannels(projectId, channels)
  })

  ipcMain.handle('broker:auto-fix-runtime', async (
    event,
    projectId: string,
    cwd: string,
    name: string,
    channels?: string[],
    errorMessage?: string
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      throw new Error(`Project path no longer exists: ${cwd}`)
    }
    return brokerManager.autoFixRuntime(projectId, cwd, name, win, channels, errorMessage)
  })

  ipcMain.handle('broker:spawn-agent', async (_, projectId: string, input: SpawnPtyInput) => {
    return brokerManager.spawnAgent(projectId, input)
  })

  ipcMain.handle('broker:attach-terminal', async (_, input: {
    projectId?: string
    name: string
    rows?: number
    cols?: number
    mode?: 'view' | 'drive' | 'passthrough'
  }) => {
    return brokerManager.attachTerminal(input.projectId, input)
  })

  ipcMain.handle('broker:connect-cloud', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    return brokerManager.connectCloud('cloud', win)
  })

  ipcMain.on('broker:send-input-fast', (_, projectId: string | undefined, name: string, data: string) => {
    brokerManager.queueInput(projectId, name, data)
  })

  ipcMain.handle('broker:set-terminal-mode', async (_, projectId: string | undefined, name: string, mode: 'view' | 'drive' | 'passthrough') => {
    return brokerManager.setTerminalMode(projectId, name, mode)
  })

  ipcMain.handle('broker:get-pending', async (_, projectId: string | undefined, name: string) => {
    return brokerManager.getPendingMessages(projectId, name)
  })

  ipcMain.handle('broker:flush-pending', async (_, projectId: string | undefined, name: string) => {
    return brokerManager.flushPending(projectId, name)
  })

  ipcMain.handle('broker:resize-pty', async (_, projectId: string | undefined, name: string, rows: number, cols: number) => {
    await brokerManager.resizePty(projectId, name, rows, cols)
  })

  ipcMain.handle('broker:send-message', async (_, projectId: string | undefined, input: SendMessageInput) => {
    await brokerManager.sendMessage(projectId, input)
  })

  ipcMain.handle('broker:subscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.subscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:unsubscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.unsubscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:release-agent', async (_, projectId: string | undefined, name: string) => {
    await brokerManager.releaseAgent(projectId, name)
  })

  ipcMain.handle('broker:list-agents', async (_, projectId?: string) => {
    return brokerManager.listAgents(projectId)
  })

  ipcMain.handle('broker:list-details', async () => {
    return brokerManager.listBrokerDetails()
  })

  ipcMain.handle('broker:list-events', () => {
    return brokerManager.listBrokerEvents()
  })

  ipcMain.handle('broker:shutdown', async () => {
    await brokerManager.shutdown()
  })

  // --- Git ---
  ipcMain.handle('git:status', async (_, path: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return []
    return git.getStatus(path)
  })

  ipcMain.handle('git:diff', async (_, path: string, file?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getDiff(path, file)
  })

  ipcMain.handle('git:file-content', async (_, path: string, file: string, revision?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getFileContent(path, file, revision)
  })

  ipcMain.handle('git:summary', async (_, path: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return null
    return git.getSummary(path)
  })

  ipcMain.handle('git:branches', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) return []
    return git.listBranches(root)
  })

  ipcMain.handle('git:branch-details', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) return []
    return git.listBranchDetails(root)
  })

  ipcMain.handle('git:checkout-branch', async (_, root: string, branch: string, options?: git.GitCheckoutBranchOptions) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.checkoutBranch(root, branch, options)
  })

  ipcMain.handle('git:branch-sync-status', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.getBranchSyncStatus(root)
  })

  ipcMain.handle('git:fetch-remote', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.fetchRemote(root)
  })

  ipcMain.handle('git:pull-current-branch', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.pullCurrentBranch(root)
  })

  ipcMain.handle('git:push-current-branch', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.pushCurrentBranch(root)
  })

  ipcMain.handle('git:history', async (_, path: string, limit?: number) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return []
    return git.getHistory(path, limit)
  })

  ipcMain.handle('git:show', async (_, path: string, hash: string, file?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getCommitDiff(path, hash, file)
  })

  ipcMain.handle('git:discard-files', async (_, path: string, files: string[]) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.discardFiles(path, files)
  })

  ipcMain.handle('git:add-gitignore-patterns', async (_, path: string, patterns: string[]) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.addGitignorePatterns(path, patterns)
  })

  ipcMain.handle('git:commit-selection', async (_, path: string, input: git.GitCommitSelectionInput) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.commitSelection(path, input)
  })

  ipcMain.handle('git:generate-commit-message', async (_, path: string, input: { wholeFiles: string[]; patch?: string }) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    const projectId = getProjectIdForPath(path)
    if (!projectId) throw new Error('No project is configured for this Git working directory')
    const diff = await git.getSelectedDiff(path, input)
    return brokerManager.generateCommitDraft(projectId, diff)
  })

  // --- Files ---
  ipcMain.handle('fs:list-dir', async (_, dirPath: string) => {
    assertPathWithinProjects(dirPath)
    return filesystem.listDirectory(dirPath)
  })

  ipcMain.handle('fs:read-preview', async (_, filePath: string) => {
    assertPathWithinProjects(filePath)
    return filesystem.readTextPreview(filePath)
  })

  ipcMain.handle('fs:reveal-path', async (_, filePath: string) => {
    const resolvedPath = resolve(filePath)
    assertPathWithinProjects(resolvedPath)
    shell.showItemInFolder(resolvedPath)
  })

  // --- Auth ---
  ipcMain.handle('auth:login', async () => {
    return auth.login()
  })

  ipcMain.handle('auth:logout', () => {
    auth.logout()
  })

  ipcMain.handle('auth:status', () => {
    return auth.getAuthStatus()
  })
}
