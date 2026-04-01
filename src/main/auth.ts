import { app, shell, safeStorage } from 'electron'
import { createServer, type Server } from 'http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'

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
  organizationName?: string
  workspaceName?: string
}

interface AuthStatus {
  loggedIn: boolean
  apiUrl?: string
  user?: UserInfo
}

const getAuthPath = (): string => {
  const dir = join(app.getPath('userData'), 'config')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'auth.json')
}

function saveTokens(tokens: StoredTokens): void {
  const encrypted = safeStorage.encryptString(JSON.stringify(tokens))
  writeFileSync(getAuthPath(), encrypted)
}

function loadTokens(): StoredTokens | null {
  try {
    const raw = readFileSync(getAuthPath())
    const decrypted = safeStorage.decryptString(raw)
    return JSON.parse(decrypted) as StoredTokens
  } catch {
    return null
  }
}

function clearTokens(): void {
  try {
    writeFileSync(getAuthPath(), '')
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
      workspaceName: data.workspace?.name
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
  const tokens = loadTokens()
  if (!tokens) return { loggedIn: false }
  return { loggedIn: true, apiUrl: tokens.apiUrl, user: tokens.user }
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
  const tokens = loadTokens()
  return tokens?.apiUrl || CLOUD_API_URL
}
