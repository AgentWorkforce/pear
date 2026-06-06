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
    mode: string
    localLayout?: string
    syncMode?: string
    background: boolean
    agentName: string
    scopes?: string[]
    readyTimeoutMs: number
    launcher?: {
      start?: (input: { env: Record<string, string> }) => Promise<unknown>
      __options?: {
        onEvent?: (event: { type: string; text?: string }) => void
      }
    }
  }

  const mountInputs: MountInput[] = []
  const startMount = vi.fn(async () => undefined)
  let currentAuth: MockCloudAuth | null = null
  let mountExpiresAt: string | null = null
  let mountSuggestedRefreshAt: string | null = null
  let mountDelay: Promise<void> | null = null

  class RelayfileSetup {
    readonly cloudApiUrl: string

    constructor(options: { cloudApiUrl: string }) {
      this.cloudApiUrl = options.cloudApiUrl
    }

    async mountWorkspace(input: MountInput) {
      mountInputs.push({
        ...input,
        scopes: input.scopes ? [...input.scopes] : undefined
      })
      if (mountDelay) await mountDelay
      return Promise.resolve({
        expiresAt: mountExpiresAt,
        localDir: input.localDir,
        suggestedRefreshAt: mountSuggestedRefreshAt,
        stop: vi.fn(async () => undefined),
        status: vi.fn(async () => ({ ready: true }))
      })
    }
  }

  return {
    mountInputs,
    startMount,
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    readFile: vi.fn(async () => '{}'),
    rm: vi.fn(async () => undefined),
    RelayfileSetup,
    get currentAuth() {
      return currentAuth
    },
    set currentAuth(value: MockCloudAuth | null) {
      currentAuth = value
    },
    get mountExpiresAt() {
      return mountExpiresAt
    },
    set mountExpiresAt(value: string | null) {
      mountExpiresAt = value
    },
    get mountSuggestedRefreshAt() {
      return mountSuggestedRefreshAt
    },
    set mountSuggestedRefreshAt(value: string | null) {
      mountSuggestedRefreshAt = value
    },
    get mountDelay() {
      return mountDelay
    },
    set mountDelay(value: Promise<void> | null) {
      mountDelay = value
    },
    resolveCloudAuth: vi.fn(async () => currentAuth),
    getAccountWorkspaceId: vi.fn(async () => 'account-workspace-id'),
    accountWorkspaceReadyRetryOptions: vi.fn(() => ({ retryAttempts: 1, retryDelayMs: 0 }))
  }
})

vi.mock('node:fs/promises', () => ({
  chmod: mock.chmod,
  mkdir: mock.mkdir,
  readFile: mock.readFile,
  rm: mock.rm
}))

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/tmp/pear-home')
}))

vi.mock('@relayfile/sdk', () => ({
  RelayfileSetup: mock.RelayfileSetup
}))

vi.mock('./auth', () => ({
  resolveCloudAuth: mock.resolveCloudAuth,
  getAccountWorkspaceId: mock.getAccountWorkspaceId,
  accountWorkspaceReadyRetryOptions: mock.accountWorkspaceReadyRetryOptions
}))

vi.mock('./relayfile-mount-launcher', () => ({
  createPearMountLauncher: vi.fn((options) => ({ start: mock.startMount, __options: options }))
}))

import { IntegrationMountManager } from './integration-mounts'

describe('IntegrationMountManager', () => {
  beforeEach(() => {
    mock.mountInputs.splice(0)
    mock.mkdir.mockClear()
    mock.chmod.mockClear()
    mock.readFile.mockClear()
    mock.readFile.mockResolvedValue('{}')
    mock.rm.mockClear()
    mock.startMount.mockClear()
    mock.currentAuth = {
      apiUrl: 'https://cloud.example',
      accessToken: 'account-token'
    }
    mock.resolveCloudAuth.mockClear()
    mock.getAccountWorkspaceId.mockClear()
    mock.mountExpiresAt = null
    mock.mountSuggestedRefreshAt = null
    mock.mountDelay = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mounts each selected relayfile path with scoped relayfile permissions', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'github',
        // Legacy catalog form — the manager derives the real root-level
        // provider path (`/github`) that adapters actually materialize.
        mountPaths: ['/integrations/github/repos']
      },
      {
        provider: 'linear',
        mountPaths: ['/linear/issues']
      }
    ])

    expect(mock.mountInputs).toHaveLength(2)
    expect(mock.mountInputs[0]).toMatchObject({
      workspaceId: 'account-workspace-id',
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/github/repos',
      remotePath: '/github/repos',
      localLayout: 'exact',
      syncMode: 'mirror',
      agentName: 'pear-integrations-github-repos',
      scopes: ['relayfile:fs:read:/github/repos/**', 'relayfile:fs:write:/github/repos/**']
    })
    expect(mock.mountInputs[1]).toMatchObject({
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/linear/issues',
      remotePath: '/linear/issues',
      agentName: 'pear-integrations-linear-issues',
      scopes: ['relayfile:fs:read:/linear/issues/**', 'relayfile:fs:write:/linear/issues/**']
    })
    expect(mock.rm).toHaveBeenCalledWith(
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/integrations',
      { recursive: true, force: true }
    )
  })

  it('reports provider root local paths for browsing', () => {
    const manager = new IntegrationMountManager()

    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'linear',
      mountPaths: ['/integrations/linear/teams', '/linear/projects']
    })).toEqual([
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/linear/projects',
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/linear/teams'
    ])
  })

  it('preserves root-level discovery mounts for writeback metadata', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/discovery/slack']
      }
    ])

    expect(mock.mountInputs).toHaveLength(1)
    expect(mock.mountInputs[0]).toMatchObject({
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/discovery/slack',
      remotePath: '/discovery/slack',
      localLayout: 'exact',
      syncMode: 'mirror',
      agentName: 'pear-integrations-discovery-slack',
      scopes: ['relayfile:fs:read:/discovery/slack/**', 'relayfile:fs:write:/discovery/slack/**']
    })
    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'slack',
      mountPaths: ['/discovery/slack']
    })).toEqual([
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/discovery/slack'
    ])
  })

  it('mounts canonical Slack command roots exactly once in write-only mode', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])

    expect(mock.mountInputs).toHaveLength(1)
    expect(mock.mountInputs[0]).toMatchObject({
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/messages',
      remotePath: '/slack/channels/C123/messages',
      localLayout: 'exact',
      syncMode: 'write-only',
      scopes: ['relayfile:fs:read:/slack/channels/C123/messages/**', 'relayfile:fs:write:/slack/channels/C123/messages/**']
    })
    expect(mock.mountInputs[0]?.localDir).not.toContain('messages/slack/channels/C123/messages')

    const launcher = mock.mountInputs[0]?.launcher
    const started = await launcher?.start?.({
      env: {
        RELAYFILE_REMOTE_PATH: '/slack/channels/C123/messages',
        RELAYFILE_LOCAL_DIR: '/tmp/root'
      }
    })

    expect(started).toBeUndefined()
    expect(mock.startMount).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        RELAYFILE_MOUNT_LOCAL_LAYOUT: 'exact',
        RELAYFILE_MOUNT_SYNC_MODE: 'write-only'
      })
    }))
  })

  it('uses the shared Slack command-root grammar for write-only mode', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/users/U123/messages']
      }
    ])

    expect(mock.mountInputs[0]).toMatchObject({
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/users/U123/messages',
      remotePath: '/slack/users/U123/messages',
      localLayout: 'exact',
      syncMode: 'write-only'
    })
  })

  it('rejects Slack command roots with traversal segments', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/../messages']
      }
    ])

    expect(mock.mountInputs).toHaveLength(0)
  })

  it('scopes bare discovery mounts to the integration provider', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/discovery']
      }
    ])

    expect(mock.mountInputs).toHaveLength(1)
    expect(mock.mountInputs[0]).toMatchObject({
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/discovery/slack',
      remotePath: '/discovery/slack',
      agentName: 'pear-integrations-discovery-slack',
      scopes: ['relayfile:fs:read:/discovery/slack/**', 'relayfile:fs:write:/discovery/slack/**']
    })
    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'slack',
      mountPaths: ['/discovery']
    })).toEqual([
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/discovery/slack'
    ])
  })

  it('restarts mounted providers when the relayfile mount token reaches its refresh time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))
    mock.mountSuggestedRefreshAt = new Date(Date.now() + 1_000).toISOString()
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'github',
        mountPaths: ['/github/repos']
      }
    ])

    expect(mock.mountInputs.map((input) => input.remotePath)).toEqual(['/github/repos'])

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.map((input) => input.remotePath)).toContain('/github/repos')
    expect(mock.mountInputs.filter((input) => input.remotePath === '/github/repos')).toHaveLength(2)
  })

  it('caps local integration mount starts when selected resources exceed the mount budget', async () => {
    const manager = new IntegrationMountManager()
    const integrations = Array.from({ length: 30 }, (_, index) => ({
      provider: 'slack',
      mountPaths: [`/slack/channels/C${String(index).padStart(3, '0')}`]
    }))

    await manager.ensureMounted(integrations)

    expect(mock.mountInputs).toHaveLength(24)
    expect(mock.mountInputs.map((input) => input.remotePath)).toEqual(
      Array.from({ length: 24 }, (_, index) => `/slack/channels/C${String(index).padStart(3, '0')}`)
    )
    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'slack',
      mountPaths: integrations.flatMap((integration) => integration.mountPaths)
    })).toEqual(
      Array.from(
        { length: 24 },
        (_, index) => `/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C${String(index).padStart(3, '0')}`
      )
    )
  })

  it('only reports actually started local paths while a reconcile is reused in flight', async () => {
    let finishMount!: () => void
    mock.mountDelay = new Promise((resolve) => {
      finishMount = () => resolve()
    })
    const manager = new IntegrationMountManager()

    const first = manager.ensureMounted([{
      provider: 'slack',
      mountPaths: ['/slack/channels/C001']
    }])
    await vi.waitFor(() => {
      expect(mock.mountInputs.map((input) => input.remotePath)).toEqual(['/slack/channels/C001'])
    })

    const second = manager.ensureMounted([{
      provider: 'slack',
      mountPaths: ['/slack/channels/C002']
    }])

    finishMount!()
    await first
    await second

    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'slack',
      mountPaths: ['/slack/channels/C002']
    })).toEqual([])
  })

  it('restarts a mounted provider after mount output reports an expired token', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels']
      }
    ])

    const slackMount = mock.mountInputs.find((input) => input.remotePath === '/slack/channels')
    expect(slackMount?.launcher?.__options?.onEvent).toBeTypeOf('function')

    slackMount?.launcher?.__options?.onEvent?.({
      type: 'stderr',
      text: 'mount sync cycle failed: http 401 unauthorized: Token has expired'
    })
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels')).toHaveLength(2)
  })

  it('restarts and reports pending writeback after state polling sees an auth failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const manager = new IntegrationMountManager()
    const healthObserver = vi.fn()
    manager.setHealthObserver(healthObserver)
    mock.readFile.mockResolvedValue(JSON.stringify({
      status: 'writeback-pending',
      pendingWriteback: 1,
      lastSuccessfulReconcileAt: '2026-06-06T13:59:00.000Z',
      lastError: {
        code: 'unauthorized',
        statusCode: 401,
        message: 'http 401 unauthorized: Token has expired',
        at: '2026-06-06T14:00:30.000Z'
      }
    }))

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.readFile).toHaveBeenCalledWith(
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/messages/.relay/state.json',
      'utf8'
    )
    expect(healthObserver).toHaveBeenCalledWith({
      type: 'auth-stall',
      remotePath: '/slack/channels/C123/messages',
      status: 'writeback-pending',
      pendingWriteback: 1,
      message: 'http 401 unauthorized: Token has expired'
    })
    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(2)
  })

  it('suppresses replayed state-poll auth alerts while a restart is throttled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const manager = new IntegrationMountManager()
    const healthObserver = vi.fn()
    manager.setHealthObserver(healthObserver)
    mock.readFile.mockResolvedValue(JSON.stringify({
      status: 'writeback-pending',
      pendingWriteback: 1,
      lastSuccessfulReconcileAt: '2026-06-06T13:59:00.000Z',
      lastError: {
        code: 'unauthorized',
        statusCode: 401,
        message: 'http 401 unauthorized: Token has expired',
        at: '2026-06-06T14:00:30.000Z'
      }
    }))

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(healthObserver).toHaveBeenCalledTimes(1)
    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(2)
  })

  it('rejects and reports cloud auth recovery when startup has no usable tokens', async () => {
    mock.currentAuth = null
    const manager = new IntegrationMountManager()
    const healthObserver = vi.fn()
    manager.setHealthObserver(healthObserver)

    await expect(manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])).rejects.toThrow('cloud-auth-required')

    expect(mock.mountInputs).toHaveLength(0)
    expect(healthObserver).toHaveBeenCalledWith({
      type: 'auth-required',
      reason: 'cloud-auth-required',
      message: 'cloud-auth-required'
    })
  })

  it('rejects and reports workspace recovery when whoami lacks an account workspace', async () => {
    mock.getAccountWorkspaceId.mockRejectedValueOnce(new Error('account-workspace-required'))
    const manager = new IntegrationMountManager()
    const healthObserver = vi.fn()
    manager.setHealthObserver(healthObserver)

    await expect(manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])).rejects.toThrow('account-workspace-required')

    expect(mock.mountInputs).toHaveLength(0)
    expect(healthObserver).toHaveBeenCalledWith({
      type: 'auth-required',
      reason: 'account-workspace-required',
      message: 'account-workspace-required'
    })
  })

  it('does not depend on missing state files to report startup auth recovery', async () => {
    mock.getAccountWorkspaceId.mockRejectedValueOnce(new Error('account-workspace-required'))
    mock.readFile.mockRejectedValue(new Error('ENOENT'))
    const manager = new IntegrationMountManager()
    const healthObserver = vi.fn()
    manager.setHealthObserver(healthObserver)

    await expect(manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])).rejects.toThrow('account-workspace-required')

    expect(mock.readFile).not.toHaveBeenCalled()
    expect(healthObserver).toHaveBeenCalledWith({
      type: 'auth-required',
      reason: 'account-workspace-required',
      message: 'account-workspace-required'
    })
  })
})
