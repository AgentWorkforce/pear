import { chmod, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  RelayfileSetup,
  type MountedWorkspaceHandle
} from '@relayfile/sdk'
import { accountWorkspaceReadyRetryOptions, getAccountWorkspaceId, resolveCloudAuth } from './auth'
import { createPearMountLauncher } from './relayfile-mount-launcher'

const MOUNT_READY_TIMEOUT_MS = 60_000
const MOUNT_REFRESH_FALLBACK_MARGIN_MS = 5 * 60_000
const MOUNT_REFRESH_MIN_DELAY_MS = 1_000
const MOUNT_AUTH_RESTART_THROTTLE_MS = 60_000

type IntegrationMountInput = {
  provider: string
  mountPaths: string[]
}

type IntegrationMountSpec = {
  remotePath: string
  localDir: string
  agentName: string
  scopes: string[]
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

function remotePathSegments(remotePath: string): string[] {
  return remotePath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map(sanitizePathSegment)
}

export function integrationMountRootForWorkspace(workspaceId: string): string {
  return integrationMountWorkspaceRoot(workspaceId)
}

function integrationMountWorkspaceRoot(workspaceId: string): string {
  return join(
    integrationMountWorkspacesRoot(),
    sanitizePathSegment(workspaceId)
  )
}

function integrationMountWorkspacesRoot(): string {
  return join(homedir(), '.agentworkforce', 'pear', 'relayfile', 'workspaces')
}

export function integrationLocalPathForRemote(workspaceId: string, remotePath: string): string {
  const segments = remotePathSegments(remotePath)
  const withoutRoot = segments[0] === 'integrations' ? segments.slice(1) : segments
  return join(integrationMountRootForWorkspace(workspaceId), ...withoutRoot)
}

// Tolerates the legacy `/integrations/<provider>/...` catalog form.
export function integrationProviderRoot(mountPath: string): string | null {
  const segments = remotePathSegments(mountPath)
  const withoutRoot = segments[0] === 'integrations' ? segments.slice(1) : segments
  return withoutRoot.length > 0 ? `/${withoutRoot[0]}` : null
}

function canonicalIntegrationMountPath(mountPath: string, provider: string): string | null {
  const providerSegment = sanitizePathSegment(provider.trim().toLowerCase())
  const segments = remotePathSegments(mountPath)
  if (segments[0] === 'discovery') {
    const discoverySegments = segments.length > 1 ? segments : ['discovery', providerSegment]
    return `/${discoverySegments.join('/')}`
  }
  const withoutLegacyRoot = segments[0] === 'integrations' ? segments.slice(2) : segments.slice(1)
  if (segments[0] === 'integrations') {
    const legacyProvider = segments[1] || providerSegment
    return `/${[legacyProvider, ...withoutLegacyRoot].filter(Boolean).join('/')}`
  }
  if (segments.length > 0) return `/${[providerSegment, ...withoutLegacyRoot].filter(Boolean).join('/')}`
  return providerSegment ? `/${providerSegment}` : null
}

async function ensureProtectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700).catch(() => undefined)
}

export class IntegrationMountManager {
  // One mount per configured Relayfile path. Mounting provider roots makes
  // large integrations mirror far more data than the project selected.
  private handles = new Map<string, MountedWorkspaceHandle>()
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private authRestartedAt = new Map<string, number>()
  private workspaceId: string | null = null
  private pending: Promise<void> | null = null
  private desiredMountPaths: string[] = []

  async ensureMounted(integrations: IntegrationMountInput[]): Promise<void> {
    const mountPaths = mountPathsForIntegrations(integrations)
    this.desiredMountPaths = mountPaths

    if (!mountPaths.length) {
      await this.stop()
      return
    }

    if (this.pending) return this.pending
    const pending = this.mount(mountPaths, new Set())
      .catch((error) => {
        console.warn('[integration-mounts] Failed to reconcile Relayfile integration mounts:', toErrorMessage(error))
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null
      })
    this.pending = pending
    return this.pending
  }

  async stop(): Promise<void> {
    this.desiredMountPaths = []
    const pending = this.pending
    if (pending) await pending.catch(() => undefined)
    await this.stopAll()
  }

  private async stopAll(): Promise<void> {
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
    this.authRestartedAt.clear()
    const roots = Array.from(this.handles.keys())
    for (const root of roots) {
      await this.stopHandle(root)
    }
    this.workspaceId = null
  }

  private async stopHandle(providerRoot: string): Promise<void> {
    const timer = this.refreshTimers.get(providerRoot)
    if (timer) clearTimeout(timer)
    this.refreshTimers.delete(providerRoot)
    this.authRestartedAt.delete(providerRoot)
    const handle = this.handles.get(providerRoot)
    this.handles.delete(providerRoot)
    if (handle) {
      await handle.stop().catch((error) => {
        console.warn(
          `[integration-mounts] Failed to stop Relayfile mount for ${providerRoot}:`,
          toErrorMessage(error)
        )
      })
    }
  }

  currentWorkspaceId(): string | null {
    return this.workspaceId
  }

  localPathsFor(workspaceId: string, integration: IntegrationMountInput): string[] {
    const mountPaths = Array.from(new Set(
      integration.mountPaths
        .map((mountPath) => canonicalIntegrationMountPath(mountPath, integration.provider))
        .filter((mountPath): mountPath is string => !!mountPath)
    )).sort()

    return mountPaths.map((mountPath) => integrationLocalPathForRemote(workspaceId, mountPath))
  }

  private queueForcedRestart(remotePath: string, reason: string): void {
    if (!this.handles.has(remotePath)) return
    const now = Date.now()
    const lastRestartedAt = this.authRestartedAt.get(remotePath) ?? 0
    if (now - lastRestartedAt < MOUNT_AUTH_RESTART_THROTTLE_MS) return
    this.authRestartedAt.set(remotePath, now)

    const previous = this.pending ?? Promise.resolve()
    const pending = previous
      .catch(() => undefined)
      .then(() => this.mount(this.desiredMountPaths, new Set([remotePath])))
      .catch((error) => {
        console.warn(
          `[integration-mounts] Failed to restart Relayfile mount for ${remotePath} after ${reason}:`,
          toErrorMessage(error)
        )
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null
      })
    this.pending = pending
  }

  private scheduleRefresh(remotePath: string, handle: MountedWorkspaceHandle): void {
    const existing = this.refreshTimers.get(remotePath)
    if (existing) clearTimeout(existing)
    this.refreshTimers.delete(remotePath)

    const refreshAt = refreshTimeFor(handle)
    if (!refreshAt) return

    const delayMs = Math.max(MOUNT_REFRESH_MIN_DELAY_MS, refreshAt - Date.now())
    const timer = setTimeout(() => {
      this.refreshTimers.delete(remotePath)
      this.queueForcedRestart(remotePath, 'token refresh')
    }, delayMs)
    this.refreshTimers.set(remotePath, timer)
  }

  private async mount(mountPaths: string[], forceRemotePaths: Set<string>): Promise<void> {
    const auth = await resolveCloudAuth()
    if (!auth) {
      await this.stopAll()
      return
    }

    // Integrations are bound to the account (app) workspace UUID on cloud —
    // the same workspace listCloudWorkspaceIntegrations reads from. Pear's
    // locally-created `rw_*` Relayfile workspace has no integration data, so
    // mounting it yields an empty tree (see workspace-integration-identity
    // notes in integrations.ts).
    const workspaceId = await getAccountWorkspaceId(accountWorkspaceReadyRetryOptions())
    if (this.workspaceId && this.workspaceId !== workspaceId) {
      await this.stopAll()
    }
    this.workspaceId = workspaceId

    const mountRoot = integrationMountRootForWorkspace(workspaceId)
    await ensureProtectedDirectory(join(homedir(), '.agentworkforce'))
    await ensureProtectedDirectory(join(homedir(), '.agentworkforce', 'pear'))
    await ensureProtectedDirectory(join(homedir(), '.agentworkforce', 'pear', 'relayfile'))
    await ensureProtectedDirectory(integrationMountWorkspacesRoot())
    await ensureProtectedDirectory(integrationMountWorkspaceRoot(workspaceId))
    await ensureProtectedDirectory(mountRoot)

    const setup = new RelayfileSetup({
      cloudApiUrl: auth.apiUrl,
      accessToken: async () => {
        const fresh = await resolveCloudAuth()
        return fresh?.accessToken ?? auth.accessToken
      }
    })

    const mountSpecs = this.mountSpecsFor(mountPaths, mountRoot)
    const expectedRemotePaths = mountSpecs.map((spec) => spec.remotePath)

    // Drop mounts for paths that are no longer connected.
    for (const existingRemotePath of Array.from(this.handles.keys())) {
      if (!expectedRemotePaths.includes(existingRemotePath)) {
        await this.stopHandle(existingRemotePath)
      }
    }

    for (const spec of mountSpecs) {
      const existing = this.handles.get(spec.remotePath)
      if (existing) {
        const status = await existing.status().catch(() => null)
        if (status?.ready && !forceRemotePaths.has(spec.remotePath)) {
          this.scheduleRefresh(spec.remotePath, existing)
          continue
        }
        await this.stopHandle(spec.remotePath)
      }

      await ensureProtectedDirectory(spec.localDir)
      try {
        const handle = await setup.mountWorkspace({
          workspaceId,
          localDir: spec.localDir,
          remotePath: spec.remotePath,
          mode: 'poll',
          background: true,
          agentName: spec.agentName,
          scopes: spec.scopes,
          launcher: createPearMountLauncher({
            onEvent: (event) => {
              const text = typeof event.text === 'string' ? event.text : ''
              if (isMountAuthExpiredOutput(text)) {
                this.queueForcedRestart(spec.remotePath, 'auth failure')
              }
            }
          }),
          readyTimeoutMs: MOUNT_READY_TIMEOUT_MS
        })
        this.handles.set(spec.remotePath, handle)
        this.scheduleRefresh(spec.remotePath, handle)
      } catch (error) {
        console.warn(
          `[integration-mounts] Failed to start Relayfile mount for ${spec.remotePath}:`,
          toErrorMessage(error)
        )
      }
    }

    await this.removeLegacyIntegrationMountRoot(mountRoot)
  }

  private mountSpecsFor(mountPaths: string[], mountRoot: string): IntegrationMountSpec[] {
    const specs: IntegrationMountSpec[] = mountPaths.map((mountPath) => {
      const providerSegment = remotePathSegments(mountPath)[0] || 'integration'
      const agentSegment = remotePathSegments(mountPath).join('-') || providerSegment
      return {
        remotePath: mountPath,
        localDir: join(mountRoot, ...remotePathSegments(mountPath)),
        agentName: `pear-integrations-${agentSegment}`,
        scopes: [
          `relayfile:fs:read:${mountPath}/**`,
          `relayfile:fs:write:${mountPath}/**`
        ]
      }
    })

    return specs.sort((a, b) => a.remotePath.localeCompare(b.remotePath))
  }

  private async removeLegacyIntegrationMountRoot(mountRoot: string): Promise<void> {
    const legacyRoot = join(mountRoot, 'integrations')
    await rm(legacyRoot, { recursive: true, force: true }).catch((error) => {
      console.warn(
        `[integration-mounts] Failed to remove legacy Relayfile integration mount root ${legacyRoot}:`,
        toErrorMessage(error)
      )
    })
  }
}

export const integrationMountManager = new IntegrationMountManager()

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function refreshTimeFor(handle: MountedWorkspaceHandle): number | null {
  const suggestedRefreshAt = parseTimestamp(handle.suggestedRefreshAt)
  if (suggestedRefreshAt) return suggestedRefreshAt
  const expiresAt = parseTimestamp(handle.expiresAt)
  return expiresAt ? expiresAt - MOUNT_REFRESH_FALLBACK_MARGIN_MS : null
}

function isMountAuthExpiredOutput(text: string): boolean {
  return /(?:401|unauthorized|token has expired|invalid jwt)/iu.test(text)
}

function mountPathsForIntegrations(integrations: IntegrationMountInput[]): string[] {
  return Array.from(new Set(
    integrations
      .flatMap((integration) => integration.mountPaths.map((mountPath) => canonicalIntegrationMountPath(mountPath, integration.provider)))
      .filter((mountPath): mountPath is string => !!mountPath)
  )).sort()
}
