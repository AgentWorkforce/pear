import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { type MountLauncher, type MountLauncherStart } from '@relayfile/sdk'
import { createDefaultMountLauncher } from '@relayfile/sdk/mount-launcher'

function canExecute(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function archSuffix(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64'
  }
  return `${process.platform}-${process.arch}`
}

export function resolveRelayfileMountBinary(): string | null {
  if (canExecute(process.env.RELAYFILE_MOUNT_BIN)) return resolve(process.env.RELAYFILE_MOUNT_BIN)

  const appPath = app.getAppPath()
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'bin', 'relayfile-mount'),
        join(appPath.replace('app.asar', 'app.asar.unpacked'), 'bin', 'relayfile-mount')
      ]
    : [
        join(appPath, 'bin', 'relayfile-mount'),
        join(process.cwd(), 'bin', 'relayfile-mount'),
        join(appPath, '..', 'relayfile', 'dist', `relayfile-mount-${archSuffix()}`),
        join(process.cwd(), '..', 'relayfile', 'dist', `relayfile-mount-${archSuffix()}`)
      ]

  for (const candidate of candidates) {
    if (canExecute(candidate)) return resolve(candidate)
  }

  return null
}

export function ensureRelayfileMountBinary(): string {
  const binary = resolveRelayfileMountBinary()
  if (!binary) {
    throw new Error(
      'relayfile-mount binary not found. Run `npm run relayfile-mount:install` or set RELAYFILE_MOUNT_BIN.'
    )
  }
  process.env.RELAYFILE_MOUNT_BIN = binary
  return binary
}

// Creds-file contract (mount-token refresh workstream): JSON {token, mintedAt,
// expiresAt?}, token required, timestamps advisory; written atomically via
// tmp+rename. A creds-aware mount binary re-reads this file on 401 instead of
// stalling on its static launch token; older binaries ignore the env var
// entirely (same precedent as RELAYFILE_MOUNT_LOCAL_LAYOUT, relayfile#243), so
// no version gating is needed. Every mount (re)start rewrites the file with
// the freshly minted token.
async function writeMountCredsFile(localDir: string, token: string): Promise<string | null> {
  const credsPath = join(localDir, '.relay', 'creds.json')
  try {
    const relayDir = join(localDir, '.relay')
    await mkdir(relayDir, { recursive: true, mode: 0o700 })
    await chmod(relayDir, 0o700).catch(() => undefined)
    const tmpPath = `${credsPath}.tmp`
    await writeFile(tmpPath, JSON.stringify({ token, mintedAt: new Date().toISOString() }), {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(tmpPath, credsPath)
    await chmod(credsPath, 0o600).catch(() => undefined)
    return credsPath
  } catch (error) {
    console.warn('[relayfile-mount-launcher] Failed to write mount creds file:', error)
    return null
  }
}

export function createPearMountLauncher(options: { onEvent?: MountLauncherStart['onEvent'] } = {}): MountLauncher {
  const launcher = createDefaultMountLauncher()
  return {
    start: async (input) => {
      const binary = ensureRelayfileMountBinary()
      const token = input.env.RELAYFILE_TOKEN
      const localDir = input.env.RELAYFILE_LOCAL_DIR
      const credsPath = token && localDir ? await writeMountCredsFile(localDir, token) : null
      return launcher.start({
        ...input,
        env: {
          ...input.env,
          RELAYFILE_MOUNT_BIN: binary,
          ...(credsPath ? { RELAYFILE_MOUNT_CREDS_FILE: credsPath } : {})
        },
        onEvent: (event) => {
          options.onEvent?.(event)
          input.onEvent?.(event)
        }
      })
    }
  }
}
