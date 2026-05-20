import { app, shell, safeStorage } from 'electron'
import { createServer, type Server } from 'http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { cacheAvatarFromUrl, cachedAvatarUrl, isRemoteAvatarUrl } from './avatar-cache'

const CLOUD_API_URL = process.env.RELAY_CLOUD_URL || 'https://agentrelay.dev/cloud'

interface StoredTokens {
  accessToken: string
  refreshToken: string
  apiUrl: string
  expiresAt?: string
  user?: UserInfo
}

interface UserInfo {
  name?: string
  email?: string
  githubUsername?: string
  avatarUrl?: string
  cachedAvatarUrl?: string
  organizationName?: string
  projectName?: string
}

interface AuthStatus {
  loggedIn: boolean
  apiUrl?: string
  user?: UserInfo
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

function normalizeUserInfo(value: unknown): UserInfo | undefined {
  if (!isRecord(value)) return undefined

  const record = value
  const githubRecord = firstObject(record, [
    'github',
    'githubUser',
    'github_user',
    'githubProfile',
    'github_profile',
    'githubAccount',
    'github_account'
  ])
  const user: UserInfo = {}
  const githubUsername =
    firstString(record, ['githubUsername', 'github_username', 'githubLogin', 'github_login']) ||
    firstString(githubRecord, ['githubUsername', 'github_username', 'username', 'login']) ||
    firstString(record, ['username', 'login'])
  const avatarUrl =
    firstString(record, ['githubAvatarUrl', 'github_avatar_url']) ||
    firstString(githubRecord, ['avatarUrl', 'avatar_url', 'avatar', 'picture', 'image']) ||
    firstString(record, ['avatarUrl', 'avatar_url', 'avatar', 'picture', 'image'])
  const cachedAvatarUrl = firstString(record, ['cachedAvatarUrl', 'cached_avatar_url'])

  const name = firstString(record, ['name', 'displayName', 'display_name'])
  const email = firstString(record, ['email'])
  const organizationName = firstString(record, ['organizationName', 'organization_name'])
  const projectName = firstString(record, ['projectName', 'project_name'])

  if (name) user.name = name
  if (email) user.email = email
  if (githubUsername) user.githubUsername = githubUsername
  if (avatarUrl) user.avatarUrl = avatarUrl
  if (cachedAvatarUrl) user.cachedAvatarUrl = cachedAvatarUrl
  if (organizationName) user.organizationName = organizationName
  if (projectName) user.projectName = projectName

  return Object.keys(user).length > 0 ? user : undefined
}

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

function mergeUserInfo(previous: UserInfo | undefined, next: UserInfo | undefined): UserInfo | undefined {
  const normalizedPrevious = normalizeUserInfo(previous)
  const normalizedNext = normalizeUserInfo(next)
  if (!normalizedPrevious && !normalizedNext) return undefined
  return { ...(normalizedPrevious || {}), ...(normalizedNext || {}) }
}

function hasAvatarIdentity(user: UserInfo | undefined): boolean {
  const normalized = normalizeUserInfo(user)
  return !!(
    normalized?.githubUsername ||
    (normalized?.avatarUrl && isRemoteAvatarUrl(normalized.avatarUrl))
  )
}

function saveAuthMeta(tokens: Pick<StoredTokens, 'apiUrl' | 'user'>): void {
  const meta = {
    apiUrl: tokens.apiUrl,
    user: tokens.user
  }
  writeFileSync(getAuthMetaPath(), JSON.stringify(meta, null, 2))
}

function loadAuthMeta(): Pick<AuthStatus, 'apiUrl' | 'user'> {
  try {
    const record = JSON.parse(readFileSync(getAuthMetaPath(), 'utf8')) as Record<string, unknown>
    return {
      apiUrl: typeof record.apiUrl === 'string' ? record.apiUrl : CLOUD_API_URL,
      user: normalizeUserInfo(record.user)
    }
  } catch {
    return { apiUrl: CLOUD_API_URL }
  }
}

function githubAvatarUrl(user: UserInfo | undefined): string | undefined {
  const githubUsername = user?.githubUsername?.trim()
  return githubUsername ? `https://github.com/${encodeURIComponent(githubUsername)}.png?size=96` : undefined
}

function avatarSourceUrl(user: UserInfo | undefined): string | undefined {
  return githubAvatarUrl(user) || (isRemoteAvatarUrl(user?.avatarUrl) ? user?.avatarUrl : undefined)
}

async function withCachedAvatar(user: UserInfo | undefined, waitForMissing: boolean): Promise<UserInfo | undefined> {
  const normalized = normalizeUserInfo(user)
  if (!normalized) return undefined

  const sourceUrl = avatarSourceUrl(normalized)
  const cacheIdentity = {
    sourceUrl,
    githubUsername: normalized.githubUsername,
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
    const tokens = JSON.parse(decrypted) as StoredTokens
    saveAuthMeta(tokens)
    return tokens
  } catch {
    return null
  }
}

function clearTokens(): void {
  try {
    writeFileSync(getAuthPath(), '')
    writeFileSync(getAuthMetaPath(), '')
  } catch {
    // ignore
  }
}

async function fetchWhoami(apiUrl: string, accessToken: string): Promise<UserInfo | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)

  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    })
    if (!res.ok) return undefined
    const data = await res.json() as unknown
    const record = isRecord(data) ? data : {}
    const userRecord = firstObject(record, ['user']) || record
    const organizationRecord = firstObject(record, ['organization', 'org'])
    const projectRecord = firstObject(record, ['project'])
    const githubRecord =
      firstObject(record, ['github', 'githubUser', 'github_user', 'githubProfile', 'github_profile', 'githubAccount', 'github_account']) ||
      firstObject(userRecord, ['github', 'githubUser', 'github_user', 'githubProfile', 'github_profile', 'githubAccount', 'github_account'])

    return normalizeUserInfo({
      ...userRecord,
      github: githubRecord,
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
  } finally {
    clearTimeout(timeout)
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

      if (!accessToken || !refreshToken) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login failed</h2><p>Missing tokens. You can close this tab.</p></body></html>')
        server.close()
        resolve({ loggedIn: false })
        return
      }

      // Fetch user info before resolving
      const user = await withCachedAvatar(await fetchWhoami(apiUrl, accessToken), true)
      saveTokens({ accessToken, refreshToken, apiUrl, user })

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Logged in!</h2><p>You can close this tab and return to Pear.</p></body></html>')
      server.close()
      resolve({ loggedIn: true, apiUrl, user })
    })

    server.listen(0, '127.0.0.1', () => {
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
      shell.openExternal(loginUrl)
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
    const cachedUser = normalizeUserInfo(tokens.user)
    const freshUser = hasAvatarIdentity(cachedUser)
      ? undefined
      : await fetchWhoami(tokens.apiUrl, tokens.accessToken)
    const user = await withCachedAvatar(mergeUserInfo(tokens.user, freshUser), true)
    if (freshUser || user?.cachedAvatarUrl !== tokens.user?.cachedAvatarUrl) {
      saveTokens({ ...tokens, user })
    }
    return { loggedIn: true, apiUrl: tokens.apiUrl, user }
  }

  const meta = loadAuthMeta()
  return { loggedIn: true, apiUrl: meta.apiUrl, user: meta.user }
}

/**
 * Get the stored access token, refreshing if near expiry.
 * Returns null if not logged in.
 */
export async function getAccessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null

  // TODO: check expiry and refresh via POST /api/v1/auth/token/refresh
  // For now, return the stored token (30min TTL from login)
  return tokens.accessToken
}

export function getApiUrl(): string {
  if (hasStoredTokens()) {
    return loadAuthMeta().apiUrl || CLOUD_API_URL
  }
  return CLOUD_API_URL
}
