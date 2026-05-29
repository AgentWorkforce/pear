import { create } from 'zustand'
import { z } from 'zod'
import {
  ProjectIntegrationSchema,
  ProjectRootSchema,
  makeProjectSchema,
  normalizeChannelName
} from '@shared/schemas/project'
import { pear } from '@/lib/ipc'

// Renderer enriches each root with `pathExists` populated by the main process.
const RendererProjectRootSchema = ProjectRootSchema.and(
  z.object({ pathExists: z.boolean().optional() })
).transform((value) => ({
  id: value.id,
  name: value.name,
  path: value.path,
  pathExists: typeof value.pathExists === 'boolean' ? value.pathExists : true
}))

const RendererProjectSchema = makeProjectSchema(RendererProjectRootSchema).transform((project) => ({
  ...project,
  rootPathExists: project.roots.some((root) => root.path === project.rootPath && root.pathExists)
}))

export type ProjectRoot = z.infer<typeof RendererProjectRootSchema>
export type ProjectIntegration = z.infer<typeof ProjectIntegrationSchema>
export type Project = z.infer<typeof RendererProjectSchema>
export type CloudAgentWorkspaceMode = 'git-overlay' | 'git' | 'relayfile'

export { normalizeChannelName }

function parseProject(value: unknown): Project | null {
  const result = RendererProjectSchema.safeParse(value)
  return result.success ? result.data : null
}

function parseIntegration(value: unknown): ProjectIntegration | null {
  const result = ProjectIntegrationSchema.safeParse(value)
  return result.success ? result.data : null
}

function parseRoot(value: unknown): ProjectRoot | null {
  const result = RendererProjectRootSchema.safeParse(value)
  return result.success ? result.data : null
}

function getBrokerChannels(project: Project | undefined): string[] {
  return project ? Array.from(new Set(project.channels)) : []
}

function normalizeChannelList(channelNames: string[]): string[] {
  return Array.from(new Set(channelNames.map(normalizeChannelName).filter(Boolean)))
}

function getRelayWorkspaceName(project: Project): string {
  return `pear-${project.relayWorkspaceId}`
}

function getDefaultRoot(project: Project | undefined): ProjectRoot | undefined {
  if (!project) return undefined
  return project.roots.find((root) => root.pathExists) || project.roots[0]
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
  updateProject: (id: string, update: Partial<Pick<Project, 'name'>> & { cloudAgentWorkspaceMode?: CloudAgentWorkspaceMode }) => Promise<void>
  removeProject: (id: string) => Promise<void>
  setActiveProject: (id: string | null) => Promise<void>
  setActiveRoot: (id: string | null) => void
  setActiveChannel: (name: string | null) => void
  addRoot: (name?: string, rootPath?: string) => Promise<ProjectRoot | null>
  removeRoot: (id: string) => Promise<void>
  addChannel: (name: string) => Promise<void>
  rememberDiscoveredChannels: (projectId: string | undefined, channels: string[]) => void
  removeChannel: (name: string) => Promise<void>
  renameChannel: (oldName: string, newName: string) => Promise<string | null>
  setChannelPeople: (channelName: string, people: string[]) => Promise<string[]>
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
    const projects = data.projects.flatMap((raw) => {
      const project = parseProject(raw)
      return project ? [project] : []
    })
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
    const project = parseProject(await pear.project.add(name, rootPath))
    if (project) {
      await pear.project.setActive(project.id)
      await get().load()
    }
    return project
  },

  updateProject: async (id, update) => {
    const next: Record<string, unknown> = {}
    if (typeof update.name === 'string') {
      const name = update.name.trim()
      if (name) next.name = name
    }
    if (
      update.cloudAgentWorkspaceMode === 'git-overlay' ||
      update.cloudAgentWorkspaceMode === 'git' ||
      update.cloudAgentWorkspaceMode === 'relayfile'
    ) {
      next.cloudAgentWorkspaceMode = update.cloudAgentWorkspaceMode
    }
    if (Object.keys(next).length === 0) return
    await pear.project.update(id, next)
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
    const root = parseRoot(await pear.project.addRoot(activeProjectId, name, rootPath))
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
                : [...project.channels, channelName],
              channelPeople: project.channelPeople
            }
          : project
      )
    }))
    await get().syncBrokerChannels()
  },

  rememberDiscoveredChannels: (projectId, channelNames) => {
    if (!projectId) return

    const project = get().projects.find((candidate) => candidate.id === projectId)
    if (!project) return

    const missingChannels = normalizeChannelList(channelNames)
      .filter((channel) => !project.channels.includes(channel))
    if (missingChannels.length === 0) return

    set((state) => ({
      projects: state.projects.map((candidate) =>
        candidate.id === projectId
          ? {
              ...candidate,
              channels: [...candidate.channels, ...missingChannels]
            }
          : candidate
      )
    }))

    for (const channel of missingChannels) {
      void pear.project.addChannel(projectId, channel).catch((err) => {
        console.error(`[project] Failed to persist discovered channel ${channel}:`, err)
      })
    }
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
              channels: project.channels.filter((channel) => channel !== channelName),
              channelPeople: Object.fromEntries(
                Object.entries(project.channelPeople).filter(([channel]) => channel !== channelName)
              )
            }
          : project
      )
    }))
    await get().syncBrokerChannels()
  },

  renameChannel: async (oldName, newName) => {
    const { activeProjectId } = get()
    const oldChannelName = normalizeChannelName(oldName)
    const nextChannelName = normalizeChannelName(newName)
    if (!activeProjectId || !oldChannelName || !nextChannelName || oldChannelName === nextChannelName) {
      return null
    }

    const project = get().projects.find((candidate) => candidate.id === activeProjectId)
    if (!project || !project.channels.includes(oldChannelName)) {
      return null
    }

    const peopleForChannel = project.channelPeople[oldChannelName] || []

    await pear.project.addChannel(activeProjectId, nextChannelName)
    await pear.project.removeChannel(activeProjectId, oldChannelName)
    if (peopleForChannel.length > 0) {
      await pear.project.setChannelPeople(activeProjectId, nextChannelName, peopleForChannel)
    }
    set((state) => ({
      activeChannelName: state.activeChannelName === oldChannelName ? nextChannelName : state.activeChannelName,
      projects: state.projects.map((candidate) => {
        if (candidate.id !== activeProjectId) return candidate

        const channels = candidate.channels
          .map((channel) => channel === oldChannelName ? nextChannelName : channel)
          .filter((channel, index, all) => all.indexOf(channel) === index)
        const { [oldChannelName]: oldPeople, ...remainingPeople } = candidate.channelPeople

        return {
          ...candidate,
          channels,
          channelPeople: {
            ...remainingPeople,
            ...(oldPeople?.length ? { [nextChannelName]: oldPeople } : {})
          }
        }
      })
    }))
    await get().syncBrokerChannels()
    return nextChannelName
  },

  setChannelPeople: async (channelName, people) => {
    const { activeProjectId } = get()
    const normalizedChannelName = normalizeChannelName(channelName)
    if (!activeProjectId || !normalizedChannelName) return []

    const nextPeople = await pear.project.setChannelPeople(activeProjectId, normalizedChannelName, people)
    set((state) => ({
      projects: state.projects.map((project) => {
        if (project.id !== activeProjectId) return project

        const channelPeople = { ...project.channelPeople }
        if (nextPeople.length > 0) {
          channelPeople[normalizedChannelName] = nextPeople
        } else {
          delete channelPeople[normalizedChannelName]
        }

        return { ...project, channelPeople }
      })
    }))
    return nextPeople
  },

  addIntegration: async (name, type = 'custom') => {
    const { activeProjectId } = get()
    if (!activeProjectId || !name.trim()) return null
    const integration = parseIntegration(
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
