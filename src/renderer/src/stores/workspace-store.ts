import { create } from 'zustand'
import { pear } from '@/lib/ipc'

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

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeWorktreeId: string | null
  activeChannelName: string | null
  brokerStarted: boolean
  loading: boolean

  load: () => Promise<void>
  ensureBroker: () => Promise<void>
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
  loading: false,

  load: async () => {
    set({ loading: true })
    const data = await pear.workspace.list()
    set({
      workspaces: data.workspaces as Workspace[],
      activeWorkspaceId: data.activeId,
      loading: false
    })
    if (data.activeId) {
      const ws = (data.workspaces as Workspace[]).find((w) => w.id === data.activeId)
      if (ws) get().refreshWorktrees()
    }
    // Start broker once (uses first workspace's cwd, but broker is global)
    await get().ensureBroker()
  },

  ensureBroker: async () => {
    if (get().brokerStarted) return
    const ws = get().getActiveWorkspace() || get().workspaces[0]
    if (!ws) return
    try {
      await pear.broker.start(ws.rootPath, 'pear')
      set({ brokerStarted: true })
    } catch (err) {
      console.error('Failed to start broker:', err)
    }
  },

  addWorkspace: async (name, rootPath) => {
    const ws = (await pear.workspace.add(name, rootPath)) as Workspace | null
    if (ws) {
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
    if (id) {
      await get().refreshWorktrees()
    }
  },

  setActiveWorktree: (id) => {
    set({ activeWorktreeId: id })
  },

  setActiveChannel: (name) => {
    set({ activeChannelName: name })
  },

  addChannel: async (name) => {
    const { activeWorkspaceId, activeWorktreeId } = get()
    if (!activeWorkspaceId || !activeWorktreeId) return
    await pear.worktree.addChannel(activeWorkspaceId, activeWorktreeId, name)
    // Update local state immediately
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === activeWorkspaceId
          ? {
              ...ws,
              worktrees: ws.worktrees.map((wt) =>
                wt.id === activeWorktreeId && !wt.channels.includes(name)
                  ? { ...wt, channels: [...wt.channels, name] }
                  : wt
              )
            }
          : ws
      )
    }))
  },

  removeChannel: async (name) => {
    const { activeWorkspaceId, activeWorktreeId } = get()
    if (!activeWorkspaceId || !activeWorktreeId) return
    await pear.worktree.removeChannel(activeWorkspaceId, activeWorktreeId, name)
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
              worktrees: ws.worktrees.map((wt) =>
                wt.id === activeWorktreeId
                  ? { ...wt, channels: wt.channels.filter((c) => c !== name) }
                  : wt
              )
            }
          : ws
      )
    }))
  },

  refreshWorktrees: async () => {
    const ws = get().getActiveWorkspace()
    if (!ws) return
    try {
      const worktrees = await pear.git.listWorktrees(ws.rootPath)
      const mapped: Worktree[] = worktrees.map(
        (wt: { path: string; branch: string; head: string }) => {
          const existing = ws.worktrees.find((w) => w.path === wt.path)
          return {
            id: wt.path,
            branch: wt.branch,
            path: wt.path,
            agents: existing?.agents || [],
            channels: existing?.channels || ['general']
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
    const wt = get().getActiveWorktree()
    const { activeChannelName } = get()
    if (!ws || !wt || !activeChannelName) return null
    return `${ws.name}-${wt.branch}-${activeChannelName}`
  },

  prefixChannel: (channelName: string) => {
    const ws = get().getActiveWorkspace()
    const wt = get().getActiveWorktree()
    if (!ws || !wt) return null
    return `${ws.name}-${wt.branch}-${channelName}`
  }
}))
