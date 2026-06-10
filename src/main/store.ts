import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { basename, join, resolve } from 'path'
import { z } from 'zod'
import type { ProactiveAgentBinding, ProactiveAgentDraft } from './proactive-agent.types'
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

export type CloudAgentWorkspaceMode = 'git-overlay' | 'git' | 'relayfile'

export type ProjectRoot = z.infer<typeof ProjectRootSchema>
export type ProjectIntegration = z.infer<typeof ProjectIntegrationSchema>

// The persisted project schema parses with `.passthrough()`, so wave-additive
// fields (cloud-agent / proactive-agent / workspace mode) survive a load/save
// round-trip on disk even though the base zod schema does not name them. Widen
// the static type to match what is actually persisted and read back, so the
// main-process consumers (cloud-agent.ts, proactive-agent.ts) see real types
// instead of property-not-found errors. No runtime behavior changes.
export type Project = z.infer<typeof ProjectSchema> & {
  cloudAgent?: ProjectCloudAgent
  cloudAgentWorkspaceMode?: CloudAgentWorkspaceMode
  proactiveAgents?: ProactiveAgentBinding[]
}

type StoreData = Omit<z.infer<typeof StoreSchema>, 'projects'> & {
  projects: Project[]
  relayWorkspace?: RelayWorkspaceRecord
}

const defaultData: StoreData = { projects: [], activeProjectId: null }

// Wave-additive types (cloud-agent / proactive-agent / relay workspace) — kept
// as ambient exports here so per-spec branches that consume them compile. The
// schema-side extensions will land with the per-spec branches that need them.
export type ProjectCloudAgent = {
  id: string
  sandboxId: string
  relayfileMountPath: string
  attachedAt: string
  autoPullAfterRun: boolean
  workspaceSource?: {
    kind: 'relayfile'
  } | {
    kind: 'git' | 'git-overlay'
    remoteUrl: string
    ref?: string
    commit?: string
    shallow?: boolean
    targetDir?: string
    largeReason?: string
  }
}

export interface RelayWorkspace {
  id: string
  createdAt: string
}

export interface RelayWorkspaceRecord extends RelayWorkspace {
  apiUrl?: string
  authKey?: string
}

export type { ProactiveAgentBinding, ProactiveAgentDraft }

const getStorePath = (): string => {
  const dir = join(app.getPath('userData'), 'config')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'projects.json')
}

function defaultRootName(path: string): string {
  return basename(path) || path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Normalize an untrusted relay-workspace record read from disk or supplied by a
// caller into a clean RelayWorkspaceRecord, or undefined when it lacks a usable
// id. Restores behavior lost in the wave-scaffolding merge (the call sites in
// setRelayWorkspace/setRelayWorkspaceRecord survived without the definition).
function normalizeRelayWorkspace(value: unknown): RelayWorkspaceRecord | undefined {
  if (!isRecord(value)) return undefined

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id) return undefined

  const createdAt = typeof value.createdAt === 'string' ? value.createdAt.trim() : ''
  const createdAtTime = createdAt ? Date.parse(createdAt) : Number.NaN
  const apiUrl = typeof value.apiUrl === 'string' ? value.apiUrl.trim().replace(/\/+$/, '') : ''
  const authKey = typeof value.authKey === 'string' ? value.authKey.trim() : ''

  return {
    id,
    createdAt: Number.isNaN(createdAtTime)
      ? new Date(0).toISOString()
      : new Date(createdAtTime).toISOString(),
    ...(apiUrl ? { apiUrl } : {}),
    ...(authKey ? { authKey } : {})
  }
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

export function getRelayWorkspace(): { id: string; createdAt: string } | null {
  const relayWorkspace = loadStore().relayWorkspace
  return relayWorkspace ? { id: relayWorkspace.id, createdAt: relayWorkspace.createdAt } : null
}

export function setRelayWorkspace(workspace: { id: string; createdAt: string }): void {
  const data = loadStore()
  const relayWorkspace = normalizeRelayWorkspace(workspace)
  if (relayWorkspace) {
    data.relayWorkspace = { id: relayWorkspace.id, createdAt: relayWorkspace.createdAt }
  } else {
    delete data.relayWorkspace
  }
  saveStore(data)
}

export function clearRelayWorkspace(): void {
  const data = loadStore()
  delete data.relayWorkspace
  saveStore(data)
}

export function getRelayWorkspaceRecord(): RelayWorkspaceRecord | undefined {
  return loadStore().relayWorkspace
}

export function setRelayWorkspaceRecord(record: RelayWorkspaceRecord | null): void {
  const data = loadStore()
  const relayWorkspace = normalizeRelayWorkspace(record)
  if (relayWorkspace) {
    data.relayWorkspace = relayWorkspace
  } else {
    delete data.relayWorkspace
  }
  saveStore(data)
}

export function addProject(name: string, rootPath: string): Project {
  const data = loadStore()
  const id = crypto.randomUUID()
  const project: Project = {
    id,
    name,
    // Mirrors the schema default (relayWorkspaceId falls back to the project id).
    relayWorkspaceId: id,
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

export function findProjectsWithPath(rootPath: string): Array<{ id: string; name: string }> {
  const data = loadStore()
  const normalizedRootPath = resolve(rootPath)
  return data.projects
    .filter((p) => p.roots.some((r) => resolve(r.path) === normalizedRootPath))
    .map((p) => ({ id: p.id, name: p.name }))
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
  const workspaceMode = (update as { cloudAgentWorkspaceMode?: unknown }).cloudAgentWorkspaceMode
  if (workspaceMode === 'git-overlay' || workspaceMode === 'git' || workspaceMode === 'relayfile') {
    const nextWithWorkspaceMode = next as { cloudAgentWorkspaceMode?: typeof workspaceMode }
    nextWithWorkspaceMode.cloudAgentWorkspaceMode = workspaceMode
  }
  data.projects[idx] = next
  saveStore(data)
}
