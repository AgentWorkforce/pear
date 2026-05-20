import { create } from 'zustand'
import { pear } from '@/lib/ipc'

export interface ProjectRoot {
  id: string
  name: string
  path: string
  pathExists: boolean
}

export interface ProjectIntegration {
  id: string
  name: string
  type: string
}

export interface Project {
  id: string
  name: string
  relayWorkspaceId: string
  rootPath: string
  rootPathExists: boolean
  roots: ProjectRoot[]
  channels: string[]
  integrations: ProjectIntegration[]
}

function getBrokerChannels(project: Project | undefined): string[] {
  return project ? Array.from(new Set(project.channels)) : []
}

function getRelayWorkspaceName(project: Project): string {
  return `pear-${project.relayWorkspaceId}`
}

function defaultRootName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function normalizeRoot(value: unknown): ProjectRoot | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const path = typeof record.path === 'string' ? record.path : null
  if (!path) return null

  return {
    id: typeof record.id === 'string' ? record.id : path,
    name: typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : defaultRootName(path),
    path,
    pathExists: typeof record.pathExists === 'boolean' ? record.pathExists : true
  }
}

function normalizeIntegration(value: unknown): ProjectIntegration | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) return null

  return {
    id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
    name,
    type: typeof record.type === 'string' && record.type.trim() ? record.type.trim() : 'custom'
  }
}

export function normalizeChannelName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeChannels(value: unknown): string[] {
  const channels = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
  const deduped = Array.from(new Set(channels.map(normalizeChannelName).filter(Boolean)))
  return deduped.length > 0 ? deduped : ['general']
}

function dedupeRoots(roots: ProjectRoot[]): ProjectRoot[] {
  const seen = new Set<string>()
  const deduped: ProjectRoot[] = []

  for (const root of roots) {
    if (seen.has(root.path)) continue
    seen.add(root.path)
    deduped.push(root)
  }

  return deduped
}

function getDefaultRoot(project: Project | undefined): ProjectRoot | undefined {
  if (!project) return undefined
  return project.roots.find((root) => root.pathExists) || project.roots[0]
}

function normalizeProject(value: unknown): Project | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : null
  const name = typeof record.name === 'string' ? record.name : null
  const relayWorkspaceId = typeof record.relayWorkspaceId === 'string' && record.relayWorkspaceId.trim()
    ? record.relayWorkspaceId.trim()
    : id || ''
  const rootPath = typeof record.rootPath === 'string' ? record.rootPath : null
  const roots = Array.isArray(record.roots)
    ? dedupeRoots(record.roots.map(normalizeRoot).filter((entry): entry is ProjectRoot => entry !== null))
    : []
  const primaryRoot = rootPath || roots[0]?.path || null
  const integrations = Array.isArray(record.integrations)
    ? record.integrations
        .map(normalizeIntegration)
        .filter((entry): entry is ProjectIntegration => entry !== null)
    : []

  if (!id || !name || !primaryRoot || roots.length === 0) return null

  return {
    id,
    name,
    relayWorkspaceId,
    rootPath: primaryRoot,
    rootPathExists: roots.some((root) => root.path === primaryRoot && root.pathExists),
    roots,
    channels: normalizeChannels(record.channels),
    integrations
  }
}

interface ProjectState {
  projects: Project[]
  activeProjectId: string | null
  activeRootId: string | null
  activeChannelName: string | null
  brokerStarted: boolean
  brokerProjectId: string | null
  loading: boolean

  load: () => Promise<void>
  ensureBroker: () => Promise<void>
  syncBrokerChannels: () => Promise<void>
  addProject: (name: string, rootPath?: string) => Promise<Project | null>
  updateProject: (id: string, update: Partial<Pick<Project, 'name'>>) => Promise<void>
  removeProject: (id: string) => Promise<void>
  setActiveProject: (id: string | null) => Promise<void>
  setActiveRoot: (id: string | null) => void
  setActiveChannel: (name: string | null) => void
  addRoot: (name?: string, rootPath?: string) => Promise<ProjectRoot | null>
  removeRoot: (id: string) => Promise<void>
  addChannel: (name: string) => Promise<void>
  removeChannel: (name: string) => Promise<void>
  addIntegration: (name: string, type?: string) => Promise<ProjectIntegration | null>
  removeIntegration: (id: string) => Promise<void>
  getActiveProject: () => Project | undefined
  getActiveRoot: () => ProjectRoot | undefined
  getActiveChannelName: () => string | null
  normalizeChannel: (channelName: string) => string | null
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  activeRootId: null,
  activeChannelName: null,
  brokerStarted: false,
  brokerProjectId: null,
  loading: false,

  load: async () => {
    set({ loading: true })
    const data = await pear.project.list()
    const projects = (data.projects as unknown[])
      .map(normalizeProject)
      .filter((project): project is Project => project !== null)
    const activeProjectId = projects.some((project) => project.id === data.activeId)
      ? data.activeId
      : projects.find((project) => project.roots.some((root) => root.pathExists))?.id || null
    const activeProject = projects.find((project) => project.id === activeProjectId)
    const currentRootId = get().activeProjectId === activeProjectId ? get().activeRootId : null
    const activeRootId = activeProject?.roots.some((root) => root.id === currentRootId)
      ? currentRootId
      : getDefaultRoot(activeProject)?.id || null

    if (activeProjectId !== data.activeId) {
      await pear.project.setActive(activeProjectId)
    }
    set({
      projects,
      activeProjectId,
      activeRootId,
      activeChannelName: null,
      loading: false
    })
    await get().ensureBroker()
  },

  ensureBroker: async () => {
    const activeProject = get().getActiveProject()
    const activeRoot = get().getActiveRoot()
    const fallbackProject = get().projects.find((project) =>
      project.roots.some((root) => root.pathExists)
    )
    const project = activeRoot?.pathExists ? activeProject : fallbackProject
    const root = activeRoot?.pathExists ? activeRoot : getDefaultRoot(fallbackProject)

    if (!project || !root?.pathExists) {
      set({ brokerStarted: false, brokerProjectId: null })
      return
    }
    try {
      await pear.broker.start(project.id, root.path, getRelayWorkspaceName(project), getBrokerChannels(project))
      set({ brokerStarted: true, brokerProjectId: project.id })
    } catch (err) {
      set({ brokerStarted: false, brokerProjectId: null })
      console.error('Failed to start broker:', err)
    }
  },

  syncBrokerChannels: async () => {
    const project = get().getActiveProject()
    if (!project) return
    await pear.broker.syncChannels(project.id, getBrokerChannels(project))
  },

  addProject: async (name, rootPath) => {
    const project = (await pear.project.add(name, rootPath)) as Project | null
    if (project) {
      await pear.project.setActive(project.id)
      await get().load()
    }
    return project
  },

  updateProject: async (id, update) => {
    const name = typeof update.name === 'string' ? update.name.trim() : ''
    if (!name) return
    await pear.project.update(id, { name })
    await get().load()
  },

  removeProject: async (id) => {
    await pear.project.remove(id)
    await get().load()
  },

  setActiveProject: async (id) => {
    await pear.project.setActive(id)
    const project = get().projects.find((candidate) => candidate.id === id)
    const activeRootId = getDefaultRoot(project)?.id || null
    set({
      activeProjectId: id,
      activeRootId,
      activeChannelName: null
    })
    if (id) await get().ensureBroker()
  },

  setActiveRoot: (id) => {
    set({ activeRootId: id })
  },

  setActiveChannel: (name) => {
    set({ activeChannelName: name ? normalizeChannelName(name) : null })
  },

  addRoot: async (name, rootPath) => {
    const { activeProjectId } = get()
    if (!activeProjectId) return null
    const root = normalizeRoot(await pear.project.addRoot(activeProjectId, name, rootPath))
    await get().load()
    if (root) {
      get().setActiveRoot(root.id)
    }
    return root
  },

  removeRoot: async (id) => {
    const { activeProjectId } = get()
    if (!activeProjectId) return
    await pear.project.removeRoot(activeProjectId, id)
    await get().load()
  },

  addChannel: async (name) => {
    const { activeProjectId } = get()
    const channelName = normalizeChannelName(name)
    if (!activeProjectId || !channelName) return
    await pear.project.addChannel(activeProjectId, channelName)
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === activeProjectId
          ? {
              ...project,
              channels: project.channels.includes(channelName)
                ? project.channels
                : [...project.channels, channelName]
            }
          : project
      )
    }))
    await get().syncBrokerChannels()
  },

  removeChannel: async (name) => {
    const { activeProjectId } = get()
    const channelName = normalizeChannelName(name)
    if (!activeProjectId) return
    await pear.project.removeChannel(activeProjectId, channelName)
    const { activeChannelName } = get()
    if (activeChannelName === channelName) {
      set({ activeChannelName: null })
    }
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === activeProjectId
          ? {
              ...project,
              channels: project.channels.filter((channel) => channel !== channelName)
            }
          : project
      )
    }))
    await get().syncBrokerChannels()
  },

  addIntegration: async (name, type = 'custom') => {
    const { activeProjectId } = get()
    if (!activeProjectId || !name.trim()) return null
    const integration = normalizeIntegration(
      await pear.project.addIntegration(activeProjectId, name.trim(), type)
    )
    if (!integration) return null
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === activeProjectId
          ? { ...project, integrations: [...project.integrations, integration] }
          : project
      )
    }))
    return integration
  },

  removeIntegration: async (id) => {
    const { activeProjectId } = get()
    if (!activeProjectId) return
    await pear.project.removeIntegration(activeProjectId, id)
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === activeProjectId
          ? { ...project, integrations: project.integrations.filter((integration) => integration.id !== id) }
          : project
      )
    }))
  },

  getActiveProject: () => {
    const { projects, activeProjectId } = get()
    return projects.find((project) => project.id === activeProjectId)
  },

  getActiveRoot: () => {
    const project = get().getActiveProject()
    const { activeRootId } = get()
    if (!project) return undefined
    return project.roots.find((root) => root.id === activeRootId) || getDefaultRoot(project)
  },

  getActiveChannelName: () => {
    const { activeChannelName } = get()
    return activeChannelName || null
  },

  normalizeChannel: (channelName: string) => {
    return normalizeChannelName(channelName) || null
  }
}))
