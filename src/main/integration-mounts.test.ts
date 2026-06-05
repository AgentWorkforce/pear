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
    background: boolean
    agentName: string
    scopes?: string[]
    readyTimeoutMs: number
    launcher?: {
      __options?: {
        onEvent?: (event: { type: string; text?: string }) => void
      }
    }
  }

  const mountInputs: MountInput[] = []
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
        suggestedRefreshAt: mountSuggestedRefreshAt,
        stop: vi.fn(async () => undefined),
        status: vi.fn(async () => ({ ready: true }))
      })
    }
  }

  return {
    mountInputs,
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
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
  createPearMountLauncher: vi.fn((options) => ({ start: vi.fn(), __options: options }))
}))

import { IntegrationMountManager } from './integration-mounts'

describe('IntegrationMountManager', () => {
  beforeEach(() => {
    mock.mountInputs.splice(0)
    mock.mkdir.mockClear()
    mock.chmod.mockClear()
    mock.rm.mockClear()
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
})
