import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

type MockCloudAuth = {
  apiUrl: string
  accessToken: string
}

const mock = vi.hoisted(() => {
  type MountInput = {
    workspaceId: string
    localDir: string
    remotePath: string
    localLayout?: string
    syncMode?: string
    scopes?: string[]
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
      detachCloudSandbox: vi.fn(async () => undefined),
      workspaceKeyForProject: vi.fn(async (): Promise<string | undefined> => undefined)
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
      if (normalizedUrl.endsWith('/api/v1/agents/deploy') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            agentId: 'created-agent-1',
            name: typeof body.name === 'string' ? body.name : 'created-agent-1'
          })
        }
      }
      if (normalizedUrl.endsWith('/api/v1/cloud-agents')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ agents: [] })
        }
      }
      if (normalizedUrl.endsWith('/api/v1/cloud-agents/created-agent-1') && init?.method === 'DELETE') {
        return {
          ok: true,
          status: 204,
          statusText: 'No Content',
          json: async () => ({})
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
  getAccountWorkspaceId: mock.getAccountWorkspaceId,
  accountWorkspaceReadyRetryOptions: vi.fn(() => ({ retryAttempts: 2, retryDelayMs: 0 }))
}))

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: vi.fn()
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

vi.mock('./relayfile-mount-launcher', () => ({
  createPearMountLauncher: vi.fn(() => ({ start: vi.fn() }))
}))

import { CloudAgentManager } from './cloud-agent'

describe('CloudAgentManager', () => {
  const tempDirs: string[] = []

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
    mock.brokerManager.workspaceKeyForProject.mockClear()
    mock.brokerManager.workspaceKeyForProject.mockResolvedValue(undefined)
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
    mock.project.rootPath = '/tmp/project-1'
    delete (mock.project as { cloudAgentWorkspaceMode?: string }).cloudAgentWorkspaceMode
    return Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))).then(() => undefined)
  })

  async function createCleanGitProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pear-cloud-agent-'))
    tempDirs.push(dir)
    await execFileAsync('git', ['init'], { cwd: dir })
    await execFileAsync('git', ['config', 'user.email', 'pear@example.test'], { cwd: dir })
    await execFileAsync('git', ['config', 'user.name', 'Pear Test'], { cwd: dir })
    await writeFile(join(dir, 'README.md'), 'hello\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: dir })
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/acme/fast-repo.git'], { cwd: dir })
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    await execFileAsync('git', ['branch', '--set-upstream-to', 'origin/main', 'main'], { cwd: dir })
    return dir
  }

  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  function boxRequest(method: string): { url: string; init?: RequestInit } | undefined {
    return mock.fetchCalls.find((call) =>
      call.init?.method === method &&
      call.url.includes('/cloud-agents/cloud-agent-1/box')
    )
  }

  function boxRequestBody(method: string): Record<string, unknown> {
    const request = boxRequest(method)
    if (!request?.init?.body) throw new Error(`missing ${method} box request body`)
    return JSON.parse(String(request.init.body)) as Record<string, unknown>
  }

  function expectBoxPostBody(expected: Record<string, unknown>): void {
    expect(boxRequestBody('POST')).toEqual({
      brokerName: 'cloud-cloud-ag',
      ...expected
    })
  }

  it('keeps a newly created cloud agent visible while the cloud list catches up', async () => {
    const manager = new CloudAgentManager()

    const created = await manager.create({
      name: 'review-agent',
      harness: 'claude',
      model: 'claude-opus-4-7'
    })
    const agents = await manager.list()

    expect(created).toMatchObject({
      id: 'created-agent-1',
      name: 'review-agent'
    })
    expect(agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'created-agent-1', name: 'review-agent' })
    ]))
  })

  it('removes deleted cloud agents from the recently-created cache', async () => {
    const manager = new CloudAgentManager()

    await manager.create({
      name: 'review-agent',
      harness: 'claude',
      model: 'claude-opus-4-7'
    })
    await manager.delete('created-agent-1')

    await expect(manager.list()).resolves.toEqual([])
  })

  it('warms a box using the token account workspace, not the relay workspace', async () => {
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    const boxPost = mock.fetchCalls.find((call) => call.init?.method === 'POST')
    expect(boxPost?.url).toBe(
      'https://cloud.example/api/v1/workspaces/account-workspace-id/cloud-agents/cloud-agent-1/box?async=true'
    )
    expectBoxPostBody({
      relayfileMountPaths: ['/integrations/github', '/workspace']
    })
    expect(boxRequestBody('POST')).not.toHaveProperty('workspaceKey')
    expect(boxPost?.url).not.toContain('relay-workspace-id')
    expect(mock.fetchCalls.filter((call) => call.url.endsWith('/api/v1/auth/whoami'))).toHaveLength(1)
    expect(mock.mountInputs[0]?.workspaceId).toBe('relay-workspace-id')
  })

  it('passes the local relay workspace key and stable cloud broker name when warming a box', async () => {
    mock.brokerManager.workspaceKeyForProject.mockResolvedValueOnce('rk_live_project')
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    expect(mock.brokerManager.workspaceKeyForProject).toHaveBeenCalledWith('project-1')
    expectBoxPostBody({
      relayfileMountPaths: ['/integrations/github', '/workspace'],
      workspaceKey: 'rk_live_project'
    })
    expect(mock.brokerManager.attachCloudSandbox).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        sandboxId: 'sandbox-1',
        sentWorkspaceKey: 'rk_live_project'
      }),
      undefined
    )
  })

  it('does not pass a sent workspace key for keyless warms', async () => {
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    expect(mock.brokerManager.attachCloudSandbox).toHaveBeenCalledWith(
      'project-1',
      expect.not.objectContaining({
        sentWorkspaceKey: expect.anything()
      }),
      undefined
    )
  })

  it('clears the sent workspace key when a cloud agent detaches', async () => {
    mock.brokerManager.workspaceKeyForProject.mockResolvedValueOnce('rk_live_project')
    const manager = new CloudAgentManager()
    await manager.attach('project-1', 'cloud-agent-1')
    await manager.detach('project-1')
    mock.brokerManager.attachCloudSandbox.mockClear()

    await (manager as unknown as {
      connectBroker: (projectId: string, sandbox: {
        sandboxId: string
        execUrl: string
        filesUrl: string
        relayfileToken: string
        relayfileMountPath: string
        status: 'ready'
      }) => Promise<void>
    }).connectBroker('project-1', {
      sandboxId: 'sandbox-2',
      execUrl: 'https://sandbox-2.example',
      filesUrl: 'https://sandbox-2.example/files',
      relayfileToken: 'relayfile-token-2',
      relayfileMountPath: '/remote/project-1',
      status: 'ready'
    })

    expect(mock.brokerManager.attachCloudSandbox).toHaveBeenCalledWith(
      'project-1',
      expect.not.objectContaining({
        sentWorkspaceKey: expect.anything()
      }),
      undefined
    )
  })

  it('reuses a warm-on-intent box when attach is clicked', async () => {
    const manager = new CloudAgentManager()

    await manager.prewarm('project-1', 'cloud-agent-1')
    await manager.attach('project-1', 'cloud-agent-1')

    const boxCalls = mock.fetchCalls.filter((call) => call.url.includes('/cloud-agents/cloud-agent-1/box'))
    expect(boxCalls.map((call) => call.init?.method)).toEqual(['POST'])
  })

  it('cancels and reaps a speculative warm when the picker closes', async () => {
    const manager = new CloudAgentManager()

    await manager.prewarm('project-1', 'cloud-agent-1')
    await flushMicrotasks()
    await manager.cancelPrewarm('project-1', 'cloud-agent-1')

    const boxCalls = mock.fetchCalls.filter((call) => call.url.includes('/cloud-agents/cloud-agent-1/box'))
    expect(boxCalls.map((call) => call.init?.method)).toEqual(['POST', 'DELETE'])
  })

  it('cancels speculative warms during shutdown', async () => {
    const manager = new CloudAgentManager()

    await manager.prewarm('project-1', 'cloud-agent-1')
    await flushMicrotasks()
    await manager.shutdownAll()

    const boxCalls = mock.fetchCalls.filter((call) => call.url.includes('/cloud-agents/cloud-agent-1/box'))
    expect(boxCalls.map((call) => call.init?.method)).toEqual(['POST', 'DELETE'])
  })

  it('forwards granular phase and eta from box warm responses', async () => {
    mock.boxResponses.push({
      sandboxId: 'sandbox-1',
      execUrl: 'https://sandbox.example',
      relayfileToken: 'relayfile-token',
      relayfileMountPath: '/remote/project-1',
      status: 'ready',
      phase: 'ready',
      etaMs: 0
    })
    const manager = new CloudAgentManager()
    const events: Array<{ type: string; phase?: string; etaMs?: number }> = []
    manager.onEvent((event) => events.push(event))

    await manager.attach('project-1', 'cloud-agent-1')

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'sandbox-status',
        phase: 'ready',
        etaMs: 0
      })
    ]))
  })

  it('prefers git-overlay for clean upstream git projects and starts the local relayfile mount', async () => {
    mock.project.rootPath = await createCleanGitProject()
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    expectBoxPostBody({
      relayfileMountPaths: ['/integrations/github', '/workspace'],
      workspaceSource: expect.objectContaining({
        kind: 'git-overlay',
        remoteUrl: 'https://github.com/acme/fast-repo.git',
        ref: 'main',
        shallow: true,
        targetDir: '/workspace'
      })
    })
    expect(mock.mountInputs[0]).toMatchObject({
      workspaceId: 'relay-workspace-id',
      localDir: mock.project.rootPath,
      remotePath: '/remote/project-1',
      localLayout: 'exact',
      syncMode: 'mirror',
      scopes: ['relayfile:fs:read:/**', 'relayfile:fs:write:/**']
    })
  })

  it('mounts non-root sandbox relayfile paths at the project root without local double-pathing', async () => {
    mock.boxResponses.push({
      sandboxId: 'sandbox-1',
      execUrl: 'https://sandbox.example',
      relayfileToken: 'relayfile-token',
      relayfileMountPath: '/workspace/project-1',
      status: 'ready'
    })
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    expect(mock.mountInputs[0]).toMatchObject({
      localDir: '/tmp/project-1',
      remotePath: '/workspace/project-1',
      localLayout: 'exact',
      syncMode: 'mirror'
    })
    expect(mock.mountInputs[0]?.localDir).not.toContain('/workspace/project-1')
  })

  it('keeps git-overlay clone source for dirty ssh-remote projects', async () => {
    mock.project.rootPath = await createCleanGitProject()
    await execFileAsync('git', ['remote', 'set-url', 'origin', 'git@github.com:acme/fast-repo.git'], {
      cwd: mock.project.rootPath
    })
    await writeFile(join(mock.project.rootPath, 'local-only.txt'), 'local\n')
    await execFileAsync('git', ['add', 'local-only.txt'], { cwd: mock.project.rootPath })
    await execFileAsync('git', ['commit', '-m', 'local only'], { cwd: mock.project.rootPath })
    await writeFile(join(mock.project.rootPath, 'dirty.txt'), 'dirty\n')
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    expectBoxPostBody({
      relayfileMountPaths: ['/integrations/github', '/workspace'],
      workspaceSource: {
        kind: 'git-overlay',
        remoteUrl: 'https://github.com/acme/fast-repo.git',
        ref: 'main',
        shallow: true,
        targetDir: '/workspace'
      }
    })
  })

  it('can opt a clean upstream git project back into pure git clone mode', async () => {
    mock.project.rootPath = await createCleanGitProject()
    const project = mock.project as { cloudAgentWorkspaceMode?: string }
    project.cloudAgentWorkspaceMode = 'git'
    const manager = new CloudAgentManager()

    await manager.attach('project-1', 'cloud-agent-1')

    expectBoxPostBody({
      relayfileMountPaths: ['/integrations/github'],
      workspaceSource: expect.objectContaining({
        kind: 'git',
        remoteUrl: 'https://github.com/acme/fast-repo.git',
        ref: 'main',
        shallow: true,
        targetDir: '/workspace'
      })
    })
    expect(mock.mountInputs).toHaveLength(0)
  })

  it('does not run pull-after-run for git-overlay live sync projects', async () => {
    vi.useFakeTimers()
    const project = mock.project as typeof mock.project & { cloudAgent: Record<string, unknown> }
    project.cloudAgent = {
      id: 'cloud-agent-1',
      sandboxId: 'sandbox-1',
      relayfileMountPath: '/workspace',
      attachedAt: new Date().toISOString(),
      autoPullAfterRun: true,
      workspaceSource: {
        kind: 'git-overlay',
        remoteUrl: 'https://github.com/acme/fast-repo.git',
        targetDir: '/workspace'
      }
    }
    const manager = new CloudAgentManager()
    const events: Array<{ type: string; message?: string }> = []
    manager.onEvent((event) => events.push(event))

    manager.noteToolCallStart('project-1')
    manager.noteToolCallEnd('project-1')
    await vi.runOnlyPendingTimersAsync()

    expect(events.some((event) =>
      event.type === 'error' && event.message?.includes('git pull failed after cloud agent run')
    )).toBe(false)
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

  it('keeps mount-path PATCH bodies scoped to mount paths only', async () => {
    mock.brokerManager.workspaceKeyForProject.mockResolvedValueOnce('rk_live_project')
    const manager = new CloudAgentManager()
    await manager.attach('project-1', 'cloud-agent-1')
    mock.fetchCalls.length = 0

    await manager.updateMountPaths('project-1', ['/integrations/slack'])

    expect(boxRequestBody('PATCH')).toEqual({
      relayfileMountPaths: ['/integrations/slack', '/workspace']
    })
  })
})
