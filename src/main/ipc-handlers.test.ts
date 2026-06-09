import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    brokerManager: {
      start: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      syncChannels: vi.fn(async () => undefined),
      autoFixRuntime: vi.fn(),
      connectCloud: vi.fn(),
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
      getAgentOutput: vi.fn(),
      getStatus: vi.fn(),
      attachCloudSandbox: vi.fn(),
      detachCloudSandbox: vi.fn(),
      onBrokerEvent: vi.fn()
    },
    integrationsManager: {
      notifyAgentState: vi.fn(async () => undefined),
      initialSpawnInstructions: vi.fn(),
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
    }
  }
})

vi.mock('electron', () => ({
  app: {
    quit: vi.fn()
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
  brokerManager: mock.brokerManager
}))

vi.mock('./git', () => ({}))
vi.mock('./filesystem', () => ({}))
vi.mock('./auth', () => ({}))
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
import { projectContainsPath } from './cli'
import { isDirectory } from './path-utils'
import { loadStore } from './store'

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
