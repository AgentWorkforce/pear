import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  RelayfileSetup,
  type MountedWorkspaceHandle
} from '@relayfile/sdk'
import { accountWorkspaceReadyRetryOptions, getAccountWorkspaceId, resolveCloudAuth } from './auth'
import { createPearMountLauncher } from './relayfile-mount-launcher'

const MOUNT_READY_TIMEOUT_MS = 60_000

type IntegrationMountInput = {
  provider: string
  mountPaths: string[]
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
  return join(integrationMountWorkspaceRoot(workspaceId), 'integrations')
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

// Provider adapters materialize data at the workspace root (`/github/...`,
// `/linear/...`), so each provider gets its own mount of that root. Derive
// the root to mount from the integration's mount paths, tolerating the
// legacy `/integrations/<provider>/...` form.
export function integrationProviderRoot(mountPath: string): string | null {
  const segments = remotePathSegments(mountPath)
  const withoutRoot = segments[0] === 'integrations' ? segments.slice(1) : segments
  return withoutRoot.length > 0 ? `/${withoutRoot[0]}` : null
}

async function ensureProtectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700).catch(() => undefined)
}

export class IntegrationMountManager {
  // One mount per provider root (e.g. '/github' → <root>/integrations/github).
  private handles = new Map<string, MountedWorkspaceHandle>()
  private workspaceId: string | null = null
  private pending: Promise<void> | null = null

  async ensureMounted(integrations: IntegrationMountInput[]): Promise<void> {
    const providerRoots = Array.from(new Set(
      integrations
        .flatMap((integration) => integration.mountPaths.map(integrationProviderRoot))
        .filter((root): root is string => !!root)
    )).sort()

    if (!providerRoots.length) {
      await this.stop()
      return
    }

    if (this.pending) return this.pending
    const pending = this.mount(providerRoots)
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
    const pending = this.pending
    if (pending) await pending.catch(() => undefined)
    await this.stopAll()
  }

  private async stopAll(): Promise<void> {
    const roots = Array.from(this.handles.keys())
    for (const root of roots) {
      await this.stopHandle(root)
    }
    this.workspaceId = null
  }

  private async stopHandle(providerRoot: string): Promise<void> {
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
    return integration.mountPaths.map((mountPath) => integrationLocalPathForRemote(workspaceId, mountPath))
  }

  private async mount(providerRoots: string[]): Promise<void> {
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

    // Drop mounts for providers that are no longer connected.
    for (const existingRoot of Array.from(this.handles.keys())) {
      if (!providerRoots.includes(existingRoot)) {
        await this.stopHandle(existingRoot)
      }
    }

    for (const providerRoot of providerRoots) {
      const existing = this.handles.get(providerRoot)
      if (existing) {
        const status = await existing.status().catch(() => null)
        if (status?.ready) continue
        await this.stopHandle(providerRoot)
      }

      const providerSegment = providerRoot.slice(1)
      const localDir = join(mountRoot, providerSegment)
      await ensureProtectedDirectory(localDir)
      try {
        const handle = await setup.mountWorkspace({
          workspaceId,
          localDir,
          remotePath: providerRoot,
          mode: 'poll',
          background: true,
          agentName: `pear-integrations-${providerSegment}`,
          scopes: [
            `relayfile:fs:read:${providerRoot}/**`,
            `relayfile:fs:write:${providerRoot}/**`
          ],
          launcher: createPearMountLauncher(),
          readyTimeoutMs: MOUNT_READY_TIMEOUT_MS
        })
        this.handles.set(providerRoot, handle)
      } catch (error) {
        console.warn(
          `[integration-mounts] Failed to start Relayfile mount for ${providerRoot}:`,
          toErrorMessage(error)
        )
      }
    }
  }
}

export const integrationMountManager = new IntegrationMountManager()
