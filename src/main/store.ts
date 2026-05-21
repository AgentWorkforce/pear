import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { basename, join } from 'path'
import { z } from 'zod'
import {
  PeopleListSchema,
  ProjectIntegrationSchema,
  ProjectRootSchema,
  StoreDataSchema,
  makeProjectSchema,
  normalizeChannelName
} from '../shared/schemas/project'

const ProjectSchema = makeProjectSchema(ProjectRootSchema)
const StoreSchema = StoreDataSchema(ProjectSchema)

export type ProjectRoot = z.infer<typeof ProjectRootSchema>
export type ProjectIntegration = z.infer<typeof ProjectIntegrationSchema>
export type Project = z.infer<typeof ProjectSchema>
type StoreData = z.infer<typeof StoreSchema>

const defaultData: StoreData = { projects: [], activeProjectId: null }

const getStorePath = (): string => {
  const dir = join(app.getPath('userData'), 'config')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'projects.json')
}

function defaultRootName(path: string): string {
  return basename(path) || path
}

function loadStoreFromDisk(): StoreData {
  try {
    const raw = readFileSync(getStorePath(), 'utf-8')
    return StoreSchema.parse(JSON.parse(raw))
  } catch {
    return { ...defaultData }
  }
}

export const loadStore = loadStoreFromDisk

export function saveStore(data: StoreData): void {
  const storePath = getStorePath()
  const tmpPath = storePath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(data, null, 2))
  renameSync(tmpPath, storePath)
}

export function addProject(name: string, rootPath: string): Project {
  const data = loadStore()
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    relayWorkspaceId: crypto.randomUUID(),
    rootPath,
    roots: [{ id: crypto.randomUUID(), name: defaultRootName(rootPath), path: rootPath }],
    channels: ['general'],
    channelPeople: {},
    integrations: []
  }
  data.projects.push(project)
  saveStore(data)
  return project
}

export function removeProject(id: string): void {
  const data = loadStore()
  data.projects = data.projects.filter((project) => project.id !== id)
  if (data.activeProjectId === id) data.activeProjectId = null
  saveStore(data)
}

export function setActiveProject(id: string | null): void {
  const data = loadStore()
  data.activeProjectId = id
  saveStore(data)
}

function withProject(data: StoreData, projectId: string): Project | undefined {
  return data.projects.find((entry) => entry.id === projectId)
}

export function addProjectChannel(projectId: string, channelName: string): void {
  const data = loadStore()
  const project = withProject(data, projectId)
  const normalized = normalizeChannelName(channelName)
  if (project && normalized && !project.channels.includes(normalized)) {
    project.channels.push(normalized)
    saveStore(data)
  }
}

export function removeProjectChannel(projectId: string, channelName: string): void {
  const data = loadStore()
  const project = withProject(data, projectId)
  const normalized = normalizeChannelName(channelName)
  if (project) {
    project.channels = project.channels.filter((channel) => channel !== normalized)
    delete project.channelPeople[normalized]
    saveStore(data)
  }
}

export function setProjectChannelPeople(projectId: string, channelName: string, people: string[]): string[] {
  const data = loadStore()
  const project = withProject(data, projectId)
  const normalized = normalizeChannelName(channelName)
  if (!project || !normalized || !project.channels.includes(normalized)) {
    return []
  }

  const normalizedPeople = PeopleListSchema.parse(people)
  if (normalizedPeople.length > 0) {
    project.channelPeople[normalized] = normalizedPeople
  } else {
    delete project.channelPeople[normalized]
  }
  saveStore(data)
  return normalizedPeople
}

export function addProjectRoot(projectId: string, rootPath: string, name?: string): ProjectRoot {
  const data = loadStore()
  const project = withProject(data, projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  const existing = project.roots.find((root) => root.path === rootPath)
  if (existing) return existing

  const root: ProjectRoot = {
    id: crypto.randomUUID(),
    name: name?.trim() || defaultRootName(rootPath),
    path: rootPath
  }
  project.roots.push(root)
  saveStore(data)
  return root
}

export function removeProjectRoot(projectId: string, rootId: string): void {
  const data = loadStore()
  const project = withProject(data, projectId)
  if (!project) return

  if (project.roots.length <= 1) {
    throw new Error('A project must have at least one root')
  }

  project.roots = project.roots.filter((root) => root.id !== rootId)
  if (!project.roots.some((root) => root.path === project.rootPath)) {
    project.rootPath = project.roots[0].path
  }
  saveStore(data)
}

export function addProjectIntegration(
  projectId: string,
  name: string,
  type = 'custom'
): ProjectIntegration {
  const data = loadStore()
  const project = withProject(data, projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  const integration = ProjectIntegrationSchema.parse({ name, type })
  project.integrations.push(integration)
  saveStore(data)
  return integration
}

export function removeProjectIntegration(projectId: string, integrationId: string): void {
  const data = loadStore()
  const project = withProject(data, projectId)
  if (!project) return

  project.integrations = project.integrations.filter((integration) => integration.id !== integrationId)
  saveStore(data)
}

export function updateProject(id: string, update: Partial<Project>): void {
  const data = loadStore()
  const idx = data.projects.findIndex((project) => project.id === id)
  if (idx === -1) return

  const next = { ...data.projects[idx] }
  if (typeof update.name === 'string' && update.name.trim()) {
    next.name = update.name.trim()
  }
  data.projects[idx] = next
  saveStore(data)
}

