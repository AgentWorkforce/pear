import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { basename, join } from 'path'

export interface ProjectRoot {
  id: string
  name: string
  path: string
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
  roots: ProjectRoot[]
  channels: string[]
  channelPeople: Record<string, string[]>
  integrations: ProjectIntegration[]
}

interface StoreData {
  projects: Project[]
  activeProjectId: string | null
}

const getStorePath = (): string => {
  const dir = join(app.getPath('userData'), 'config')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'projects.json')
}

const defaultData: StoreData = { projects: [], activeProjectId: null }

function defaultRootName(path: string): string {
  return basename(path) || path
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
    path
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

function normalizeChannelName(value: string): string {
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

function normalizePeopleList(value: unknown): string[] {
  const people = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
  const names = people.map((entry) => entry.trim()).filter(Boolean)
  return Array.from(new Map(names.map((name) => [name.toLowerCase(), name])).values())
}

function normalizeChannelPeople(value: unknown, channels: string[]): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const channelSet = new Set(channels)
  const result: Record<string, string[]> = {}
  for (const [rawChannelName, rawPeople] of Object.entries(value as Record<string, unknown>)) {
    const channelName = normalizeChannelName(rawChannelName)
    if (!channelName || !channelSet.has(channelName)) continue

    const people = normalizePeopleList(rawPeople)
    if (people.length > 0) {
      result[channelName] = people
    }
  }

  return result
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
  const primaryRootPath = rootPath || roots[0]?.path || null
  const integrations = Array.isArray(record.integrations)
    ? record.integrations
        .map(normalizeIntegration)
        .filter((entry): entry is ProjectIntegration => entry !== null)
    : []

  if (!id || !name || !primaryRootPath || roots.length === 0) return null

  const channels = normalizeChannels(record.channels)

  return {
    id,
    name,
    relayWorkspaceId,
    rootPath: primaryRootPath,
    roots,
    channels,
    channelPeople: normalizeChannelPeople(record.channelPeople, channels),
    integrations
  }
}

function normalizeStore(raw: unknown): StoreData {
  if (!raw || typeof raw !== 'object') return { ...defaultData }
  const record = raw as Record<string, unknown>
  const projects = Array.isArray(record.projects)
    ? record.projects.map(normalizeProject).filter((entry): entry is Project => entry !== null)
    : []
  const activeProjectId =
    typeof record.activeProjectId === 'string' || record.activeProjectId === null
      ? record.activeProjectId
      : null

  return {
    projects,
    activeProjectId
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

export function addProject(name: string, rootPath: string): Project {
  const data = loadStore()
  const root: ProjectRoot = {
    id: crypto.randomUUID(),
    name: defaultRootName(rootPath),
    path: rootPath
  }
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    relayWorkspaceId: crypto.randomUUID(),
    rootPath,
    roots: [root],
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

export function addProjectChannel(projectId: string, channelName: string): void {
  const data = loadStore()
  const project = data.projects.find((entry) => entry.id === projectId)
  const normalizedName = normalizeChannelName(channelName)
  if (project && normalizedName && !project.channels.includes(normalizedName)) {
    project.channels.push(normalizedName)
    saveStore(data)
  }
}

export function removeProjectChannel(projectId: string, channelName: string): void {
  const data = loadStore()
  const project = data.projects.find((entry) => entry.id === projectId)
  const normalizedName = normalizeChannelName(channelName)
  if (project) {
    project.channels = project.channels.filter((channel) => channel !== normalizedName)
    delete project.channelPeople[normalizedName]
    saveStore(data)
  }
}

export function setProjectChannelPeople(projectId: string, channelName: string, people: string[]): string[] {
  const data = loadStore()
  const project = data.projects.find((entry) => entry.id === projectId)
  const normalizedName = normalizeChannelName(channelName)
  if (!project || !normalizedName || !project.channels.includes(normalizedName)) {
    return []
  }

  const normalizedPeople = normalizePeopleList(people)
  if (normalizedPeople.length > 0) {
    project.channelPeople[normalizedName] = normalizedPeople
  } else {
    delete project.channelPeople[normalizedName]
  }
  saveStore(data)
  return normalizedPeople
}

export function addProjectRoot(projectId: string, rootPath: string, name?: string): ProjectRoot {
  const data = loadStore()
  const project = data.projects.find((entry) => entry.id === projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  const existing = project.roots.find((root) => root.path === rootPath)
  if (existing) {
    return existing
  }

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
  const project = data.projects.find((entry) => entry.id === projectId)
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
  const project = data.projects.find((entry) => entry.id === projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  const integration: ProjectIntegration = {
    id: crypto.randomUUID(),
    name: name.trim(),
    type: type.trim() || 'custom'
  }

  if (!integration.name) {
    throw new Error('Integration name is required')
  }

  project.integrations.push(integration)
  saveStore(data)
  return integration
}

export function removeProjectIntegration(projectId: string, integrationId: string): void {
  const data = loadStore()
  const project = data.projects.find((entry) => entry.id === projectId)
  if (!project) return

  project.integrations = project.integrations.filter((integration) => integration.id !== integrationId)
  saveStore(data)
}

export function updateProject(id: string, update: Partial<Project>): void {
  const data = loadStore()
  const idx = data.projects.findIndex((project) => project.id === id)
  if (idx !== -1) {
    const next = { ...data.projects[idx] }
    if (typeof update.name === 'string' && update.name.trim()) {
      next.name = update.name.trim()
    }
    data.projects[idx] = next
    saveStore(data)
  }
}
