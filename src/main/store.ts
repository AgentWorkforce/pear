import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { basename, join } from 'path'
import type { ProactiveAgentBinding, ProactiveAgentDraft } from './proactive-agent.types'

export interface ProjectRoot {
  id: string
  name: string
  path: string
}

export interface ProjectIntegration {
  id: string
  name: string
  type: string
  provider?: string
  integrationId?: string
  scope?: Record<string, unknown>
  mountPaths?: string[]
  connectedAt?: string
  notifyAgent?: boolean
  lastSyncAt?: string
  lastError?: string
}

export interface RelayWorkspace {
  id: string
  createdAt: string
}

export interface RelayWorkspaceRecord extends RelayWorkspace {
  apiUrl?: string
  authKey?: string
}

export interface Project {
  id: string
  name: string
  relayWorkspaceId?: string
  rootPath: string
  roots: ProjectRoot[]
  channels: string[]
  channelPeople: Record<string, string[]>
  integrations: ProjectIntegration[]
  cloudAgent?: {
    id: string
    sandboxId: string
    relayfileMountPath: string
    attachedAt: string
    autoPullAfterRun: boolean
  }
  proactiveAgents?: ProactiveAgentBinding[]
}

export type ProjectCloudAgent = NonNullable<Project['cloudAgent']>

interface StoreData {
  projects: Project[]
  activeProjectId: string | null
  relayWorkspace?: { id: string; createdAt: string; apiUrl?: string; authKey?: string }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

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
    createdAt: Number.isNaN(createdAtTime) ? new Date(0).toISOString() : new Date(createdAtTime).toISOString(),
    ...(apiUrl ? { apiUrl } : {}),
    ...(authKey ? { authKey } : {})
  }
}

function normalizeIntegration(value: unknown): ProjectIntegration | null {
  if (!isRecord(value)) return null
  const record = value
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) return null

  const provider = typeof record.provider === 'string' && record.provider.trim()
    ? record.provider.trim()
    : undefined
  const integrationId = typeof record.integrationId === 'string' && record.integrationId.trim()
    ? record.integrationId.trim()
    : undefined
  const scope = isRecord(record.scope) ? record.scope : undefined
  const mountPaths = normalizeStringList(record.mountPaths)

  return {
    id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
    name,
    type: typeof record.type === 'string' && record.type.trim() ? record.type.trim() : 'custom',
    ...(provider ? { provider } : {}),
    ...(integrationId ? { integrationId } : {}),
    ...(scope ? { scope } : {}),
    ...(mountPaths ? { mountPaths } : {}),
    ...(typeof record.connectedAt === 'string' && record.connectedAt.trim()
      ? { connectedAt: record.connectedAt.trim() }
      : {}),
    ...(typeof record.notifyAgent === 'boolean' ? { notifyAgent: record.notifyAgent } : {}),
    ...(typeof record.lastSyncAt === 'string' && record.lastSyncAt.trim()
      ? { lastSyncAt: record.lastSyncAt.trim() }
      : {}),
    ...(typeof record.lastError === 'string' && record.lastError.trim()
      ? { lastError: record.lastError.trim() }
      : {})
  }
}

function normalizeCloudAgent(value: unknown): ProjectCloudAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const sandboxId = typeof record.sandboxId === 'string' ? record.sandboxId.trim() : ''
  const relayfileMountPath =
    typeof record.relayfileMountPath === 'string' ? record.relayfileMountPath : ''

  if (!id || !sandboxId || !relayfileMountPath) return null

  const attachedAt =
    typeof record.attachedAt === 'string' && record.attachedAt.trim()
      ? record.attachedAt
      : new Date(0).toISOString()
  const autoPullAfterRun =
    typeof record.autoPullAfterRun === 'boolean' ? record.autoPullAfterRun : true

  return {
    id,
    sandboxId,
    relayfileMountPath,
    attachedAt,
    autoPullAfterRun
  }
}

function normalizeProactiveAgentDraft(value: unknown): ProactiveAgentDraft | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const cloudAgentId = typeof value.cloudAgentId === 'string' ? value.cloudAgentId.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt : ''
  const handlerCode = typeof value.handlerCode === 'string' ? value.handlerCode : ''

  if (!id || !name || !cloudAgentId || !model || !systemPrompt || !handlerCode) return null

  const harness = value.harness === 'codex' || value.harness === 'opencode' ? value.harness : 'claude'
  const watch = Array.isArray(value.watch)
    ? value.watch
        .filter(isRecord)
        .map((rule) => ({
          paths: normalizeStringList(rule.paths) || [],
          events: (Array.isArray(rule.events) ? rule.events : [])
            .filter((entry): entry is 'created' | 'updated' | 'deleted' =>
              entry === 'created' || entry === 'updated' || entry === 'deleted'
            ),
          ...(typeof rule.debounceMs === 'number' ? { debounceMs: rule.debounceMs } : {}),
          ...(typeof rule.match === 'string' ? { match: rule.match } : {})
        }))
    : []

  return {
    id,
    name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    cloudAgentId,
    harness,
    model,
    systemPrompt,
    integrations: isRecord(value.integrations) ? value.integrations as Record<string, Record<string, unknown>> : {},
    watch,
    handlerCode,
    ...(isRecord(value.inputs) ? { inputs: value.inputs as Record<string, string> } : {}),
    ...(isRecord(value.memory) ? { memory: value.memory as ProactiveAgentDraft['memory'] } : {}),
    ...(isRecord(value.harnessSettings)
      ? { harnessSettings: value.harnessSettings as ProactiveAgentDraft['harnessSettings'] }
      : {}),
    ...(isRecord(value.mount) && typeof value.mount.enabled === 'boolean'
      ? { mount: { enabled: value.mount.enabled } }
      : { mount: { enabled: false } }),
    runMode: value.runMode === 'local' ? 'local' : 'cloud'
  }
}

function normalizeProactiveAgentBinding(value: unknown, projectId: string): ProactiveAgentBinding | null {
  if (!isRecord(value)) return null
  const draft = normalizeProactiveAgentDraft(value.draft)
  if (!draft) return null

  const personaId = typeof value.personaId === 'string' && value.personaId.trim()
    ? value.personaId.trim()
    : draft.id
  const status = value.status === 'warming' ||
    value.status === 'active' ||
    value.status === 'paused' ||
    value.status === 'error'
    ? value.status
    : 'draft'
  const createdAt = typeof value.createdAt === 'string' && value.createdAt.trim()
    ? value.createdAt
    : new Date(0).toISOString()
  const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt.trim()
    ? value.updatedAt
    : createdAt

  return {
    projectId,
    personaId,
    cloudAgentId: draft.cloudAgentId,
    status,
    ...(typeof value.lastError === 'string' && value.lastError.trim() ? { lastError: value.lastError } : {}),
    ...(typeof value.lastFiredAt === 'string' && value.lastFiredAt.trim() ? { lastFiredAt: value.lastFiredAt } : {}),
    createdAt,
    updatedAt,
    draft
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
  const relayWorkspaceId =
    typeof record.relayWorkspaceId === 'string' && record.relayWorkspaceId.trim()
      ? record.relayWorkspaceId.trim()
      : undefined
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
  const cloudAgent = normalizeCloudAgent(record.cloudAgent)
  const proactiveAgents = Array.isArray(record.proactiveAgents) && id
    ? record.proactiveAgents
        .map((entry) => normalizeProactiveAgentBinding(entry, id))
        .filter((entry): entry is ProactiveAgentBinding => entry !== null)
    : []

  if (!id || !name || !primaryRootPath || roots.length === 0) return null

  const channels = normalizeChannels(record.channels)

  return {
    id,
    name,
    rootPath: primaryRootPath,
    roots,
    channels,
    channelPeople: normalizeChannelPeople(record.channelPeople, channels),
    integrations,
    ...(relayWorkspaceId ? { relayWorkspaceId } : {}),
    ...(cloudAgent ? { cloudAgent } : {}),
    ...(proactiveAgents.length > 0 ? { proactiveAgents } : {})
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
  const relayWorkspace = normalizeRelayWorkspace(record.relayWorkspace)

  return {
    projects,
    activeProjectId,
    ...(relayWorkspace ? { relayWorkspace } : {})
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
  const root: ProjectRoot = {
    id: crypto.randomUUID(),
    name: defaultRootName(rootPath),
    path: rootPath
  }
  const project: Project = {
    id: crypto.randomUUID(),
    name,
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
