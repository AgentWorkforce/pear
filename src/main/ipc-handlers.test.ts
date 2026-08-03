import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadFactoryConfig } from '../../node_modules/@agent-relay/factory/dist/config/schema.js'

const mock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const mockWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn()
    }
  }

  return {
    handlers,
    mockWindow,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      on: vi.fn()
    },
    browserWindow: {
      fromWebContents: vi.fn(() => mockWindow),
      getAllWindows: vi.fn(() => [mockWindow])
    },
    termFidelityCorpusDumper: {
      dump: vi.fn()
    },
    brokerManager: {
      start: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      syncChannels: vi.fn(async () => undefined),
      autoFixRuntime: vi.fn(),
      spawnAgent: vi.fn(),
      listPersonas: vi.fn(),
      spawnPersona: vi.fn(),
      attachTerminal: vi.fn(),
      sendInputFireAndForget: vi.fn(),
      setTerminalMode: vi.fn(),
      getPending: vi.fn(),
      flushPending: vi.fn(),
      sendMessage: vi.fn(),
      sendMessageAndWaitForDelivery: vi.fn(),
      reconcileMessages: vi.fn(),
      listAgents: vi.fn(),
      listBrokerDetails: vi.fn(),
      getAgentOutput: vi.fn(),
      generateCommitDraft: vi.fn(),
      getStatus: vi.fn(),
      attachCloudSandbox: vi.fn(),
      detachCloudSandbox: vi.fn(),
      onBrokerEvent: vi.fn()
    },
    isCommandAvailableWithAugmentedPath: vi.fn(),
    integrationsManager: {
      notifyAgentState: vi.fn(async () => undefined),
      initialSpawnInstructions: vi.fn(),
      prescriptiveSpawnInstructions: vi.fn(),
      recordSpawnInstructionDelivery: vi.fn(),
      hydrateActiveProject: vi.fn(),
      listCatalog: vi.fn(),
      startConnect: vi.fn(),
      pollConnect: vi.fn(),
      completeConnect: vi.fn(),
      listConnected: vi.fn(),
      addIntegrationToProject: vi.fn(),
      updateIntegrationScope: vi.fn(),
      updateIntegrationVisibility: vi.fn(),
      updateIntegrationNotification: vi.fn(),
      updateIntegrationSubscription: vi.fn(),
      updateHistoricalDownload: vi.fn(),
      disconnect: vi.fn()
    },
    integrationEventBridge: {
      invalidateProjectAgentCache: vi.fn()
    },
    proactiveAgentManager: {
      onEvent: vi.fn()
    },
    auth: {
      resolveCloudAuth: vi.fn(),
      getAccountWorkspaceId: vi.fn(),
      accountWorkspaceReadyRetryOptions: vi.fn(() => ({}))
    }
  }
})

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    getPath: vi.fn(() => '/tmp/pear-test-user-data'),
    getAppPath: vi.fn(() => process.cwd()),
    getVersion: vi.fn(() => '1.0.0-test')
  },
  ipcMain: mock.ipcMain,
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn()
  },
  BrowserWindow: mock.browserWindow,
  shell: {
    openExternal: vi.fn(),
    showItemInFolder: vi.fn()
  }
}))

vi.mock('./store', () => ({
  loadStore: vi.fn(() => ({ projects: [], activeProjectId: null })),
  addProject: vi.fn(),
  removeProject: vi.fn(),
  setActiveProject: vi.fn(),
  updateProject: vi.fn(),
  addProjectChannel: vi.fn(),
  removeProjectChannel: vi.fn(),
  setProjectChannelPeople: vi.fn(),
  addProjectRoot: vi.fn(),
  removeProjectRoot: vi.fn(),
  addProjectIntegration: vi.fn(),
  removeProjectIntegration: vi.fn()
}))

vi.mock('./broker', () => ({
  brokerManager: mock.brokerManager,
  isCommandAvailableWithAugmentedPath: mock.isCommandAvailableWithAugmentedPath
}))

vi.mock('./term-fidelity-corpus', () => ({
  TermFidelityCorpusDumper: class {
    dump(...args: unknown[]): unknown {
      return mock.termFidelityCorpusDumper.dump(...args)
    }
  }
}))

vi.mock('./git', () => ({
  getSelectedDiff: vi.fn()
}))
vi.mock('./filesystem', () => ({}))
vi.mock('./auth', () => mock.auth)
vi.mock('./cloud-agent', () => ({
  cloudAgentManager: {}
}))
vi.mock('./proactive-agent', () => ({
  proactiveAgentManager: mock.proactiveAgentManager
}))
vi.mock('./integrations', () => ({
  integrationsManager: mock.integrationsManager
}))
vi.mock('./integration-event-bridge', () => ({
  getIntegrationEventTelemetrySnapshot: vi.fn(() => ({})),
  integrationEventBridge: mock.integrationEventBridge
}))
vi.mock('./ai-hist', () => ({
  aiHistManager: {}
}))
vi.mock('./burn', () => ({
  burnManager: {}
}))
vi.mock('./relay-workspace', () => ({
  resetRelayWorkspaceManager: vi.fn()
}))
vi.mock('./path-utils', () => ({
  assertDirectory: vi.fn(),
  isDirectory: vi.fn(() => true)
}))
vi.mock('./cli', () => ({
  findProjectForPath: vi.fn(),
  projectContainsPath: vi.fn()
}))

import { registerIpcHandlers } from './ipc-handlers'
import { findProjectForPath, projectContainsPath } from './cli'
import { isDirectory } from './path-utils'
import { loadStore } from './store'
import * as git from './git'
import * as auth from './auth'
import type { FactoryConfigReadResult, FactoryStatus } from '../shared/types/ipc'

const asConfigResult = (value: unknown): FactoryConfigReadResult => value as FactoryConfigReadResult
const asStatus = (value: unknown): FactoryStatus => value as FactoryStatus

describe('registerIpcHandlers term-fidelity:dump-corpus', () => {
  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    mock.termFidelityCorpusDumper.dump.mockReset()
    mock.brokerManager.listBrokerDetails.mockReset()
    registerIpcHandlers()
  })

  it('captures the sender page and supplies production metadata to the corpus writer', async () => {
    const input = {
      projectId: 'project-1',
      agentName: 'codex-1',
      cli: 'codex',
      renderer: { rows: 2, cols: 10, text: 'renderer' },
      broker: { rows: 2, cols: 10, text: 'broker' },
      telemetryLines: ['confirmed']
    }
    const png = Buffer.from('png')
    const capturePage = vi.fn(async () => ({ toPNG: () => png }))
    mock.brokerManager.listBrokerDetails.mockResolvedValueOnce([
      {
        projectId: 'project-1',
        name: 'pear-project-1',
        session: { brokerVersion: '10.6.3' }
      }
    ])
    mock.termFidelityCorpusDumper.dump.mockImplementationOnce(
      async (receivedInput, options) => {
        expect(receivedInput).toEqual(input)
        expect(options.rootDir).toBe('/tmp/pear-test-user-data/term-fidelity-corpus')
        expect(await options.capturePage()).toEqual(png)
        expect(await options.relayVersions()).toMatchObject({
          pear: '1.0.0-test',
          'agent-relay': '^11.0.2',
          'broker:pear-project-1': '10.6.3'
        })
        return { dumped: true, path: '/tmp/bundle' }
      }
    )

    const handler = mock.handlers.get('term-fidelity:dump-corpus')
    const result = await handler?.({ sender: { capturePage } }, input)

    expect(result).toEqual({ dumped: true, path: '/tmp/bundle' })
    expect(capturePage).toHaveBeenCalledTimes(1)
  })
})

describe('registerIpcHandlers broker:start', () => {
  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    mock.browserWindow.fromWebContents.mockClear()
    mock.brokerManager.start.mockReset()
    mock.integrationsManager.notifyAgentState.mockClear()
    registerIpcHandlers()
  })

  it('returns the BrokerManager start result and only notifies integrations for real starts', async () => {
    const handler = mock.handlers.get('broker:start')
    expect(handler).toBeTypeOf('function')
    mock.brokerManager.start
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const event = { sender: {} }
    const first = await handler?.(event, 'project-1', '/tmp/project-1', 'pear-project-1', ['general'])
    const second = await handler?.(event, 'project-1', '/tmp/project-1', 'pear-project-1', ['general'])

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(mock.brokerManager.start).toHaveBeenCalledTimes(2)
    expect(mock.integrationsManager.notifyAgentState).toHaveBeenCalledTimes(1)
    expect(mock.integrationsManager.notifyAgentState).toHaveBeenCalledWith('project-1')
  })
})

describe('registerIpcHandlers broker:spawn-agent', () => {
  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    mock.brokerManager.spawnAgent.mockReset()
    mock.integrationsManager.initialSpawnInstructions.mockReset()
    mock.integrationsManager.prescriptiveSpawnInstructions.mockReset()
    mock.integrationsManager.recordSpawnInstructionDelivery.mockReset()
    registerIpcHandlers()
  })

  it('returns a structured-clone-safe spawn result', async () => {
    const handler = mock.handlers.get('broker:spawn-agent')
    expect(handler).toBeTypeOf('function')
    const raw = {
      name: 'worker',
      runtime: 'pty',
      client: () => undefined
    }
    mock.brokerManager.spawnAgent.mockResolvedValueOnce(raw)

    const result = await handler?.({}, 'project-1', { name: 'worker', cli: 'codex' })

    expect(result).toEqual({ name: 'worker', runtime: 'pty' })
    expect(() => structuredClone(result)).not.toThrow()
  })

  it('uses prescriptive instructions for non-claude CLIs', async () => {
    const handler = mock.handlers.get('broker:spawn-agent')
    mock.integrationsManager.prescriptiveSpawnInstructions.mockReturnValueOnce('PRESCRIPTIVE')
    mock.brokerManager.spawnAgent.mockResolvedValueOnce({ name: 'oc-1', runtime: 'pty' })

    await handler?.({}, 'project-1', { name: 'oc-1', cli: 'opencode', task: 'do it' })

    expect(mock.integrationsManager.prescriptiveSpawnInstructions).toHaveBeenCalledWith('project-1')
    expect(mock.integrationsManager.initialSpawnInstructions).not.toHaveBeenCalled()
    const spawnArg = mock.brokerManager.spawnAgent.mock.calls[0][1]
    expect(spawnArg.task).toContain('PRESCRIPTIVE')
    expect(spawnArg.task).toContain('do it')
    // Prescriptive spawns do not register narrative per-agent delivery.
    expect(mock.integrationsManager.recordSpawnInstructionDelivery).not.toHaveBeenCalled()
  })

  it('uses narrative instructions for claude and records delivery', async () => {
    const handler = mock.handlers.get('broker:spawn-agent')
    mock.integrationsManager.initialSpawnInstructions.mockReturnValueOnce('NARRATIVE')
    mock.brokerManager.spawnAgent.mockResolvedValueOnce({ name: 'claude-1', runtime: 'pty' })

    await handler?.({}, 'project-1', { name: 'claude-1', cli: 'claude', task: 'do it' })

    expect(mock.integrationsManager.initialSpawnInstructions).toHaveBeenCalledWith('project-1')
    expect(mock.integrationsManager.prescriptiveSpawnInstructions).not.toHaveBeenCalled()
    expect(mock.integrationsManager.recordSpawnInstructionDelivery).toHaveBeenCalledWith('project-1', 'claude-1')
  })
})

describe('registerIpcHandlers broker:list-personas', () => {
  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    mock.brokerManager.listPersonas.mockReset()
    vi.mocked(loadStore).mockReset()
    vi.mocked(loadStore).mockReturnValue({ projects: [], activeProjectId: null })
    vi.mocked(projectContainsPath).mockReset()
    vi.mocked(isDirectory).mockReset()
    vi.mocked(isDirectory).mockReturnValue(true)
    registerIpcHandlers()
  })

  it('lists personas for a cwd inside the requested project root', async () => {
    const handler = mock.handlers.get('broker:list-personas')
    expect(handler).toBeTypeOf('function')
    const project = { id: 'project-1', roots: [{ id: 'root-1', name: 'Project 1', path: '/tmp/project-1' }] }
    vi.mocked(loadStore).mockReturnValue({ projects: [project], activeProjectId: null } as never)
    vi.mocked(projectContainsPath).mockReturnValue(true)
    mock.brokerManager.listPersonas.mockResolvedValueOnce([{ id: 'autonomous-actor' }])

    const result = await handler?.({}, 'project-1', '/tmp/project-1')

    expect(result).toEqual([{ id: 'autonomous-actor' }])
    expect(projectContainsPath).toHaveBeenCalledWith(project, '/tmp/project-1')
    expect(mock.brokerManager.listPersonas).toHaveBeenCalledWith('project-1', '/tmp/project-1')
  })

  it('lists personas for the requested project when multiple projects share the cwd root', async () => {
    const handler = mock.handlers.get('broker:list-personas')
    expect(handler).toBeTypeOf('function')
    const firstProject = { id: 'project-1', roots: [{ id: 'root-1', name: 'Shared', path: '/tmp/shared' }] }
    const requestedProject = { id: 'project-2', roots: [{ id: 'root-2', name: 'Shared', path: '/tmp/shared' }] }
    vi.mocked(loadStore).mockReturnValue({
      projects: [firstProject, requestedProject],
      activeProjectId: null
    } as never)
    vi.mocked(projectContainsPath).mockImplementation((project) => project.id === 'project-2')
    mock.brokerManager.listPersonas.mockResolvedValueOnce([{ id: 'autonomous-actor' }])

    const result = await handler?.({}, 'project-2', '/tmp/shared')

    expect(result).toEqual([{ id: 'autonomous-actor' }])
    expect(projectContainsPath).toHaveBeenCalledTimes(1)
    expect(projectContainsPath).toHaveBeenCalledWith(requestedProject, '/tmp/shared')
    expect(mock.brokerManager.listPersonas).toHaveBeenCalledWith('project-2', '/tmp/shared')
  })

  it('rejects persona cwd outside the requested project root', async () => {
    const handler = mock.handlers.get('broker:list-personas')
    expect(handler).toBeTypeOf('function')
    const project = { id: 'project-1', roots: [{ id: 'root-1', name: 'Project 1', path: '/tmp/project-1' }] }
    vi.mocked(loadStore).mockReturnValue({ projects: [project], activeProjectId: null } as never)
    vi.mocked(projectContainsPath).mockReturnValue(false)

    await expect(handler?.({}, 'project-1', '/tmp/project-2')).rejects.toThrow(
      /Path is outside project roots for project project-1/
    )
    expect(mock.brokerManager.listPersonas).not.toHaveBeenCalled()
  })
})

describe('registerIpcHandlers broker:spawn-persona', () => {
  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    mock.brokerManager.spawnPersona.mockReset()
    mock.integrationEventBridge.invalidateProjectAgentCache.mockClear()
    mock.brokerManager.spawnPersona.mockResolvedValue({ name: 'persona', runtime: 'pty', cli: 'claude' })
    registerIpcHandlers()
  })

  it('invalidates the integration agent cache after persona spawn settles', async () => {
    const handler = mock.handlers.get('broker:spawn-persona')
    expect(handler).toBeTypeOf('function')

    const result = await handler?.({}, 'project-1', 'autonomous-actor')

    expect(result).toEqual({ name: 'persona', runtime: 'pty', cli: 'claude' })
    expect(mock.brokerManager.spawnPersona).toHaveBeenCalledWith('project-1', 'autonomous-actor')
    expect(mock.integrationEventBridge.invalidateProjectAgentCache).toHaveBeenCalledTimes(1)
    expect(mock.integrationEventBridge.invalidateProjectAgentCache).toHaveBeenCalledWith('project-1')
  })
})

describe('registerIpcHandlers git:generate-commit-message', () => {
  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    mock.brokerManager.generateCommitDraft.mockReset()
    vi.mocked(loadStore).mockReset()
    vi.mocked(loadStore).mockReturnValue({ projects: [], activeProjectId: null })
    vi.mocked(findProjectForPath).mockReset()
    vi.mocked(projectContainsPath).mockReset()
    vi.mocked(isDirectory).mockReset()
    vi.mocked(isDirectory).mockReturnValue(true)
    vi.mocked(git.getSelectedDiff).mockReset()
    registerIpcHandlers()
  })

  it('generates the commit draft for the passed project when multiple projects share the root', async () => {
    const handler = mock.handlers.get('git:generate-commit-message')
    expect(handler).toBeTypeOf('function')
    const firstProject = { id: 'project-1', roots: [{ id: 'root-1', name: 'Shared', path: '/tmp/shared' }] }
    const requestedProject = { id: 'project-2', roots: [{ id: 'root-2', name: 'Shared', path: '/tmp/shared' }] }
    vi.mocked(loadStore).mockReturnValue({
      projects: [firstProject, requestedProject],
      activeProjectId: null
    } as never)
    vi.mocked(findProjectForPath).mockReturnValue(firstProject as never)
    vi.mocked(projectContainsPath).mockImplementation((project) => project.id === 'project-2')
    vi.mocked(git.getSelectedDiff).mockResolvedValueOnce('selected diff')
    mock.brokerManager.generateCommitDraft.mockResolvedValueOnce({ title: 'Draft', body: '' })

    const result = await handler?.({}, 'project-2', '/tmp/shared', { wholeFiles: ['README.md'] })

    expect(result).toEqual({ title: 'Draft', body: '' })
    expect(projectContainsPath).toHaveBeenCalledWith(requestedProject, '/tmp/shared')
    expect(git.getSelectedDiff).toHaveBeenCalledWith('/tmp/shared', { wholeFiles: ['README.md'] })
    expect(mock.brokerManager.generateCommitDraft).toHaveBeenCalledWith('project-2', 'selected diff')
  })

  it("rejects commit draft generation when the path is outside the passed project's roots", async () => {
    const handler = mock.handlers.get('git:generate-commit-message')
    expect(handler).toBeTypeOf('function')
    const project = { id: 'project-1', roots: [{ id: 'root-1', name: 'Project 1', path: '/tmp/project-1' }] }
    vi.mocked(loadStore).mockReturnValue({ projects: [project], activeProjectId: null } as never)
    vi.mocked(findProjectForPath).mockReturnValue(project as never)
    vi.mocked(projectContainsPath).mockReturnValue(false)

    await expect(handler?.({}, 'project-1', '/tmp/project-2', { wholeFiles: ['README.md'] })).rejects.toThrow(
      /Path is outside project roots for project project-1/
    )
    expect(git.getSelectedDiff).not.toHaveBeenCalled()
    expect(mock.brokerManager.generateCommitDraft).not.toHaveBeenCalled()
  })
})

describe('registerIpcHandlers broker:check-cli-available', () => {
  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    mock.isCommandAvailableWithAugmentedPath.mockReset()
    registerIpcHandlers()
  })

  it('returns whether the requested CLI can be resolved', () => {
    const handler = mock.handlers.get('broker:check-cli-available')
    expect(handler).toBeTypeOf('function')
    mock.isCommandAvailableWithAugmentedPath.mockReturnValueOnce(true)

    const result = handler?.({}, 'opencode')

    expect(result).toBe(true)
    expect(mock.isCommandAvailableWithAugmentedPath).toHaveBeenCalledWith('opencode')
  })

  it('rejects non-string CLI values', () => {
    const handler = mock.handlers.get('broker:check-cli-available')
    expect(handler).toBeTypeOf('function')

    const result = handler?.({}, null)

    expect(result).toBe(false)
    expect(mock.isCommandAvailableWithAugmentedPath).not.toHaveBeenCalled()
  })
})

describe('registerIpcHandlers factory:read-config / factory:save-config', () => {
  let dir: string

  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'factory-config-'))
    registerIpcHandlers()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports an empty NodeConfig when the config file does not exist', async () => {
    const read = mock.handlers.get('factory:read-config')
    const path = join(dir, 'missing.config.json')

    const result = await read?.({}, path)

    expect(result).toEqual({
      configPath: path,
      exists: false,
      config: { capabilities: [], clonePaths: {}, dryRun: false },
      errors: []
    })
  })

  it('round-trips a NodeConfig draft: save writes the file and re-read reproduces it', async () => {
    const save = mock.handlers.get('factory:save-config')
    const read = mock.handlers.get('factory:read-config')
    const path = join(dir, 'factory.config.json')
    const draft = {
      workspaceId: 'ws-1',
      capabilities: ['spawn:claude', 'spawn:codex'],
      cloneRoot: '/clones',
      clonePaths: { 'org/repo': '/clones/repo' },
      dryRun: true
    }

    const saved = asConfigResult(await save?.({}, draft, path))
    expect(saved).toMatchObject({ configPath: path, exists: true, errors: [] })
    expect(saved.config).toEqual(draft)

    // The file is written with NodeConfig fields at the TOP LEVEL.
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk).toEqual(draft)

    const reread = asConfigResult(await read?.({}, path))
    expect(reread.config).toEqual(draft)
  })

  it('reads NodeConfig fields that live under repos.* via fallback', async () => {
    const read = mock.handlers.get('factory:read-config')
    const path = join(dir, 'factory.config.json')
    // Compact single-source shape: operative values under repos.*
    writeFileSync(
      path,
      JSON.stringify({
        capabilities: ['spawn:claude'],
        repos: { cloneRoot: '/repos-root', clonePaths: { 'org/a': '/repos-root/a' } }
      }),
      'utf8'
    )

    const result = asConfigResult(await read?.({}, path))

    expect(result.config).toEqual({
      capabilities: ['spawn:claude'],
      cloneRoot: '/repos-root',
      clonePaths: { 'org/a': '/repos-root/a' },
      dryRun: false
    })
  })

  it('promotes edited NodeConfig fields to the top level, leaving repos.* untouched (pins the read/save asymmetry)', async () => {
    const read = mock.handlers.get('factory:read-config')
    const save = mock.handlers.get('factory:save-config')
    const path = join(dir, 'factory.config.json')
    writeFileSync(
      path,
      JSON.stringify({
        capabilities: ['spawn:claude'],
        repos: { cloneRoot: '/old-root', clonePaths: { 'org/a': '/old-root/a' } }
      }),
      'utf8'
    )

    // Read falls back into repos.*, the editor changes the clone root, and saves.
    const loaded = asConfigResult(await read?.({}, path))
    const edited = { ...loaded.config, cloneRoot: '/new-root' }
    await save?.({}, edited, path)

    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    // The edited value is written at the top level...
    expect(onDisk.cloneRoot).toBe('/new-root')
    // ...while the original repos.* block is preserved (NodeConfigSchema picks the top-level field).
    expect(onDisk.repos).toEqual({ cloneRoot: '/old-root', clonePaths: { 'org/a': '/old-root/a' } })
  })

  it('preserves inherited split-config checkout mappings on a no-op read/save', async () => {
    const read = mock.handlers.get('factory:read-config')
    const save = mock.handlers.get('factory:save-config')
    const path = join(dir, 'split.config.json')
    const splitConfig = {
      workspaceConfig: {
        workspaceId: 'ws-1',
        repos: {
          cloneRoot: '/work',
          clonePaths: { 'AgentWorkforce/pear': '/custom/pear' }
        }
      },
      nodeConfig: {
        capabilities: ['spawn:claude']
      }
    }
    writeFileSync(path, JSON.stringify(splitConfig), 'utf8')
    const before = loadFactoryConfig(splitConfig)

    const loaded = asConfigResult(await read?.({}, path))
    expect(loaded.config).toMatchObject({
      workspaceId: 'ws-1',
      capabilities: ['spawn:claude'],
      cloneRoot: '/work',
      clonePaths: { 'AgentWorkforce/pear': '/custom/pear' },
      dryRun: false
    })

    await save?.({}, loaded.config, path)

    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.nodeConfig).toEqual({
      capabilities: ['spawn:claude'],
      dryRun: false
    })
    const after = loadFactoryConfig(onDisk)
    expect(after.nodeConfig.cloneRoot).toBe(before.nodeConfig.cloneRoot)
    expect(after.nodeConfig.clonePaths).toEqual(before.nodeConfig.clonePaths)
  })

  it('preserves an explicit split-config empty clonePaths override', async () => {
    const read = mock.handlers.get('factory:read-config')
    const save = mock.handlers.get('factory:save-config')
    const path = join(dir, 'split-explicit-empty.config.json')
    writeFileSync(
      path,
      JSON.stringify({
        workspaceConfig: {
          repos: {
            cloneRoot: '/work',
            clonePaths: { 'AgentWorkforce/pear': '/custom/pear' }
          }
        },
        nodeConfig: {
          capabilities: ['spawn:claude'],
          clonePaths: {}
        }
      }),
      'utf8'
    )

    const loaded = asConfigResult(await read?.({}, path))
    expect(loaded.config?.clonePaths).toEqual({})

    await save?.({}, loaded.config, path)

    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.nodeConfig.clonePaths).toEqual({})
  })

  it('returns validation errors without writing when the draft is invalid', async () => {
    const save = mock.handlers.get('factory:save-config')
    const path = join(dir, 'invalid.config.json')

    const result = asConfigResult(await save?.({}, { capabilities: 'not-an-array' }, path))

    expect(result.config).toBeNull()
    expect(result.errors).toContain('capabilities: must be an array of strings')
    expect(existsSync(path)).toBe(false)
  })
})

describe('registerIpcHandlers factory:status', () => {
  const apiUrl = 'https://cloud.example.com'
  const accessToken = 'token-1'
  const workspaceId = 'workspace-1'

  beforeEach(() => {
    mock.handlers.clear()
    mock.ipcMain.handle.mockClear()
    mock.ipcMain.on.mockClear()
    vi.mocked(auth.resolveCloudAuth).mockReset()
    vi.mocked(auth.getAccountWorkspaceId).mockReset()
    vi.mocked(auth.accountWorkspaceReadyRetryOptions).mockReturnValue({} as never)
    vi.mocked(auth.getAccountWorkspaceId).mockResolvedValue(workspaceId)
    registerIpcHandlers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns unauthenticated when there is no cloud auth', async () => {
    const handler = mock.handlers.get('factory:status')
    vi.mocked(auth.resolveCloudAuth).mockResolvedValue(null as never)

    const result = await handler?.({})

    expect(result).toMatchObject({ source: 'cloud', state: 'unauthenticated', connected: false })
    expect(auth.getAccountWorkspaceId).not.toHaveBeenCalled()
  })

  it('falls back across endpoints and reports empty when all are unsupported (404)', async () => {
    const handler = mock.handlers.get('factory:status')
    vi.mocked(auth.resolveCloudAuth).mockResolvedValue({ apiUrl, accessToken } as never)
    const fetchMock = vi.fn(async () => ({ status: 404, ok: false }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await handler?.({})

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ source: 'cloud', state: 'empty', connected: true, workspaceId })
  })

  it('reports unauthenticated on a 401 from the cloud endpoint', async () => {
    const handler = mock.handlers.get('factory:status')
    vi.mocked(auth.resolveCloudAuth).mockResolvedValue({ apiUrl, accessToken } as never)
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false })))

    const result = await handler?.({})

    expect(result).toMatchObject({ source: 'cloud', state: 'unauthenticated', connected: false, workspaceId })
  })

  it('reports unavailable on a non-OK, non-auth response', async () => {
    const handler = mock.handlers.get('factory:status')
    vi.mocked(auth.resolveCloudAuth).mockResolvedValue({ apiUrl, accessToken } as never)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 500,
      ok: false,
      statusText: 'Server Error',
      text: async () => 'boom'
    })))

    const result = asStatus(await handler?.({}))

    expect(result).toMatchObject({ source: 'cloud', state: 'unavailable', connected: false })
    expect(result.message).toContain('500')
  })

  it('normalizes a 200 payload and dedups issues that span multiple buckets', async () => {
    const handler = mock.handlers.get('factory:status')
    vi.mocked(auth.resolveCloudAuth).mockResolvedValue({ apiUrl, accessToken } as never)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        issues: [{ key: 'AR-1', title: 'First', state: 'in_progress' }],
        inFlight: [{ key: 'AR-1', title: 'First (dup)' }],
        queued: [{ key: 'AR-2', title: 'Second' }],
        agents: [{ name: 'worker-1', status: 'running', issue: { key: 'AR-1' } }],
        counters: { active: 2, idle: 0 }
      })
    })))

    const result = asStatus(await handler?.({}))

    expect(result).toMatchObject({ source: 'cloud', state: 'online', connected: true, workspaceId })
    // AR-1 appears in both issues and inFlight buckets — dedup keeps the first occurrence.
    expect(result.issues).toHaveLength(2)
    expect(result.issues.map((i) => i.key)).toEqual(['AR-1', 'AR-2'])
    expect(result.issues[0]).toMatchObject({ key: 'AR-1', title: 'First', state: 'in_progress' })
    expect(result.agents).toHaveLength(1)
    expect(result.counters).toEqual({ active: 2, idle: 0 })
  })

  it('coalesces concurrent factory:status calls into a single in-flight promise', async () => {
    const handler = mock.handlers.get('factory:status')
    vi.mocked(auth.resolveCloudAuth).mockResolvedValue(null as never)

    // Two concurrent calls share a single in-flight read: without the
    // `factoryStatusInFlight` coalescer the second call would start its own read
    // and consult resolveCloudAuth a second time.
    const first = handler?.({})
    const second = handler?.({})

    const [a, b] = await Promise.all([first, second])
    expect(auth.resolveCloudAuth).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })
})
