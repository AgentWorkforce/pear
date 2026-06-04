import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  }

  const mountInputs: MountInput[] = []
  let currentAuth: MockCloudAuth | null = null

  class RelayfileSetup {
    readonly cloudApiUrl: string

    constructor(options: { cloudApiUrl: string }) {
      this.cloudApiUrl = options.cloudApiUrl
    }

    mountWorkspace(input: MountInput) {
      mountInputs.push({
        ...input,
        scopes: input.scopes ? [...input.scopes] : undefined
      })
      return Promise.resolve({
        stop: vi.fn(async () => undefined),
        status: vi.fn(async () => ({ ready: true }))
      })
    }
  }

  return {
    mountInputs,
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    RelayfileSetup,
    get currentAuth() {
      return currentAuth
    },
    set currentAuth(value: MockCloudAuth | null) {
      currentAuth = value
    },
    resolveCloudAuth: vi.fn(async () => currentAuth),
    getAccountWorkspaceId: vi.fn(async () => 'account-workspace-id'),
    accountWorkspaceReadyRetryOptions: vi.fn(() => ({ retryAttempts: 1, retryDelayMs: 0 }))
  }
})

vi.mock('node:fs/promises', () => ({
  chmod: mock.chmod,
  mkdir: mock.mkdir
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
  createPearMountLauncher: vi.fn(() => ({ start: vi.fn() }))
}))

import { IntegrationMountManager } from './integration-mounts'

describe('IntegrationMountManager', () => {
  beforeEach(() => {
    mock.mountInputs.splice(0)
    mock.mkdir.mockClear()
    mock.chmod.mockClear()
    mock.currentAuth = {
      apiUrl: 'https://cloud.example',
      accessToken: 'account-token'
    }
    mock.resolveCloudAuth.mockClear()
    mock.getAccountWorkspaceId.mockClear()
  })

  it('mounts each provider root with provider-scoped relayfile scopes', async () => {
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
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/integrations/github',
      remotePath: '/github',
      agentName: 'pear-integrations-github',
      scopes: ['relayfile:fs:read:/github/**', 'relayfile:fs:write:/github/**']
    })
    expect(mock.mountInputs[1]).toMatchObject({
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/account-workspace-id/integrations/linear',
      remotePath: '/linear',
      agentName: 'pear-integrations-linear',
      scopes: ['relayfile:fs:read:/linear/**', 'relayfile:fs:write:/linear/**']
    })
  })
})
