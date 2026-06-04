import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  RelayfileSetup,
  type MountedWorkspaceHandle
} from '@relayfile/sdk'
import { resolveCloudAuth } from './auth'
import { getRelayWorkspaceManager } from './relay-workspace'
import { createPearMountLauncher } from './relayfile-mount-launcher'

const INTEGRATIONS_REMOTE_ROOT = '/integrations'
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

async function ensureProtectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700).catch(() => undefined)
}

export class IntegrationMountManager {
  private handle: MountedWorkspaceHandle | null = null
  private workspaceId: string | null = null
  private pending: Promise<void> | null = null

  async ensureMounted(integrations: IntegrationMountInput[]): Promise<void> {
    const hasIntegrations = integrations.some((integration) => integration.mountPaths.length > 0)
    if (!hasIntegrations) {
      await this.stop()
      return
    }

    if (this.pending) return this.pending
    const pending = this.mount(integrations)
      .catch((error) => {
        console.warn('[integration-mounts] Failed to start Relayfile integration mount:', toErrorMessage(error))
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
    await this.stopCurrent()
  }

  private async stopCurrent(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.workspaceId = null
    if (handle) {
      await handle.stop().catch((error) => {
        console.warn('[integration-mounts] Failed to stop Relayfile integration mount:', toErrorMessage(error))
      })
    }
  }

  currentWorkspaceId(): string | null {
    return this.workspaceId
  }

  localPathsFor(workspaceId: string, integration: IntegrationMountInput): string[] {
    return integration.mountPaths.map((mountPath) => integrationLocalPathForRemote(workspaceId, mountPath))
  }

  private async mount(_integrations: IntegrationMountInput[]): Promise<void> {
    const auth = await resolveCloudAuth()
    if (!auth) {
      await this.stopCurrent()
      return
    }

    const workspaceId = await getRelayWorkspaceManager().getWorkspaceId()
    if (this.handle && this.workspaceId === workspaceId) {
      const status = await this.handle.status().catch(() => null)
      if (status?.ready) return
      await this.stopCurrent()
    } else if (this.handle) {
      await this.stopCurrent()
    }

    const localDir = integrationMountRootForWorkspace(workspaceId)
    await ensureProtectedDirectory(join(homedir(), '.agentworkforce'))
    await ensureProtectedDirectory(join(homedir(), '.agentworkforce', 'pear'))
    await ensureProtectedDirectory(join(homedir(), '.agentworkforce', 'pear', 'relayfile'))
    await ensureProtectedDirectory(integrationMountWorkspacesRoot())
    await ensureProtectedDirectory(integrationMountWorkspaceRoot(workspaceId))
    await ensureProtectedDirectory(localDir)
    const setup = new RelayfileSetup({
      cloudApiUrl: auth.apiUrl,
      accessToken: async () => {
        const fresh = await resolveCloudAuth()
        return fresh?.accessToken ?? auth.accessToken
      }
    })
    this.handle = await setup.mountWorkspace({
      workspaceId,
      localDir,
      remotePath: INTEGRATIONS_REMOTE_ROOT,
      mode: 'poll',
      background: true,
      agentName: 'pear-integrations',
      scopes: ['relayfile:fs:read:/integrations/**', 'relayfile:fs:write:/integrations/**'],
      launcher: createPearMountLauncher(),
      readyTimeoutMs: MOUNT_READY_TIMEOUT_MS
    })
    this.workspaceId = workspaceId
  }
}

export const integrationMountManager = new IntegrationMountManager()
