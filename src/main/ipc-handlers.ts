import { app, ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { toErrorMessage } from './errors'
import { isRecord } from './guards'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import type { SpawnPtyInput, SendMessageInput } from '@agent-relay/harness-driver'
import {
  loadStore,
  addProject,
  removeProject,
  setActiveProject,
  updateProject,
  addProjectChannel,
  removeProjectChannel,
  setProjectChannelPeople,
  addProjectRoot,
  removeProjectRoot,
  findProjectsWithPath,
  addProjectIntegration,
  removeProjectIntegration
} from './store'
import { brokerManager, isCommandAvailableWithAugmentedPath } from './broker'
import * as git from './git'
import * as filesystem from './filesystem'
import * as auth from './auth'
import { cloudAgentManager } from './cloud-agent'
import { proactiveAgentManager } from './proactive-agent'
import { integrationsManager } from './integrations'
import { getIntegrationEventTelemetrySnapshot, integrationEventBridge } from './integration-event-bridge'
import { aiHistManager } from './ai-hist'
import { burnManager, type BurnAgentInput, type BurnProjectInput, type BurnSessionBreakdownInput, type BurnFingerprintInput } from './burn'
import { resetRelayWorkspaceManager } from './relay-workspace'
import { isDirectory } from './path-utils'
import { findProjectForPath, projectContainsPath } from './cli'
import type {
  BrokerReconcileMessagesInput,
  BrokerSpawnAgentResult,
  FactoryAgentStatus,
  FactoryConfigReadResult,
  FactoryIssueStatus,
  FactoryNodeConfig,
  FactoryStatus,
  TermFidelityCorpusInput
} from '../shared/types/ipc'
import type { ProactiveAgentDraft } from './proactive-agent.types'
import { TermFidelityCorpusDumper } from './term-fidelity-corpus'

const termFidelityCorpusDumper = new TermFidelityCorpusDumper()

async function termFidelityRelayVersions(projectId?: string): Promise<Record<string, string>> {
  let declaredRelayVersions: Record<string, string> = {}
  try {
    const manifest = JSON.parse(
      await readFile(join(app.getAppPath(), 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, unknown> } | null
    declaredRelayVersions = Object.fromEntries(
      Object.entries(manifest?.dependencies || {}).filter(
        ([name, version]) =>
          (name === 'agent-relay' || name.startsWith('@agent-relay/')) &&
          typeof version === 'string'
      )
    ) as Record<string, string>
  } catch {
    // Broker version metadata below still makes the bundle actionable when a
    // packaged app manifest is unavailable.
  }
  const versions: Record<string, string> = {
    pear: app.getVersion(),
    ...declaredRelayVersions
  }
  const details = await brokerManager.listBrokerDetails().catch(() => [])
  for (const detail of details) {
    if (projectId && detail.projectId !== projectId) continue
    if (detail.session?.brokerVersion) {
      versions[`broker:${detail.name}`] = detail.session.brokerVersion
    }
  }
  return versions
}

function toBrokerSpawnAgentResult(result: BrokerSpawnAgentResult): BrokerSpawnAgentResult {
  return {
    name: result.name,
    runtime: result.runtime,
    ...(result.cli ? { cli: result.cli } : {})
  }
}

function getProjectIdForPath(targetPath: string): string | null {
  const resolved = resolve(targetPath)
  const { projects } = loadStore()
  const project = findProjectForPath(projects, resolved)
  return project?.id || null
}

function assertPathWithinProjects(targetPath: string): void {
  const resolved = resolve(targetPath)
  if (!getProjectIdForPath(resolved)) {
    throw new Error(`Path is outside all known project roots: ${resolved}`)
  }
}

const gitStatusWarnings = new Set<string>()


function warnGitStatusOnce(path: string, error: unknown): void {
  const message = toErrorMessage(error)
  const key = `${path}:${message}`
  if (gitStatusWarnings.has(key)) return
  gitStatusWarnings.add(key)
  console.warn(`[git] Failed to read status for ${path}: ${message}`)
}


function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key]
    if (isRecord(value)) return value
  }
  return undefined
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function buildCloudApiUrl(apiUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/u, ''), `${apiUrl.replace(/\/+$/u, '')}/`).toString()
}

function defaultFactoryConfigPath(projectRoot?: string): string {
  const candidates = [
    projectRoot ? join(projectRoot, 'factory.config.json') : undefined,
    join(process.cwd(), 'factory.config.json'),
    join(app.getAppPath(), 'factory.config.json')
  ].filter((candidate): candidate is string => !!candidate)

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function normalizeFactoryConfigPath(path?: string, projectRoot?: string): string {
  if (path?.trim()) return isAbsolute(path) ? path : resolve(projectRoot || process.cwd(), path)
  return defaultFactoryConfigPath(projectRoot)
}

function emptyNodeConfig(): FactoryNodeConfig {
  return {
    capabilities: [],
    clonePaths: {},
    dryRun: false
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a[key] === b[key])
}

function normalizeNodeConfigInput(input: unknown): { config: FactoryNodeConfig | null; errors: string[] } {
  if (!isRecord(input)) {
    return { config: null, errors: ['nodeConfig: must be an object'] }
  }

  const errors: string[] = []
  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.trim()
    ? input.workspaceId.trim()
    : undefined
  const cloneRoot = typeof input.cloneRoot === 'string' && input.cloneRoot.trim()
    ? input.cloneRoot.trim()
    : undefined
  const capabilities = Array.isArray(input.capabilities)
    ? input.capabilities.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim())
    : []
  if (input.capabilities !== undefined && !Array.isArray(input.capabilities)) {
    errors.push('capabilities: must be an array of strings')
  }
  if (input.clonePaths !== undefined && !isRecord(input.clonePaths)) {
    errors.push('clonePaths: must be an object of repo-to-path strings')
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    errors.push('dryRun: must be a boolean')
  }

  if (errors.length > 0) return { config: null, errors }

  return {
    config: {
      ...(workspaceId ? { workspaceId } : {}),
      capabilities,
      ...(cloneRoot ? { cloneRoot } : {}),
      clonePaths: stringRecord(input.clonePaths),
      dryRun: typeof input.dryRun === 'boolean' ? input.dryRun : false
    },
    errors: []
  }
}

// NodeConfig fields (cloneRoot/clonePaths) live at the TOP LEVEL of compact
// configs, but split configs inherit them from workspaceConfig.repos when
// nodeConfig omits them. Keep this in sync with @agent-relay/factory's
// combineSplitConfigInput semantics.
function extractNodeConfig(raw: Record<string, unknown>): FactoryNodeConfig {
  const isSplitConfig = isRecord(raw.nodeConfig) || isRecord(raw.workspaceConfig)
  const source = isRecord(raw.nodeConfig)
    ? raw.nodeConfig
    : isRecord(raw.factoryConfig)
      ? raw.factoryConfig
      : raw
  const workspaceConfig = isSplitConfig && isRecord(raw.workspaceConfig) ? raw.workspaceConfig : undefined
  const repos = isRecord(source.repos)
    ? source.repos
    : isRecord(workspaceConfig?.repos)
      ? workspaceConfig.repos
      : undefined
  const normalized = normalizeNodeConfigInput({
    workspaceId: source.workspaceId ?? workspaceConfig?.workspaceId,
    capabilities: source.capabilities,
    cloneRoot: source.cloneRoot ?? repos?.cloneRoot,
    clonePaths: source.clonePaths ?? repos?.clonePaths,
    dryRun: source.dryRun
  })
  return normalized.config ?? emptyNodeConfig()
}

function splitNodeConfigForSave(raw: Record<string, unknown>, parsed: FactoryNodeConfig): Partial<FactoryNodeConfig> {
  const previousNode = isRecord(raw.nodeConfig) ? raw.nodeConfig : {}
  const workspace = isRecord(raw.workspaceConfig) ? raw.workspaceConfig : {}
  const workspaceRepos = isRecord(workspace.repos) ? workspace.repos : {}
  const next: Partial<FactoryNodeConfig> = { ...parsed }

  if (!hasOwn(previousNode, 'workspaceId') && parsed.workspaceId === workspace.workspaceId) {
    delete next.workspaceId
  }

  if (!hasOwn(previousNode, 'cloneRoot') && parsed.cloneRoot === workspaceRepos.cloneRoot) {
    delete next.cloneRoot
  }

  const workspaceClonePaths = stringRecord(workspaceRepos.clonePaths)
  if (
    !hasOwn(previousNode, 'clonePaths') &&
    recordsEqual(parsed.clonePaths ?? {}, workspaceClonePaths)
  ) {
    delete next.clonePaths
  }

  return next
}

async function readFactoryNodeConfig(configPath?: string, projectRoot?: string): Promise<FactoryConfigReadResult> {
  const path = normalizeFactoryConfigPath(configPath, projectRoot)
  if (!existsSync(path)) {
    return { configPath: path, exists: false, config: emptyNodeConfig(), errors: [] }
  }

  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(raw)) throw new Error('factory config must be a JSON object')
    return { configPath: path, exists: true, config: extractNodeConfig(raw), errors: [] }
  } catch (error) {
    return { configPath: path, exists: true, config: null, errors: [toErrorMessage(error)] }
  }
}

async function saveFactoryNodeConfig(
  config: unknown,
  configPath?: string,
  projectRoot?: string
): Promise<FactoryConfigReadResult> {
  const path = normalizeFactoryConfigPath(configPath, projectRoot)
  const parsed = normalizeNodeConfigInput(config)
  if (!parsed.config) {
    return { configPath: path, exists: existsSync(path), config: null, errors: parsed.errors }
  }

  let raw: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (isRecord(existing)) raw = existing
    } catch {
      raw = {}
    }
  }

  let next: Record<string, unknown>
  if (isRecord(raw.nodeConfig) || isRecord(raw.workspaceConfig)) {
    next = { ...raw, nodeConfig: splitNodeConfigForSave(raw, parsed.config) }
  } else if (isRecord(raw.factoryConfig)) {
    next = { ...raw, factoryConfig: { ...raw.factoryConfig, ...parsed.config } }
  } else {
    next = { ...raw, ...parsed.config }
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { configPath: path, exists: true, config: parsed.config, errors: [] }
}

function normalizeIssue(value: unknown): FactoryIssueStatus | null {
  if (!isRecord(value)) return null
  const key = firstString(value, ['key', 'issueKey', 'id'])
  if (!key) return null
  return {
    key,
    title: firstString(value, ['title', 'name', 'summary']),
    url: firstString(value, ['url', 'href']),
    state: firstString(value, ['state', 'status']),
    repo: firstString(value, ['repo', 'repository', 'repositoryName']),
    assignee: firstString(value, ['assignee', 'owner']),
    updatedAt: firstString(value, ['updatedAt', 'updated_at', 'lastActivityAt'])
  }
}

function normalizeAgent(value: unknown): FactoryAgentStatus | null {
  if (!isRecord(value)) return null
  const name = firstString(value, ['name', 'agentName', 'id'])
  if (!name) return null
  const issueRecord = firstRecord(value, ['issue', 'linearIssue'])
  const issue = issueRecord ? normalizeIssue(issueRecord) : null
  return {
    id: firstString(value, ['id', 'agentId']),
    name,
    role: firstString(value, ['role', 'persona']),
    status: firstString(value, ['status', 'state']),
    ...(issue ? { issue } : {})
  }
}

function normalizeFactoryCloudStatus(
  payload: Record<string, unknown>,
  auth: { apiUrl: string },
  workspaceId: string
): FactoryStatus {
  const root = firstRecord(payload, ['factory', 'status']) ?? payload
  // A speculative cloud payload can list the same issue across the
  // issues/inFlight/queued buckets; dedup by key (keep first occurrence) so the
  // renderer never emits duplicate React keys and we treat duplicate delivery as
  // normal per AGENTS.md.
  const seenIssueKeys = new Set<string>()
  const issues = [
    ...firstArray(root, ['issues']),
    ...firstArray(root, ['inFlight', 'inflight']),
    ...firstArray(root, ['queued'])
  ]
    .map(normalizeIssue)
    .filter((issue): issue is FactoryIssueStatus => {
      if (!issue) return false
      if (seenIssueKeys.has(issue.key)) return false
      seenIssueKeys.add(issue.key)
      return true
    })
  const agents = firstArray(root, ['agents', 'workers', 'spawns'])
    .map(normalizeAgent)
    .filter((agent): agent is FactoryAgentStatus => !!agent)
  const counters = firstRecord(root, ['counters', 'counts'])
  const stateText = firstString(root, ['state', 'status'])
  const hasCloudState = issues.length > 0 || agents.length > 0 || (counters && Object.keys(counters).length > 0)

  return {
    source: 'cloud',
    state: stateText === 'unavailable' || stateText === 'offline'
      ? 'unavailable'
      : hasCloudState
        ? 'online'
        : 'empty',
    connected: true,
    workspaceId,
    cloudUrl: auth.apiUrl,
    updatedAt: firstString(root, ['updatedAt', 'updated_at']) ?? new Date().toISOString(),
    message: firstString(root, ['message', 'detail']),
    counters: counters
      ? Object.fromEntries(
        Object.entries(counters)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
      )
      : undefined,
    agents,
    issues
  }
}

function emptyFactoryCloudStatus(
  auth: { apiUrl: string },
  workspaceId: string,
  message = 'Cloud factory status is not available yet.'
): FactoryStatus {
  return {
    source: 'cloud',
    state: 'empty',
    connected: true,
    workspaceId,
    cloudUrl: auth.apiUrl,
    updatedAt: new Date().toISOString(),
    message,
    agents: [],
    issues: []
  }
}

let factoryStatusInFlight: Promise<FactoryStatus> | null = null

async function readFactoryCloudStatus(): Promise<FactoryStatus> {
  const authState = await auth.resolveCloudAuth()
  if (!authState) {
    return {
      source: 'cloud',
      state: 'unauthenticated',
      connected: false,
      message: 'Sign in to Agent Relay Cloud to view factory status.',
      agents: [],
      issues: []
    }
  }

  let workspaceId: string
  try {
    workspaceId = await auth.getAccountWorkspaceId(auth.accountWorkspaceReadyRetryOptions())
  } catch (error) {
    return {
      source: 'cloud',
      state: 'unconfigured',
      connected: false,
      cloudUrl: authState.apiUrl,
      message: toErrorMessage(error),
      agents: [],
      issues: []
    }
  }

  const endpoints = [
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/factory/status`,
    `/api/v1/factory/status?workspaceId=${encodeURIComponent(workspaceId)}`,
    `/api/factory/status?workspaceId=${encodeURIComponent(workspaceId)}`
  ]
  let unsupported = false

  for (const endpoint of endpoints) {
    const response = await fetch(buildCloudApiUrl(authState.apiUrl, endpoint), {
      headers: { Authorization: `Bearer ${authState.accessToken}`, Accept: 'application/json' }
    }).catch((error: unknown) => {
      throw new Error(`Cloud factory status request failed: ${toErrorMessage(error)}`)
    })
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      unsupported = true
      continue
    }
    if (response.status === 401 || response.status === 403) {
      return {
        source: 'cloud',
        state: 'unauthenticated',
        connected: false,
        workspaceId,
        cloudUrl: authState.apiUrl,
        message: 'Cloud authentication expired. Sign in again to view factory status.',
        agents: [],
        issues: []
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        source: 'cloud',
        state: 'unavailable',
        connected: false,
        workspaceId,
        cloudUrl: authState.apiUrl,
        message: `Cloud factory status failed: ${response.status} ${text || response.statusText}`,
        agents: [],
        issues: []
      }
    }
    const payload = await response.json().catch(() => ({})) as unknown
    return normalizeFactoryCloudStatus(isRecord(payload) ? payload : {}, authState, workspaceId)
  }

  return emptyFactoryCloudStatus(
    authState,
    workspaceId,
    unsupported ? 'Cloud factory status endpoint is not available yet.' : undefined
  )
}

function factoryStatus(): Promise<FactoryStatus> {
  if (!factoryStatusInFlight) {
    factoryStatusInFlight = readFactoryCloudStatus().finally(() => {
      factoryStatusInFlight = null
    })
  }
  return factoryStatusInFlight
}

export function registerIpcHandlers(): void {
  // Fan proactive-agent events out to all renderer windows.
  proactiveAgentManager.onEvent((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('proactive-agent:event', event)
    }
  })

  // --- App ---
  ipcMain.handle('app:confirm-quit', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Close Pear', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Close Pear?',
      message: 'Close Pear by Agent Relay?',
      detail: 'Agent Relay will be shut down before the app closes.'
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)

    if (result.response !== 0) return false

    await brokerManager.shutdown()
    app.quit()
    return true
  })

  ipcMain.handle(
    'term-fidelity:dump-corpus',
    async (event, input: TermFidelityCorpusInput) => {
      return termFidelityCorpusDumper.dump(input, {
        rootDir: join(app.getPath('userData'), 'term-fidelity-corpus'),
        capturePage: async () => (await event.sender.capturePage()).toPNG(),
        relayVersions: () => termFidelityRelayVersions(input.projectId)
      })
    }
  )

  // --- Project ---
  ipcMain.handle('project:list', () => {
    const data = loadStore()
    return {
      projects: data.projects.map((project) => ({
        ...project,
        rootPathExists: isDirectory(project.rootPath),
        roots: project.roots.map((root) => ({
          ...root,
          pathExists: isDirectory(root.path)
        }))
      })),
      activeId: data.activeProjectId
    }
  })

  ipcMain.handle('project:add', async (event, name: string, rootPath?: string) => {
    let path = rootPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window available')
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select project root directory'
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    return addProject(name, path)
  })

  ipcMain.handle('project:remove', (_, id: string) => {
    removeProject(id)
  })

  ipcMain.handle('project:set-active', async (_, id: string | null) => {
    setActiveProject(id)
    await integrationsManager.hydrateActiveProject(id)
  })

  ipcMain.handle('project:update', (_, id: string, update: Record<string, unknown>) => {
    updateProject(id, update)
  })

  ipcMain.handle('project:add-channel', (_, projectId: string, name: string) => {
    addProjectChannel(projectId, name)
  })

  ipcMain.handle('project:remove-channel', (_, projectId: string, name: string) => {
    removeProjectChannel(projectId, name)
  })

  ipcMain.handle('project:set-channel-people', (_, projectId: string, channelName: string, people: string[]) => {
    return setProjectChannelPeople(projectId, channelName, people)
  })

  ipcMain.handle('project:add-root', async (event, projectId: string, name?: string, rootPath?: string) => {
    let path = rootPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window available')
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select project root directory'
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }

    const conflict = findProjectsWithPath(path).find((p) => p.id !== projectId)
    if (conflict) {
      return { kind: 'conflict', projectId, existingProjectId: conflict.id, existingProjectName: conflict.name, path }
    }

    return { kind: 'added', root: addProjectRoot(projectId, path, name) }
  })

  ipcMain.handle('project:create-worktree-root', async (_, projectId: string, repoPath: string, projectName: string, name?: string) => {
    const gitRoot = await git.getGitRoot(repoPath)
    if (!gitRoot) throw new Error(`Not a git repository: ${repoPath}`)

    const repoBasename = basename(gitRoot)
    const repoHash = createHash('sha1').update(gitRoot).digest('hex').slice(0, 8)
    const worktreePath = join(app.getPath('userData'), 'worktrees', projectId, `${repoBasename}-${repoHash}`)

    const branchSlug = projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pear'
    const projectSlug = projectId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 8)
    const branchName = `pear/${branchSlug}${projectSlug ? `-${projectSlug}` : ''}`

    if (!git.worktreeExists(worktreePath)) {
      await git.createWorktree(gitRoot, worktreePath, branchName)
    }
    return addProjectRoot(projectId, worktreePath, name || repoBasename)
  })

  ipcMain.handle('project:remove-root', (_, projectId: string, rootId: string) => {
    removeProjectRoot(projectId, rootId)
  })

  ipcMain.handle('project:add-integration', (_, projectId: string, name: string, type?: string) => {
    return addProjectIntegration(projectId, name, type)
  })

  ipcMain.handle('project:remove-integration', (_, projectId: string, integrationId: string) => {
    removeProjectIntegration(projectId, integrationId)
  })

  // --- Broker ---
  ipcMain.handle('broker:start', async (event, projectId: string, cwd: string, name: string, channels?: string[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      console.warn(`[broker] Project path no longer exists; skipping broker start: ${cwd}`)
      return false
    }
    const started = await brokerManager.start(projectId, cwd, name, win, channels)
    if (started) {
      void integrationsManager.notifyAgentState(projectId).catch((error) => {
        console.warn('[integrations] Failed to notify agents after broker start:', error instanceof Error ? error.message : String(error))
      })
    }
    return started
  })

  ipcMain.handle('broker:sync-channels', async (_, projectId: string, channels: string[]) => {
    await brokerManager.syncChannels(projectId, channels)
  })

  ipcMain.handle('broker:join-workspace', async (
    event,
    projectId: string,
    cwd: string,
    name: string,
    channels: string[] | undefined,
    workspaceKey: string
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      throw new Error(`Project path no longer exists: ${cwd}`)
    }
    const started = await brokerManager.joinWorkspace(projectId, cwd, name, win, channels, workspaceKey)
    if (started) {
      void integrationsManager.notifyAgentState(projectId).catch((error) => {
        console.warn('[integrations] Failed to notify agents after workspace join:', error instanceof Error ? error.message : String(error))
      })
    }
  })

  ipcMain.handle('broker:mint-observer-token', async (_, projectId: string) => {
    return brokerManager.mintObserverToken(projectId)
  })

  ipcMain.handle('broker:auto-fix-runtime', async (
    event,
    projectId: string,
    cwd: string,
    name: string,
    channels?: string[],
    errorMessage?: string
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      throw new Error(`Project path no longer exists: ${cwd}`)
    }
    return brokerManager.autoFixRuntime(projectId, cwd, name, win, channels, errorMessage)
  })

  ipcMain.handle('broker:spawn-agent', async (_, projectId: string, input: SpawnPtyInput & { broker?: 'local' | 'cloud' }) => {
    const usePrescriptive = typeof input.cli === 'string' && input.cli !== 'claude'
    const integrationInstructions = usePrescriptive
      ? integrationsManager.prescriptiveSpawnInstructions(projectId)
      : integrationsManager.initialSpawnInstructions(projectId)
    const result = await brokerManager.spawnAgent(projectId, integrationInstructions
      ? {
          ...input,
          task: input.task?.trim()
            ? `${integrationInstructions}\n\nUser task:\n${input.task.trim()}`
            : integrationInstructions
        }
      : input)
    if (!usePrescriptive && integrationInstructions && result?.name) {
      // The spawn task embedded the current integrations snippet — mark the
      // new agent as already notified so the next project broadcast doesn't
      // deliver the same setup context to it a second time.
      // Not needed for prescriptive spawns: they use a different text format
      // that the per-agent delivery tracker doesn't manage.
      integrationsManager.recordSpawnInstructionDelivery(projectId, result.name)
    }
    integrationEventBridge.invalidateProjectAgentCache(projectId)
    return toBrokerSpawnAgentResult(result)
  })

  ipcMain.handle('broker:list-personas', async (_, projectId: string, cwd?: string) => {
    const normalizedProjectId = projectId.trim()
    const personaCwd = cwd?.trim()
    if (personaCwd) {
      const resolved = resolve(personaCwd)
      const { projects } = loadStore()
      const project = projects.find((entry) => entry.id === normalizedProjectId)
      if (!project || !projectContainsPath(project, resolved)) {
        throw new Error(`Path is outside project roots for project ${projectId}: ${resolved}`)
      }
      if (!isDirectory(resolved)) {
        return []
      }
      return brokerManager.listPersonas(normalizedProjectId, resolved)
    }
    return brokerManager.listPersonas(normalizedProjectId)
  })

  ipcMain.handle('broker:spawn-persona', async (_, projectId: string, personaId: string) => {
    try {
      const result = await brokerManager.spawnPersona(projectId, personaId)
      return toBrokerSpawnAgentResult(result)
    } finally {
      integrationEventBridge.invalidateProjectAgentCache(projectId)
    }
  })

  ipcMain.handle('broker:attach-terminal', async (_, input: {
    projectId?: string
    name: string
    rows?: number
    cols?: number
    mode?: 'view' | 'drive' | 'passthrough'
  }) => {
    return brokerManager.attachTerminal(input.projectId, input)
  })

  ipcMain.handle('broker:connect-cloud', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    return brokerManager.connectCloud('cloud', win)
  })

  ipcMain.handle('broker:send-input', async (_, projectId: string | undefined, name: string, data: string) => {
    return brokerManager.sendInput(projectId, name, data)
  })

  ipcMain.on('broker:send-input-fast', (_, projectId: string | undefined, name: string, data: string) => {
    brokerManager.sendInputFireAndForget(projectId, name, data)
  })

  ipcMain.handle('broker:set-terminal-mode', async (_, projectId: string | undefined, name: string, mode: 'view' | 'drive' | 'passthrough') => {
    return brokerManager.setTerminalMode(projectId, name, mode)
  })

  ipcMain.handle('broker:get-pending', async (_, projectId: string | undefined, name: string) => {
    return brokerManager.getPendingMessages(projectId, name)
  })

  ipcMain.handle('broker:flush-pending', async (_, projectId: string | undefined, name: string) => {
    return brokerManager.flushPending(projectId, name)
  })

  ipcMain.handle('broker:resize-pty', async (_, projectId: string | undefined, name: string, rows: number, cols: number) => {
    await brokerManager.resizePty(projectId, name, rows, cols)
  })

  ipcMain.handle('broker:snapshot-terminal', async (_, projectId: string | undefined, name: string, format: 'plain' | 'ansi') => {
    return brokerManager.snapshotTerminal(projectId, name, format)
  })

  ipcMain.handle('broker:input-srtt', (_, projectId: string | undefined, name: string) => {
    return brokerManager.getInputSrtt(projectId, name)
  })

  ipcMain.handle('broker:send-message', async (_, projectId: string | undefined, input: SendMessageInput) => {
    await brokerManager.sendMessage(projectId, input)
  })

  ipcMain.handle('broker:reconcile-messages', async (_, input: BrokerReconcileMessagesInput) => {
    return brokerManager.reconcileMessages(input)
  })

  ipcMain.handle('broker:refresh-event-stream', async (event, projectId?: string, reason?: string) => {
    const normalizedProjectId = projectId?.trim()
    if (!normalizedProjectId) return
    const win = BrowserWindow.fromWebContents(event.sender)
    await brokerManager.refreshEventStream(normalizedProjectId, reason || 'renderer-request', win || undefined)
  })

  ipcMain.handle('broker:subscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.subscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:unsubscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.unsubscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:release-agent', async (_, projectId: string | undefined, name: string) => {
    await brokerManager.releaseAgent(projectId, name)
    integrationEventBridge.invalidateProjectAgentCache(projectId)
  })

  ipcMain.handle('broker:list-agents', async (_, projectId?: string) => {
    return brokerManager.listAgents(projectId)
  })

  ipcMain.handle('broker:check-cli-available', (_, cli: string) => {
    return typeof cli === 'string' && isCommandAvailableWithAugmentedPath(cli)
  })

  ipcMain.handle('broker:list-details', async () => {
    return brokerManager.listBrokerDetails()
  })

  ipcMain.handle('broker:list-events', () => {
    return brokerManager.listBrokerEvents()
  })

  ipcMain.handle('broker:shutdown', async () => {
    await brokerManager.shutdown()
  })

  // --- Factory ---
  ipcMain.handle('factory:status', async () => {
    return factoryStatus()
  })

  ipcMain.handle('factory:read-config', async (_, configPath?: string, projectRoot?: string) => {
    return readFactoryNodeConfig(configPath, projectRoot)
  })

  ipcMain.handle('factory:save-config', async (_, config: unknown, configPath?: string, projectRoot?: string) => {
    return saveFactoryNodeConfig(config, configPath, projectRoot)
  })

  // --- Burn ---
  ipcMain.handle('burn:list-agent-summaries', async (_, agents: BurnAgentInput[]) => {
    return burnManager.listAgentSummaries(agents)
  })

  ipcMain.handle('burn:get-agent-breakdown', async (_, agent: BurnAgentInput) => {
    return burnManager.getAgentBreakdown(agent)
  })

  ipcMain.handle('burn:get-project-breakdown', async (_, input: BurnProjectInput) => {
    return burnManager.getProjectBreakdown(input)
  })

  ipcMain.handle('burn:lookup-sessions', async (_, sessionIds: string[]) => {
    return burnManager.lookupSessions(Array.isArray(sessionIds) ? sessionIds : [])
  })

  ipcMain.handle('burn:get-session-breakdown', async (_, input: BurnSessionBreakdownInput) => {
    return burnManager.getSessionBreakdown(input)
  })

  ipcMain.handle('burn:fingerprint', async (_, input: BurnFingerprintInput) => {
    return burnManager.getFingerprint(input ?? {})
  })

  ipcMain.handle('burn:get-project-overhead', async (_, input: { projectId: string }) => {
    return burnManager.getProjectOverhead(input)
  })

  // --- Git ---
  ipcMain.handle('git:status', async (_, path: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return []
    try {
      return await git.getStatus(path)
    } catch (error) {
      warnGitStatusOnce(path, error)
      return []
    }
  })

  ipcMain.handle('git:diff', async (_, path: string, file?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getDiff(path, file)
  })

  ipcMain.handle('git:file-content', async (_, path: string, file: string, revision?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getFileContent(path, file, revision)
  })

  ipcMain.handle('git:summary', async (_, path: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return null
    return git.getSummary(path)
  })

  ipcMain.handle('git:branches', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) return []
    return git.listBranches(root)
  })

  ipcMain.handle('git:branch-details', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) return []
    return git.listBranchDetails(root)
  })

  ipcMain.handle('git:checkout-branch', async (_, root: string, branch: string, options?: git.GitCheckoutBranchOptions) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.checkoutBranch(root, branch, options)
  })

  ipcMain.handle('git:branch-sync-status', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.getBranchSyncStatus(root)
  })

  ipcMain.handle('git:fetch-remote', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.fetchRemote(root)
  })

  ipcMain.handle('git:pull-current-branch', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.pullCurrentBranch(root)
  })

  ipcMain.handle('git:push-current-branch', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.pushCurrentBranch(root)
  })

  ipcMain.handle('git:active-pull-requests', async (_, roots: string[]) => {
    const validRoots = Array.isArray(roots)
      ? roots.filter((root): root is string => typeof root === 'string')
      : []

    for (const root of validRoots) {
      assertPathWithinProjects(root)
    }

    return git.getActivePullRequests(validRoots.filter((root) => isDirectory(root)))
  })

  ipcMain.handle('git:history', async (_, path: string, limit?: number) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return []
    return git.getHistory(path, limit)
  })

  ipcMain.handle('git:show', async (_, path: string, hash: string, file?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getCommitDiff(path, hash, file)
  })

  ipcMain.handle('git:discard-files', async (_, path: string, files: string[]) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.discardFiles(path, files)
  })

  ipcMain.handle('git:add-gitignore-patterns', async (_, path: string, patterns: string[]) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.addGitignorePatterns(path, patterns)
  })

  ipcMain.handle('git:commit-selection', async (_, path: string, input: git.GitCommitSelectionInput) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.commitSelection(path, input)
  })

  ipcMain.handle('git:generate-commit-message', async (_, projectId: string, path: string, input: { wholeFiles: string[]; patch?: string }) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    const normalizedProjectId = projectId.trim()
    const { projects } = loadStore()
    const project = projects.find((entry) => entry.id === normalizedProjectId)
    if (!project || !projectContainsPath(project, path)) {
      throw new Error(`Path is outside project roots for project ${projectId}: ${resolve(path)}`)
    }
    const diff = await git.getSelectedDiff(path, input)
    return brokerManager.generateCommitDraft(normalizedProjectId, diff)
  })

  // --- Files ---
  ipcMain.handle('fs:list-dir', async (_, dirPath: string) => {
    assertPathWithinProjects(dirPath)
    return filesystem.listDirectory(dirPath)
  })

  ipcMain.handle('fs:read-preview', async (_, filePath: string) => {
    assertPathWithinProjects(filePath)
    return filesystem.readTextPreview(filePath)
  })

  ipcMain.handle('fs:reveal-path', async (_, filePath: string) => {
    const resolvedPath = resolve(filePath)
    assertPathWithinProjects(resolvedPath)
    shell.showItemInFolder(resolvedPath)
  })

  // --- Auth ---
  ipcMain.handle('auth:login', async (_, input?: { apiUrl?: string }) => {
    const status = await auth.ensureAuthenticated(input?.apiUrl)
    if (status.loggedIn) {
      resetRelayWorkspaceManager()
      // Re-run the cloud auth check so a stale "Cloud sign-in required" banner
      // clears now that we have fresh tokens. Fire-and-forget: the banner
      // clears via the `integration-auth-recovered` event when this resolves,
      // so we don't block the login response on a cloud round-trip.
      void integrationsManager.retryAuthRecovery()
    }
    return status
  })

  ipcMain.handle('auth:logout', () => {
    resetRelayWorkspaceManager()
    auth.logout()
  })

  ipcMain.handle('auth:status', () => {
    return auth.getAuthStatus()
  })

  // --- Cloud Agent ---
  // Renderer-facing channels. The event stream `cloud-agent:event` is emitted by cloudAgentManager via webContents.send().
  ipcMain.handle('cloud-agent:list', async () => {
    return cloudAgentManager.list()
  })

  ipcMain.handle('cloud-agent:create', async (_, input: { name: string; harness: string; model: string }) => {
    return cloudAgentManager.create(input)
  })

  ipcMain.handle('cloud-agent:delete', async (_, id: string) => {
    return cloudAgentManager.delete(id)
  })

  ipcMain.handle('cloud-agent:prewarm', async (_, projectId: string, cloudAgentId: string) => {
    return cloudAgentManager.prewarm(projectId, cloudAgentId)
  })

  ipcMain.handle('cloud-agent:cancel-prewarm', async (_, projectId: string, cloudAgentId?: string) => {
    return cloudAgentManager.cancelPrewarm(projectId, cloudAgentId)
  })

  ipcMain.handle('cloud-agent:attach', async (event, projectId: string, cloudAgentId: string) => {
    return cloudAgentManager.attach(projectId, cloudAgentId, BrowserWindow.fromWebContents(event.sender))
  })

  ipcMain.handle('cloud-agent:detach', async (_, projectId: string) => {
    return cloudAgentManager.detach(projectId)
  })

  ipcMain.handle('cloud-agent:status', async (_, projectId: string) => {
    return cloudAgentManager.status(projectId)
  })

  // --- Proactive Agent ---
  ipcMain.handle('proactive-agent:list', async (_, projectId: string) => {
    return proactiveAgentManager.list(projectId)
  })

  ipcMain.handle('proactive-agent:create', async (_, projectId: string, draft: ProactiveAgentDraft) => {
    return proactiveAgentManager.create(projectId, draft)
  })

  ipcMain.handle('proactive-agent:update', async (_, projectId: string, personaId: string, draft: ProactiveAgentDraft) => {
    return proactiveAgentManager.update(projectId, personaId, draft)
  })

  ipcMain.handle('proactive-agent:deploy', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.deploy(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:pause', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.pause(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:resume', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.resume(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:undeploy', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.undeploy(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:runs', async (
    _,
    projectId: string,
    personaId: string,
    opts?: { limit?: number; cursor?: string }
  ) => {
    return proactiveAgentManager.runs(projectId, personaId, opts)
  })

  ipcMain.handle('proactive-agent:run-transcript', async (_, runId: string) => {
    return proactiveAgentManager.runTranscript(runId)
  })

  // --- Integrations ---
  ipcMain.handle('integrations:catalog', async () => {
    return integrationsManager.listCatalog()
  })

  ipcMain.handle('integrations:list', async (_, projectId: string) => {
    return integrationsManager.listConnectedForSettings(projectId)
  })

  ipcMain.handle('integrations:auth-recovery-state', () => {
    return integrationsManager.getAuthRecoveryState()
  })

  ipcMain.handle('integrations:telemetry', () => {
    return getIntegrationEventTelemetrySnapshot()
  })

  ipcMain.handle('integrations:list-mount-dir', async (_, projectId: string, integrationId: string, dirPath: string) => {
    return integrationsManager.listMountDirectory(projectId, integrationId, dirPath)
  })

  ipcMain.handle('integrations:list-remote-dir', async (_, projectId: string, remotePath: string) => {
    return integrationsManager.listRemoteDirectory(projectId, remotePath)
  })

  ipcMain.handle('integrations:read-mount-preview', async (_, projectId: string, integrationId: string, filePath: string) => {
    return integrationsManager.readMountPreview(projectId, integrationId, filePath)
  })

  ipcMain.handle('integrations:read-remote-file', async (_, projectId: string, remotePath: string) => {
    return integrationsManager.readRemoteFile(projectId, remotePath)
  })

  ipcMain.handle('integrations:write-remote-file', async (_, projectId: string, remotePath: string, content: string) => {
    return integrationsManager.writeRemoteFile(projectId, remotePath, content)
  })

  ipcMain.handle('integrations:list-options', async (_, projectId: string, provider: string, resource: string) => {
    return integrationsManager.listOptions(projectId, provider, resource)
  })

  ipcMain.handle('integrations:start-connect', async (_, projectId: string, provider: string) => {
    return integrationsManager.startConnect(projectId, provider)
  })

  ipcMain.handle('integrations:poll-connect', async (_, sessionId: string) => {
    return integrationsManager.pollConnect(sessionId)
  })

  ipcMain.handle(
    'integrations:complete-connect',
    async (
      _,
      projectId: string,
      sessionId: string,
      scope: Record<string, unknown>,
      mountPaths: string[],
      notifyAgent: boolean
    ) => {
      return integrationsManager.completeConnect(projectId, sessionId, scope, mountPaths, notifyAgent)
    }
  )

  ipcMain.handle(
    'integrations:update-scope',
    async (_, projectId: string, integrationId: string, scope: Record<string, unknown>, mountPaths: string[]) => {
      return integrationsManager.updateScope(projectId, integrationId, scope, mountPaths)
    }
  )

  ipcMain.handle(
    'integrations:update-subscription',
    async (_, projectId: string, integrationId: string, subscribeAgent: boolean) => {
      return integrationsManager.updateSubscription(projectId, integrationId, subscribeAgent)
    }
  )

  ipcMain.handle(
    'integrations:update-historical-download',
    async (_, projectId: string, integrationId: string, downloadHistoricalData: boolean) => {
      return integrationsManager.updateHistoricalDownload(projectId, integrationId, downloadHistoricalData)
    }
  )

  ipcMain.handle('integrations:disconnect', async (_, projectId: string, integrationId: string) => {
    return integrationsManager.disconnect(projectId, integrationId)
  })

  ipcMain.handle('ai-hist:status', () => aiHistManager.getStatus())
  ipcMain.handle('ai-hist:recent', (_, opts?: Parameters<typeof aiHistManager.recent>[0]) =>
    aiHistManager.recent(opts)
  )
  ipcMain.handle('ai-hist:list-sessions', (_, opts?: Parameters<typeof aiHistManager.listSessions>[0]) =>
    aiHistManager.listSessions(opts)
  )
  ipcMain.handle('ai-hist:get-session', (_, sessionId: string) =>
    aiHistManager.getSession(sessionId)
  )
  ipcMain.handle(
    'ai-hist:search',
    (_, query: string, opts?: Parameters<typeof aiHistManager.search>[1]) =>
      aiHistManager.search(query, opts)
  )
  ipcMain.handle(
    'ai-hist:search-sessions',
    (_, query: string, opts?: Parameters<typeof aiHistManager.searchSessions>[1]) =>
      aiHistManager.searchSessions(query, opts)
  )
  ipcMain.handle('ai-hist:stats', () => aiHistManager.stats())
  ipcMain.handle(
    'ai-hist:resume-command',
    (_, entry: Parameters<typeof aiHistManager.resumeCommand>[0]) =>
      aiHistManager.resumeCommand(entry)
  )
  ipcMain.handle('ai-hist:reload', () => aiHistManager.reload())
}
