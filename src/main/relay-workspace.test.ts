import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockCloudAuth = {
  apiUrl: string
  accessToken: string
  accountKey: string
}

type MockWorkspaceHandle = {
  workspaceId: string
  refreshToken: ReturnType<typeof vi.fn>
  requestJson: ReturnType<typeof vi.fn>
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

const mock = vi.hoisted(() => {
  type HoistedCloudAuth = {
    apiUrl: string
    accessToken: string
    accountKey: string
  }

  type HoistedWorkspaceHandle = {
    workspaceId: string
    refreshToken: ReturnType<typeof vi.fn>
    requestJson: ReturnType<typeof vi.fn>
  }

  type HoistedDeferred<T> = {
    promise: Promise<T>
    resolve(value: T): void
    reject(error: unknown): void
  }

  function createDeferred<T>(): HoistedDeferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  const createResults = new Map<string, HoistedDeferred<HoistedWorkspaceHandle>>()
  const joinResults = new Map<string, HoistedDeferred<HoistedWorkspaceHandle>>()
  const createCalls: Array<{ apiUrl: string }> = []
  const joinCalls: Array<{ apiUrl: string; workspaceId: string }> = []
  const store: { relayWorkspace?: unknown } = {}
  const savedStores: unknown[] = []
  let currentAuth: HoistedCloudAuth | null = null

  class RelayfileSetup {
    private readonly cloudApiUrl: string

    constructor(options: { cloudApiUrl: string }) {
      this.cloudApiUrl = options.cloudApiUrl
    }

    createWorkspace(): Promise<HoistedWorkspaceHandle> {
      createCalls.push({ apiUrl: this.cloudApiUrl })
      const result = createResults.get(this.cloudApiUrl)
      if (!result) throw new Error(`unexpected createWorkspace for ${this.cloudApiUrl}`)
      return result.promise
    }

    joinWorkspace(workspaceId: string): Promise<HoistedWorkspaceHandle> {
      joinCalls.push({ apiUrl: this.cloudApiUrl, workspaceId })
      const result = joinResults.get(`${this.cloudApiUrl}:${workspaceId}`)
      if (!result) throw new Error(`unexpected joinWorkspace for ${this.cloudApiUrl}:${workspaceId}`)
      return result.promise
    }
  }

  return {
    RelayfileSetup,
    createDeferred,
    createResults,
    joinResults,
    createCalls,
    joinCalls,
    store,
    savedStores,
    get currentAuth() {
      return currentAuth
    },
    set currentAuth(value: HoistedCloudAuth | null) {
      currentAuth = value
    },
    resolveCloudAuth: vi.fn(async () => currentAuth),
    loadStore: vi.fn(() => ({ ...store })),
    saveStore: vi.fn((nextStore: { relayWorkspace?: unknown }) => {
      delete store.relayWorkspace
      if (nextStore.relayWorkspace) store.relayWorkspace = nextStore.relayWorkspace
      savedStores.push({ ...nextStore })
    })
  }
})

vi.mock('@relayfile/sdk', () => ({
  RelayfileSetup: mock.RelayfileSetup
}))

vi.mock('./auth', () => ({
  resolveCloudAuth: mock.resolveCloudAuth
}))

vi.mock('./store', () => ({
  loadStore: mock.loadStore,
  saveStore: mock.saveStore
}))

import { RelayWorkspaceManager } from './relay-workspace'

const authA: MockCloudAuth = {
  apiUrl: 'https://cloud-a.example',
  accessToken: 'token-a',
  accountKey: 'account-a'
}

const authB: MockCloudAuth = {
  apiUrl: 'https://cloud-b.example',
  accessToken: 'token-b',
  accountKey: 'account-b'
}

function createDeferred<T>(): Deferred<T> {
  return mock.createDeferred<T>()
}

function createHandle(workspaceId: string): MockWorkspaceHandle {
  return {
    workspaceId,
    refreshToken: vi.fn(async () => undefined),
    requestJson: vi.fn()
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('RelayWorkspaceManager', () => {
  beforeEach(() => {
    mock.createResults.clear()
    mock.joinResults.clear()
    mock.createCalls.splice(0)
    mock.joinCalls.splice(0)
    mock.savedStores.splice(0)
    delete mock.store.relayWorkspace
    mock.currentAuth = null
    mock.resolveCloudAuth.mockClear()
    mock.loadStore.mockClear()
    mock.saveStore.mockClear()
  })

  it('discards a stale bootstrap when auth changes before the old workspace resolves', async () => {
    const manager = new RelayWorkspaceManager()
    const createA = createDeferred<MockWorkspaceHandle>()
    const createB = createDeferred<MockWorkspaceHandle>()
    const handleA = createHandle('ws-a')
    const handleB = createHandle('ws-b')
    mock.createResults.set(authA.apiUrl, createA)
    mock.createResults.set(authB.apiUrl, createB)

    mock.currentAuth = authA
    const firstHandle = manager.getWorkspaceHandle()
    await flushMicrotasks()
    expect(mock.createCalls).toEqual([{ apiUrl: authA.apiUrl }])

    mock.currentAuth = authB
    const secondHandle = manager.getWorkspaceHandle()
    await flushMicrotasks()
    expect(mock.createCalls).toEqual([{ apiUrl: authA.apiUrl }, { apiUrl: authB.apiUrl }])

    createB.resolve(handleB)
    await expect(secondHandle).resolves.toBe(handleB)
    expect(manager.getPersisted()?.id).toBe('ws-b')

    createA.resolve(handleA)
    await expect(firstHandle).resolves.toBe(handleB)
    await expect(manager.getWorkspaceId()).resolves.toBe('ws-b')
    expect(manager.getPersisted()?.id).toBe('ws-b')
    expect(mock.saveStore).toHaveBeenCalledTimes(1)
  })

  it('settles a stale bootstrap caller through the current pending account workspace', async () => {
    const manager = new RelayWorkspaceManager()
    const createA = createDeferred<MockWorkspaceHandle>()
    const createB = createDeferred<MockWorkspaceHandle>()
    const handleA = createHandle('ws-a')
    const handleB = createHandle('ws-b')
    mock.createResults.set(authA.apiUrl, createA)
    mock.createResults.set(authB.apiUrl, createB)

    mock.currentAuth = authA
    const firstHandle = manager.getWorkspaceHandle()
    await flushMicrotasks()
    expect(mock.createCalls).toEqual([{ apiUrl: authA.apiUrl }])

    mock.currentAuth = authB
    const secondHandle = manager.getWorkspaceHandle()
    await flushMicrotasks()
    expect(mock.createCalls).toEqual([{ apiUrl: authA.apiUrl }, { apiUrl: authB.apiUrl }])

    createA.resolve(handleA)
    await flushMicrotasks()

    createB.resolve(handleB)
    await expect(firstHandle).resolves.toBe(handleB)
    await expect(secondHandle).resolves.toBe(handleB)
    expect(manager.getPersisted()?.id).toBe('ws-b')
    expect(mock.saveStore).toHaveBeenCalledTimes(1)
  })
})
