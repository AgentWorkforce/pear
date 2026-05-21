import { app, shell, safeStorage } from 'electron'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { readStoredAuth as readCloudSdkAuth } from '@agent-relay/cloud'

const CLOUD_API_URL = process.env.RELAY_CLOUD_URL || 'https://agentrelay.dev/cloud'
const TOKEN_EXPIRY_BUFFER_MS = 60_000

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  apiUrl: string
  expiresAt?: string
  user?: UserInfo
}

export interface UserInfo {
  name?: string
  email?: string
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
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const user: UserInfo = {}

  if (typeof record.name === 'string') user.name = record.name
  if (typeof record.email === 'string') user.email = record.email
  if (typeof record.organizationName === 'string') user.organizationName = record.organizationName
  if (typeof record.projectName === 'string') user.projectName = record.projectName

  return Object.keys(user).length > 0 ? user : undefined
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

export function isTokenExpired(tokens: Pick<StoredTokens, 'expiresAt'>): boolean {
  if (!tokens.expiresAt) return false
  const expiresMs = Date.parse(tokens.expiresAt)
  if (Number.isNaN(expiresMs)) return false
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

async function fetchWhoami(apiUrl: string, accessToken: string): Promise<UserInfo | undefined> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) return undefined
    const data = await res.json()
    return {
      name: data.user?.name,
      email: data.user?.email,
      organizationName: data.organization?.name,
      projectName: data.project?.name
    }
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

      if (!accessToken || !refreshToken) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login failed</h2><p>Missing tokens. You can close this tab.</p></body></html>')
        server.close()
        resolve({ loggedIn: false })
        return
      }

      // Fetch user info before resolving
      const user = await fetchWhoami(apiUrl, accessToken)
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

export function getAuthStatus(): AuthStatus {
  if (!hasStoredTokens()) return { loggedIn: false }
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

export interface CloudAuth {
  accessToken: string
  apiUrl: string
  accountKey: string
}

function normalizeCloudApiUrl(url: string | undefined): string {
  return (url || getApiUrl()).trim().replace(/\/+$/, '')
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
  if (pearAuth && !isTokenExpired(pearAuth)) {
    const apiUrl = normalizeCloudApiUrl(pearAuth.apiUrl)
    return {
      accessToken: pearAuth.accessToken,
      apiUrl,
      accountKey: deriveCloudAuthAccountKey(apiUrl, pearAuth.accessToken, pearAuth.user)
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

export async function ensureAuthenticated(apiUrl?: string): Promise<AuthStatus> {
  const stored = loadTokens()
  if (stored && !isTokenExpired(stored)) {
    return { loggedIn: true, apiUrl: stored.apiUrl, user: stored.user }
  }
  if (apiUrl && stored) {
    saveAuthMeta({ apiUrl, user: stored.user })
  }
  return login()
}
