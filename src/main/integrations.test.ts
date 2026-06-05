import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FetchCall = {
  url: string
  init?: RequestInit
}

const mock = vi.hoisted(() => {
  const fetchCalls: FetchCall[] = []
  const initialIntegration = () => ({
    id: 'slack-integration-1',
    name: 'Slack',
    type: 'slack',
    provider: 'slack',
    integrationId: 'slack-integration-1',
    scope: {},
    mountPaths: ['/slack/channels'],
    connectedAt: '2026-06-05T00:00:00.000Z',
    notifyAgent: true,
    subscribeAgent: false,
    downloadHistoricalData: false,
    visibleInProject: true
  })
  const store = {
    projects: [
      {
        id: 'project-1',
        name: 'Project 1',
        rootPath: '/tmp/project-1',
        roots: [],
        channels: ['general'],
        channelPeople: {},
        integrations: [initialIntegration()]
      }
    ],
    activeProjectId: 'project-1'
  }
  let mountReconcilePromise: Promise<void> = Promise.resolve()
  const readFileCalls: Array<{ workspaceId: string; path: string }> = []
  const relayClient = {
    readFile: vi.fn(async (workspaceId: string, path: string) => {
      readFileCalls.push({ workspaceId, path })
      return {
        path,
        revision: 'rev-1',
        contentType: 'application/json',
        content: JSON.stringify({
          provider: 'slack',
          objectType: 'message',
          payload: {
            text: 'hello from the remote Slack record',
            channel: 'C123',
            ts: '1713220123.001100',
            user: 'U456'
          }
        }),
        encoding: 'utf-8'
      }
    })
  }
  const workspaceHandle = {
    workspaceId: 'account-workspace-id',
    client: vi.fn(() => relayClient)
  }
  const relayWorkspaceManager = {
    withHandle: vi.fn(async (fn: (handle: typeof workspaceHandle) => Promise<unknown>) => fn(workspaceHandle)),
    getWorkspaceHandle: vi.fn(async () => workspaceHandle)
  }

  const jsonResponse = (payload: unknown, status = 200, statusText = 'OK') => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => payload
  })

  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const normalizedUrl = String(url)
    fetchCalls.push({ url: normalizedUrl, init })
    const parsed = new URL(normalizedUrl)

    if (parsed.pathname === '/api/v1/integrations/catalog') {
      return jsonResponse({
        providers: [
          {
            id: 'slack',
            displayName: 'Slack',
            version: '1',
            backends: ['nango'],
            defaultMountPaths: ['/slack/channels']
          },
          {
            id: 'google-mail',
            displayName: 'Gmail',
            version: '1',
            backends: ['nango'],
            defaultMountPaths: ['/google-mail/messages']
          }
        ]
      })
    }

    if (parsed.pathname === '/api/v1/workspaces/account-workspace-id/integrations/google-mail/options/channels') {
      return jsonResponse({
        options: [
          { value: 'inbox', label: 'Inbox', hint: 'mail' },
          { value: 'sent' }
        ]
      })
    }

    if (parsed.pathname === '/api/v1/workspaces/account-workspace-id/integrations/slack/options/channels') {
      return jsonResponse({ error: 'not found' }, 404, 'Not Found')
    }

    if (
      parsed.pathname === '/api/v1/workspaces/account-workspace-id/integrations/slack/channels/available' &&
      parsed.searchParams.get('cursor') === 'cursor-2'
    ) {
      return jsonResponse({
        channels: [{ id: 'C456', name: 'private-team', is_private: true }]
      })
    }

    if (parsed.pathname === '/api/v1/workspaces/account-workspace-id/integrations/slack/channels/available') {
      return jsonResponse({
        channels: [{ id: 'C123', name: 'general' }],
        nextCursor: 'cursor-2'
      })
    }

    throw new Error(`unexpected fetch: ${normalizedUrl}`)
  })

  return {
    fetchCalls,
    store,
    fetch,
    browserWindow: {
      getAllWindows: vi.fn(() => [])
    },
    resolveCloudAuth: vi.fn(async () => ({
      apiUrl: 'https://cloud.example',
      accessToken: 'account-token'
    })),
    getAccountWorkspaceId: vi.fn(async () => 'account-workspace-id'),
    accountWorkspaceReadyRetryOptions: vi.fn(() => ({ retryAttempts: 1, retryDelayMs: 0 })),
    loadStore: vi.fn(() => store),
    saveStore: vi.fn(() => undefined),
    integrationMountManager: {
      ensureMounted: vi.fn(() => mountReconcilePromise),
      currentWorkspaceId: vi.fn(() => null),
      localPathsFor: vi.fn(() => []),
      stop: vi.fn(async () => undefined)
    },
    integrationEventBridge: {
      reconcile: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined)
    },
    cloudAgentManager: {
      updateMountPaths: vi.fn(async () => undefined)
    },
    readFileCalls,
    relayClient,
    relayWorkspaceManager,
    brokerManager: {
      listAgents: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined)
    },
    ensureProjectIntegrationsLink: vi.fn(async () => undefined),
    removeProjectIntegrationsLink: vi.fn(async () => undefined),
    resetStore() {
      store.projects[0].integrations = [initialIntegration()]
    },
    setMountReconcilePromise(value: Promise<void>) {
      mountReconcilePromise = value
    }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mock.browserWindow,
  shell: {
    openExternal: vi.fn(async () => undefined)
  }
}))

vi.mock('./auth', () => ({
  resolveCloudAuth: mock.resolveCloudAuth,
  getAccountWorkspaceId: mock.getAccountWorkspaceId,
  accountWorkspaceReadyRetryOptions: mock.accountWorkspaceReadyRetryOptions,
  getApiUrl: vi.fn(() => 'https://cloud.example')
}))

vi.mock('./store', () => ({
  loadStore: mock.loadStore,
  saveStore: mock.saveStore
}))

vi.mock('./integration-mounts', () => ({
  integrationMountManager: mock.integrationMountManager,
  integrationMountRootForWorkspace: vi.fn((workspaceId: string) => `/tmp/relayfile/${workspaceId}`),
  MAX_LOCAL_INTEGRATION_MOUNT_PATHS: 24
}))

vi.mock('./integration-event-bridge', () => ({
  integrationEventBridge: mock.integrationEventBridge,
  integrationSubscriptionSummaries: vi.fn(() => [])
}))

vi.mock('./cloud-agent', () => ({
  cloudAgentManager: mock.cloudAgentManager
}))

vi.mock('./broker', () => ({
  brokerManager: mock.brokerManager
}))

vi.mock('./integration-symlinks', () => ({
  PROJECT_INTEGRATIONS_LINK_NAME: '.integrations',
  ensureProjectIntegrationsLink: mock.ensureProjectIntegrationsLink,
  removeProjectIntegrationsLink: mock.removeProjectIntegrationsLink
}))

vi.mock('./relay-workspace', () => ({
  getRelayWorkspaceManager: vi.fn(() => mock.relayWorkspaceManager)
}))

import { IntegrationsManager, localSyncMountPathsForIntegration } from './integrations'

type SystemMessageSnippetBuilder = {
  buildSystemMessageSnippet(
    integrations: Array<Parameters<typeof localSyncMountPathsForIntegration>[0]>,
    subscriptionsReady: boolean
  ): string
}

describe('IntegrationsManager', () => {
  beforeEach(() => {
    mock.fetchCalls.splice(0)
    mock.fetch.mockClear()
    mock.browserWindow.getAllWindows.mockClear()
    mock.resolveCloudAuth.mockClear()
    mock.getAccountWorkspaceId.mockClear()
    mock.accountWorkspaceReadyRetryOptions.mockClear()
    mock.loadStore.mockClear()
    mock.saveStore.mockClear()
    mock.integrationMountManager.ensureMounted.mockClear()
    mock.integrationMountManager.currentWorkspaceId.mockClear()
    mock.integrationMountManager.localPathsFor.mockClear()
    mock.integrationMountManager.stop.mockClear()
    mock.integrationEventBridge.reconcile.mockClear()
    mock.cloudAgentManager.updateMountPaths.mockClear()
    mock.readFileCalls.splice(0)
    mock.relayClient.readFile.mockClear()
    mock.relayWorkspaceManager.withHandle.mockClear()
    mock.relayWorkspaceManager.getWorkspaceHandle.mockClear()
    mock.brokerManager.listAgents.mockClear()
    mock.brokerManager.sendMessage.mockClear()
    mock.ensureProjectIntegrationsLink.mockClear()
    mock.removeProjectIntegrationsLink.mockClear()
    mock.resetStore()
    mock.setMountReconcilePromise(Promise.resolve())
    vi.stubGlobal('fetch', mock.fetch)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('lists integration options through the account workspace API', async () => {
    const manager = new IntegrationsManager()

    await expect(manager.listOptions('project-1', 'gmail', 'channels')).resolves.toEqual([
      { value: 'inbox', label: 'Inbox', hint: 'mail' },
      { value: 'sent', label: 'sent' }
    ])

    const optionsCall = mock.fetchCalls.find((call) =>
      call.url.endsWith('/api/v1/workspaces/account-workspace-id/integrations/google-mail/options/channels')
    )
    expect(optionsCall?.init?.headers).toMatchObject({
      Authorization: 'Bearer account-token'
    })
  })

  it('falls back to legacy Slack channel options through the account workspace API', async () => {
    const manager = new IntegrationsManager()

    await expect(manager.listOptions('project-1', 'slack', 'channels')).resolves.toEqual([
      { value: 'C123', label: '#general' },
      { value: 'C456', label: '#private-team', hint: 'private' }
    ])

    expect(mock.fetchCalls.map((call) => new URL(call.url).pathname + new URL(call.url).search)).toContain(
      '/api/v1/workspaces/account-workspace-id/integrations/slack/channels/available?cursor=cursor-2'
    )
  })

  it('keeps local sync to discovery and narrow outbox command roots while historical download is off', () => {
    expect(localSyncMountPathsForIntegration({
      provider: 'slack',
      integrationId: 'slack-integration-1',
      scope: {},
      mountPaths: ['/discovery/slack', '/slack/channels', '/slack/channels/C123', '/slack/dms/D123'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: false
    })).toEqual([
      '/discovery/slack',
      '/slack/channels/C123/.outbox',
      '/slack/dms/D123/.outbox'
    ])
  })

  it('only includes narrow provider record paths when historical download is on', () => {
    expect(localSyncMountPathsForIntegration({
      provider: 'slack',
      integrationId: 'slack-integration-1',
      scope: {},
      mountPaths: ['/discovery/slack', '/slack/channels', '/slack/channels/C123', '/integrations/slack/dms/D123'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: true
    })).toEqual(['/discovery/slack', '/slack/channels/C123', '/slack/dms/D123'])
  })

  it('names outbox command roots in agent guidance while historical download is off', () => {
    const manager = new IntegrationsManager() as unknown as SystemMessageSnippetBuilder

    const message = manager.buildSystemMessageSnippet([{
      provider: 'slack',
      integrationId: 'slack-integration-1',
      scope: {},
      mountPaths: ['/slack/channels/C123'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: false
    }], true)

    expect(message).toContain('create writeback files under .integrations/slack/channels/C123/.outbox')
    expect(message).toContain('Writeback command roots are mounted at .integrations/slack/channels/C123/.outbox')
    expect(message).not.toContain('create writeback files under .integrations/slack/channels/C123, not under discovery')
  })

  it('surfaces local mount budget skips in agent guidance', () => {
    const manager = new IntegrationsManager() as unknown as SystemMessageSnippetBuilder

    const message = manager.buildSystemMessageSnippet([{
      provider: 'slack',
      integrationId: 'slack-integration-1',
      scope: {},
      mountPaths: Array.from({ length: 30 }, (_, index) => `/slack/channels/C${String(index).padStart(3, '0')}`),
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: true
    }], true)

    expect(message).toContain('not locally poll-mounted')
    expect(message).toContain('.integrations/slack/channels/C023')
  })

  it('does not block updateScope on integration state sync', async () => {
    let finishMountReconcile!: () => void
    mock.setMountReconcilePromise(new Promise((resolve) => {
      finishMountReconcile = () => resolve()
    }))
    const manager = new IntegrationsManager()

    const updated = await manager.updateScope(
      'project-1',
      'slack-integration-1',
      { channels: ['C123'] },
      ['/slack/channels/C123']
    )

    expect(updated).toMatchObject({
      integrationId: 'slack-integration-1',
      scope: { channels: ['C123'] },
      mountPaths: ['/slack/channels/C123']
    })
    await vi.waitFor(() => {
      expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalled()
    })

    finishMountReconcile()
  })

  it('reads a targeted remote Slack event record without reconciling local mounts', async () => {
    const manager = new IntegrationsManager()

    const preview = await manager.readRemoteFile(
      'project-1',
      '/slack/channels/C123/messages/1713220123_001100.json'
    )

    expect(preview).toMatchObject({
      kind: 'text',
      content: expect.stringContaining('hello from the remote Slack record')
    })
    expect(mock.readFileCalls).toEqual([
      {
        workspaceId: 'account-workspace-id',
        path: '/slack/channels/C123/messages/1713220123_001100.json'
      }
    ])
    expect(mock.integrationMountManager.ensureMounted).not.toHaveBeenCalled()
  })

  it('rejects targeted remote file reads outside the project integration scope', async () => {
    const manager = new IntegrationsManager()

    await expect(
      manager.readRemoteFile('project-1', '/github/repos/acme/app/issues/1.json')
    ).rejects.toThrow('outside this project integration scope')

    expect(mock.readFileCalls).toEqual([])
  })
})
