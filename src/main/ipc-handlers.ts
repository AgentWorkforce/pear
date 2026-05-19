import { ipcMain, dialog, BrowserWindow } from 'electron'
import { resolve } from 'path'
import type { SpawnPtyInput, SendMessageInput } from '@agent-relay/sdk'
import {
  loadStore,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  updateWorkspace,
  addWorkspaceChannel,
  removeWorkspaceChannel
} from './store'
import { brokerManager } from './broker'
import * as git from './git'
import * as filesystem from './filesystem'
import * as auth from './auth'
import { assertDirectory, isDirectory } from './path-utils'

function assertPathWithinWorkspaces(targetPath: string): void {
  const resolved = resolve(targetPath)
  const { workspaces } = loadStore()
  const allowed = workspaces.some((ws) => resolved.startsWith(ws.rootPath + '/') || resolved === ws.rootPath)
  if (!allowed) {
    throw new Error(`Path is outside all known workspaces: ${resolved}`)
  }
}

export function registerIpcHandlers(): void {
  // --- Workspace ---
  ipcMain.handle('workspace:list', () => {
    const data = loadStore()
    return {
      workspaces: data.workspaces.map((workspace) => ({
        ...workspace,
        rootPathExists: isDirectory(workspace.rootPath)
      })),
      activeId: data.activeWorkspaceId
    }
  })

  ipcMain.handle('workspace:add', async (event, name: string, rootPath?: string) => {
    let path = rootPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window available')
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select workspace root directory'
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    return addWorkspace(name, path)
  })

  ipcMain.handle('workspace:remove', (_, id: string) => {
    removeWorkspace(id)
  })

  ipcMain.handle('workspace:set-active', (_, id: string | null) => {
    setActiveWorkspace(id)
  })

  ipcMain.handle('workspace:update', (_, id: string, update: Record<string, unknown>) => {
    updateWorkspace(id, update)
  })

  ipcMain.handle('workspace:add-channel', (_, workspaceId: string, name: string) => {
    addWorkspaceChannel(workspaceId, name)
  })

  ipcMain.handle('workspace:remove-channel', (_, workspaceId: string, name: string) => {
    removeWorkspaceChannel(workspaceId, name)
  })

  // --- Broker ---
  ipcMain.handle('broker:start', async (event, cwd: string, name: string, channels?: string[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      console.warn(`[broker] Workspace path no longer exists; skipping broker start: ${cwd}`)
      return false
    }
    await brokerManager.start(cwd, name, win, channels)
    return true
  })

  ipcMain.handle('broker:sync-channels', async (_, channels: string[]) => {
    await brokerManager.syncChannels(channels)
  })

  ipcMain.handle('broker:spawn-agent', async (_, input: SpawnPtyInput) => {
    return brokerManager.spawnAgent(input)
  })

  ipcMain.handle('broker:attach-terminal', async (_, input: {
    name: string
    rows?: number
    cols?: number
    mode?: 'view' | 'drive' | 'passthrough'
  }) => {
    return brokerManager.attachTerminal(input)
  })

  ipcMain.handle('broker:connect-cloud', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    return brokerManager.connectCloud(win)
  })

  ipcMain.handle('broker:send-input', async (_, name: string, data: string) => {
    await brokerManager.sendInput(name, data)
  })

  ipcMain.handle('broker:set-terminal-mode', async (_, name: string, mode: 'view' | 'drive' | 'passthrough') => {
    return brokerManager.setTerminalMode(name, mode)
  })

  ipcMain.handle('broker:get-pending', async (_, name: string) => {
    return brokerManager.getPendingMessages(name)
  })

  ipcMain.handle('broker:flush-pending', async (_, name: string) => {
    return brokerManager.flushPending(name)
  })

  ipcMain.handle('broker:resize-pty', async (_, name: string, rows: number, cols: number) => {
    await brokerManager.resizePty(name, rows, cols)
  })

  ipcMain.handle('broker:send-message', async (_, input: SendMessageInput) => {
    await brokerManager.sendMessage(input)
  })

  ipcMain.handle('broker:release-agent', async (_, name: string) => {
    await brokerManager.releaseAgent(name)
  })

  ipcMain.handle('broker:list-agents', async () => {
    return brokerManager.listAgents()
  })

  ipcMain.handle('broker:shutdown', async () => {
    await brokerManager.shutdown()
  })

  // --- Git ---
  ipcMain.handle('git:list-worktrees', async (_, root: string) => {
    assertPathWithinWorkspaces(root)
    if (!isDirectory(root)) return []
    return git.listWorktrees(root)
  })

  ipcMain.handle('git:add-worktree', async (_, root: string, branch: string, baseBranch?: string) => {
    assertPathWithinWorkspaces(root)
    assertDirectory(root, 'Workspace path')
    return git.addWorktree(root, branch, baseBranch)
  })

  ipcMain.handle('git:remove-worktree', async (_, root: string, path: string) => {
    assertPathWithinWorkspaces(root)
    assertPathWithinWorkspaces(path)
    await git.removeWorktree(root, path)
  })

  ipcMain.handle('git:status', async (_, path: string) => {
    assertPathWithinWorkspaces(path)
    if (!isDirectory(path)) return []
    return git.getStatus(path)
  })

  ipcMain.handle('git:diff', async (_, path: string, file?: string) => {
    assertPathWithinWorkspaces(path)
    if (!isDirectory(path)) return ''
    return git.getDiff(path, file)
  })

  ipcMain.handle('git:branches', async (_, root: string) => {
    assertPathWithinWorkspaces(root)
    if (!isDirectory(root)) return []
    return git.listBranches(root)
  })

  // --- Files ---
  ipcMain.handle('fs:list-dir', async (_, dirPath: string) => {
    assertPathWithinWorkspaces(dirPath)
    return filesystem.listDirectory(dirPath)
  })

  ipcMain.handle('fs:read-preview', async (_, filePath: string) => {
    assertPathWithinWorkspaces(filePath)
    return filesystem.readTextPreview(filePath)
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
