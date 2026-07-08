import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FetchCall = {
  url: string
  init?: RequestInit
}

/** Build a minimal connected-integration fixture for prescriptive tests. */
function makeIntegration(provider: string, mountPaths: string[]) {
  return {
    id: `${provider}-integration-1`,
    name: provider,
    type: provider,
    provider,
    integrationId: `${provider}-integration-1`,
    scope: {},
    mountPaths,
    connectedAt: '2026-06-05T00:00:00.000Z',
    notifyAgent: true,
    subscribeAgent: false,
    subscribeAgentConfigured: false,
    downloadHistoricalData: false,
    visibleInProject: true
  }
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
    // Narrow channel mount → a writeback command root is mounted, so the default
    // fixture is "active" (the integrations-update snippet now omits idle ones).
    mountPaths: ['/slack/channels/C123'],
    connectedAt: '2026-06-05T00:00:00.000Z',
    notifyAgent: true,
    subscribeAgent: false,
    subscribeAgentConfigured: false,
    downloadHistoricalData: false,
    visibleInProject: true
  })
  const store = {
    projects: [
      {
        id: 'project-1',
        name: 'Project 1',
        rootPath: '/tmp/project-1',
        roots: [{ id: 'root-primary', name: 'primary', path: '/tmp/project-1' }],
        channels: ['general'],
        channelPeople: {},
        integrations: [initialIntegration()]
      }
    ],
    activeProjectId: 'project-1'
  }
  let mountReconcilePromise: Promise<void> = Promise.resolve()
  const readFileCalls: Array<{ workspaceId: string; path: string }> = []
  const writeFileCalls: Array<{ workspaceId: string; path: string; baseRevision: string; content: string }> = []
  const joinWorkspaceCalls: Array<{ workspaceId: string; options: { agentName: string; scopes: string[] } }> = []
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
    }),
    writeFile: vi.fn(async (input: { workspaceId: string; path: string; baseRevision: string; content: string }) => {
      writeFileCalls.push(input)
      return { opId: 'op-1', status: 'queued' }
    }),
    listTree: vi.fn(async (_workspaceId: string, _options: { path: string; depth?: number; cursor?: string }) => ({
      entries: [] as Array<{ path: string; type: 'file' | 'dir' }>,
      nextCursor: null as string | null
    }))
  }
  const shellOpenExternal = vi.fn(async () => undefined)
  const workspaceHandle = {
    workspaceId: 'account-workspace-id',
    client: vi.fn(() => relayClient),
    requestJson: vi.fn(async (_request: { path: string }): Promise<unknown> => {
      throw new Error('unexpected workspace request')
    }),
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
    shellOpenExternal,
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
      currentWorkspaceId: vi.fn((): string | null => null),
      localPathsFor: vi.fn((): string[] => []),
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
    writeFileCalls,
    joinWorkspaceCalls,
    relayClient,
    relayWorkspaceManager,
    workspaceHandle,
    brokerManager: {
      listAgents: vi.fn(async (): Promise<Array<{ name: string; projectId: string }>> => []),
      sendMessage: vi.fn(async (_projectId: string | undefined, _input: unknown) => undefined),
      sendMessageAndWaitForDelivery: vi.fn(async () => undefined)
    },
    ensureProjectIntegrationsLink: vi.fn(async () => undefined),
    removeProjectIntegrationsLink: vi.fn(async () => undefined),
    resetStore() {
      store.projects[0].roots = [{ id: 'root-primary', name: 'primary', path: '/tmp/project-1' }]
      store.projects[0].integrations = [initialIntegration()]
    },
    setMountReconcilePromise(value: Promise<void>) {
      mountReconcilePromise = value
    }
  }
})

// Remote read/list/write operations resolve scoped handles via
// RelayfileSetup.joinWorkspace.
// Mock the SDK so that path returns the in-memory handle instead of doing a
// real network join.
vi.mock('@relayfile/sdk', () => ({
  RelayfileSetup: class {
    async joinWorkspace(workspaceId: string, options: { agentName: string; scopes: string[] }) {
      mock.joinWorkspaceCalls.push({ workspaceId, options })
      return mock.workspaceHandle
    }
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: mock.browserWindow,
  shell: {
    openExternal: mock.shellOpenExternal
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
  integrationLocalPathForRemote: vi.fn((workspaceId: string, remotePath: string) => {
    const segments = remotePath.split('/').filter(Boolean)
    const withoutRoot = segments[0] === 'integrations' ? segments.slice(1) : segments
    return ['/tmp/relayfile', workspaceId, ...withoutRoot].join('/')
  }),
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
// Mocked module (see vi.mock('./integration-event-bridge') above): importing the
// stubbed function lets a test override what subscription summaries it returns.
import { integrationSubscriptionSummaries } from './integration-event-bridge'

type SystemMessageSnippetBuilder = {
  buildSystemMessageSnippet(
    integrations: Array<Parameters<typeof localSyncMountPathsForIntegration>[0]>
  ): string
}

const accountWorkspaceMirrorRoot = '/tmp/relayfile/account-workspace-id'
const secondaryProjectRoot = '/tmp/project-1-secondary'

function createAccountWorkspaceMirror(): void {
  mkdirSync(accountWorkspaceMirrorRoot, { recursive: true })
}

function mockConnectSession(connectLink: string): void {
  mock.workspaceHandle.requestJson.mockImplementation(async (request: { path: string }) => {
    if (request.path.endsWith('/status')) {
      throw new Error('not connected')
    }
    if (request.path.endsWith('/connect-session')) {
      return {
        connectLink,
        connectionId: 'connect-session-1'
      }
    }
    throw new Error(`unexpected workspace request: ${request.path}`)
  })
}

describe('IntegrationsManager', () => {
  beforeEach(() => {
    mock.fetchCalls.splice(0)
    mock.fetch.mockClear()
    mock.browserWindow.getAllWindows.mockClear()
    mock.resolveCloudAuth.mockClear()
    // Full reset (not just calls): tests that block cloud hydration override
    // the implementation with a rejection, which must not leak forward.
    mock.getAccountWorkspaceId.mockReset()
    mock.getAccountWorkspaceId.mockImplementation(async () => 'account-workspace-id')
    mock.accountWorkspaceReadyRetryOptions.mockClear()
    mock.loadStore.mockClear()
    mock.saveStore.mockClear()
    mock.integrationMountManager.ensureMounted.mockClear()
    // Full reset: the prescriptive adapter-doc test overrides the return value
    // with a workspace id, which must default back to null for other tests.
    mock.integrationMountManager.currentWorkspaceId.mockReset()
    mock.integrationMountManager.currentWorkspaceId.mockReturnValue(null)
    mock.integrationMountManager.localPathsFor.mockClear()
    mock.integrationMountManager.setHealthObserver.mockClear()
    mock.integrationMountManager.stop.mockClear()
    mock.integrationEventBridge.reconcile.mockClear()
    mock.integrationEventBridge.closeAll.mockClear()
    mock.integrationEventBridge.closeAllExcept.mockClear()
    mock.cloudAgentManager.updateMountPaths.mockClear()
    mock.readFileCalls.splice(0)
    mock.writeFileCalls.splice(0)
    mock.joinWorkspaceCalls.splice(0)
    mock.relayClient.readFile.mockClear()
    mock.relayClient.writeFile.mockClear()
    mock.relayClient.listTree.mockClear()
    mock.shellOpenExternal.mockClear()
    mock.workspaceHandle.requestJson.mockReset()
    mock.workspaceHandle.requestJson.mockImplementation(async (_request: { path: string }) => {
      throw new Error('unexpected workspace request')
    })
    mock.relayWorkspaceManager.withHandle.mockClear()
    mock.relayWorkspaceManager.getWorkspaceHandle.mockClear()
    mock.brokerManager.listAgents.mockClear()
    mock.brokerManager.sendMessage.mockClear()
    mock.brokerManager.sendMessageAndWaitForDelivery.mockClear()
    mock.ensureProjectIntegrationsLink.mockClear()
    mock.removeProjectIntegrationsLink.mockClear()
    rmSync(accountWorkspaceMirrorRoot, { recursive: true, force: true })
    mock.resetStore()
    mock.setMountReconcilePromise(Promise.resolve())
    vi.stubGlobal('fetch', mock.fetch)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    rmSync(accountWorkspaceMirrorRoot, { recursive: true, force: true })
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

  it('does not auto-subscribe an unconfigured webhook integration to events', () => {
    const manager = new IntegrationsManager()

    expect(manager.listConnected('project-1')).toEqual([
      expect.objectContaining({
        provider: 'slack',
        subscribeAgent: false,
        subscribeAgentConfigured: false
      })
    ])
  })

  it('preserves an explicit disabled webhook event subscription', () => {
    mock.store.projects[0].integrations[0] = {
      ...mock.store.projects[0].integrations[0],
      subscribeAgent: false,
      subscribeAgentConfigured: true
    }
    const manager = new IntegrationsManager()

    expect(manager.listConnected('project-1')).toEqual([
      expect.objectContaining({
        provider: 'slack',
        subscribeAgent: false,
        subscribeAgentConfigured: true
      })
    ])
  })

  it('marks event subscription as explicit when the user toggles it', async () => {
    const manager = new IntegrationsManager()

    await manager.updateSubscription('project-1', 'slack-integration-1', false)

    expect(mock.store.projects[0].integrations[0]).toEqual(
      expect.objectContaining({
        subscribeAgent: false,
        subscribeAgentConfigured: true
      })
    )
  })

  it('does not auto-subscribe hydrated webhook integrations to events', async () => {
    mock.store.projects[0].integrations = []
    const manager = new IntegrationsManager()

    await manager.hydrateProjectCloudIntegrations('project-1')

    expect(mock.store.projects[0].integrations[0]).toEqual(
      expect.objectContaining({
        provider: 'slack',
        subscribeAgent: false,
        subscribeAgentConfigured: false
      })
    )
  })

  it('writes remote files at the current revision (read-then-write)', async () => {
    const manager = new IntegrationsManager()

    await expect(manager.writeRemoteFile('project-1', '/slack/channels/C123/messages/draft.json', '{"text":"hello"}'))
      .resolves.toBeUndefined()

    // The file exists remotely (mock read returns rev-1), so the write must
    // carry that revision — not '0', which the server rejects with a 409 for
    // any existing file (e.g. Issues status changes updating the issue record).
    expect(mock.readFileCalls).toEqual([
      { workspaceId: 'account-workspace-id', path: '/slack/channels/C123/messages/draft.json' }
    ])
    expect(mock.writeFileCalls).toEqual([
      {
        workspaceId: 'account-workspace-id',
        path: '/slack/channels/C123/messages/draft.json',
        baseRevision: 'rev-1',
        content: '{"text":"hello"}'
      }
    ])
    expect(mock.joinWorkspaceCalls).toEqual([
      {
        workspaceId: 'account-workspace-id',
        options: {
          agentName: 'pear-integrations-writer',
          scopes: ['relayfile:fs:read:/**', 'relayfile:fs:write:/**']
        }
      }
    ])
  })

  it('creates a new remote file with baseRevision 0 when the pre-write read 404s', async () => {
    mock.relayClient.readFile.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { status: 404 })
    )
    const manager = new IntegrationsManager()

    await expect(manager.writeRemoteFile('project-1', '/slack/channels/C123/messages/draft.json', '{"text":"hi"}'))
      .resolves.toBeUndefined()

    expect(mock.writeFileCalls).toEqual([
      expect.objectContaining({ baseRevision: '0', content: '{"text":"hi"}' })
    ])
  })

  it('re-reads and retries exactly once on a revision conflict', async () => {
    const fileAt = (revision: string) => ({
      path: '/slack/channels/C123/messages/draft.json',
      revision,
      contentType: 'application/json',
      content: '{}',
      encoding: 'utf-8' as const
    })
    mock.relayClient.readFile
      .mockResolvedValueOnce(fileAt('rev-1'))
      .mockResolvedValueOnce(fileAt('rev-2'))
    mock.relayClient.writeFile.mockRejectedValueOnce(
      Object.assign(new Error('revision conflict'), { status: 409, code: 'revision_conflict' })
    )
    const manager = new IntegrationsManager()

    await expect(manager.writeRemoteFile('project-1', '/slack/channels/C123/messages/draft.json', '{"a":1}'))
      .resolves.toBeUndefined()

    expect(
      mock.relayClient.writeFile.mock.calls.map(([input]) => (input as { baseRevision: string }).baseRevision)
    ).toEqual(['rev-1', 'rev-2'])
  })

  it('does not swallow a second consecutive revision conflict', async () => {
    const conflict = () =>
      Object.assign(new Error('revision conflict'), { status: 409, code: 'revision_conflict' })
    mock.relayClient.writeFile.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict())
    const manager = new IntegrationsManager()

    await expect(manager.writeRemoteFile('project-1', '/slack/channels/C123/messages/draft.json', '{}'))
      .rejects.toMatchObject({ status: 409 })
    expect(mock.relayClient.writeFile).toHaveBeenCalledTimes(2)
  })

  it('allows /linear/states list + read when a Linear integration is visible, but never write', async () => {
    mock.store.projects[0].integrations.push({
      id: 'linear-integration-1',
      name: 'Linear',
      type: 'linear',
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: {},
      mountPaths: ['/linear/issues'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: false,
      subscribeAgentConfigured: false,
      downloadHistoricalData: false,
      visibleInProject: true
    })
    mock.relayClient.listTree.mockResolvedValueOnce({
      entries: [
        { path: '/linear/states', type: 'dir' },
        { path: '/linear/states/state-1.json', type: 'file' }
      ],
      nextCursor: null
    })
    const manager = new IntegrationsManager()

    await expect(manager.listRemoteDirectory('project-1', '/linear/states')).resolves.toEqual([
      { name: 'state-1.json', path: '/linear/states/state-1.json', type: 'file' }
    ])
    await expect(manager.readRemoteFile('project-1', '/linear/states/state-1.json'))
      .resolves.toMatchObject({ kind: 'text' })
    // The carve-out is read-only: workflow states are reference data.
    await expect(manager.writeRemoteFile('project-1', '/linear/states/state-1.json', '{}'))
      .rejects.toThrow('Integration remote file is outside this project integration scope')
  })

  it('rejects /linear/states listing without a visible Linear integration', async () => {
    const manager = new IntegrationsManager()

    await expect(manager.listRemoteDirectory('project-1', '/linear/states'))
      .rejects.toThrow('Integration remote directory is outside this project integration scope')
    expect(mock.relayClient.listTree).not.toHaveBeenCalled()
  })

  it('rejects remote writes outside the configured project scope', async () => {
    const manager = new IntegrationsManager()

    await expect(manager.writeRemoteFile('project-1', '/github/repos/acme/widgets/issues/1.json', '{}'))
      .rejects.toThrow('Integration remote file is outside this project integration scope')

    expect(mock.relayClient.writeFile).not.toHaveBeenCalled()
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

  it('returns settings integrations before local mount reconciliation finishes', async () => {
    let finishMountReconcile!: () => void
    mock.setMountReconcilePromise(new Promise((resolve) => {
      finishMountReconcile = resolve
    }))
    const manager = new IntegrationsManager()
    let resolved = false

    const loadPromise = manager.listConnectedForSettings('project-1')
      .then((integrations) => {
        resolved = true
        return integrations
      })

    await Promise.resolve()
    await Promise.resolve()

    expect(resolved).toBe(true)
    expect(await loadPromise).toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])
    expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1)

    finishMountReconcile()
    await Promise.resolve()
  })

  it('coalesces repeated settings mount syncs while reconciliation is pending', async () => {
    let finishMountReconcile!: () => void
    mock.setMountReconcilePromise(new Promise((resolve) => {
      finishMountReconcile = resolve
    }))
    const manager = new IntegrationsManager()

    await Promise.all([
      manager.listConnectedForSettings('project-1'),
      manager.listConnectedForSettings('project-1')
    ])

    expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1)

    finishMountReconcile()
    await Promise.resolve()
  })

  it('repairs project integration links when mount reconciliation hits a transient failure', async () => {
    createAccountWorkspaceMirror()
    mock.store.projects[0].roots = [
      { id: 'root-primary', name: 'primary', path: '/tmp/project-1' },
      { id: 'root-secondary', name: 'secondary', path: secondaryProjectRoot }
    ]
    mock.integrationMountManager.currentWorkspaceId.mockReturnValue('account-workspace-id')
    mock.integrationMountManager.ensureMounted.mockRejectedValueOnce(new Error('spawn failed'))
    const manager = new IntegrationsManager()

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])

    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(mock.ensureProjectIntegrationsLink).toHaveBeenCalledWith('/tmp/project-1', 'account-workspace-id')
      expect(mock.ensureProjectIntegrationsLink).toHaveBeenCalledWith(secondaryProjectRoot, 'account-workspace-id')
    })
    expect(mock.ensureProjectIntegrationsLink).toHaveBeenCalledTimes(2)
    expect(mock.removeProjectIntegrationsLink).not.toHaveBeenCalled()
  })

  it('does not remove project integration links when workspace id resolution fails during a transient mount failure', async () => {
    mock.integrationMountManager.ensureMounted.mockRejectedValueOnce(new Error('spawn failed'))
    mock.getAccountWorkspaceId.mockRejectedValue(new Error('account-workspace-required'))
    const manager = new IntegrationsManager()

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])

    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1))
    expect(mock.ensureProjectIntegrationsLink).not.toHaveBeenCalled()
    expect(mock.removeProjectIntegrationsLink).not.toHaveBeenCalled()
  })

  it('does not create project integration links until the local mirror exists', async () => {
    mock.integrationMountManager.currentWorkspaceId.mockReturnValue('account-workspace-id')
    const manager = new IntegrationsManager()

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([
      expect.objectContaining({ provider: 'slack', integrationId: 'slack-integration-1' })
    ])

    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1))
    expect(mock.ensureProjectIntegrationsLink).not.toHaveBeenCalled()
    expect(mock.removeProjectIntegrationsLink).not.toHaveBeenCalled()
  })

  it('removes project integration links after a successful reconcile with no visible integrations', async () => {
    mock.store.projects[0].integrations = []
    mock.store.projects[0].roots = [
      { id: 'root-primary', name: 'primary', path: '/tmp/project-1' },
      { id: 'root-secondary', name: 'secondary', path: secondaryProjectRoot }
    ]
    mock.fetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ integrations: [] })
    }))
    const manager = new IntegrationsManager()

    await expect(manager.listConnectedForSettings('project-1')).resolves.toEqual([])

    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledWith([]))
    await vi.waitFor(() => {
      expect(mock.removeProjectIntegrationsLink).toHaveBeenCalledWith('/tmp/project-1')
      expect(mock.removeProjectIntegrationsLink).toHaveBeenCalledWith(secondaryProjectRoot)
    })
    expect(mock.removeProjectIntegrationsLink).toHaveBeenCalledTimes(2)
    expect(mock.ensureProjectIntegrationsLink).not.toHaveBeenCalled()
  })

  it('removes project integration links from secondary roots on shutdown', async () => {
    mock.store.projects[0].roots = [
      { id: 'root-primary', name: 'primary', path: '/tmp/project-1' },
      { id: 'root-duplicate', name: 'duplicate', path: '/tmp/project-1' },
      { id: 'root-secondary', name: 'secondary', path: secondaryProjectRoot }
    ]
    const manager = new IntegrationsManager()

    await manager.shutdownLocalMounts()

    expect(mock.removeProjectIntegrationsLink).toHaveBeenCalledWith('/tmp/project-1')
    expect(mock.removeProjectIntegrationsLink).toHaveBeenCalledWith(secondaryProjectRoot)
    expect(mock.removeProjectIntegrationsLink).toHaveBeenCalledTimes(2)
    expect(mock.integrationMountManager.stop).toHaveBeenCalledTimes(1)
    expect(mock.integrationEventBridge.closeAll).toHaveBeenCalledTimes(1)
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

    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'integration-auth-required',
      reason: 'account-workspace-required',
      message: 'account-workspace-required'
    }))
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

  it('surfaces a restart-cap-exceeded mount as user-actionable auth recovery', () => {
    const manager = new IntegrationsManager()
    const observer = mock.integrationMountManager.setHealthObserver.mock.calls.at(-1)?.[0]

    observer?.({
      type: 'restart-cap-exceeded',
      remotePath: '/slack/channels/C0BBTBC1RCM__epic/messages',
      attempts: 5,
      reason: 'reconcile loop stalled'
    })

    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'cloud-auth-required',
      failureClass: 'mount-recovery-exhausted'
    })
    expect(manager.getAuthRecoveryState()?.message).toMatch(/stopped recovering after 5 restarts/)
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
    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1))
    expect(manager.getAuthRecoveryState()).toMatchObject({
      reason: 'account-workspace-required',
      failureClass: 'whoami-http-500',
      message: 'account-workspace-required:whoami-http-500'
    })

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
    await vi.waitFor(() => expect(mock.integrationMountManager.ensureMounted).toHaveBeenCalledTimes(1))
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

  it('opens an https connect link returned by the cloud', async () => {
    vi.useFakeTimers()
    const connectLink = 'https://cloud.example/integrations/connect?token=abc'
    mockConnectSession(connectLink)
    const manager = new IntegrationsManager()

    await expect(manager.startConnect('project-1', 'google-mail')).resolves.toMatchObject({
      sessionId: 'connect-session-1',
      status: 'awaiting-user',
      authUrl: connectLink
    })

    expect(mock.shellOpenExternal).toHaveBeenCalledTimes(1)
    expect(mock.shellOpenExternal).toHaveBeenCalledWith(connectLink)
  })

  it('rejects a file connect link returned by the cloud', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockConnectSession('file:///tmp/connect-token')
    const manager = new IntegrationsManager()

    await expect(manager.startConnect('project-1', 'google-mail')).resolves.toMatchObject({
      sessionId: 'connect-session-1',
      status: 'awaiting-user',
      authUrl: 'file:///tmp/connect-token'
    })

    expect(mock.shellOpenExternal).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      '[integrations] Refusing to open integration connect link:',
      expect.objectContaining({
        projectId: 'project-1',
        provider: 'google-mail',
        sessionId: 'connect-session-1',
        reason: 'unsupported-scheme',
        scheme: 'file:'
      })
    )
    warnSpy.mockRestore()
  })

  it('rejects a malformed connect link without throwing', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockConnectSession('not a url')
    const manager = new IntegrationsManager()

    await expect(manager.startConnect('project-1', 'google-mail')).resolves.toMatchObject({
      sessionId: 'connect-session-1',
      status: 'awaiting-user',
      authUrl: 'not a url'
    })

    expect(mock.shellOpenExternal).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      '[integrations] Refusing to open integration connect link:',
      expect.objectContaining({
        projectId: 'project-1',
        provider: 'google-mail',
        sessionId: 'connect-session-1',
        reason: 'invalid-url'
      })
    )
    warnSpy.mockRestore()
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
    }])

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
    }])

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
    }])

    expect(message).toContain('not locally poll-mounted')
    expect(message).toContain('.integrations/slack/channels/C023')
  })

  it('treats a subscribed-but-otherwise-idle integration as active (listening)', () => {
    const manager = new IntegrationsManager() as unknown as SystemMessageSnippetBuilder
    // No history sync and a base mount path (no narrow writeback command roots),
    // so the integration is active only by virtue of "listening" — a registered
    // event subscription.
    const idleSubscribedLinear = {
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: {},
      mountPaths: ['/linear'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      downloadHistoricalData: false
    }

    // Without an active subscription summary the gate suppresses the message:
    // not syncing, not actionable, not listening.
    vi.mocked(integrationSubscriptionSummaries).mockReturnValueOnce([])
    expect(manager.buildSystemMessageSnippet([idleSubscribedLinear])).toBe('')

    // With a subscription summary present the integration is listening, so the
    // message renders and lists the active subscription.
    vi.mocked(integrationSubscriptionSummaries).mockReturnValue([
      { provider: 'linear', watches: ['.integrations/linear/**'], targets: [] }
    ])
    const message = manager.buildSystemMessageSnippet([idleSubscribedLinear])
    expect(message).toContain('<integrations-update>')
    expect(message).toContain('linear')
    expect(message).toContain('Active integration event subscriptions for this project')
    expect(message).toContain('file changes at .integrations/linear/**')

    vi.mocked(integrationSubscriptionSummaries).mockReturnValue([])
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
      subscribeAgentConfigured: false,
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

  // Typed view over the untyped sendMessage mock: the integrations-update
  // send inputs in call order.
  const integrationUpdateSendInputs = (): Array<{ to: string; text: string }> =>
    (mock.brokerManager.sendMessage as unknown as {
      mock: { calls: Array<[unknown, { to: string; text: string; data?: { kind?: string } }]> }
    }).mock.calls
      .map((call) => call[1])
      .filter((input) => input?.data?.kind === 'integrations-update')

  it('retries a partially failed broadcast only to the agents that missed it', async () => {
    vi.useFakeTimers()
    // Hermetic snippet text: background cloud hydration re-adds integrations
    // to the store and changes the rendered text between broadcasts (the
    // separate staged-churn case the cooldown test covers). Block hydration
    // and pin a single active integration so the text is identical across
    // reconciles (an idle/empty project now produces no snippet at all).
    mock.store.projects[0].integrations = [makeIntegration('slack', ['/slack/channels/C123'])]
    mock.getAccountWorkspaceId.mockRejectedValue(new Error('offline'))
    mock.brokerManager.listAgents.mockResolvedValue([
      { name: 'claude-1', projectId: 'project-1' },
      { name: 'codex-1', projectId: 'project-1' }
    ] as never)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // First broadcast: codex-1's send fails, claude-1's succeeds.
    mock.brokerManager.sendMessage.mockImplementation((async (_projectId: string, input: { to: string }) => {
      if (input.to === 'codex-1') throw new Error('input stream wedged')
      return undefined
    }) as never)
    const manager = new IntegrationsManager()

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    const sentTo = (): string[] => integrationUpdateSendInputs().map((input) => input.to)
    expect(sentTo()).toEqual(['claude-1', 'codex-1'])

    // Retry reconcile: ONLY codex-1 (which missed it) may be re-sent —
    // claude-1 already received and acknowledged this update. Re-sending to
    // everyone is the duplicated-transcript bug.
    mock.brokerManager.sendMessage.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(60_000) // clear the broadcast cooldown
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(sentTo()).toEqual(['claude-1', 'codex-1', 'codex-1'])
    warnSpy.mockRestore()
  })

  it('sends an unchanged update to a newly arrived agent without re-sending to existing agents', async () => {
    vi.useFakeTimers()
    mock.store.projects[0].integrations = [makeIntegration('slack', ['/slack/channels/C123'])]
    mock.getAccountWorkspaceId.mockRejectedValue(new Error('offline'))
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }] as never)
    const manager = new IntegrationsManager()

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)

    mock.brokerManager.listAgents.mockResolvedValue([
      { name: 'claude-1', projectId: 'project-1' },
      { name: 'codex-1', projectId: 'project-1' }
    ] as never)
    await vi.advanceTimersByTimeAsync(60_000)
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(61_000)

    expect(integrationUpdateSendInputs().map((input) => input.to)).toEqual(['claude-1', 'codex-1'])
  })

  it('skips the broadcast for an agent whose spawn task already embedded the snippet', async () => {
    vi.useFakeTimers()
    mock.store.projects[0].integrations = [{
      id: 'linear-integration-1',
      name: 'Linear',
      type: 'linear',
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: {},
      mountPaths: ['/linear/issues'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      subscribeAgentConfigured: true,
      downloadHistoricalData: false,
      visibleInProject: true
    }]
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }] as never)
    const manager = new IntegrationsManager()

    // Spawn path: the snippet rides inside the spawn task, and the spawn
    // handler records delivery for the new agent.
    const instructions = manager.initialSpawnInstructions('project-1')
    expect(instructions).toContain('<integrations-update>')
    manager.recordSpawnInstructionDelivery('project-1', 'claude-1')

    // The post-spawn broadcast of the same snippet must be a no-op for the
    // agent that just received it in its spawn task ("Setup context
    // received" acknowledged twice was this bug).
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(integrationUpdateSendInputs()).toHaveLength(0)
  })

  it('does not re-notify a fresh spawn when the broadcast text differs only by staged churn', async () => {
    // The codex-double-acknowledgment case: an agent spawns with the snippet
    // embedded in its task; moments later the project broadcast renders a
    // slightly different text (readiness clause / paths hydrating) and used
    // to deliver a near-identical second setup message. The spawn grace
    // skips it; the follow-up after the grace delivers a still-different
    // text exactly once.
    vi.useFakeTimers()
    mock.store.projects[0].integrations = [{
      id: 'linear-integration-1',
      name: 'Linear',
      type: 'linear',
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: {},
      mountPaths: ['/linear/issues'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      subscribeAgentConfigured: true,
      downloadHistoricalData: false,
      visibleInProject: true
    }]
    mock.getAccountWorkspaceId.mockRejectedValue(new Error('offline'))
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'codex-1', projectId: 'project-1' }] as never)
    const manager = new IntegrationsManager()

    expect(manager.initialSpawnInstructions('project-1')).toContain('<integrations-update>')
    manager.recordSpawnInstructionDelivery('project-1', 'codex-1')

    // Simulate staged churn: the store changes right after the spawn, so the
    // broadcast text differs from the embedded snippet (historical download
    // flips on, which rewrites the history clause).
    mock.store.projects[0].integrations = [{
      ...mock.store.projects[0].integrations[0],
      downloadHistoricalData: true
    }]
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(5_000)
    // Grace holds: no near-identical second setup message right after spawn.
    expect(integrationUpdateSendInputs()).toHaveLength(0)

    // After the grace lapses the still-different text arrives exactly once.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(integrationUpdateSendInputs()).toHaveLength(1)
    expect(integrationUpdateSendInputs()[0].to).toBe('codex-1')

    // And an identical reconcile afterwards stays silent.
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(integrationUpdateSendInputs()).toHaveLength(1)
  })

  it('holds a changed update inside the rebroadcast cooldown and sends the latest text once', async () => {
    vi.useFakeTimers()
    mock.store.projects[0].integrations = [makeIntegration('slack', ['/slack/channels/C123'])]
    mock.getAccountWorkspaceId.mockRejectedValue(new Error('offline'))
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }] as never)
    const manager = new IntegrationsManager()
    const updateTexts = (): string[] => integrationUpdateSendInputs().map((input) => input.text)

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(updateTexts()).toHaveLength(1)

    // Integration state converges in stages right after the first broadcast
    // (channel-name discovery renames mount paths, readiness flips). The
    // changed text must NOT go out immediately — it waits out the cooldown,
    // and the trailing broadcast carries the latest text exactly once.
    mock.store.projects[0].integrations = [{
      id: 'linear-integration-1',
      name: 'Linear',
      type: 'linear',
      provider: 'linear',
      integrationId: 'linear-integration-1',
      scope: {},
      mountPaths: ['/linear/issues'],
      connectedAt: '2026-06-05T00:00:00.000Z',
      notifyAgent: true,
      subscribeAgent: true,
      subscribeAgentConfigured: true,
      downloadHistoricalData: false,
      visibleInProject: true
    }]
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(updateTexts()).toHaveLength(1) // held by the cooldown

    await vi.advanceTimersByTimeAsync(60_000)
    expect(updateTexts()).toHaveLength(2)
    expect(updateTexts()[1]).toContain('linear')
  })

  it('broadcasts one clearing update when the last active integration is removed', async () => {
    vi.useFakeTimers()
    mock.store.projects[0].integrations = [makeIntegration('slack', ['/slack/channels/C123'])]
    mock.getAccountWorkspaceId.mockRejectedValue(new Error('offline'))
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }] as never)
    const manager = new IntegrationsManager()
    const updateTexts = (): string[] => integrationUpdateSendInputs().map((input) => input.text)

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(updateTexts()).toHaveLength(1)
    expect(updateTexts()[0]).toContain('.integrations/slack/channels/C123')

    // Last integration disconnected: agents already told about it must get one
    // clearing update rather than silence (otherwise they keep stale context).
    mock.store.projects[0].integrations = []
    await vi.advanceTimersByTimeAsync(60_000) // clear the rebroadcast cooldown
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(updateTexts()).toHaveLength(2)
    expect(updateTexts()[1]).toContain('- none')

    // A further idle reconcile stays silent — the prior context was cleared once.
    await vi.advanceTimersByTimeAsync(60_000)
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(updateTexts()).toHaveLength(2)
  })

  it('does not re-send an unchanged integrations update after the dedupe window lapses', async () => {
    vi.useFakeTimers()
    // Pin a single active integration so the rendered text is identical across
    // reconciles (background hydration would otherwise change it, which is the
    // legitimate-rebroadcast case; an idle/empty project now yields no snippet).
    mock.store.projects[0].integrations = [makeIntegration('slack', ['/slack/channels/C123'])]
    mock.getAccountWorkspaceId.mockRejectedValue(new Error('offline'))
    mock.brokerManager.listAgents.mockResolvedValue([{ name: 'claude-1', projectId: 'project-1' }] as never)
    const manager = new IntegrationsManager()
    const integrationsUpdateSends = (): number =>
      mock.brokerManager.sendMessage.mock.calls.filter(
        ([, input]) => (input as { data?: { kind?: string } }).data?.kind === 'integrations-update'
      ).length

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(integrationsUpdateSends()).toBe(1)

    // A later reconcile with identical integration state must not re-broadcast
    // regardless of elapsed time — duplicate <integrations-update> messages
    // were observed minutes apart with the old 30s text-TTL dedupe.
    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(integrationsUpdateSends()).toBe(1)

    await manager.notifyAgentState('project-1')
    await vi.advanceTimersByTimeAsync(61_000)
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

  it('builds prescriptive spawn instructions from the adapter discovery doc', () => {
    // Materialize a discovery .adapter.md on the (mocked) local mount so the
    // generator reads writable resources from adapter data, not hardcoded rows.
    const workspaceId = 'ws-prescriptive'
    mock.integrationMountManager.currentWorkspaceId.mockReturnValue(workspaceId)
    const slackDiscoveryDir = join('/tmp/relayfile', workspaceId, 'discovery', 'slack')
    const linearDiscoveryDir = join('/tmp/relayfile', workspaceId, 'discovery', 'linear')
    mkdirSync(slackDiscoveryDir, { recursive: true })
    mkdirSync(linearDiscoveryDir, { recursive: true })
    writeFileSync(
      join(slackDiscoveryDir, '.adapter.md'),
      [
        '# slack writeback adapter',
        '## Writable resources',
        '### messages — `/slack/channels/{channelId}/messages`',
        '- schema: `discovery/slack/channels/{channelId}/messages/.schema.json`',
        '### direct-messages — `/slack/users/{userId}/messages`',
        '- schema: `discovery/slack/users/{userId}/messages/.schema.json`',
        '## Contract',
        '### not-a-resource — `/slack/should/not/appear`'
      ].join('\n')
    )
    writeFileSync(
      join(linearDiscoveryDir, '.adapter.md'),
      [
        '# linear writeback adapter',
        '## Writable resources',
        '### issues — `/linear/issues`',
        '### comments — `/linear/issues/{issueId}/comments`'
      ].join('\n')
    )

    mock.store.projects[0].integrations = [
      makeIntegration('slack', ['/slack/channels/C12345__general']),
      makeIntegration('linear', ['/linear/issues'])
    ]
    const manager = new IntegrationsManager()

    const instructions = manager.prescriptiveSpawnInstructions('project-1')

    expect(instructions).toBeDefined()
    // Path comes from the adapter doc; concrete channel id resolved from the scoped mount.
    expect(instructions).toContain('messages → .integrations/slack/channels/C12345__general/messages/<name>.json')
    // Payload shape points at the adapter's discovery create example — not hardcoded.
    expect(instructions).toContain('fields: .integrations/discovery/slack/channels/{channelId}/messages/.create.example.json')
    // Linear create + nested comments (id placeholder preserved).
    expect(instructions).toContain('issues → .integrations/linear/issues/<name>.json')
    expect(instructions).toContain('comments → .integrations/linear/issues/{issueId}/comments/<name>.json')
    expect(instructions).toContain('fields: .integrations/discovery/linear/issues/{issueId}/comments/.create.example.json')
    expect(instructions).toContain('{…} path segments are resource ids')
    // The "## Contract" heading ends the writable section — its row is ignored.
    expect(instructions).not.toContain('should/not/appear')
    // No hardcoded payloads or narrative block.
    expect(instructions).not.toContain('"text":"<message>"')
    expect(instructions).not.toContain('<integrations-update>')
  })

  it('works generically for a provider with no pear-side knowledge', () => {
    // notion has no special-casing anywhere in pear — paths + example pointers
    // come entirely from its adapter doc.
    const workspaceId = 'ws-notion'
    mock.integrationMountManager.currentWorkspaceId.mockReturnValue(workspaceId)
    const dir = join('/tmp/relayfile', workspaceId, 'discovery', 'notion')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '.adapter.md'),
      [
        '# notion writeback adapter',
        '## Writable resources',
        '### pages — `/notion/databases/{databaseId}/pages`'
      ].join('\n')
    )
    mock.store.projects[0].integrations = [
      makeIntegration('notion', ['/notion/databases/DB123/pages'])
    ]
    const manager = new IntegrationsManager()

    const instructions = manager.prescriptiveSpawnInstructions('project-1')

    expect(instructions).toContain('pages → .integrations/notion/databases/DB123/pages/<name>.json')
    expect(instructions).toContain('fields: .integrations/discovery/notion/databases/{databaseId}/pages/.create.example.json')
  })

  it('falls back to a discovery pointer when the adapter doc is unavailable', () => {
    // currentWorkspaceId defaults to null in the mock → no adapter doc to read.
    mock.store.projects[0].integrations = [
      makeIntegration('slack', ['/slack/channels/C12345__general'])
    ]
    const manager = new IntegrationsManager()

    const instructions = manager.prescriptiveSpawnInstructions('project-1')

    expect(instructions).toBeDefined()
    expect(instructions).toContain('read .integrations/discovery/slack/.adapter.md')
    expect(instructions).toContain('.integrations/slack/channels/C12345__general/messages/<name>.json')
  })

  it('returns undefined from prescriptiveSpawnInstructions when no integrations', () => {
    mock.store.projects[0].integrations = []
    const manager = new IntegrationsManager()
    expect(manager.prescriptiveSpawnInstructions('project-1')).toBeUndefined()
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
