import { ipcMain, dialog, BrowserWindow } from 'electron'
import { resolve } from 'path'
import type { SpawnPtyInput, SendMessageInput } from '@agent-relay/sdk'
import {
  loadStore,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  updateWorkspace,
  addWorktreeChannel,
  removeWorktreeChannel
} from './store'
import { brokerManager } from './broker'
import * as git from './git'
import * as filesystem from './filesystem'

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
    return { workspaces: data.workspaces, activeId: data.activeWorkspaceId }
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

  ipcMain.handle('worktree:add-channel', (_, workspaceId: string, worktreeId: string, name: string) => {
    addWorktreeChannel(workspaceId, worktreeId, name)
  })

  ipcMain.handle('worktree:remove-channel', (_, workspaceId: string, worktreeId: string, name: string) => {
    removeWorktreeChannel(workspaceId, worktreeId, name)
  })

  // --- Broker ---
  ipcMain.handle('broker:start', async (event, cwd: string, name: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    await brokerManager.start(cwd, name, win)
  })

  ipcMain.handle('broker:spawn-agent', async (_, input: SpawnPtyInput) => {
    return brokerManager.spawnAgent(input)
  })

  ipcMain.handle('broker:send-input', async (_, name: string, data: string) => {
    await brokerManager.sendInput(name, data)
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
    return git.listWorktrees(root)
  })

  ipcMain.handle('git:add-worktree', async (_, root: string, branch: string, baseBranch?: string) => {
    assertPathWithinWorkspaces(root)
    return git.addWorktree(root, branch, baseBranch)
  })

  ipcMain.handle('git:remove-worktree', async (_, root: string, path: string) => {
    assertPathWithinWorkspaces(root)
    assertPathWithinWorkspaces(path)
    await git.removeWorktree(root, path)
  })

  ipcMain.handle('git:status', async (_, path: string) => {
    assertPathWithinWorkspaces(path)
    return git.getStatus(path)
  })

  ipcMain.handle('git:diff', async (_, path: string, file?: string) => {
    assertPathWithinWorkspaces(path)
    return git.getDiff(path, file)
  })

  ipcMain.handle('git:branches', async (_, root: string) => {
    assertPathWithinWorkspaces(root)
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
}
