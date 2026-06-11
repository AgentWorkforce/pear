import { RelayfileSetup, type WorkspaceHandle } from '@relayfile/sdk'

import { resolveCloudAuth } from './auth'
import { loadStore, saveStore } from './store'
import type { RelayWorkspaceManagerLike, RelayWorkspaceRecord } from './relay-workspace.types'

const ACCOUNT_AGENT_NAME = 'pear-account'
// Scope grammar is `plane:resource:action:path`; the cloud API only accepts the
// `read` and `write` actions (matching the SDK's DEFAULT_SCOPES of fs:read/fs:write).
// A combined `readwrite` action is rejected with `invalid_scopes`, so grant both.
const ACCOUNT_SCOPES = ['relayfile:fs:read:/**', 'relayfile:fs:write:/**']

type RelayWorkspaceAuthContext = {
  apiUrl: string
  authKey: string
}

type RelayWorkspaceBootstrapResult = {
  handle: WorkspaceHandle
  persist?: RelayWorkspaceRecord
}

export interface RelayWorkspaceManagerOptions {
  agentName?: string
  scopes?: string[]
}

export class RelayWorkspaceManager {
  private readonly agentName: string
  private readonly scopes: string[]
  private handle: WorkspaceHandle | null = null
  private handleAuth: RelayWorkspaceAuthContext | null = null
  private pendingHandle: Promise<WorkspaceHandle> | null = null
  private pendingAuth: RelayWorkspaceAuthContext | null = null
  private bootstrapGeneration = 0

  constructor(options: RelayWorkspaceManagerOptions = {}) {
    this.agentName = options.agentName ?? ACCOUNT_AGENT_NAME
    this.scopes = options.scopes ?? ACCOUNT_SCOPES
  }

  async getWorkspaceHandle(): Promise<WorkspaceHandle> {
    const auth = await resolveCloudAuth()
    if (!auth) {
      this.reset()
      throw new Error('cloud-auth-required')
    }

    const authContext = { apiUrl: auth.apiUrl, authKey: auth.accountKey }
    if (this.handle && this.handleAuth && isSameAuthContext(this.handleAuth, authContext)) return this.handle
    if (this.handle) this.reset()

    if (this.pendingHandle) {
      if (this.pendingAuth && isSameAuthContext(this.pendingAuth, authContext)) return this.pendingHandle
      this.reset()
    }
    const generation = this.bootstrapGeneration
    this.pendingAuth = authContext
    const pendingHandle = this.createGuardedBootstrap(auth, authContext, generation)
    this.pendingHandle = pendingHandle
    return pendingHandle
  }

  async getWorkspaceId(): Promise<string> {
    const handle = await this.getWorkspaceHandle()
    return handle.workspaceId
  }

  /**
   * Run an authenticated request against the account workspace, transparently
   * refreshing the workspace token (and rebuilding the handle) on a 401.
   */
  async withHandle<T>(fn: (handle: WorkspaceHandle) => Promise<T>): Promise<T> {
    const handle = await this.getWorkspaceHandle()
    try {
      return await fn(handle)
    } catch (err) {
      if (!isUnauthorized(err)) throw err
      await handle.refreshToken().catch(() => undefined)
      try {
        return await fn(handle)
      } catch (refreshErr) {
        if (!isUnauthorized(refreshErr)) throw refreshErr
        this.handle = null
        const fresh = await this.getWorkspaceHandle()
        return fn(fresh)
      }
    }
  }

  /**
   * Drop the cached handle. The next call rejoins/creates the workspace.
   * Used on sign-out so a different account doesn't reuse a stale handle.
   */
  reset(): void {
    this.bootstrapGeneration += 1
    this.handle = null
    this.handleAuth = null
    this.pendingHandle = null
    this.pendingAuth = null
  }

  getPersisted(): RelayWorkspaceRecord | null {
    return readPersistedWorkspace()
  }

  private createGuardedBootstrap(
    auth: { apiUrl: string; accessToken: string; accountKey: string },
    authContext: RelayWorkspaceAuthContext,
    generation: number
  ): Promise<WorkspaceHandle> {
    const pendingHandle: Promise<WorkspaceHandle> = this.bootstrap(auth)
      .then((result) => {
        if (!this.isCurrentBootstrap(pendingHandle, authContext, generation)) {
          return this.getCurrentOrNextHandle()
        }

        if (result.persist) writePersistedWorkspace(result.persist)
        this.handle = result.handle
        this.handleAuth = authContext
        return result.handle
      })
      // If a stale bootstrap rejects (e.g. network blip after auth changed and
      // a newer bootstrap already succeeded), don't propagate the error to the
      // caller — redirect them to the current/next handle, mirroring the
      // success-path redirect above. Without this, callers awaiting an
      // outdated bootstrap would see its failure even though a valid handle
      // exists.
      .catch((err) => {
        if (!this.isCurrentBootstrap(pendingHandle, authContext, generation)) {
          return this.getCurrentOrNextHandle()
        }
        throw err
      })
      .finally(() => {
        if (this.pendingHandle === pendingHandle && this.bootstrapGeneration === generation) {
          this.pendingHandle = null
          this.pendingAuth = null
        }
      })
    return pendingHandle
  }

  private getCurrentOrNextHandle(): Promise<WorkspaceHandle> | WorkspaceHandle {
    if (this.pendingHandle) return this.pendingHandle
    if (this.handle) return this.handle
    return this.getWorkspaceHandle()
  }

  private isCurrentBootstrap(
    pendingHandle: Promise<WorkspaceHandle>,
    authContext: RelayWorkspaceAuthContext,
    generation: number
  ): boolean {
    return (
      this.pendingHandle === pendingHandle &&
      this.bootstrapGeneration === generation &&
      this.pendingAuth !== null &&
      isSameAuthContext(this.pendingAuth, authContext)
    )
  }

  private async bootstrap(auth: { apiUrl: string; accessToken: string; accountKey: string }): Promise<RelayWorkspaceBootstrapResult> {
    const setup = new RelayfileSetup({
      cloudApiUrl: auth.apiUrl,
      accessToken: () => auth.accessToken
    })

    const existing = readPersistedWorkspace()
    if (existing) {
      if (!isWorkspaceForAuth(existing, auth.apiUrl, auth.accountKey)) {
        clearPersistedWorkspace(existing)
      } else {
        try {
          const handle = await setup.joinWorkspace(existing.id, {
            agentName: this.agentName,
            scopes: this.scopes
          })
          return { handle }
        } catch (err) {
          if (!isWorkspaceMissing(err)) throw err
          clearPersistedWorkspace(existing)
        }
      }
    }

    const handle = await setup.createWorkspace({
      agentName: this.agentName,
      scopes: this.scopes
    })
    return {
      handle,
      persist: {
        id: handle.workspaceId,
        createdAt: new Date().toISOString(),
        apiUrl: auth.apiUrl,
        authKey: auth.accountKey
      }
    }
  }
}

const relayWorkspaceManagerContract: new () => RelayWorkspaceManagerLike = RelayWorkspaceManager
void relayWorkspaceManagerContract

function readPersistedWorkspace(): RelayWorkspaceRecord | null {
  const store = loadStore() as unknown as { relayWorkspace?: RelayWorkspaceRecord }
  const record = store.relayWorkspace
  if (!record || typeof record.id !== 'string' || !record.id.trim()) return null
  return record
}

function writePersistedWorkspace(record: RelayWorkspaceRecord): void {
  const store = loadStore() as unknown as { relayWorkspace?: RelayWorkspaceRecord }
  store.relayWorkspace = record
  saveStore(store as Parameters<typeof saveStore>[0])
}

function clearPersistedWorkspace(expected?: RelayWorkspaceRecord): void {
  const store = loadStore() as unknown as { relayWorkspace?: RelayWorkspaceRecord }
  if (!store.relayWorkspace) return
  if (expected && !isSameWorkspaceRecord(store.relayWorkspace, expected)) return
  delete store.relayWorkspace
  saveStore(store as Parameters<typeof saveStore>[0])
}

function isWorkspaceForAuth(record: RelayWorkspaceRecord, apiUrl: string, authKey: string): boolean {
  return record.apiUrl === apiUrl && record.authKey === authKey
}

function isSameAuthContext(left: RelayWorkspaceAuthContext, right: RelayWorkspaceAuthContext): boolean {
  return left.apiUrl === right.apiUrl && left.authKey === right.authKey
}

function isSameWorkspaceRecord(left: RelayWorkspaceRecord, right: RelayWorkspaceRecord): boolean {
  return (
    left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.apiUrl === right.apiUrl &&
    left.authKey === right.authKey
  )
}

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = getErrorStatus(err)
  if (status === 401 || status === 403) return true
  const message = (err as { message?: string }).message ?? ''
  return /\b(401|403|unauthor|forbidden)\b/i.test(message)
}

function isWorkspaceMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = getErrorStatus(err)
  if (status === 404) return true
  const message = (err as { message?: string }).message ?? ''
  return /\bworkspace[_ -]?not[_ -]?found\b|\b404\b/i.test(message)
}

function getErrorStatus(err: object): number | undefined {
  const candidate = err as { status?: unknown; statusCode?: unknown; httpStatus?: unknown }
  if (typeof candidate.status === 'number') return candidate.status
  if (typeof candidate.statusCode === 'number') return candidate.statusCode
  if (typeof candidate.httpStatus === 'number') return candidate.httpStatus
  return undefined
}

let singleton: RelayWorkspaceManager | null = null

export function getRelayWorkspaceManager(): RelayWorkspaceManager {
  if (!singleton) singleton = new RelayWorkspaceManager()
  return singleton
}

export function resetRelayWorkspaceManager(): void {
  singleton?.reset()
  singleton = null
}
