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
    client: vi.fn(() => relayClient),
    refreshToken: vi.fn(async () => undefined)
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
          },
          {
            id: 'linear',
            displayName: 'Linear',
            version: '1',
            backends: ['nango'],
            defaultMountPaths: ['/linear/issues']
          }
        ]
      })
    }

    if (parsed.pathname === '/api/v1/workspaces/account-workspace-id/integrations') {
      return jsonResponse({
        integrations: [
          {
            provider: 'slack',
            integrationId: 'slack-integration-1',
            mountPaths: ['/slack/channels'],
            scope: {},
            connectedAt: '2026-06-05T00:00:00.000Z',
            ready: true
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
      setHealthObserver: vi.fn(),
      stop: vi.fn(async () => undefined)
    },
    integrationEventBridge: {
      reconcile: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
      closeAllExcept: vi.fn(async () => undefined)
    },
    cloudAgentManager: {
      updateMountPaths: vi.fn(async () => undefined)
    },
    readFileCalls,
    relayClient,
    relayWorkspaceManager,
    workspaceHandle,
    brokerManager: {
      listAgents: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
      sendMessageAndWaitForDelivery: vi.fn(async () => undefined)
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

// readRemoteFile/listRemoteDirectory now resolve a reader handle via
// RelayfileSetup.joinWorkspace (integrations.ts getIntegrationRemoteReaderHandle).
// Mock the SDK so that path returns the in-memory handle instead of doing a
// real network join.
vi.mock('@relayfile/sdk', () => ({
  RelayfileSetup: class {
    async joinWorkspace() {
      return mock.workspaceHandle
    }
  }
}))

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
  integrationSubscriptionSummaries: vi.fn(() => []),
  slackListenDms: (integration: { provider?: string; scope?: Record<string, unknown> }) => {
    if (integration.provider !== 'slack') return false
    const scope = integration.scope ?? {}
    return ['listenDms', 'listenDirectMessages', 'directMessages'].some((key) => scope[key] === true)
  }
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
    mock.integrationMountManager.setHealthObserver.mockClear()
    mock.integrationMountManager.stop.mockClear()
    mock.integrationEventBridge.reconcile.mockClear()
    mock.integrationEventBridge.closeAll.mockClear()
    mock.integrationEventBridge.closeAllExcept.mockClear()
    mock.cloudAgentManager.updateMountPaths.mockClear()
    mock.readFileCalls.splice(0)
    mock.relayClient.readFile.mockClear()
    mock.relayWorkspaceManager.withHandle.mockClear()
    mock.relayWorkspaceManager.getWorkspaceHandle.mockClear()
    mock.brokerManager.listAgents.mockClear()
    mock.brokerManager.sendMessage.mockClear()
    mock.brokerManager.sendMessageAndWaitForDelivery.mockClear()
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

  it('returns local settings integrations and sets recovery when signed in before the account workspace exists', async () => {
    mock.getAccountWorkspaceId.mockRejectedValueOnce(new Error('account-workspace-required'))
    const manager = new IntegrationsManager()

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({
        provider: 'slack',
        integrationId: 'slack-integration-1'
      })
    ])

    await manager.hydrateProjectCloudIntegrations('project-1')
    expect(mock.fetchCalls.some((call) => call.url.includes('/api/v1/workspaces/'))).toBe(false)
    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'account-workspace-required',
      message: 'account-workspace-required'
    })
  })

  it('raises the cloud-auth sign-in banner via background hydration without blocking first paint', async () => {
    mock.getAccountWorkspaceId.mockRejectedValueOnce(new Error('cloud-auth-required'))
    const manager = new IntegrationsManager()
    const events: unknown[] = []
    manager.onEvent((event) => events.push(event))

    // First paint returns the local list immediately and never throws on a cloud
    // auth failure — the renderer prompt is driven by the auth-required event.
    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])

    await manager.hydrateProjectCloudIntegrations('project-1')
    expect(manager.getAuthRecoveryState()).toMatchObject({ reason: 'cloud-auth-required' })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'integration-auth-required', reason: 'cloud-auth-required' })
    )
  })

  it('returns the local list first while cloud hydration is still pending', async () => {
    // Gate cloud resolution so we can prove first paint does NOT wait on it.
    let releaseCloud!: () => void
    const cloudGate = new Promise<void>((resolve) => {
      releaseCloud = resolve
    })
    mock.getAccountWorkspaceId.mockImplementationOnce(async () => {
      await cloudGate
      return 'account-workspace-id'
    })
    const manager = new IntegrationsManager()

    // Resolves to the local list even though the cloud call is still blocked.
    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])
    expect(mock.fetchCalls.some((call) => call.url.includes('/api/v1/workspaces/account-workspace-id/integrations'))).toBe(false)

    // Releasing the cloud call lets the background hydration issue its fetch.
    releaseCloud()
    await manager.hydrateProjectCloudIntegrations('project-1')
    expect(manager.getAuthRecoveryState()).toBeNull()
    expect(mock.fetchCalls.some((call) => call.url.includes('/api/v1/workspaces/account-workspace-id/integrations'))).toBe(true)
  })

  it('does not throw or raise a banner when background cloud hydration hits a transient failure', async () => {
    mock.getAccountWorkspaceId.mockRejectedValueOnce(new Error('network unreachable'))
    const manager = new IntegrationsManager()

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])

    await manager.hydrateProjectCloudIntegrations('project-1')
    // A generic (non-auth) failure is swallowed: first paint already showed local.
    expect(manager.getAuthRecoveryState()).toBeNull()
  })

  it('emits auth recovery and returns local integrations when local mount startup cannot resolve an account workspace', async () => {
    const manager = new IntegrationsManager()
    const events: unknown[] = []
    manager.onEvent((event) => events.push(event))
    mock.integrationMountManager.ensureMounted.mockRejectedValueOnce(new Error('account-workspace-required'))

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({
        provider: 'slack',
        integrationId: 'slack-integration-1'
      })
    ])

    expect(events).toContainEqual({
      type: 'integration-auth-required',
      reason: 'account-workspace-required',
      message: 'account-workspace-required'
    })
  })

  it('keeps boot-time auth recovery queryable after the event is missed by renderer listeners', () => {
    const manager = new IntegrationsManager()
    const observer = mock.integrationMountManager.setHealthObserver.mock.calls.at(-1)?.[0]

    observer?.({
      type: 'auth-required',
      reason: 'cloud-auth-required',
      message: 'cloud-auth-required'
    })

    const lateEvents: unknown[] = []
    manager.onEvent((event) => lateEvents.push(event))

    expect(lateEvents).toEqual([])
    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'cloud-auth-required',
      message: 'cloud-auth-required'
    })
  })

  it('clears sticky auth recovery state after the all-dead recovery retry respawns mounts', async () => {
    vi.useFakeTimers()
    const manager = new IntegrationsManager()
    const events: unknown[] = []
    manager.onEvent((event) => events.push(event))
    mock.integrationMountManager.ensureMounted.mockRejectedValueOnce(new Error('account-workspace-required:whoami-http-500'))

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({
        provider: 'slack',
        integrationId: 'slack-integration-1'
      })
    ])
    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'account-workspace-required',
      failureClass: 'whoami-http-500',
      message: 'account-workspace-required:whoami-http-500'
    })
    expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()

    expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(2)
    expect(manager.getAuthRecoveryState()).toBeNull()
    expect(events).toContainEqual({ type: 'integration-auth-recovered' })
  })

  it('keeps sticky auth recovery state when a retry hits a non-auth mount failure', async () => {
    vi.useFakeTimers()
    const manager = new IntegrationsManager()
    mock.integrationMountManager.ensureMounted
      .mockRejectedValueOnce(new Error('account-workspace-required:whoami-http-500'))
      .mockRejectedValueOnce(new Error('spawn failed'))

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({
        provider: 'slack',
        integrationId: 'slack-integration-1'
      })
    ])
    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'account-workspace-required',
      failureClass: 'whoami-http-500'
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()

    expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(2)
    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'account-workspace-required',
      failureClass: 'whoami-http-500'
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()

    expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(3)
    expect(manager.getAuthRecoveryState()).toBeNull()
  })

  it('classifies stale workspace integration access as sign-in recovery', async () => {
    mock.fetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'Forbidden' })
    }))
    const manager = new IntegrationsManager()

    // Local-first: first paint returns local; the 403 is classified into the
    // sign-in banner by the background hydration rather than thrown.
    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])
    await manager.hydrateProjectCloudIntegrations('project-1')

    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'cloud-auth-required',
      failureClass: 'workspace-access-revoked',
      message: 'cloud-auth-required:workspace-access-revoked'
    })
  })

  it('clears the cloud-auth banner when retryAuthRecovery re-checks after a fresh login', async () => {
    const manager = new IntegrationsManager()
    const events: unknown[] = []
    manager.onEvent((event) => events.push(event))

    // Banner goes up: cloud rejects the workspace access (e.g. revoked/expired
    // token), exactly the state a "Cloud sign-in required" banner reflects.
    mock.fetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'Forbidden' })
    }))
    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])
    await manager.hydrateProjectCloudIntegrations('project-1')
    expect(manager.getAuthRecoveryState()).toMatchObject({ reason: 'cloud-auth-required' })

    // Fresh login fires retryAuthRecovery; the cloud re-check now succeeds, so
    // the banner clears without the user opening the integrations settings page.
    await manager.retryAuthRecovery()

    expect(manager.getAuthRecoveryState()).toBeNull()
    expect(events).toContainEqual({ type: 'integration-auth-recovered' })
  })

  it('retryAuthRecovery is a no-op when no auth banner is showing', async () => {
    const manager = new IntegrationsManager()
    mock.integrationMountManager.ensureMounted.mockClear()

    await manager.retryAuthRecovery()

    expect(manager.getAuthRecoveryState()).toBeNull()
    expect(mock.integrationMountManager.ensureMounted).not.toHaveBeenCalled()
  })

  it('relays mount-manager auth recovery alerts to renderer integration events', () => {
    const manager = new IntegrationsManager()
    const events: unknown[] = []
    manager.onEvent((event) => events.push(event))

    const observer = mock.integrationMountManager.setHealthObserver.mock.calls.at(-1)?.[0]
    observer?.({
      type: 'auth-required',
      reason: 'cloud-auth-required',
      message: 'cloud-auth-required'
    })

    expect(events).toEqual([
      {
        type: 'integration-auth-required',
        reason: 'cloud-auth-required',
        message: 'cloud-auth-required'
      }
    ])
  })

  it('keeps local sync to discovery and narrow canonical writeback command roots while historical download is off', () => {
    expect(localSyncMountPathsForIntegration({
      provider: 'slack',
      integrationId: 'slack-integration-1',
      scope: {},
      mountPaths: ['/discovery/slack', '/slack/channels', '/slack/channels/C123', '/slack/dms/D123', '/slack/users/U123/messages'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: false
    })).toEqual([
      '/discovery/slack',
      '/slack/channels/C123/messages',
      '/slack/channels/C123/threads',
      '/slack/dms/D123/messages',
      '/slack/dms/D123/threads',
      '/slack/users/U123/messages'
    ])

    expect(localSyncMountPathsForIntegration({
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: {},
      mountPaths: ['/discovery/linear', '/linear', '/linear/issues'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: false
    })).toEqual([
      '/discovery/linear',
      '/linear/issues'
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

  it('names canonical writeback command roots in agent guidance while historical download is off', () => {
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

    expect(message).toContain('create writeback files under .integrations/slack/channels/C123/messages')
    expect(message).toContain('Writeback command roots are mounted at .integrations/slack/channels/C123/messages')
    expect(message).toContain('live thread context roots are mounted at .integrations/slack/channels/C123/threads')
    expect(message).not.toContain('create writeback files under .integrations/slack/channels/C123, not under discovery')
  })

  it('names non-Slack narrow resources as writeback command roots', () => {
    const manager = new IntegrationsManager() as unknown as SystemMessageSnippetBuilder

    const message = manager.buildSystemMessageSnippet([{
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: { resources: ['issues'] },
      mountPaths: ['/linear/issues'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: false
    }], true)

    expect(message).toContain('create writeback files under .integrations/linear/issues')
    expect(message).toContain('Writeback command roots are mounted at .integrations/linear/issues')
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
    expect(mock.integrationMountManager.ensureMounted).toHaveBeenLastCalledWith([
      {
        provider: 'slack',
        mountPaths: [
          '/discovery/slack',
          '/slack/channels/C123/messages',
          '/slack/channels/C123/threads'
        ]
      }
    ])

    finishMountReconcile()
  })

  it('reconciles non-Slack writeback mounts after a live scope change', async () => {
    mock.store.projects[0].integrations = [{
      id: 'linear-integration-1',
      name: 'Linear',
      type: 'linear',
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: {},
      mountPaths: ['/linear'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: false,
      downloadHistoricalData: false,
      visibleInProject: true
    }]
    const manager = new IntegrationsManager()

    await manager.updateScope(
      'project-1',
      'linear-integration-1',
      { resources: ['issues'] },
      ['/linear/issues']
    )

    await vi.waitFor(() => {
      expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledWith(
        expect.arrayContaining([
          {
            provider: 'linear',
            mountPaths: ['/discovery/linear', '/linear/issues']
          }
        ])
      )
    })
  })

  it('waits for a newly spawned agent before injecting integration guidance', async () => {
    vi.useFakeTimers()
    let listAttempts = 0
    mock.brokerManager.listAgents.mockImplementation(async () => {
      listAttempts += 1
      return listAttempts === 1
        ? []
        : [{ name: 'claude-1', projectId: 'project-1' }]
    })
    const manager = new IntegrationsManager()

    await manager.notifyAgentState('project-1')
    expect(mock.brokerManager.sendMessage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mock.brokerManager.listAgents).toHaveBeenCalledTimes(1)
    expect(mock.brokerManager.sendMessage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(mock.brokerManager.sendMessage).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        to: 'claude-1',
        from: 'system',
        text: expect.stringContaining('<integrations-update>'),
        data: {
          kind: 'integrations-update',
          system: true
        }
      })
    )
  })

  it('does not wait for delivery confirmation when injecting integration guidance', async () => {
    vi.useFakeTimers()
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }])
    mock.brokerManager.sendMessageAndWaitForDelivery.mockRejectedValue(new Error('delivery timeout'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new IntegrationsManager()

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mock.brokerManager.sendMessage).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        to: 'claude-1',
        from: 'system',
        text: expect.stringContaining('<integrations-update>')
      })
    )
    expect(mock.brokerManager.sendMessageAndWaitForDelivery).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[integrations] Failed to inject integration system message:',
      expect.any(String)
    )
    warnSpy.mockRestore()
  })

  it('does not re-send an unchanged integrations update after the dedupe window lapses', async () => {
    vi.useFakeTimers()
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }])
    const manager = new IntegrationsManager()
    const integrationsUpdateSends = (): number =>
      mock.brokerManager.sendMessage.mock.calls.filter(
        ([, input]) => (input as { data?: { kind?: string } }).data?.kind === 'integrations-update'
      ).length

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(integrationsUpdateSends()).toBe(1)
    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalled())
    mock.brokerManager.sendMessage.mockClear()

    // A later reconcile with identical integration state must not re-broadcast
    // regardless of elapsed time — duplicate <integrations-update> messages
    // were observed minutes apart with the old 30s text-TTL dedupe.
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(integrationsUpdateSends()).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(integrationsUpdateSends()).toBe(1)
  })

  it('re-broadcasts the integrations update after a failed send', async () => {
    vi.useFakeTimers()
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }])
    mock.brokerManager.sendMessage.mockRejectedValueOnce(new Error('broker unavailable'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new IntegrationsManager()
    const integrationsUpdateSends = (): number =>
      mock.brokerManager.sendMessage.mock.calls.filter(
        ([, input]) => (input as { data?: { kind?: string } }).data?.kind === 'integrations-update'
      ).length

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(integrationsUpdateSends()).toBe(1)

    // The failed broadcast must not record a last-sent signature; the next
    // reconcile retries the identical message.
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(integrationsUpdateSends()).toBe(2)
    warnSpy.mockRestore()
  })

  it('does not dedupe integration guidance when the first agent wait times out empty', async () => {
    vi.useFakeTimers()
    mock.brokerManager.listAgents.mockResolvedValue([])
    const manager = new IntegrationsManager()

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(mock.brokerManager.sendMessage).not.toHaveBeenCalled()

    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }])
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mock.brokerManager.sendMessage).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        to: 'claude-1',
        from: 'system',
        text: expect.stringContaining('<integrations-update>')
      })
    )
  })

  it('subscribes integration events before waiting on local Relayfile mounts', async () => {
    vi.useFakeTimers()
    mock.setMountReconcilePromise(new Promise(() => undefined))
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }])
    const manager = new IntegrationsManager()

    await manager.notifyAgentState('project-1')

    expect(mock.integrationEventBridge.closeAllExcept).toHaveBeenCalledWith('project-1')
    expect(mock.integrationEventBridge.reconcile).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'slack',
          integrationId: 'slack-integration-1'
        })
      ])
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mock.brokerManager.sendMessage).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        to: 'claude-1',
        from: 'system',
        text: expect.stringContaining('<integrations-update>')
      })
    )
  })

  it('passes current local mount paths into integration event reconciliation', async () => {
    mock.store.projects[0].integrations[0] = {
      ...mock.store.projects[0].integrations[0],
      mountPaths: ['/slack/users/U0ADJH4P83T/messages'],
      scope: { listenDms: true },
      subscribeAgent: true
    }
    mock.integrationMountManager.currentWorkspaceId.mockReturnValue('workspace-id')
    mock.integrationMountManager.localPathsFor.mockReturnValue([
      '/tmp/relayfile/workspace-id/slack/users/U0ADJH4P83T/messages'
    ])
    const manager = new IntegrationsManager()

    await manager.refreshAgentState('project-1')

    expect(mock.integrationEventBridge.reconcile).toHaveBeenCalledWith(
      'project-1',
      [
        expect.objectContaining({
          provider: 'slack',
          integrationId: 'slack-integration-1',
          mountPaths: ['/slack/users/U0ADJH4P83T/messages'],
          localMountPaths: ['/tmp/relayfile/workspace-id/slack/users/U0ADJH4P83T/messages']
        })
      ]
    )
    expect(mock.integrationMountManager.localPathsFor).toHaveBeenCalledWith('workspace-id', {
      provider: 'slack',
      mountPaths: ['/discovery/slack', '/slack/users/U0ADJH4P83T/messages']
    })
  })

  it('retries active integration event subscriptions after startup mount hydration', async () => {
    mock.store.projects[0].integrations[0].subscribeAgent = true
    const manager = new IntegrationsManager()

    await manager.startLocalMountDaemon()
    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalled())

    expect(mock.integrationEventBridge.closeAllExcept).toHaveBeenCalledTimes(2)
    expect(mock.integrationEventBridge.reconcile).toHaveBeenCalledTimes(2)
    expect(mock.integrationEventBridge.reconcile).toHaveBeenLastCalledWith(
      'project-1',
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'slack',
          integrationId: 'slack-integration-1',
          subscribeAgent: true
        })
      ])
    )
  })

  it('builds initial spawn instructions from project integrations', () => {
    const manager = new IntegrationsManager()

    const instructions = manager.initialSpawnInstructions('project-1')

    expect(instructions).toContain('Initial project integration context')
    expect(instructions).toContain('<integrations-update>')
    expect(instructions).toContain('slack')
    expect(instructions).toContain('.integrations/discovery/slack')
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

  it('returns a missing preview when an in-scope remote read 404s instead of rejecting', async () => {
    // Historical provider records (e.g. the GitHub issue JSON synthesized from
    // Linear sync metadata) are not downloaded locally, so an in-scope read can
    // legitimately 404. It must degrade to a missing preview rather than reject
    // the IPC handler.
    mock.relayClient.readFile.mockImplementationOnce(async (_workspaceId: string, path: string) => {
      mock.readFileCalls.push({ workspaceId: _workspaceId, path })
      throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' })
    })

    const manager = new IntegrationsManager()
    const preview = await manager.readRemoteFile(
      'project-1',
      '/slack/channels/C123/messages/1713220123_001100.json'
    )

    expect(preview).toMatchObject({ kind: 'missing', size: 0 })
  })

  it('rejects targeted remote file reads outside the project integration scope', async () => {
    const manager = new IntegrationsManager()

    await expect(
      manager.readRemoteFile('project-1', '/github/repos/acme/app/issues/1.json')
    ).rejects.toThrow('outside this project integration scope')

    expect(mock.readFileCalls).toEqual([])
  })

  it('reads Slack DM/user message records when DM listening is enabled, even outside channel mounts', async () => {
    mock.store.projects[0].integrations[0].scope = { listenDms: true }
    const manager = new IntegrationsManager()

    const preview = await manager.readRemoteFile(
      'project-1',
      '/slack/users/U0ADJH4P83T/messages/1781020047_821749/meta.json'
    )

    expect(preview).toMatchObject({ kind: 'text' })
    expect(mock.readFileCalls).toEqual([
      {
        workspaceId: 'account-workspace-id',
        path: '/slack/users/U0ADJH4P83T/messages/1781020047_821749/meta.json'
      }
    ])
  })

  it('still rejects Slack DM/user message reads when DM listening is disabled', async () => {
    // Default scope has DM listening off, and /slack/users is outside the
    // channel mount paths, so the scope guard must still reject it.
    const manager = new IntegrationsManager()

    await expect(
      manager.readRemoteFile('project-1', '/slack/users/U0ADJH4P83T/messages/1781020047_821749/meta.json')
    ).rejects.toThrow('outside this project integration scope')

    expect(mock.readFileCalls).toEqual([])
  })
})
