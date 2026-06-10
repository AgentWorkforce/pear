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
  const stoppedRemotePaths: string[] = []

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
        stop: vi.fn(async () => {
          stoppedRemotePaths.push(input.remotePath)
        }),
        status: vi.fn(async () => ({ ready: true }))
      })
    }
  }

  return {
    mountInputs,
    stoppedRemotePaths,
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

import { IntegrationMountManager, readStalledInjectedRevisions } from './integration-mounts'

describe('IntegrationMountManager', () => {
  beforeEach(() => {
    mock.mountInputs.splice(0)
    mock.stoppedRemotePaths.splice(0)
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

  it('mounts Slack channel message roots in mirror mode (read-down + writeback)', async () => {
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
      // Dual-purpose root: reads inbound top-level messages down AND accepts
      // send-writebacks. Mirror is a superset of write-only, so it does both;
      // write-only disabled inbound read-down entirely.
      syncMode: 'mirror',
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
        RELAYFILE_MOUNT_SYNC_MODE: 'mirror',
        RELAYFILE_MOUNT_TIMEOUT: '180s'
      })
    }))
  })

  it('mounts Slack user DM roots in mirror mode so inbound DMs read down', async () => {
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
      syncMode: 'mirror'
    })
  })

  it('mounts Slack thread context roots in mirror mode', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/threads']
      }
    ])

    expect(mock.mountInputs[0]).toMatchObject({
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/threads',
      remotePath: '/slack/channels/C123/threads',
      localLayout: 'exact',
      syncMode: 'mirror'
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
    mock.rm.mockClear()

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.map((input) => input.remotePath)).toContain('/github/repos')
    expect(mock.mountInputs.filter((input) => input.remotePath === '/github/repos')).toHaveLength(2)
    expect(mock.rm).not.toHaveBeenCalledWith(
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/github/repos/.relayfile-mount-state.json',
      { force: true }
    )
    expect(mock.rm).not.toHaveBeenCalledWith(
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/github/repos/.relay/state.json',
      { force: true }
    )
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

  it('applies an in-flight desired-mount change instead of dropping it', async () => {
    // A channel-subscription change that arrives while a reconcile is still in
    // flight must not be swallowed: it should be chained after the pending op so
    // the new path ends up mounted and the superseded one is dropped.
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

    // The in-flight change was applied: C002 was mounted after C001 settled.
    expect(mock.mountInputs.map((input) => input.remotePath)).toContain('/slack/channels/C002')
    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'slack',
      mountPaths: ['/slack/channels/C002']
    })).toEqual([
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C002'
    ])
    // The superseded path is no longer a live handle.
    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'slack',
      mountPaths: ['/slack/channels/C001']
    })).toEqual([])
  })

  it('stops a deselected writeback resource during mount reconciliation', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'linear',
        mountPaths: ['/discovery/linear', '/linear/issues']
      }
    ])
    expect(mock.mountInputs.map((input) => input.remotePath)).toEqual(['/discovery/linear', '/linear/issues'])

    await manager.ensureMounted([
      {
        provider: 'linear',
        mountPaths: ['/discovery/linear']
      }
    ])

    expect(mock.stoppedRemotePaths).toContain('/linear/issues')
    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'linear',
      mountPaths: ['/linear/issues']
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
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/messages/.relayfile-mount-state.json',
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

  it('falls back to the legacy state file path for state-poll auth recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const manager = new IntegrationMountManager()
    mock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/.relayfile-mount-state.json')) throw new Error('ENOENT')
      if (path.endsWith('/.relay/state.json')) {
        return JSON.stringify({
          status: 'writeback-pending',
          pendingWriteback: 1,
          lastSuccessfulReconcileAt: '2026-06-06T13:59:00.000Z',
          lastError: {
            code: 'unauthorized',
            statusCode: 401,
            message: 'http 401 unauthorized: Token has expired',
            at: '2026-06-06T14:00:30.000Z'
          }
        })
      }
      return ''
    })

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
    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(2)
  })

  it('does not fall back to stale legacy state when the primary state file is mid-write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const manager = new IntegrationMountManager()
    mock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/.relayfile-mount-state.json')) return '{'
      if (path.endsWith('/.relay/state.json')) {
        return JSON.stringify({
          status: 'writeback-pending',
          pendingWriteback: 1,
          lastSuccessfulReconcileAt: '2026-06-06T13:59:00.000Z',
          lastError: {
            code: 'unauthorized',
            statusCode: 401,
            message: 'http 401 unauthorized: Token has expired',
            at: '2026-06-06T14:00:30.000Z'
          }
        })
      }
      return ''
    })

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.readFile).not.toHaveBeenCalledWith(
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/messages/.relay/state.json',
      'utf8'
    )
    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(1)
  })

  it('restarts and clears stale state after repeated sync deadline failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const manager = new IntegrationMountManager()
    mock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/.relay/mount.log')) {
        return [
          '2026/06/06 13:59:00 mount sync cycle completed',
          '2026/06/06 14:00:00 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:00:45 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:01:30 mount sync cycle failed: context deadline exceeded'
        ].join('\n')
      }
      return JSON.stringify({
        files: {},
        eventsCursor: 'evt_1'
      })
    })

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/threads']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.rm).toHaveBeenCalledWith(
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/threads/.relayfile-mount-state.json',
      { force: true }
    )
    expect(mock.rm).toHaveBeenCalledWith(
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/threads/.relay/state.json',
      { force: true }
    )
    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/threads')).toHaveLength(2)
  })

  it('still checks sync wedge logs after a replayed auth state error', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const manager = new IntegrationMountManager()
    mock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/.relay/mount.log')) {
        return [
          '2026/06/06 14:00:00 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:00:45 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:01:30 mount sync cycle failed: context deadline exceeded'
        ].join('\n')
      }
      return JSON.stringify({
        status: 'writeback-pending',
        pendingWriteback: 1,
        lastSuccessfulReconcileAt: '2026-06-06T13:59:00.000Z',
        lastError: {
          code: 'unauthorized',
          statusCode: 401,
          message: 'http 401 unauthorized: Token has expired',
          at: '2026-06-06T14:00:30.000Z'
        }
      })
    })

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/threads']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/threads')).toHaveLength(3)
  })

  it('does not restart when sync deadline failures are followed by a completed cycle', async () => {
    vi.useFakeTimers()
    const manager = new IntegrationMountManager()
    mock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/.relay/mount.log')) {
        return [
          '2026/06/06 14:00:00 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:00:45 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:01:30 mount sync cycle completed'
        ].join('\n')
      }
      return JSON.stringify({
        files: {},
        eventsCursor: 'evt_1'
      })
    })

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/threads']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/threads')).toHaveLength(1)
  })

  it('does not restart when the latest sync failure is not a wedge failure', async () => {
    vi.useFakeTimers()
    const manager = new IntegrationMountManager()
    mock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/.relay/mount.log')) {
        return [
          '2026/06/06 14:00:00 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:00:45 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:01:30 mount sync cycle failed: http 401 unauthorized: Token has expired'
        ].join('\n')
      }
      return JSON.stringify({
        files: {},
        eventsCursor: 'evt_1'
      })
    })

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/threads']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/threads')).toHaveLength(1)
  })

  it('does not restart when a newer non-wedge failure interrupts sync deadline failures', async () => {
    vi.useFakeTimers()
    const manager = new IntegrationMountManager()
    mock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/.relay/mount.log')) {
        return [
          '2026/06/06 14:00:00 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:00:45 mount sync cycle failed: context deadline exceeded',
          '2026/06/06 14:01:30 mount sync cycle failed: http 401 unauthorized: Token has expired',
          '2026/06/06 14:02:15 mount sync cycle failed: context deadline exceeded'
        ].join('\n')
      }
      return JSON.stringify({
        files: {},
        eventsCursor: 'evt_1'
      })
    })

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/threads']
      }
    ])

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/threads')).toHaveLength(1)
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

  it('liveness watchdog restarts a present handle whose reconcile loop has frozen at status:ready', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:10:00.000Z'))
    const manager = new IntegrationMountManager()
    const healthObserver = vi.fn()
    manager.setHealthObserver(healthObserver)
    // status:ready, no lastError, but lastSuccessfulReconcileAt is 10min stale —
    // the auth/sync-wedge/stalled-revision checks all stay silent; only the
    // liveness watchdog can catch this.
    mock.readFile.mockResolvedValue(JSON.stringify({
      status: 'ready',
      stale: false,
      pendingWriteback: 0,
      files: {},
      lastSuccessfulReconcileAt: '2026-06-06T14:00:00.000Z'
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

    expect(healthObserver).toHaveBeenCalledWith({
      type: 'reconcile-stalled',
      remotePath: '/slack/channels/C123/messages',
      status: 'ready',
      lastSuccessfulReconcileAt: '2026-06-06T14:00:00.000Z'
    })
    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(2)
  })

  it('liveness watchdog does not restart a present handle that reconciled recently', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:10:00.000Z'))
    const manager = new IntegrationMountManager()
    const healthObserver = vi.fn()
    manager.setHealthObserver(healthObserver)
    // Reconciled 30s ago — well within the stale window.
    mock.readFile.mockResolvedValue(JSON.stringify({
      status: 'ready',
      files: {},
      lastSuccessfulReconcileAt: '2026-06-06T14:09:30.000Z'
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

    expect(healthObserver).not.toHaveBeenCalled()
    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(1)
  })

  it('supervisor rebuilds a desired mount that has no live handle and re-runs after auth recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    // Simulate the mass-stopAll outage: the first mount fails because auth is
    // momentarily unavailable, so no handle is ever created.
    mock.currentAuth = null
    const manager = new IntegrationMountManager()

    await expect(manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])).rejects.toThrow('cloud-auth-required')

    expect(mock.mountInputs).toHaveLength(0)

    // Auth recovers. The supervisor — armed even though handles=0 — rebuilds the
    // desired mount on its next tick without any further ensureMounted call.
    mock.currentAuth = {
      apiUrl: 'https://cloud.example',
      accessToken: 'account-token'
    }

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(1)
    expect(manager.localPathsFor('account-workspace-id', {
      provider: 'slack',
      mountPaths: ['/slack/channels/C123/messages']
    })).toEqual([
      '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/slack/channels/C123/messages'
    ])
  })

  it('supervisor does not remount when every desired path already has a live handle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const manager = new IntegrationMountManager()
    // Fresh mount, no lastSuccessfulReconcileAt yet — must not be treated as stale.
    mock.readFile.mockResolvedValue('{}')

    await manager.ensureMounted([
      {
        provider: 'slack',
        mountPaths: ['/slack/channels/C123/messages']
      }
    ])

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.mountInputs.filter((input) => input.remotePath === '/slack/channels/C123/messages')).toHaveLength(1)
  })
})

describe('readStalledInjectedRevisions', () => {
  const NOW = '2026-06-08T13:00:00.000Z'
  const REMOTE_PATH = '/slack/channels/C123__slug/threads'
  const REPLY_PATH = '/slack/channels/C123__slug/threads/1780871788_370329/replies/1780921813_531539.json'

  const injectingLine = (path: string, timestamp: string): string => JSON.stringify({
    timestamp,
    message: 'injecting',
    metadata: { projectId: 'p', eventId: 'ws:file.created:rev_1', path, recipients: ['slack-comms'] }
  })

  const stateWith = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'ready',
    lastSuccessfulReconcileAt: '2026-06-08T12:55:00.000Z',
    files: {},
    ...overrides
  })

  beforeEach(() => {
    mock.readFile.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flags an injected revision that aged past the grace window and never landed in state.files', async () => {
    mock.readFile.mockResolvedValueOnce(injectingLine(REPLY_PATH, '2026-06-08T12:40:00.000Z'))

    const result = await readStalledInjectedRevisions(REMOTE_PATH, stateWith())

    expect(result).toEqual({
      missingCount: 1,
      oldestInjectedAt: '2026-06-08T12:40:00.000Z',
      examples: [REPLY_PATH]
    })
  })

  it('does not flag a revision still within the grace window', async () => {
    mock.readFile.mockResolvedValueOnce(injectingLine(REPLY_PATH, '2026-06-08T12:55:30.000Z'))

    expect(await readStalledInjectedRevisions(REMOTE_PATH, stateWith())).toBeNull()
  })

  it('does not flag a revision the mount has already tracked in state.files', async () => {
    mock.readFile.mockResolvedValueOnce(injectingLine(REPLY_PATH, '2026-06-08T12:40:00.000Z'))

    const result = await readStalledInjectedRevisions(
      REMOTE_PATH,
      stateWith({ files: { [REPLY_PATH]: { revision: 'rev_1', status: 'ready' } } })
    )

    expect(result).toBeNull()
  })

  it('does not restart a mount that has not reconciled since the revision arrived', async () => {
    mock.readFile.mockResolvedValueOnce(injectingLine(REPLY_PATH, '2026-06-08T12:40:00.000Z'))

    // lastSuccessfulReconcileAt predates the injected revision → no chance to pull it yet.
    expect(await readStalledInjectedRevisions(
      REMOTE_PATH,
      stateWith({ lastSuccessfulReconcileAt: '2026-06-08T12:30:00.000Z' })
    )).toBeNull()
  })

  it('does not restart a mount that has never reconciled (omitted lastSuccessfulReconcileAt)', async () => {
    mock.readFile.mockResolvedValueOnce(injectingLine(REPLY_PATH, '2026-06-08T12:40:00.000Z'))

    const state = stateWith()
    delete state.lastSuccessfulReconcileAt
    expect(await readStalledInjectedRevisions(REMOTE_PATH, state)).toBeNull()
  })

  it('ignores injected revisions for a different mount root', async () => {
    mock.readFile.mockResolvedValueOnce(
      injectingLine('/slack/channels/C999__other/threads/1/replies/2.json', '2026-06-08T12:40:00.000Z')
    )

    expect(await readStalledInjectedRevisions(REMOTE_PATH, stateWith())).toBeNull()
  })

  it('returns null when the events log is unreadable', async () => {
    mock.readFile.mockRejectedValueOnce(new Error('ENOENT'))

    expect(await readStalledInjectedRevisions(REMOTE_PATH, stateWith())).toBeNull()
  })
})
