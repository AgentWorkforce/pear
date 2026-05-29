import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { resolve } from 'path'
import type { SpawnPtyInput, SendMessageInput } from '@agent-relay/sdk'
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
  addProjectIntegration,
  removeProjectIntegration
} from './store'
import { brokerManager } from './broker'
import * as git from './git'
import * as filesystem from './filesystem'
import * as auth from './auth'
import { cloudAgentManager } from './cloud-agent'
import { proactiveAgentManager } from './proactive-agent'
import { integrationsManager } from './integrations'
import { aiHistManager } from './ai-hist'
import { burnManager, type BurnAgentInput } from './burn'
import { resetRelayWorkspaceManager } from './relay-workspace'
import { assertDirectory, isDirectory } from './path-utils'
import type { ProactiveAgentDraft } from './proactive-agent.types'

function getProjectIdForPath(targetPath: string): string | null {
  const resolved = resolve(targetPath)
  const { projects } = loadStore()
  const project = projects.find((candidate) =>
    candidate.roots.some((root) => {
      const rootPath = resolve(root.path)
      return resolved.startsWith(rootPath + '/') || resolved === rootPath
    })
  )
  return project?.id || null
}

function assertPathWithinProjects(targetPath: string): void {
  const resolved = resolve(targetPath)
  if (!getProjectIdForPath(resolved)) {
    throw new Error(`Path is outside all known project roots: ${resolved}`)
  }
}

const gitStatusWarnings = new Set<string>()
const AUTOPILOT_ATTACH_CHANNEL = '__autopilot:cloud-attach'

type AutopilotCloudAttachInput = {
  projectId?: unknown
  cloudAgentId?: unknown
}

type AutopilotCloudAttachResult = {
  ok: boolean
  brokerMode: string | null
  elapsedSec: number
  error?: string
}

let autopilotProbeServer: Server | null = null

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function sessionMode(value: unknown): string | null {
  return isRecord(value) && typeof value.mode === 'string' ? value.mode : null
}

async function readJsonRequest(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function runAutopilotCloudAttach(
  input: AutopilotCloudAttachInput,
  win?: BrowserWindow | null
): Promise<AutopilotCloudAttachResult> {
  const startedAt = Date.now()
  try {
    const projectId = requireString(input.projectId, 'projectId')
    const cloudAgentId = requireString(input.cloudAgentId, 'cloudAgentId')
    await cloudAgentManager.attach(projectId, cloudAgentId, win ?? BrowserWindow.getAllWindows()[0] ?? null)

    const details = (await brokerManager.listBrokerDetails())
      .find((entry) => entry.projectId === projectId && entry.kind === 'cloud')
    if (!details?.url) throw new Error('Cloud broker URL was not available after attach')

    const response = await fetch(new URL('/api/session', details.url), {
      headers: details.apiKey ? { 'X-API-Key': details.apiKey } : undefined
    })
    const payload = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      throw new Error(`Broker /api/session failed: ${response.status} ${response.statusText}`)
    }

    const brokerMode = sessionMode(payload) || details.session?.mode || null
    return {
      ok: brokerMode === 'persist',
      brokerMode,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000)
    }
  } catch (error) {
    return {
      ok: false,
      brokerMode: null,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      error: toErrorMessage(error)
    }
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function startAutopilotProbeBridge(): void {
  if (process.env.PEAR_AUTOPILOT_PROBE !== '1' || autopilotProbeServer) return

  const port = Number(process.env.PEAR_AUTOPILOT_PROBE_PORT || 0)
  autopilotProbeServer = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true, ipcChannel: AUTOPILOT_ATTACH_CHANNEL })
        return
      }
      if (req.method === 'POST' && req.url === '/cloud-attach') {
        const body = await readJsonRequest(req)
        const result = await runAutopilotCloudAttach(isRecord(body) ? body : {})
        sendJson(res, 200, result)
        return
      }
      sendJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) })
    }
  })
  autopilotProbeServer.listen(port, '127.0.0.1', () => {
    const address = autopilotProbeServer?.address() as AddressInfo | null
    console.log(`[ipc] ready port=${address?.port ?? port} channel=${AUTOPILOT_ATTACH_CHANNEL}`)
  })
  app.once('before-quit', () => {
    autopilotProbeServer?.close()
    autopilotProbeServer = null
  })
}

function warnGitStatusOnce(path: string, error: unknown): void {
  const message = toErrorMessage(error)
  const key = `${path}:${message}`
  if (gitStatusWarnings.has(key)) return
  gitStatusWarnings.add(key)
  console.warn(`[git] Failed to read status for ${path}: ${message}`)
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

  ipcMain.handle('project:set-active', (_, id: string | null) => {
    setActiveProject(id)
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
    return addProjectRoot(projectId, path, name)
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
    await brokerManager.start(projectId, cwd, name, win, channels)
    return true
  })

  ipcMain.handle('broker:sync-channels', async (_, projectId: string, channels: string[]) => {
    await brokerManager.syncChannels(projectId, channels)
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

  ipcMain.handle('broker:spawn-agent', async (_, projectId: string, input: SpawnPtyInput) => {
    return brokerManager.spawnAgent(projectId, input)
  })

  ipcMain.handle('broker:list-personas', async (_, projectId: string) => {
    return brokerManager.listPersonas(projectId)
  })

  ipcMain.handle('broker:spawn-persona', async (_, projectId: string, personaId: string) => {
    return brokerManager.spawnPersona(projectId, personaId)
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

  ipcMain.handle('broker:send-message', async (_, projectId: string | undefined, input: SendMessageInput) => {
    await brokerManager.sendMessage(projectId, input)
  })

  ipcMain.handle('broker:subscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.subscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:unsubscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.unsubscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:release-agent', async (_, projectId: string | undefined, name: string) => {
    await brokerManager.releaseAgent(projectId, name)
  })

  ipcMain.handle('broker:list-agents', async (_, projectId?: string) => {
    return brokerManager.listAgents(projectId)
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

  // --- Burn ---
  ipcMain.handle('burn:list-agent-summaries', async (_, agents: BurnAgentInput[]) => {
    return burnManager.listAgentSummaries(agents)
  })

  ipcMain.handle('burn:get-agent-breakdown', async (_, agent: BurnAgentInput) => {
    return burnManager.getAgentBreakdown(agent)
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

  ipcMain.handle('git:generate-commit-message', async (_, path: string, input: { wholeFiles: string[]; patch?: string }) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    const projectId = getProjectIdForPath(path)
    if (!projectId) throw new Error('No project is configured for this Git working directory')
    const diff = await git.getSelectedDiff(path, input)
    return brokerManager.generateCommitDraft(projectId, diff)
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
    if (status.loggedIn) resetRelayWorkspaceManager()
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

  ipcMain.handle('cloud-agent:attach', async (event, projectId: string, cloudAgentId: string) => {
    return cloudAgentManager.attach(projectId, cloudAgentId, BrowserWindow.fromWebContents(event.sender))
  })

  if (process.env.PEAR_AUTOPILOT_PROBE === '1') {
    ipcMain.handle(AUTOPILOT_ATTACH_CHANNEL, async (event, input: AutopilotCloudAttachInput) => {
      return runAutopilotCloudAttach(input, BrowserWindow.fromWebContents(event.sender))
    })
    startAutopilotProbeBridge()
  }

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
