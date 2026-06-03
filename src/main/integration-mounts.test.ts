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
    getRelayWorkspaceManager: vi.fn(() => ({
      getWorkspaceId: vi.fn(async () => 'relay-workspace-id')
    }))
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
  resolveCloudAuth: mock.resolveCloudAuth
}))

vi.mock('./relay-workspace', () => ({
  getRelayWorkspaceManager: mock.getRelayWorkspaceManager
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
    mock.getRelayWorkspaceManager.mockClear()
  })

  it('mounts integrations with separate relayfile read and write scopes', async () => {
    const manager = new IntegrationMountManager()

    await manager.ensureMounted([
      {
        provider: 'github',
        mountPaths: ['/integrations/github/repos']
      }
    ])

    expect(mock.mountInputs).toHaveLength(1)
    expect(mock.mountInputs[0]).toMatchObject({
      workspaceId: 'relay-workspace-id',
      localDir: '/tmp/pear-home/.agentworkforce/pear/relayfile/workspaces/relay-workspace-id/integrations',
      remotePath: '/integrations',
      agentName: 'pear-integrations',
      scopes: ['relayfile:fs:read:/integrations/**', 'relayfile:fs:write:/integrations/**']
    })
  })
})
