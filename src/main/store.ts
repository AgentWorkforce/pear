import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface Worktree {
  id: string
  branch: string
  path: string
}

export interface Workspace {
  id: string
  name: string
  rootPath: string
  channels: string[]
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

function normalizeWorktree(value: unknown): Worktree | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : typeof record.path === 'string' ? record.path : null
  const branch = typeof record.branch === 'string' ? record.branch : null
  const path = typeof record.path === 'string' ? record.path : null

  if (!id || !branch || !path) return null

  return { id, branch, path }
}

function normalizeChannels(
  workspaceChannels: unknown,
  legacyWorktrees: Array<Record<string, unknown>>
): string[] {
  const workspaceList = Array.isArray(workspaceChannels)
    ? workspaceChannels.filter((value): value is string => typeof value === 'string')
    : []
  const legacyList = legacyWorktrees.flatMap((worktree) =>
    Array.isArray(worktree.channels)
      ? worktree.channels.filter((value): value is string => typeof value === 'string')
      : []
  )
  const deduped = Array.from(new Set([...workspaceList, ...legacyList].map((channel) => channel.trim()).filter(Boolean)))
  return deduped.length > 0 ? deduped : ['general']
}

function normalizeWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : null
  const name = typeof record.name === 'string' ? record.name : null
  const rootPath = typeof record.rootPath === 'string' ? record.rootPath : null
  const legacyWorktrees = Array.isArray(record.worktrees)
    ? record.worktrees.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    : []
  const worktrees = legacyWorktrees.map(normalizeWorktree).filter((entry): entry is Worktree => entry !== null)

  if (!id || !name || !rootPath) return null

  return {
    id,
    name,
    rootPath,
    channels: normalizeChannels(record.channels, legacyWorktrees),
    worktrees
  }
}

function normalizeStore(raw: unknown): StoreData {
  if (!raw || typeof raw !== 'object') return { ...defaultData }
  const record = raw as Record<string, unknown>
  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces.map(normalizeWorkspace).filter((entry): entry is Workspace => entry !== null)
    : []
  const activeWorkspaceId =
    typeof record.activeWorkspaceId === 'string' || record.activeWorkspaceId === null
      ? record.activeWorkspaceId
      : null

  return {
    workspaces,
    activeWorkspaceId
  }
}

export function loadStore(): StoreData {
  try {
    const raw = readFileSync(getStorePath(), 'utf-8')
    return normalizeStore(JSON.parse(raw))
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
    channels: ['general'],
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

export function addWorkspaceChannel(workspaceId: string, channelName: string): void {
  const data = loadStore()
  const ws = data.workspaces.find((w) => w.id === workspaceId)
  if (ws && !ws.channels.includes(channelName)) {
    ws.channels.push(channelName)
    saveStore(data)
  }
}

export function removeWorkspaceChannel(workspaceId: string, channelName: string): void {
  const data = loadStore()
  const ws = data.workspaces.find((w) => w.id === workspaceId)
  if (ws) {
    ws.channels = ws.channels.filter((c) => c !== channelName)
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
