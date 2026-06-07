import { app, shell, safeStorage } from 'electron'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { readStoredAuth as readCloudSdkAuth } from '@agent-relay/cloud'
import { cacheAvatarFromUrl, cachedAvatarUrl, isRemoteAvatarUrl } from './avatar-cache'
import {
  AuthMetaSchema,
  StoredTokensSchema,
  UserInfoSchema,
  type StoredTokens,
  type UserInfo
} from './schemas'

const CLOUD_API_URL = process.env.RELAY_CLOUD_URL || 'https://agentrelay.com/cloud'
const LEGACY_CLOUD_API_URL = 'https://agentrelay.dev/cloud'
const TOKEN_EXPIRY_BUFFER_MS = 60_000
const WHOAMI_REQUEST_TIMEOUT_MS = 10_000
const ACCOUNT_WORKSPACE_RETRY_ATTEMPTS = 8
const ACCOUNT_WORKSPACE_RETRY_DELAY_MS = 500
const warnedWhoamiWorkspaceFailures = new Set<string>()

interface AuthStatus {
  loggedIn: boolean
  apiUrl?: string
  user?: UserInfo
}

type AccountWorkspaceCache = {
  accountKey?: string
  tokenHash?: string
  workspaceId: string
}

type AccountWorkspaceIdOptions = {
  retryAttempts?: number
  retryDelayMs?: number
}

type AuthMeta = Pick<AuthStatus, 'apiUrl' | 'user'> & {
  accountWorkspace?: AccountWorkspaceCache
}

const getAuthDir = (): string => {
  const dir = join(app.getPath('userData'), 'config')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const getAuthPath = (): string => {
  return join(getAuthDir(), 'auth.json')
}

const getAuthMetaPath = (): string => {
  return join(getAuthDir(), 'auth-meta.json')
}

function hasStoredTokens(): boolean {
  try {
    return readFileSync(getAuthPath()).length > 0
  } catch {
    return false
  }
}

// The cloud API has historically returned the same logical field under several
// keys. We tolerate common camelCase/snake_case variants, then validate the
// final shape with UserInfoSchema.
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstObject(record: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (isRecord(value)) return value
  }
  return undefined
}

function normalizeUserInfo(value: unknown): UserInfo | undefined {
  if (!isRecord(value)) return undefined

  const candidate = {
    name: firstString(value, ['name', 'displayName', 'display_name']),
    email: firstString(value, ['email']),
    username: firstString(value, ['username', 'id', 'userId', 'user_id']),
    avatarUrl:
      firstString(value, ['avatarUrl', 'avatar_url', 'avatar', 'picture', 'image']),
    cachedAvatarUrl: firstString(value, ['cachedAvatarUrl', 'cached_avatar_url']),
    organizationName: firstString(value, ['organizationName', 'organization_name']),
    projectName: firstString(value, ['projectName', 'project_name'])
  }

  const parsed = UserInfoSchema.parse(candidate)
  // Zod preserves keys with `undefined` values from the input, so we strip
  // them before returning. Without this, an empty whoami payload would shadow
  // previously cached fields during `mergeUserInfo` (e.g. clearing the cached
  // avatar URL on every refresh).
  const user: UserInfo = {}
  for (const [key, value] of Object.entries(parsed) as Array<[keyof UserInfo, string | undefined]>) {
    if (value !== undefined) user[key] = value
  }
  return Object.keys(user).length > 0 ? user : undefined
}

function mergeUserInfo(previous: UserInfo | undefined, next: UserInfo | undefined): UserInfo | undefined {
  const normalizedPrevious = normalizeUserInfo(previous)
  const normalizedNext = normalizeUserInfo(next)
  if (!normalizedPrevious && !normalizedNext) return undefined
  return { ...(normalizedPrevious || {}), ...(normalizedNext || {}) }
}

function hasAvatarIdentity(user: UserInfo | undefined): boolean {
  const normalized = normalizeUserInfo(user)
  return !!(normalized?.avatarUrl && isRemoteAvatarUrl(normalized.avatarUrl))
}

function accountWorkspaceTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex')
}

function accountWorkspaceCacheMatches(
  cached: AccountWorkspaceCache | undefined,
  auth: Pick<CloudAuth, 'accountKey' | 'accessToken'>
): boolean {
  if (!cached?.workspaceId.trim()) return false
  return cached.accountKey === auth.accountKey ||
    cached.tokenHash === accountWorkspaceTokenHash(auth.accessToken)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function saveAuthMeta(tokens: Pick<StoredTokens, 'apiUrl' | 'user'> & Partial<Pick<StoredTokens, 'accessToken'>>): void {
  const previous = loadAuthMeta()
  const apiUrl = normalizeCloudApiUrl(tokens.apiUrl)
  const accountKey = tokens.accessToken
    ? deriveCloudAuthAccountKey(apiUrl, tokens.accessToken, tokens.user)
    : undefined
  const tokenHash = tokens.accessToken ? accountWorkspaceTokenHash(tokens.accessToken) : undefined
  const accountWorkspace =
    accountKey && accountWorkspaceCacheMatches(previous.accountWorkspace, {
      accountKey,
      accessToken: tokens.accessToken || ''
    })
      ? {
          ...previous.accountWorkspace,
          accountKey,
          ...(tokenHash ? { tokenHash } : {})
        }
      : undefined
  const meta = {
    apiUrl,
    user: tokens.user,
    ...(accountWorkspace ? { accountWorkspace } : {})
  }
  writeFileSync(getAuthMetaPath(), JSON.stringify(meta, null, 2))
}

function loadAuthMeta(): AuthMeta {
  try {
    const parsed = AuthMetaSchema.safeParse(JSON.parse(readFileSync(getAuthMetaPath(), 'utf8')))
    if (!parsed.success) return { apiUrl: CLOUD_API_URL }
    const apiUrl = (parsed.data.apiUrl?.trim() || CLOUD_API_URL).replace(/\/+$/, '')
    return {
      apiUrl: apiUrl === LEGACY_CLOUD_API_URL ? CLOUD_API_URL : apiUrl,
      user: parsed.data.user,
      accountWorkspace: parsed.data.accountWorkspace
    }
  } catch {
    return { apiUrl: CLOUD_API_URL }
  }
}

function avatarSourceUrl(user: UserInfo | undefined): string | undefined {
  return isRemoteAvatarUrl(user?.avatarUrl) ? user?.avatarUrl : undefined
}

async function withCachedAvatar(user: UserInfo | undefined, waitForMissing: boolean): Promise<UserInfo | undefined> {
  const normalized = normalizeUserInfo(user)
  if (!normalized) return undefined

  const sourceUrl = avatarSourceUrl(normalized)
  const cacheIdentity = {
    sourceUrl,
    email: normalized.email,
    name: normalized.name
  }
  const existingCachedAvatarUrl = cachedAvatarUrl(cacheIdentity) || normalized.cachedAvatarUrl

  if (!sourceUrl) {
    return existingCachedAvatarUrl ? { ...normalized, cachedAvatarUrl: existingCachedAvatarUrl } : normalized
  }

  if (existingCachedAvatarUrl) {
    void cacheAvatarFromUrl(sourceUrl, cacheIdentity)
    return { ...normalized, cachedAvatarUrl: existingCachedAvatarUrl }
  }

  if (!waitForMissing) return normalized

  const nextCachedAvatarUrl = await cacheAvatarFromUrl(sourceUrl, cacheIdentity)
  return nextCachedAvatarUrl ? { ...normalized, cachedAvatarUrl: nextCachedAvatarUrl } : normalized
}

function saveTokens(tokens: StoredTokens): void {
  const encrypted = safeStorage.encryptString(JSON.stringify(tokens))
  writeFileSync(getAuthPath(), encrypted)
  saveAuthMeta(tokens)
}

function loadTokens(): StoredTokens | null {
  try {
    const raw = readFileSync(getAuthPath())
    const decrypted = safeStorage.decryptString(raw)
    const parsed = StoredTokensSchema.safeParse(JSON.parse(decrypted))
    if (!parsed.success) return null
    const tokens = { ...parsed.data, apiUrl: normalizeCloudApiUrl(parsed.data.apiUrl) }
    saveAuthMeta(tokens)
    return tokens
  } catch {
    return null
  }
}

export function isTokenExpired(tokens: Pick<StoredTokens, 'expiresAt'>): boolean {
  // Tokens persisted before `expiresAt` was captured on the login redirect
  // are treated as expired: their actual lifetime (1 day from issue) is
  // long since past for anyone who logged in before the capture went in,
  // and the safer default is "try to refresh" rather than "return a
  // probably-dead token". The refresh path itself handles failure
  // (transient 5xx falls through to the stale token; 403 invalid_grant
  // clears stored tokens so the UI prompts re-login).
  if (!tokens.expiresAt) return true
  const expiresMs = Date.parse(tokens.expiresAt)
  // Likewise, an unparseable timestamp is a state we shouldn't trust —
  // assume expired and let the refresh path decide.
  if (Number.isNaN(expiresMs)) return true
  return expiresMs - Date.now() < TOKEN_EXPIRY_BUFFER_MS
}

export function readStoredAuth(): StoredTokens | null {
  return loadTokens()
}

function clearTokens(): void {
  try {
    writeFileSync(getAuthPath(), '')
    writeFileSync(getAuthMetaPath(), '')
  } catch {
    // ignore
  }
}

type WhoamiPayloadResult =
  | { ok: true; data: unknown }
  | { ok: false; failureClass: string; status?: number }

function whoamiFailureClassForStatus(status: number): string {
  return `whoami-http-${status}`
}

function warnWhoamiWorkspaceFailure(failureClass: string): void {
  if (warnedWhoamiWorkspaceFailures.has(failureClass)) return
  warnedWhoamiWorkspaceFailures.add(failureClass)
  console.warn('[auth] Account workspace whoami lookup failed:', { failureClass })
}

async function fetchWhoamiPayload(apiUrl: string, accessToken: string): Promise<WhoamiPayloadResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WHOAMI_REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    })
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        failureClass: whoamiFailureClassForStatus(res.status)
      }
    }
    return { ok: true, data: await res.json() as unknown }
  } catch (error) {
    return {
      ok: false,
      failureClass: error instanceof Error && error.name === 'AbortError'
        ? 'whoami-timeout'
        : 'whoami-network'
    }
  } finally {
    clearTimeout(timeout)
  }
}

function accountWorkspaceIdFromWhoami(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  // currentWorkspace.id is the source of truth (matches what /auth/whoami
  // returns today). The other keys are fallbacks for legacy / alternate
  // payload shapes — checking them first would let a stale top-level alias
  // win over the active workspace.
  return (
    firstString(firstObject(value, ['currentWorkspace']), ['id', 'workspaceId', 'workspace_id']) ||
    firstString(value, ['workspaceId', 'workspace_id']) ||
    firstString(firstObject(value, ['workspace']), ['id', 'workspaceId', 'workspace_id'])
  )
}

function saveAccountWorkspaceCache(auth: CloudAuth, workspaceId: string): void {
  const previous = loadAuthMeta()
  const meta = {
    apiUrl: normalizeCloudApiUrl(auth.apiUrl || previous.apiUrl),
    user: previous.user,
    accountWorkspace: {
      accountKey: auth.accountKey,
      tokenHash: accountWorkspaceTokenHash(auth.accessToken),
      workspaceId
    }
  }
  writeFileSync(getAuthMetaPath(), JSON.stringify(meta, null, 2))
}

async function fetchWhoami(apiUrl: string, accessToken: string): Promise<UserInfo | undefined> {
  try {
    const payload = await fetchWhoamiPayload(apiUrl, accessToken)
    if (!payload.ok) return undefined
    const data = payload.data
    const record = isRecord(data) ? data : {}
    const userRecord = firstObject(record, ['user']) || record
    const organizationRecord = firstObject(record, ['organization', 'org'])
    const projectRecord = firstObject(record, ['project'])
    return normalizeUserInfo({
      ...userRecord,
      organizationName:
        firstString(userRecord, ['organizationName', 'organization_name']) ||
        firstString(record, ['organizationName', 'organization_name']) ||
        firstString(organizationRecord, ['name']),
      projectName:
        firstString(userRecord, ['projectName', 'project_name']) ||
        firstString(record, ['projectName', 'project_name']) ||
        firstString(projectRecord, ['name'])
    })
  } catch {
    return undefined
  }
}

/**
 * Start an OAuth login flow:
 * 1. Spin up a temporary local HTTP server to capture the redirect
 * 2. Open the browser to the cloud CLI login endpoint
 * 3. Cloud does Google OAuth → redirects back with tokens
 * 4. Capture tokens, store encrypted, shut down server
 */
export async function login(): Promise<AuthStatus> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      if (!req.url?.startsWith('/auth')) {
        res.writeHead(404)
        res.end()
        return
      }

      const url = new URL(req.url, `http://127.0.0.1`)
      const accessToken = url.searchParams.get('access_token')
      const refreshToken = url.searchParams.get('refresh_token')
      const apiUrl = url.searchParams.get('api_url') || CLOUD_API_URL
      // Cloud's /api/v1/cli/login response includes `access_token_expires_at`
      // (ISO 8601). We persist it so `isTokenExpired` can detect near-expiry
      // and `getAccessToken` can refresh via /api/v1/auth/token/refresh before
      // returning a dead token to callers — otherwise every API call 401s
      // ~24h after login.
      const expiresAt = url.searchParams.get('access_token_expires_at') ?? undefined

      if (!accessToken || !refreshToken) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login failed</h2><p>Missing tokens. You can close this tab.</p></body></html>')
        server.close()
        resolve({ loggedIn: false })
        return
      }

      // Fetch user info before resolving
      const user = await withCachedAvatar(await fetchWhoami(apiUrl, accessToken), true)
      saveTokens({ accessToken, refreshToken, apiUrl, user, ...(expiresAt ? { expiresAt } : {}) })

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Logged in!</h2><p>You can close this tab and return to Pear by Agent Relay.</p></body></html>')
      server.close()
      resolve({ loggedIn: true, apiUrl, user })
    })

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind local auth server'))
        return
      }

      const port = addr.port
      const state = crypto.randomUUID()
      const redirectUri = encodeURIComponent(`http://127.0.0.1:${port}/auth`)
      const loginUrl = `${CLOUD_API_URL}/api/v1/cli/login?redirect_uri=${redirectUri}&state=${state}`

      console.log('[auth] Opening browser for login:', loginUrl)
      try {
        await shell.openExternal(loginUrl)
      } catch (error) {
        server.close()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close()
      resolve({ loggedIn: false })
    }, 5 * 60 * 1000)
  })
}

export function logout(): void {
  clearTokens()
}

export async function getAuthStatus(): Promise<AuthStatus> {
  if (!hasStoredTokens()) return { loggedIn: false }

  const tokens = loadTokens()
  if (tokens) {
    // If the access token is past its 1-day TTL, try to refresh now so the
    // avatar/UI doesn't claim signed-in while every cloud call 401s. On
    // permanent refresh failure (e.g. refresh token revoked or > 7d old),
    // refreshStoredTokens clears storage on 403; we then fall through to
    // loggedOut. On transient failure, keep showing signed-in with the
    // stale token — the next call will retry.
    const usable = isTokenExpired(tokens)
      ? (await refreshStoredTokens(tokens)) ?? (loadTokens() ?? null)
      : tokens
    if (!usable) return { loggedIn: false }

    const cachedUser = normalizeUserInfo(usable.user)
    const freshUser = hasAvatarIdentity(cachedUser)
      ? undefined
      : await fetchWhoami(usable.apiUrl, usable.accessToken)
    const user = await withCachedAvatar(mergeUserInfo(usable.user, freshUser), true)
    if (freshUser || user?.cachedAvatarUrl !== usable.user?.cachedAvatarUrl) {
      saveTokens({ ...usable, user })
    }
    return { loggedIn: true, apiUrl: usable.apiUrl, user }
  }

  return { loggedIn: false }
}

/**
 * Get the stored access token, refreshing it from `/api/v1/auth/token/refresh`
 * if it is at or near expiry. Returns null if not logged in.
 *
 * Cloud-side TTLs (from `cli/login`):
 *   - accessToken : 1 day
 *   - refreshToken: 7 days
 *
 * Without refresh, every cloud call 401s ~24h after login. Refresh tokens are
 * single-use (cloud rotates them on each refresh — see
 * `cloud/packages/web/app/api/v1/auth/token/refresh/route.ts`), so we persist
 * the rotated pair on success.
 *
 * On refresh failure (e.g. refresh token itself expired after 7 days, or
 * revoked server-side), we return the stale access token. The caller's cloud
 * request will then 401 and prompt the user to re-login through the normal
 * flow — better than throwing here and breaking IPC handlers that aren't
 * prepared for `getAccessToken` to fail.
 */
export async function getAccessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null

  if (!isTokenExpired(tokens)) {
    return tokens.accessToken
  }

  const refreshed = await refreshStoredTokens(tokens)
  if (refreshed) return refreshed.accessToken

  // Refresh failed — let the stale token through. The caller will see a 401
  // and the UI can prompt re-login. Don't clear tokens here in case the
  // failure is transient (network, brief 5xx) — the next call will retry.
  return tokens.accessToken
}

const REFRESH_REQUEST_TIMEOUT_MS = 5_000
let inFlightRefresh: Promise<StoredTokens | null> | null = null

/**
 * Coalesce concurrent refresh requests so that bursty IPC traffic (multiple
 * cloud-agent / integration / whoami calls firing at once) doesn't fire N
 * parallel refreshes — only one is in flight at a time, all callers see the
 * same result, and refresh-token rotation stays consistent.
 */
async function refreshStoredTokens(stored: StoredTokens): Promise<StoredTokens | null> {
  if (inFlightRefresh) return inFlightRefresh
  inFlightRefresh = (async (): Promise<StoredTokens | null> => {
    try {
      return await performTokenRefresh(stored)
    } finally {
      inFlightRefresh = null
    }
  })()
  return inFlightRefresh
}

async function performTokenRefresh(stored: StoredTokens): Promise<StoredTokens | null> {
  const apiUrl = normalizeCloudApiUrl(stored.apiUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REFRESH_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: stored.refreshToken }),
      signal: controller.signal
    })

    if (!res.ok) {
      // 403 invalid_grant ⇒ refresh token is permanently dead (expired or
      // revoked). Clear stored tokens so the next getAuthStatus call returns
      // loggedIn=false and the UI shows the login button. Returning null
      // (without clearing) on transient 5xx lets the next refresh attempt
      // try again with the same refresh token.
      if (res.status === 403) {
        clearTokens()
      }
      return null
    }

    const data = (await res.json()) as {
      accessToken?: unknown
      refreshToken?: unknown
      accessTokenExpiresAt?: unknown
      apiUrl?: unknown
    }
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken.trim() : ''
    const refreshToken = typeof data.refreshToken === 'string' ? data.refreshToken.trim() : ''
    if (!accessToken || !refreshToken) return null

    const next: StoredTokens = {
      accessToken,
      refreshToken,
      apiUrl: typeof data.apiUrl === 'string' && data.apiUrl.trim()
        ? normalizeCloudApiUrl(data.apiUrl)
        : apiUrl,
      user: stored.user,
      ...(typeof data.accessTokenExpiresAt === 'string' && data.accessTokenExpiresAt.trim()
        ? { expiresAt: data.accessTokenExpiresAt.trim() }
        : {})
    }
    saveTokens(next)
    return next
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export function getApiUrl(): string {
  if (hasStoredTokens()) {
    return normalizeCloudApiUrl(loadAuthMeta().apiUrl)
  }
  return CLOUD_API_URL
}

export interface CloudAuth {
  accessToken: string
  apiUrl: string
  accountKey: string
}

function cloudAuthFromStored(tokens: StoredTokens): CloudAuth {
  const apiUrl = normalizeCloudApiUrl(tokens.apiUrl)
  return {
    accessToken: tokens.accessToken,
    apiUrl,
    accountKey: deriveCloudAuthAccountKey(apiUrl, tokens.accessToken, tokens.user)
  }
}

function normalizeCloudApiUrl(url: string | undefined): string {
  const normalized = (url || CLOUD_API_URL).trim().replace(/\/+$/, '')
  if (normalized === LEGACY_CLOUD_API_URL) return CLOUD_API_URL
  return normalized
}

function readJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function deriveAuthSubject(accessToken: string, user?: UserInfo): string {
  if (user?.email?.trim()) return `email:${user.email.trim().toLowerCase()}`

  const payload = readJwtPayload(accessToken)
  const subject = payload?.sub ?? payload?.userId ?? payload?.user_id ?? payload?.email
  if (typeof subject === 'string' && subject.trim()) return `token-subject:${subject.trim()}`

  return `token-hash:${createHash('sha256').update(accessToken).digest('hex')}`
}

function deriveCloudAuthAccountKey(apiUrl: string, accessToken: string, user?: UserInfo): string {
  const normalizedApiUrl = normalizeCloudApiUrl(apiUrl)
  const subject = deriveAuthSubject(accessToken, user)
  return createHash('sha256').update(`${normalizedApiUrl}\0${subject}`).digest('hex')
}

function isCloudSdkAuthExpired(auth: { accessTokenExpiresAt?: string } | null): boolean {
  if (!auth?.accessTokenExpiresAt) return true
  const expiresAt = Date.parse(auth.accessTokenExpiresAt)
  return Number.isNaN(expiresAt) || expiresAt - Date.now() < TOKEN_EXPIRY_BUFFER_MS
}

/**
 * Resolve cloud credentials the same way for every cloud-backed feature.
 * Prefers Pear's in-app login (the encrypted userData store), then falls back
 * to the @agent-relay/cloud SDK credentials — CLOUD_API_* env vars or
 * ~/.agent-relay/cloud-auth.json — so env/file-provisioned auth works exactly
 * like it does in ../workforce and ../cloud. Returns null when neither source
 * has valid, unexpired credentials.
 */
export async function resolveCloudAuth(): Promise<CloudAuth | null> {
  const pearAuth = loadTokens()
  if (pearAuth) {
    // Token may have aged past its 1-day TTL. Refresh transparently so
    // integrations / cloud-agent / proactive-agent don't surface
    // "cloud-auth-required" while the UI still shows the user as signed in
    // (getAuthStatus doesn't check expiry — see #cloud-auth-skew).
    // On refresh failure, fall through to the stale token (matching
    // getAccessToken's behaviour) — the caller's 401 surfaces re-login
    // through the normal flow instead of looking unauthenticated here.
    // refreshStoredTokens clears tokens itself on permanent failure (403).
    const usable = isTokenExpired(pearAuth)
      ? (await refreshStoredTokens(pearAuth)) ?? (loadTokens() ?? null)
      : pearAuth
    if (usable) {
      return cloudAuthFromStored(usable)
    }
  }

  const cloudAuth = await readCloudSdkAuth()
  if (cloudAuth && !isCloudSdkAuthExpired(cloudAuth)) {
    const apiUrl = normalizeCloudApiUrl(cloudAuth.apiUrl)
    return {
      accessToken: cloudAuth.accessToken,
      apiUrl,
      accountKey: deriveCloudAuthAccountKey(apiUrl, cloudAuth.accessToken)
    }
  }

  return null
}

export async function refreshCloudAuth(): Promise<CloudAuth | null> {
  const pearAuth = loadTokens()
  if (!pearAuth) return null
  const refreshed = await refreshStoredTokens(pearAuth)
  return refreshed ? cloudAuthFromStored(refreshed) : null
}

export async function ensureAuthenticated(apiUrl?: string): Promise<AuthStatus> {
  const stored = loadTokens()
  if (stored && !isTokenExpired(stored)) {
    return { loggedIn: true, apiUrl: stored.apiUrl, user: normalizeUserInfo(stored.user) }
  }
  if (apiUrl && stored) {
    saveAuthMeta({ apiUrl, user: stored.user, accessToken: stored.accessToken })
  }
  return login()
}

export async function getAccountWorkspaceId(options: AccountWorkspaceIdOptions = {}): Promise<string> {
  const auth = await resolveCloudAuth()
  if (!auth) throw new Error('cloud-auth-required')

  const cached = loadAuthMeta().accountWorkspace
  const cachedWorkspaceId = cached?.workspaceId.trim()
  if (cachedWorkspaceId && accountWorkspaceCacheMatches(cached, auth)) {
    return cachedWorkspaceId
  }

  const retryAttempts = Math.max(1, Math.floor(options.retryAttempts ?? 1))
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? ACCOUNT_WORKSPACE_RETRY_DELAY_MS))
  let workspaceId: string | undefined
  let failureClass = 'whoami-no-workspace-in-payload'

  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    const payload = await fetchWhoamiPayload(auth.apiUrl, auth.accessToken)
    if (!payload.ok) {
      failureClass = payload.failureClass
      if (payload.status === 401 || payload.status === 403) {
        warnWhoamiWorkspaceFailure(failureClass)
        throw new Error(`cloud-auth-required:${failureClass}`)
      }
    } else {
      workspaceId = accountWorkspaceIdFromWhoami(payload.data)
      failureClass = workspaceId ? '' : 'whoami-no-workspace-in-payload'
    }
    if (workspaceId) break
    if (attempt < retryAttempts) await delay(retryDelayMs)
  }

  if (!workspaceId) {
    warnWhoamiWorkspaceFailure(failureClass)
    throw new Error(`account-workspace-required:${failureClass}`)
  }

  saveAccountWorkspaceCache(auth, workspaceId)
  return workspaceId
}

export function accountWorkspaceReadyRetryOptions(): Required<AccountWorkspaceIdOptions> {
  return {
    retryAttempts: ACCOUNT_WORKSPACE_RETRY_ATTEMPTS,
    retryDelayMs: ACCOUNT_WORKSPACE_RETRY_DELAY_MS
  }
}
