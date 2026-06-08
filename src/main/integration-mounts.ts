import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  RelayfileSetup,
  type MountLauncher,
  type MountLauncherStart,
  type MountedWorkspaceHandle
} from '@relayfile/sdk'
import { accountWorkspaceReadyRetryOptions, getAccountWorkspaceId, refreshCloudAuth, resolveCloudAuth } from './auth'
import { createPearMountLauncher } from './relayfile-mount-launcher'
import { isSlackWritebackCommandRoot } from './slack-writeback-command-roots'

const MOUNT_READY_TIMEOUT_MS = 60_000
const MOUNT_SYNC_TIMEOUT = '180s'
const MOUNT_REFRESH_FALLBACK_MARGIN_MS = 5 * 60_000
const MOUNT_REFRESH_MIN_DELAY_MS = 1_000
const MOUNT_AUTH_RESTART_THROTTLE_MS = 60_000
// Stays under MOUNT_AUTH_RESTART_THROTTLE_MS so back-to-back poll hits
// coalesce into one restart instead of racing it.
const MOUNT_HEALTH_POLL_INTERVAL_MS = 45_000
const MOUNT_SYNC_WEDGE_FAILURES = 3
export const MAX_LOCAL_INTEGRATION_MOUNT_PATHS = 24

type IntegrationMountInput = {
  provider: string
  mountPaths: string[]
}

export type MountHealthAlert = {
  type: 'auth-stall'
  remotePath: string
  status: string | null
  pendingWriteback: number
  message: string
} | {
  type: 'auth-required'
  reason: MountAuthRequiredReason
  message: string
}

type MountAuthRequiredReason = 'cloud-auth-required' | 'account-workspace-required'

type IntegrationMountSpec = {
  remotePath: string
  localDir: string
  localLayout: 'exact'
  syncMode: 'mirror' | 'write-only'
  agentName: string
  scopes: string[]
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAccountWorkspaceRequiredError(error: unknown): boolean {
  return /account-workspace-required/i.test(toErrorMessage(error))
}

function isCloudAuthRequiredError(error: unknown): boolean {
  return /cloud-auth-required/i.test(toErrorMessage(error))
}

function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { httpStatus?: unknown; status?: unknown }).httpStatus ??
    (error as { httpStatus?: unknown; status?: unknown }).status
  if (status === 401 || status === 403) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /\b(401|403|unauthor|forbidden)\b/i.test(message)
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

function hasTraversalPathSegment(remotePath: string): boolean {
  return remotePath
    .split(/[\\/]+/u)
    .map((segment) => segment.trim())
    .some((segment) => segment === '.' || segment === '..')
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
  if (hasTraversalPathSegment(mountPath)) return null
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
  private healthPollTimer: ReturnType<typeof setInterval> | null = null
  private healthObserver: ((alert: MountHealthAlert) => void) | null = null
  private handledHealthErrorKeys = new Map<string, string>()
  private lastAuthRequiredReason: MountAuthRequiredReason | null = null

  setHealthObserver(observer: ((alert: MountHealthAlert) => void) | null): void {
    this.healthObserver = observer
  }

  async ensureMounted(integrations: IntegrationMountInput[]): Promise<void> {
    const mountPaths = mountPathsForIntegrations(integrations)
    this.desiredMountPaths = mountPaths

    if (!mountPaths.length) {
      await this.stop()
      return
    }

    if (this.pending) return this.pending
    const pending = this.mount(mountPaths, new Set(), new Set())
      .catch((error) => {
        if (isCloudAuthRequiredError(error) || isAccountWorkspaceRequiredError(error)) {
          this.reportAuthRequired(error)
          throw error
        }
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
    if (this.healthPollTimer) clearInterval(this.healthPollTimer)
    this.healthPollTimer = null
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
    this.authRestartedAt.clear()
    this.handledHealthErrorKeys.clear()
    this.lastAuthRequiredReason = null
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
    let mountPaths = Array.from(new Set(
      integration.mountPaths
        .map((mountPath) => canonicalIntegrationMountPath(mountPath, integration.provider))
        .filter((mountPath): mountPath is string => !!mountPath)
    )).sort()
    if (this.workspaceId === workspaceId && this.handles.size > 0) {
      const mountedPaths = new Set(this.handles.keys())
      mountPaths = mountPaths.filter((mountPath) => mountedPaths.has(mountPath))
    }

    return mountPaths.map((mountPath) => integrationLocalPathForRemote(workspaceId, mountPath))
  }

  // The mount binary runs detached (background: true) and logs sync failures
  // to .relay/mount.log plus its state file — the launcher's stdout scrape only
  // sees startup output, so mid-session stalls otherwise stay silent. Polling
  // state/log files is the deterministic signal; stdout remains a startup guard.
  private ensureHealthPolling(): void {
    if (this.healthPollTimer || this.handles.size === 0) return
    const timer = setInterval(() => {
      void this.checkMountHealth()
    }, MOUNT_HEALTH_POLL_INTERVAL_MS)
    timer.unref?.()
    this.healthPollTimer = timer
  }

  private async checkMountHealth(): Promise<void> {
    for (const [remotePath, handle] of Array.from(this.handles.entries())) {
      const state = await readMountStateFile(handle.localDir)
      if (state) {
        const lastError = asRecord(state.lastError)
        if (lastError) {
          const errorAt = parseTimestamp(typeof lastError.at === 'string' ? lastError.at : null)
          const lastSuccessAt = parseTimestamp(
            typeof state.lastSuccessfulReconcileAt === 'string' ? state.lastSuccessfulReconcileAt : null
          )
          // Only act on errors newer than the last good cycle — a recovered mount
          // keeps its historical lastError in state.json.
          if (errorAt !== null && lastSuccessAt !== null && errorAt <= lastSuccessAt) {
            this.handledHealthErrorKeys.delete(remotePath)
          } else {
            const message = typeof lastError.message === 'string' ? lastError.message : ''
            const unauthorized = lastError.statusCode === 401 ||
              lastError.code === 'unauthorized' ||
              isMountAuthExpiredOutput(message)
            if (unauthorized) {
              const healthErrorKey = [
                errorAt ?? 'missing-at',
                typeof lastError.statusCode === 'number' ? lastError.statusCode : '',
                typeof lastError.code === 'string' ? lastError.code : '',
                message
              ].join('|')
              if (this.handledHealthErrorKeys.get(remotePath) !== healthErrorKey) {
                const pendingWriteback = typeof state.pendingWriteback === 'number' ? state.pendingWriteback : 0
                const queued = this.queueForcedRestart(remotePath, 'auth failure (state poll)')
                if (queued) {
                  this.handledHealthErrorKeys.set(remotePath, healthErrorKey)
                  console.warn(
                    `[integration-mounts] Mount auth expired for ${remotePath} (state poll); restarting with fresh credentials`,
                    { pendingWriteback, error: message || 'unauthorized' }
                  )
                  this.healthObserver?.({
                    type: 'auth-stall',
                    remotePath,
                    status: typeof state.status === 'string' ? state.status : null,
                    pendingWriteback,
                    message: message || 'unauthorized'
                  })
                }
              }
            }
          }
        }
      }

      const syncWedge = await readMountSyncWedge(handle.localDir)
      if (syncWedge) {
        const healthErrorKey = [
          syncWedge.lastFailureAt,
          syncWedge.failureCount,
          syncWedge.message
        ].join('|')
        if (this.handledHealthErrorKeys.get(remotePath) === healthErrorKey) continue
        const queued = this.queueForcedRestart(remotePath, 'sync wedge', { clearState: true })
        if (queued) {
          this.handledHealthErrorKeys.set(remotePath, healthErrorKey)
          console.warn(
            `[integration-mounts] Mount sync wedged for ${remotePath}; restarting`,
            {
              failures: syncWedge.failureCount,
              lastFailureAt: syncWedge.lastFailureAt,
              error: syncWedge.message
            }
          )
        } else {
          this.handledHealthErrorKeys.set(remotePath, healthErrorKey)
        }
      }
    }
  }

  private queueForcedRestart(remotePath: string, reason: string, options: { clearState?: boolean } = {}): boolean {
    if (!this.handles.has(remotePath)) return false
    const now = Date.now()
    const lastRestartedAt = this.authRestartedAt.get(remotePath) ?? 0
    if (now - lastRestartedAt < MOUNT_AUTH_RESTART_THROTTLE_MS) return false
    this.authRestartedAt.set(remotePath, now)

    const previous = this.pending ?? Promise.resolve()
    const pending = previous
      .catch(() => undefined)
      .then(() => this.mount(
        this.desiredMountPaths,
        new Set([remotePath]),
        options.clearState ? new Set([remotePath]) : new Set()
      ))
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
    return true
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

  private async mount(
    mountPaths: string[],
    forceRemotePaths: Set<string>,
    clearStateRemotePaths: Set<string>
  ): Promise<void> {
    const auth = await resolveCloudAuth()
    if (!auth) {
      await this.stopAll()
      throw new Error('cloud-auth-required')
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

    let activeAuth = auth
    let setup = this.createSetup(activeAuth)

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
        const existingLocalDir = existing.localDir
        await this.stopHandle(spec.remotePath)
        if (clearStateRemotePaths.has(spec.remotePath)) {
          await clearMountStateFiles(spec.remotePath, existingLocalDir)
        }
      }

      await ensureProtectedDirectory(spec.localDir)
      try {
        const startMount = async (): Promise<MountedWorkspaceHandle> => {
          const mountInput = {
            workspaceId,
            localDir: spec.localDir,
            remotePath: spec.remotePath,
            mode: 'poll' as const,
            localLayout: spec.localLayout,
            syncMode: spec.syncMode,
            background: true,
            agentName: spec.agentName,
            scopes: spec.scopes,
            launcher: this.createContractLauncher(spec, createPearMountLauncher({
              onEvent: (event) => {
                const text = typeof event.text === 'string' ? event.text : ''
                if (isMountAuthExpiredOutput(text)) {
                  this.queueForcedRestart(spec.remotePath, 'auth failure')
                }
              }
            })),
            readyTimeoutMs: MOUNT_READY_TIMEOUT_MS
          }
          return setup.mountWorkspace(mountInput)
        }
        let handle: MountedWorkspaceHandle
        try {
          handle = await startMount()
        } catch (error) {
          if (!isUnauthorizedError(error)) throw error
          const refreshed = await refreshCloudAuth()
          if (!refreshed) throw error
          activeAuth = refreshed
          setup = this.createSetup(activeAuth)
          handle = await startMount()
        }
        this.handles.set(spec.remotePath, handle)
        this.scheduleRefresh(spec.remotePath, handle)
      } catch (error) {
        if (isUnauthorizedError(error)) {
          throw new Error('cloud-auth-required')
        }
        console.warn(
          `[integration-mounts] Failed to start Relayfile mount for ${spec.remotePath}:`,
          toErrorMessage(error)
        )
      }
    }

    await this.removeLegacyIntegrationMountRoot(mountRoot)
    this.lastAuthRequiredReason = null
    this.ensureHealthPolling()
  }

  private reportAuthRequired(error: unknown): void {
    const reason: MountAuthRequiredReason = isAccountWorkspaceRequiredError(error)
      ? 'account-workspace-required'
      : 'cloud-auth-required'
    if (this.lastAuthRequiredReason === reason) return
    this.lastAuthRequiredReason = reason
    console.warn('[integration-mounts] Relayfile integration mounts require auth recovery:', { reason })
    this.healthObserver?.({
      type: 'auth-required',
      reason,
      message: reason
    })
  }

  private createSetup(auth: { apiUrl: string; accessToken: string }): RelayfileSetup {
    return new RelayfileSetup({
      cloudApiUrl: auth.apiUrl,
      accessToken: async () => {
        const fresh = await resolveCloudAuth()
        return fresh?.accessToken ?? auth.accessToken
      }
    })
  }

  private mountSpecsFor(mountPaths: string[], mountRoot: string): IntegrationMountSpec[] {
    const specs: IntegrationMountSpec[] = mountPaths.map((mountPath) => {
      const providerSegment = remotePathSegments(mountPath)[0] || 'integration'
      const agentSegment = remotePathSegments(mountPath).join('-') || providerSegment
      return {
        remotePath: mountPath,
        localDir: join(mountRoot, ...remotePathSegments(mountPath)),
        localLayout: 'exact',
        syncMode: isSlackWritebackCommandRoot(mountPath) ? 'write-only' : 'mirror',
        agentName: `pear-integrations-${agentSegment}`,
        scopes: [
          `relayfile:fs:read:${mountPath}/**`,
          `relayfile:fs:write:${mountPath}/**`
        ]
      }
    })

    return specs.sort((a, b) => a.remotePath.localeCompare(b.remotePath))
  }

  private createContractLauncher(spec: IntegrationMountSpec, launcher: MountLauncher): MountLauncher {
    return {
      ...launcher,
      start: (input: MountLauncherStart) => launcher.start({
        ...input,
        env: {
          ...input.env,
          RELAYFILE_MOUNT_LOCAL_LAYOUT: spec.localLayout,
          RELAYFILE_MOUNT_SYNC_MODE: spec.syncMode,
          RELAYFILE_MOUNT_TIMEOUT: input.env.RELAYFILE_MOUNT_TIMEOUT ||
            process.env.RELAYFILE_MOUNT_TIMEOUT ||
            MOUNT_SYNC_TIMEOUT
        }
      })
    }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// relayfile-mount v0.7.x writes .relayfile-mount-state.json at the mount root;
// newer SDK probes may also expose .relay/state.json. A missing or mid-write
// file resolves null and the poll simply retries next cycle.
async function readMountStateFile(localDir: string): Promise<Record<string, unknown> | null> {
  for (const statePath of [
    join(localDir, '.relayfile-mount-state.json'),
    join(localDir, '.relay', 'state.json')
  ]) {
    let rawState: string
    try {
      rawState = await readFile(statePath, 'utf8')
    } catch {
      continue
    }
    try {
      const state = asRecord(JSON.parse(rawState))
      if (state) return state
    } catch {
      return null
    }
  }
  return null
}

async function clearMountStateFiles(remotePath: string, localDir: string): Promise<void> {
  await Promise.all([
    join(localDir, '.relayfile-mount-state.json'),
    join(localDir, '.relay', 'state.json')
  ].map(async (statePath) => {
    await rm(statePath, { force: true }).catch((error) => {
      console.warn(
        `[integration-mounts] Failed to remove stale Relayfile mount state for ${remotePath} at ${statePath}:`,
        toErrorMessage(error)
      )
    })
  }))
}

type MountSyncWedge = {
  failureCount: number
  lastFailureAt: string
  message: string
}

async function readMountSyncWedge(localDir: string): Promise<MountSyncWedge | null> {
  let logText: string
  try {
    logText = await readFile(join(localDir, '.relay', 'mount.log'), 'utf8')
  } catch {
    return null
  }

  let consecutiveFailures = 0
  let lastFailureAt: string | null = null
  let message = ''
  for (const line of logText.trim().split(/\r?\n/u).slice(-120).reverse()) {
    if (line.includes('mount sync cycle completed')) break
    const failed = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) mount sync cycle failed: (.+)$/u)
    if (!failed) continue
    const failedMessage = failed[2] || ''
    if (!isMountSyncWedgeOutput(failedMessage)) break
    consecutiveFailures += 1
    lastFailureAt ??= failed[1]?.replace(/\//gu, '-').replace(' ', 'T') ?? 'unknown'
    message ||= failedMessage
  }

  if (consecutiveFailures < MOUNT_SYNC_WEDGE_FAILURES || !lastFailureAt) return null
  return {
    failureCount: consecutiveFailures,
    lastFailureAt,
    message
  }
}

function isMountSyncWedgeOutput(text: string): boolean {
  return /context deadline exceeded|i\/o timeout|Client\.Timeout exceeded/i.test(text)
}

function mountPathsForIntegrations(integrations: IntegrationMountInput[]): string[] {
  const mountPaths = Array.from(new Set(
    integrations
      .flatMap((integration) => integration.mountPaths.map((mountPath) => canonicalIntegrationMountPath(mountPath, integration.provider)))
      .filter((mountPath): mountPath is string => !!mountPath)
  )).sort()
  if (mountPaths.length <= MAX_LOCAL_INTEGRATION_MOUNT_PATHS) return mountPaths

  const kept = mountPaths.slice(0, MAX_LOCAL_INTEGRATION_MOUNT_PATHS)
  const skipped = mountPaths.slice(MAX_LOCAL_INTEGRATION_MOUNT_PATHS)
  console.warn(
    `[integration-mounts] Local integration mount budget exceeded; mounting ${kept.length} of ${mountPaths.length} paths. ` +
    `Skipped: ${skipped.join(', ')}`
  )
  return kept
}
