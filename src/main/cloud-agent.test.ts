import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockCloudAuth = {
  apiUrl: string
  accessToken: string
}

const mock = vi.hoisted(() => {
  type MountInput = {
    workspaceId: string
    localDir: string
    remotePath: string
  }

  const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
  const mountInputs: MountInput[] = []
  const boxResponses: Array<Record<string, unknown>> = []
  let currentAuth: MockCloudAuth | null = null

  const project = {
    id: 'project-1',
    name: 'Project 1',
    rootPath: '/tmp/project-1',
    roots: [],
    channels: ['general'],
    channelPeople: {},
    integrations: []
  }

  class RelayfileSetup {
    mountWorkspace(input: MountInput) {
      mountInputs.push(input)
      return Promise.resolve({
        stop: vi.fn(async () => undefined),
        status: vi.fn(async () => ({ state: 'running' }))
      })
    }
  }

  return {
    fetchCalls,
    mountInputs,
    boxResponses,
    project,
    get currentAuth() {
      return currentAuth
    },
    set currentAuth(value: MockCloudAuth | null) {
      currentAuth = value
    },
    RelayfileSetup,
    browserWindow: {
      getAllWindows: vi.fn(() => [])
    },
    brokerManager: {
      onBrokerEvent: vi.fn(),
      attachCloudSandbox: vi.fn(async () => undefined),
      detachCloudSandbox: vi.fn(async () => undefined)
    },
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const normalizedUrl = String(url)
      fetchCalls.push({ url: normalizedUrl, init })
      if (normalizedUrl.endsWith('/api/v1/auth/whoami')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ currentWorkspace: { id: 'account-workspace-id' } })
        }
      }
      const parsedUrl = new URL(normalizedUrl)
      if (parsedUrl.pathname.endsWith('/api/v1/workspaces/account-workspace-id/cloud-agents/cloud-agent-1/box')) {
        const queued = boxResponses.shift()
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => queued ?? ({
            sandboxId: 'sandbox-1',
            execUrl: 'https://sandbox.example',
            relayfileToken: 'relayfile-token',
            relayfileMountPath: '/remote/project-1',
            status: 'ready'
          })
        }
      }
      throw new Error(`unexpected fetch: ${normalizedUrl}`)
    }),
    loadStore: vi.fn(() => ({
      projects: [{ ...project }],
      activeProjectId: project.id
    })),
    saveStore: vi.fn((data: unknown) => {
      void data
    }),
    resolveCloudAuth: vi.fn(async () => currentAuth
      ? {
          apiUrl: currentAuth.apiUrl,
          accessToken: currentAuth.accessToken,
          accountKey: 'account-key'
        }
      : null),
    getAccountWorkspaceId: vi.fn(async () => {
      if (!currentAuth) throw new Error('cloud-auth-required')
      const response = await fetch(`${currentAuth.apiUrl}/api/v1/auth/whoami`, {
        headers: { Authorization: `Bearer ${currentAuth.accessToken}` }
      })
      const data = await response.json() as {
        workspaceId?: string
        workspace?: { id?: string }
        currentWorkspace?: { id?: string }
      }
      const workspaceId = data.workspaceId || data.workspace?.id || data.currentWorkspace?.id
      if (!workspaceId) throw new Error('account-workspace-required')
      return workspaceId
    }),
    getRelayWorkspaceManager: vi.fn(() => ({
      getWorkspaceId: vi.fn(async () => 'relay-workspace-id')
    })),
    mountPathsFor: vi.fn(async () => ['/integrations/github'])
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mock.browserWindow
}))

vi.mock('./auth', () => ({
  resolveCloudAuth: mock.resolveCloudAuth,
  getAccountWorkspaceId: mock.getAccountWorkspaceId
}))

vi.mock('@agent-relay/sdk', () => ({
  AgentRelayClient: vi.fn()
}))

vi.mock('@relayfile/sdk', () => ({
  RelayfileSetup: mock.RelayfileSetup,
  createDefaultMountLauncher: vi.fn(() => ({
    start: vi.fn()
  }))
}))

vi.mock('./broker', () => ({
  brokerManager: mock.brokerManager
}))

vi.mock('./relay-workspace', () => ({
  getRelayWorkspaceManager: mock.getRelayWorkspaceManager
}))

vi.mock('./store', () => ({
  loadStore: mock.loadStore,
  saveStore: mock.saveStore
}))

vi.mock('./integrations', () => ({
  integrationsManager: {
    mountPathsFor: mock.mountPathsFor
  }
}))

import { CloudAgentManager } from './cloud-agent'

describe('CloudAgentManager', () => {
  beforeEach(() => {
    mock.currentAuth = {
      apiUrl: 'https://cloud.example',
      accessToken: 'account-token'
    }
    mock.fetch.mockClear()
    mock.fetchCalls.splice(0)
    mock.mountInputs.splice(0)
    mock.boxResponses.splice(0)
    mock.browserWindow.getAllWindows.mockClear()
    mock.brokerManager.onBrokerEvent.mockClear()
    mock.brokerManager.attachCloudSandbox.mockClear()
    mock.brokerManager.detachCloudSandbox.mockClear()
    mock.loadStore.mockClear()
    mock.saveStore.mockClear()
    mock.resolveCloudAuth.mockClear()
    mock.getAccountWorkspaceId.mockClear()
    mock.getRelayWorkspaceManager.mockClear()
    mock.mountPathsFor.mockClear()
    vi.stubGlobal('fetch', mock.fetch)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    mock.currentAuth = null
  })

  it('warms a box using the token account workspace, not the relay workspace', async () => {
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    const boxPost = mock.fetchCalls.find((call) => call.init?.method === 'POST')
    expect(boxPost?.url).toBe(
      'https://cloud.example/api/v1/workspaces/account-workspace-id/cloud-agents/cloud-agent-1/box?async=true'
    )
    expect(boxPost?.url).not.toContain('relay-workspace-id')
    expect(mock.fetchCalls.filter((call) => call.url.endsWith('/api/v1/auth/whoami'))).toHaveLength(1)
    expect(mock.mountInputs[0]?.workspaceId).toBe('relay-workspace-id')
  })

  it('polls async box warm until the sandbox is ready', async () => {
    vi.useFakeTimers()
    mock.boxResponses.push(
      {
        sandboxId: 'sandbox-1',
        relayfileToken: 'relayfile-token',
        relayfileMountPath: '/remote/project-1',
        status: 'warming'
      },
      {
        sandboxId: 'sandbox-1',
        execUrl: 'https://sandbox.example',
        relayfileToken: 'relayfile-token',
        relayfileMountPath: '/remote/project-1',
        status: 'ready'
      }
    )
    const manager = new CloudAgentManager()

    const attach = manager.attach('project-1', 'cloud-agent-1')
    await vi.runOnlyPendingTimersAsync()
    await attach

    const boxCalls = mock.fetchCalls.filter((call) => call.url.includes('/cloud-agents/cloud-agent-1/box'))
    expect(boxCalls.map((call) => [call.init?.method, call.url])).toEqual([
      ['POST', 'https://cloud.example/api/v1/workspaces/account-workspace-id/cloud-agents/cloud-agent-1/box?async=true'],
      ['GET', 'https://cloud.example/api/v1/workspaces/account-workspace-id/cloud-agents/cloud-agent-1/box']
    ])
    vi.useRealTimers()
  })

  it('surfaces async box warm failures from the status response', async () => {
    mock.boxResponses.push({
      sandboxId: 'sandbox-1',
      relayfileToken: 'relayfile-token',
      relayfileMountPath: '/remote/project-1',
      status: 'failed',
      error: 'broker failed to start'
    })
    const manager = new CloudAgentManager()

    await expect(manager.attach('project-1', 'cloud-agent-1')).rejects.toThrow('broker failed to start')
  })
})
