import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface AgentInfo {
  name: string
  cli: string
  model?: string
  status: 'running' | 'exited'
}

export interface Worktree {
  id: string
  branch: string
  path: string
  agents: AgentInfo[]
  channels: string[]
}

export interface Workspace {
  id: string
  name: string
  rootPath: string
  worktrees: Worktree[]
}

interface StoreData {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

const getStorePath = (): string => {
  const dir = join(app.getPath('userData'), 'config')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'workspaces.json')
}

const defaultData: StoreData = { workspaces: [], activeWorkspaceId: null }

export function loadStore(): StoreData {
  try {
    const raw = readFileSync(getStorePath(), 'utf-8')
    return JSON.parse(raw) as StoreData
  } catch {
    return { ...defaultData }
  }
}

export function saveStore(data: StoreData): void {
  const storePath = getStorePath()
  const tmpPath = storePath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(data, null, 2))
  renameSync(tmpPath, storePath)
}

export function addWorkspace(name: string, rootPath: string): Workspace {
  const data = loadStore()
  const ws: Workspace = {
    id: crypto.randomUUID(),
    name,
    rootPath,
    worktrees: []
  }
  data.workspaces.push(ws)
  saveStore(data)
  return ws
}

export function removeWorkspace(id: string): void {
  const data = loadStore()
  data.workspaces = data.workspaces.filter((w) => w.id !== id)
  if (data.activeWorkspaceId === id) data.activeWorkspaceId = null
  saveStore(data)
}

export function setActiveWorkspace(id: string | null): void {
  const data = loadStore()
  data.activeWorkspaceId = id
  saveStore(data)
}

export function addWorktreeChannel(workspaceId: string, worktreeId: string, channelName: string): void {
  const data = loadStore()
  const ws = data.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return
  const wt = ws.worktrees.find((w) => w.id === worktreeId)
  if (wt && !wt.channels.includes(channelName)) {
    wt.channels.push(channelName)
    saveStore(data)
  }
}

export function removeWorktreeChannel(workspaceId: string, worktreeId: string, channelName: string): void {
  const data = loadStore()
  const ws = data.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return
  const wt = ws.worktrees.find((w) => w.id === worktreeId)
  if (wt) {
    wt.channels = wt.channels.filter((c) => c !== channelName)
    saveStore(data)
  }
}

export function updateWorkspace(id: string, update: Partial<Workspace>): void {
  const data = loadStore()
  const idx = data.workspaces.findIndex((w) => w.id === id)
  if (idx !== -1) {
    data.workspaces[idx] = { ...data.workspaces[idx], ...update }
    saveStore(data)
  }
}
