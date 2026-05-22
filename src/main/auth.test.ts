import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StoredTokens = {
  accessToken: string
  refreshToken: string
  apiUrl: string
  expiresAt?: string
  user?: Record<string, unknown>
}

const mock = vi.hoisted(() => {
  let userDataDir: string | null = null

  return {
    setUserDataDir(dir: string) {
      userDataDir = dir
    },
    clearUserDataDir() {
      userDataDir = null
    },
    app: {
      getPath: vi.fn((name: string) => {
        if (name !== 'userData') throw new Error(`unexpected getPath: ${name}`)
        if (!userDataDir) throw new Error('userDataDir not set in test')
        return userDataDir
      })
    },
    safeStorage: {
      // The real safeStorage uses OS-level encryption; for tests we just
      // round-trip through JSON-as-buffer so loadTokens can decode what
      // saveTokens wrote, without actually pulling in keychain APIs.
      encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
      decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf8'))
    },
    readStoredAuth: vi.fn(async () => null),
    fetchMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: mock.app,
  shell: { openExternal: vi.fn() },
  safeStorage: mock.safeStorage
}))

vi.mock('@agent-relay/cloud', () => ({
  readStoredAuth: mock.readStoredAuth
}))

vi.mock('./avatar-cache', () => ({
  cacheAvatarFromUrl: vi.fn(async () => undefined),
  cachedAvatarUrl: vi.fn(() => undefined),
  isRemoteAvatarUrl: vi.fn(() => false)
}))

function writeAuthJson(userDataDir: string, tokens: StoredTokens): void {
  const configDir = join(userDataDir, 'config')
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  // Mirror what saveTokens does: JSON → safeStorage.encryptString.
  // Our mocked safeStorage just utf8-encodes, so we write the raw JSON bytes.
  writeFileSync(join(configDir, 'auth.json'), Buffer.from(JSON.stringify(tokens), 'utf8'))
}

function readMeta(userDataDir: string): Record<string, unknown> | null {
  const path = join(userDataDir, 'config', 'auth-meta.json')
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

function tokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex')
}

describe('getAccountWorkspaceId', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pear-auth-test-'))
    mock.setUserDataDir(userDataDir)
    mock.readStoredAuth.mockReset()
    mock.readStoredAuth.mockResolvedValue(null)
    mock.fetchMock.mockReset()
    vi.stubGlobal('fetch', mock.fetchMock)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mock.clearUserDataDir()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('throws cloud-auth-required when no tokens are stored and SDK auth is missing', async () => {
    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId()).rejects.toThrowError('cloud-auth-required')
    expect(mock.fetchMock).not.toHaveBeenCalled()
  })

  it('returns the workspace id from currentWorkspace.id and persists the cache', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_abc',
      refreshToken: 'cld_rt_abc',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ currentWorkspace: { id: 'ws-from-current' } })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    const id = await getAccountWorkspaceId()

    expect(id).toBe('ws-from-current')
    expect(mock.fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl] = mock.fetchMock.mock.calls[0]
    expect(String(calledUrl)).toBe('https://cloud.example/api/v1/auth/whoami')

    const meta = readMeta(userDataDir)
    expect(meta?.accountWorkspace).toEqual({
      tokenHash: tokenHash('cld_at_abc'),
      workspaceId: 'ws-from-current'
    })
  })

  it('prefers currentWorkspace.id over a top-level workspaceId when both are present', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_both',
      refreshToken: 'cld_rt_both',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        workspaceId: 'ws-legacy-alias',
        currentWorkspace: { id: 'ws-active' }
      })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId()).resolves.toBe('ws-active')
  })

  it('falls back to top-level workspaceId and workspace.id when currentWorkspace is absent', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_top',
      refreshToken: 'cld_rt_top',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ workspaceId: 'ws-from-top' })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId()).resolves.toBe('ws-from-top')
  })

  it('uses the cached workspace id and skips whoami when the token hash still matches', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_cached',
      refreshToken: 'cld_rt_cached',
      apiUrl: 'https://cloud.example'
    })
    const configDir = join(userDataDir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'auth-meta.json'),
      JSON.stringify({
        apiUrl: 'https://cloud.example',
        accountWorkspace: {
          tokenHash: tokenHash('cld_at_cached'),
          workspaceId: 'ws-cached'
        }
      })
    )

    const { getAccountWorkspaceId } = await import('./auth')
    const id = await getAccountWorkspaceId()

    expect(id).toBe('ws-cached')
    expect(mock.fetchMock).not.toHaveBeenCalled()
  })

  it('refetches when the cached token hash no longer matches the current token', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_new',
      refreshToken: 'cld_rt_new',
      apiUrl: 'https://cloud.example'
    })
    const configDir = join(userDataDir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'auth-meta.json'),
      JSON.stringify({
        apiUrl: 'https://cloud.example',
        accountWorkspace: {
          tokenHash: tokenHash('cld_at_old'),
          workspaceId: 'ws-stale'
        }
      })
    )
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ currentWorkspace: { id: 'ws-fresh' } })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    const id = await getAccountWorkspaceId()

    expect(id).toBe('ws-fresh')
    expect(mock.fetchMock).toHaveBeenCalledTimes(1)

    const meta = readMeta(userDataDir)
    expect(meta?.accountWorkspace).toEqual({
      tokenHash: tokenHash('cld_at_new'),
      workspaceId: 'ws-fresh'
    })
  })

  it('throws account-workspace-required when whoami payload has no usable workspace id', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_bad',
      refreshToken: 'cld_rt_bad',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ user: { id: 'user-1' } })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId()).rejects.toThrowError('account-workspace-required')
    expect(readMeta(userDataDir)?.accountWorkspace).toBeUndefined()
  })

  it('throws account-workspace-required when whoami responds with a non-OK status', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_401',
      refreshToken: 'cld_rt_401',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Unauthorized' })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId()).rejects.toThrowError('account-workspace-required')
  })
})
