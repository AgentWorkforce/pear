import { create } from 'zustand'
import { pear } from '@/lib/ipc'

export interface Worktree {
  id: string
  branch: string
  path: string
}

export interface Workspace {
  id: string
  name: string
  rootPath: string
  rootPathExists: boolean
  channels: string[]
  worktrees: Worktree[]
}

function getBrokerChannels(workspaces: Workspace[]): string[] {
  void workspaces
  return []
}

function normalizeWorktree(value: unknown): Worktree | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : typeof record.path === 'string' ? record.path : null
  const branch = typeof record.branch === 'string' ? record.branch : null
  const path = typeof record.path === 'string' ? record.path : null

  if (!id || !branch || !path) return null

  return { id, branch, path }
}

function normalizeChannels(workspaceChannels: unknown, legacyWorktrees: Array<Record<string, unknown>>): string[] {
  const workspaceList = Array.isArray(workspaceChannels)
    ? workspaceChannels.filter((value): value is string => typeof value === 'string')
    : []
  const legacyList = legacyWorktrees.flatMap((worktree) =>
    Array.isArray(worktree.channels)
      ? worktree.channels.filter((value): value is string => typeof value === 'string')
      : []
  )
  const channels = Array.from(
    new Set([...workspaceList, ...legacyList].map((channel) => channel.trim()).filter(Boolean))
  )
  return channels.length > 0 ? channels : ['general']
}

function normalizeWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : null
  const name = typeof record.name === 'string' ? record.name : null
  const rootPath = typeof record.rootPath === 'string' ? record.rootPath : null
  const rootPathExists = typeof record.rootPathExists === 'boolean' ? record.rootPathExists : true
  const legacyWorktrees = Array.isArray(record.worktrees)
    ? record.worktrees.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    : []

  if (!id || !name || !rootPath) return null

  return {
    id,
    name,
    rootPath,
    rootPathExists,
    channels: normalizeChannels(record.channels, legacyWorktrees),
    worktrees: rootPathExists
      ? legacyWorktrees.map(normalizeWorktree).filter((entry): entry is Worktree => entry !== null)
      : []
  }
}

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeWorktreeId: string | null
  activeChannelName: string | null
  brokerStarted: boolean
  brokerWorkspaceId: string | null
  loading: boolean

  load: () => Promise<void>
  ensureBroker: () => Promise<void>
  syncBrokerChannels: () => Promise<void>
  addWorkspace: (name: string, rootPath?: string) => Promise<Workspace | null>
  removeWorkspace: (id: string) => Promise<void>
  setActiveWorkspace: (id: string | null) => Promise<void>
  setActiveWorktree: (id: string | null) => void
  setActiveChannel: (name: string | null) => void
  addChannel: (name: string) => Promise<void>
  removeChannel: (name: string) => Promise<void>
  refreshWorktrees: () => Promise<void>
  getActiveWorkspace: () => Workspace | undefined
  getActiveWorktree: () => Worktree | undefined
  getActiveChannelPrefixed: () => string | null
  prefixChannel: (channelName: string) => string | null
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  activeWorktreeId: null,
  activeChannelName: null,
  brokerStarted: false,
  brokerWorkspaceId: null,
  loading: false,

  load: async () => {
    set({ loading: true })
    const data = await pear.workspace.list()
    const workspaces = (data.workspaces as unknown[])
      .map(normalizeWorkspace)
      .filter((workspace): workspace is Workspace => workspace !== null)
    const activeWorkspaceId = workspaces.some((workspace) => workspace.id === data.activeId)
      ? data.activeId
      : workspaces.find((workspace) => workspace.rootPathExists)?.id || null
    if (activeWorkspaceId !== data.activeId) {
      await pear.workspace.setActive(activeWorkspaceId)
    }
    set({
      workspaces,
      activeWorkspaceId,
      activeWorktreeId: null,
      activeChannelName: null,
      loading: false
    })
    await get().ensureBroker()
  },

  ensureBroker: async () => {
    const activeWorkspace = get().getActiveWorkspace()
    const ws = activeWorkspace?.rootPathExists
      ? activeWorkspace
      : get().workspaces.find((workspace) => workspace.rootPathExists)
    const brokerChannels = getBrokerChannels(get().workspaces)
    if (!ws) {
      set({ brokerStarted: false, brokerWorkspaceId: null })
      return
    }
    if (get().brokerStarted && get().brokerWorkspaceId === ws.id) {
      return
    }
    try {
      await pear.broker.start(ws.rootPath, 'pear', brokerChannels)
      set({ brokerStarted: true, brokerWorkspaceId: ws.id })
    } catch (err) {
      set({ brokerStarted: false, brokerWorkspaceId: null })
      console.error('Failed to start broker:', err)
    }
  },

  syncBrokerChannels: async () => {
    return
  },

  addWorkspace: async (name, rootPath) => {
    const ws = (await pear.workspace.add(name, rootPath)) as Workspace | null
    if (ws) {
      await pear.workspace.setActive(ws.id)
      await get().load()
    }
    return ws
  },

  removeWorkspace: async (id) => {
    await pear.workspace.remove(id)
    await get().load()
  },

  setActiveWorkspace: async (id) => {
    await pear.workspace.setActive(id)
    set({ activeWorkspaceId: id, activeWorktreeId: null, activeChannelName: null })
    if (id) await get().ensureBroker()
  },

  setActiveWorktree: (id) => {
    set({ activeWorktreeId: id })
  },

  setActiveChannel: (name) => {
    set({ activeChannelName: name })
  },

  addChannel: async (name) => {
    const { activeWorkspaceId } = get()
    if (!activeWorkspaceId) return
    await pear.workspace.addChannel(activeWorkspaceId, name)
    // Update local state immediately
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === activeWorkspaceId
          ? {
              ...ws,
              channels: ws.channels.includes(name) ? ws.channels : [...ws.channels, name]
            }
          : ws
      )
    }))
    await get().syncBrokerChannels()
  },

  removeChannel: async (name) => {
    const { activeWorkspaceId } = get()
    if (!activeWorkspaceId) return
    await pear.workspace.removeChannel(activeWorkspaceId, name)
    const { activeChannelName } = get()
    if (activeChannelName === name) {
      set({ activeChannelName: null })
    }
    // Update local state immediately
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === activeWorkspaceId
          ? {
              ...ws,
              channels: ws.channels.filter((c) => c !== name)
            }
          : ws
      )
    }))
    await get().syncBrokerChannels()
  },

  refreshWorktrees: async () => {
    const ws = get().getActiveWorkspace()
    if (!ws) return
    if (!ws.rootPathExists) {
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, worktrees: [] } : w))
      }))
      return
    }
    try {
      const worktrees = await pear.git.listWorktrees(ws.rootPath)
      const mapped: Worktree[] = worktrees.map(
        (wt: { path: string; branch: string; head: string }) => {
          return {
            id: wt.path,
            branch: wt.branch,
            path: wt.path
          }
        }
      )
      const updated = { ...ws, worktrees: mapped }
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === ws.id ? updated : w))
      }))
    } catch {
      // Git might not be available or not a repo
    }
  },

  getActiveWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get()
    return workspaces.find((w) => w.id === activeWorkspaceId)
  },

  getActiveWorktree: () => {
    const ws = get().getActiveWorkspace()
    const { activeWorktreeId } = get()
    if (!ws || !activeWorktreeId) return undefined
    return ws.worktrees.find((w) => w.id === activeWorktreeId)
  },

  getActiveChannelPrefixed: () => {
    const ws = get().getActiveWorkspace()
    const { activeChannelName } = get()
    if (!ws || !activeChannelName) return null
    return `${ws.name}-${activeChannelName}`
  },

  prefixChannel: (channelName: string) => {
    const ws = get().getActiveWorkspace()
    if (!ws) return null
    return `${ws.name}-${channelName}`
  }
}))
