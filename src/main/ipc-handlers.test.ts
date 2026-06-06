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
  integrationEventBridge: {
    invalidateProjectAgentCache: vi.fn()
  }
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
  findProjectForPath: vi.fn()
}))

import { registerIpcHandlers } from './ipc-handlers'

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
