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
  // Default to a future expiresAt so tests that aren't exercising the
  // refresh path don't accidentally trip it (post-PR isTokenExpired
  // treats missing/invalid expiresAt as expired). Tests that DO want
  // to exercise refresh pass an explicit past expiresAt — or omit
  // expiresAt entirely to model legacy stored state.
  // Either an explicit string OR an explicit `undefined` (model legacy
  // stored state) suppresses the default. JSON.stringify drops undefined
  // values, so passing `expiresAt: undefined` ends up persisting auth.json
  // with no expiresAt key — exactly what pre-capture login produced.
  const withExpiry: StoredTokens = 'expiresAt' in tokens
    ? tokens
    : { ...tokens, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
  writeFileSync(join(configDir, 'auth.json'), Buffer.from(JSON.stringify(withExpiry), 'utf8'))
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

function accountKeyForToken(apiUrl: string, accessToken: string, subject: string): string {
  return createHash('sha256')
    .update(`${apiUrl}\0token-subject:${subject}`)
    .digest('hex')
}

function jwtWithSubject(subject: string, nonce: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: subject, nonce })}.sig`
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

  it('uses the production cloud URL by default', async () => {
    const { getApiUrl } = await import('./auth')
    expect(getApiUrl()).toBe('https://agentrelay.com/cloud')
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
    expect(meta?.accountWorkspace).toMatchObject({
      accountKey: expect.any(String),
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
    expect(readMeta(userDataDir)?.accountWorkspace).toMatchObject({
      accountKey: expect.any(String),
      tokenHash: tokenHash('cld_at_cached'),
      workspaceId: 'ws-cached'
    })
  })

  it('uses the cached workspace id across token rotation for the same account subject', async () => {
    const oldToken = jwtWithSubject('user-1', 'old')
    const newToken = jwtWithSubject('user-1', 'new')
    writeAuthJson(userDataDir, {
      accessToken: newToken,
      refreshToken: 'cld_rt_rotated',
      apiUrl: 'https://cloud.example'
    })
    const configDir = join(userDataDir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'auth-meta.json'),
      JSON.stringify({
        apiUrl: 'https://cloud.example',
        accountWorkspace: {
          accountKey: accountKeyForToken('https://cloud.example', oldToken, 'user-1'),
          tokenHash: tokenHash(oldToken),
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
    expect(meta?.accountWorkspace).toMatchObject({
      accountKey: expect.any(String),
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

  it('retries when whoami is temporarily missing currentWorkspace', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_retry',
      refreshToken: 'cld_rt_retry',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ user: { id: 'user-1' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ currentWorkspace: { id: 'ws-after-ready' } })
      })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId({ retryAttempts: 2, retryDelayMs: 0 })).resolves.toBe('ws-after-ready')
    expect(mock.fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries when whoami temporarily times out', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_timeout_retry',
      refreshToken: 'cld_rt_timeout_retry',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ currentWorkspace: { id: 'ws-after-timeout' } })
      })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId({ retryAttempts: 2, retryDelayMs: 0 })).resolves.toBe('ws-after-timeout')
    expect(mock.fetchMock).toHaveBeenCalledTimes(2)
  })

  it('canonicalizes legacy agentrelay.dev auth records to production', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_legacy_dev',
      refreshToken: 'cld_rt_legacy_dev',
      apiUrl: 'https://agentrelay.dev/cloud'
    })
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ currentWorkspace: { id: 'ws-prod' } })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId()).resolves.toBe('ws-prod')
    expect(mock.fetchMock).toHaveBeenCalledWith(
      'https://agentrelay.com/cloud/api/v1/auth/whoami',
      expect.any(Object)
    )
  })

  it('canonicalizes legacy agentrelay.dev metadata used by getApiUrl callers', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_legacy_meta',
      refreshToken: 'cld_rt_legacy_meta',
      apiUrl: 'https://agentrelay.dev/cloud'
    })

    const { getAccessToken, getApiUrl } = await import('./auth')
    await expect(getAccessToken()).resolves.toBe('cld_at_legacy_meta')

    expect(getApiUrl()).toBe('https://agentrelay.com/cloud')
    expect(readMeta(userDataDir)?.apiUrl).toBe('https://agentrelay.com/cloud')
  })

  it('throws cloud-auth-required when whoami rejects the access token', async () => {
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
    await expect(getAccountWorkspaceId()).rejects.toThrowError('cloud-auth-required:whoami-http-401')
  })

  it('throws account-workspace-required with a failure class when whoami returns a server error', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_500',
      refreshToken: 'cld_rt_500',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'No active workspace' })
    })

    const { getAccountWorkspaceId } = await import('./auth')
    await expect(getAccountWorkspaceId({ retryAttempts: 1, retryDelayMs: 0 }))
      .rejects.toThrowError('account-workspace-required:whoami-http-500')
  })
})

describe('getAccessToken (refresh flow)', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pear-auth-refresh-'))
    mock.setUserDataDir(userDataDir)
    mock.fetchMock.mockReset()
    vi.stubGlobal('fetch', mock.fetchMock)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mock.clearUserDataDir()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  function readPersistedTokens(): { accessToken: string; refreshToken: string; expiresAt?: string } | null {
    const path = join(userDataDir, 'config', 'auth.json')
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    if (!raw.trim()) return null
    try {
      return JSON.parse(raw) as { accessToken: string; refreshToken: string; expiresAt?: string }
    } catch {
      return null
    }
  }

  it('returns the stored access token when it is not near expiry', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_fresh',
      refreshToken: 'cld_rt_fresh',
      apiUrl: 'https://cloud.example',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    })

    const { getAccessToken } = await import('./auth')
    await expect(getAccessToken()).resolves.toBe('cld_at_fresh')
    expect(mock.fetchMock).not.toHaveBeenCalled()
  })

  it('treats tokens without expiresAt as expired and refreshes them (legacy state)', async () => {
    // Tokens persisted before `access_token_expires_at` was captured on
    // the login redirect have no expiresAt field. The actual access-token
    // TTL is 1 day from issue, so for any pre-capture user this token is
    // dead. The refresh path should fire and store a fresh pair.
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_legacy',
      refreshToken: 'cld_rt_legacy',
      apiUrl: 'https://cloud.example',
      expiresAt: undefined // explicit legacy-state signal — see writeAuthJson
    })
    const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    mock.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        accessToken: 'cld_at_post_legacy',
        refreshToken: 'cld_rt_post_legacy',
        accessTokenExpiresAt: newExpiresAt
      })
    })

    const { getAccessToken } = await import('./auth')
    await expect(getAccessToken()).resolves.toBe('cld_at_post_legacy')
    expect(mock.fetchMock).toHaveBeenCalledTimes(1)

    const persisted = readPersistedTokens()
    expect(persisted?.refreshToken).toBe('cld_rt_post_legacy')
    expect(persisted?.expiresAt).toBe(newExpiresAt)
  })

  it('refreshes the access token when it is near expiry and persists the rotated pair', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_stale',
      refreshToken: 'cld_rt_v1',
      apiUrl: 'https://cloud.example',
      expiresAt: new Date(Date.now() - 1_000).toISOString() // already expired
    })
    const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    mock.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        accessToken: 'cld_at_new',
        refreshToken: 'cld_rt_v2',
        accessTokenExpiresAt: newExpiresAt,
        apiUrl: 'https://cloud.example/'
      })
    })

    const { getAccessToken } = await import('./auth')
    await expect(getAccessToken()).resolves.toBe('cld_at_new')

    expect(mock.fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = mock.fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(calledUrl)).toBe('https://cloud.example/api/v1/auth/token/refresh')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'cld_rt_v1' })

    const persisted = readPersistedTokens()
    expect(persisted?.accessToken).toBe('cld_at_new')
    expect(persisted?.refreshToken).toBe('cld_rt_v2')
    expect(persisted?.expiresAt).toBe(newExpiresAt)
  })

  it('clears stored tokens on 403 invalid_grant (refresh token dead)', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_stale',
      refreshToken: 'cld_rt_dead',
      apiUrl: 'https://cloud.example',
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    })
    mock.fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'invalid_grant' })
    })

    const { getAccessToken } = await import('./auth')
    // Falls back to the stale token so the in-flight call can complete its
    // 401 path; subsequent loadTokens returns null because clearTokens ran.
    await expect(getAccessToken()).resolves.toBe('cld_at_stale')

    const persisted = readPersistedTokens()
    expect(persisted).toBeNull()
  })

  it('keeps stored tokens on transient 5xx (so the next call can retry)', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_stale',
      refreshToken: 'cld_rt_keep',
      apiUrl: 'https://cloud.example',
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    })
    mock.fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'unavailable' })
    })

    const { getAccessToken } = await import('./auth')
    await expect(getAccessToken()).resolves.toBe('cld_at_stale')

    const persisted = readPersistedTokens()
    expect(persisted?.refreshToken).toBe('cld_rt_keep')
  })

  it('coalesces concurrent refreshes into a single network call', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_stale',
      refreshToken: 'cld_rt_v1',
      apiUrl: 'https://cloud.example',
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    })
    // Promise<unknown> is explicit: the executor never calls resolve() itself
    // (the test does, below), so TS would otherwise infer the resolve param as
    // never. The definite-assignment `!` keeps resolveFetch callable since the
    // mock implementation assigns it synchronously when fetch is first invoked.
    let resolveFetch!: (value: unknown) => void
    mock.fetchMock.mockImplementationOnce(() => new Promise<unknown>((resolve) => {
      resolveFetch = resolve
    }))

    const { getAccessToken } = await import('./auth')
    const a = getAccessToken()
    const b = getAccessToken()
    // Both calls observe the same in-flight refresh; only one fetch fires.
    expect(mock.fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch?.({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        accessToken: 'cld_at_new',
        refreshToken: 'cld_rt_v2',
        accessTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
    })

    await expect(a).resolves.toBe('cld_at_new')
    await expect(b).resolves.toBe('cld_at_new')
    expect(mock.fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('getAuthStatus', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pear-auth-status-'))
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

  it('reports signed in from valid stored tokens even when profile fetch fails', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_no_user',
      refreshToken: 'cld_rt_no_user',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Unauthorized' })
    })

    const { getAuthStatus } = await import('./auth')

    await expect(getAuthStatus()).resolves.toEqual({
      loggedIn: true,
      apiUrl: 'https://cloud.example',
      user: undefined
    })
  })

  it('reports signed in when whoami only returns a stable user id', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_user_id',
      refreshToken: 'cld_rt_user_id',
      apiUrl: 'https://cloud.example'
    })
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ user: { id: 'user-1' } })
    })

    const { getAuthStatus } = await import('./auth')

    await expect(getAuthStatus()).resolves.toEqual({
      loggedIn: true,
      apiUrl: 'https://cloud.example',
      user: { username: 'user-1' }
    })
  })

  it('canonicalizes legacy agentrelay.dev stored tokens before refreshing auth status', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_legacy_status',
      refreshToken: 'cld_rt_legacy_status',
      apiUrl: 'https://agentrelay.dev/cloud'
    })
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ user: { id: 'user-legacy' } })
    })

    const { getAuthStatus } = await import('./auth')

    await expect(getAuthStatus()).resolves.toEqual({
      loggedIn: true,
      apiUrl: 'https://agentrelay.com/cloud',
      user: { username: 'user-legacy' }
    })
    expect(mock.fetchMock).toHaveBeenCalledWith(
      'https://agentrelay.com/cloud/api/v1/auth/whoami',
      expect.any(Object)
    )
  })

  it('hydrates a sparse stored profile from whoami', async () => {
    writeAuthJson(userDataDir, {
      accessToken: 'cld_at_sparse_user',
      refreshToken: 'cld_rt_sparse_user',
      apiUrl: 'https://cloud.example',
      user: { username: 'user-1' }
    })
    mock.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        user: {
          id: 'user-1',
          name: 'Khaliq Gant',
          email: 'khaliq@example.test',
          avatarUrl: 'https://lh3.googleusercontent.com/a/avatar=s96-c'
        }
      })
    })

    const { getAuthStatus } = await import('./auth')

    await expect(getAuthStatus()).resolves.toMatchObject({
      loggedIn: true,
      apiUrl: 'https://cloud.example',
      user: {
        username: 'user-1',
        name: 'Khaliq Gant',
        email: 'khaliq@example.test',
        avatarUrl: 'https://lh3.googleusercontent.com/a/avatar=s96-c'
      }
    })
    expect(mock.fetchMock).toHaveBeenCalledWith(
      'https://cloud.example/api/v1/auth/whoami',
      expect.objectContaining({
        headers: { Authorization: 'Bearer cld_at_sparse_user' }
      })
    )
  })

  it('does not report signed in from auth metadata when stored tokens are invalid', async () => {
    const configDir = join(userDataDir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'auth.json'), 'not-json')
    writeFileSync(join(configDir, 'auth-meta.json'), JSON.stringify({
      apiUrl: 'https://cloud.example',
      user: { name: 'Stale User', email: 'stale@example.test' }
    }))

    const { getAuthStatus } = await import('./auth')

    await expect(getAuthStatus()).resolves.toEqual({ loggedIn: false })
  })
})
