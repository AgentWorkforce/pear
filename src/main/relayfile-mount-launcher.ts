import { accessSync, constants } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { type MountLauncher, type MountLauncherStart } from '@relayfile/sdk'
import { createDefaultMountLauncher } from '@relayfile/sdk/mount-launcher'
import { normalizeRelayServiceEnv } from './relay-service-urls'

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

// Locate the relayfile-mount binary shipped as the per-platform optional
// package (@relayfile/mount-<platform>-<arch>), installed transitively via
// @relayfile/sdk's optionalDependencies — the same distribution model as the
// agent-relay broker (see resolveBundledBrokerBinary in broker.ts). The SDK
// itself resolves this via import.meta.url, but that points at out/main/ once
// electron-vite bundles the main process, so we resolve from __dirname instead.
function optionalPackageMountBinaries(): string[] {
  const pkgArch = `${process.platform}-${process.arch}`
  const binName = process.platform === 'win32' ? 'relayfile-mount.exe' : 'relayfile-mount'
  const unpackIfPackaged = (binary: string): string =>
    app.isPackaged ? binary.replace('app.asar', 'app.asar.unpacked') : binary
  // __dirname is out/main; ../../ reaches the app root that holds node_modules.
  const nodeModules = join(__dirname, '..', '..', 'node_modules')
  return [
    // Hoisted to the app's top-level node_modules (the common case).
    join(nodeModules, '@relayfile', `mount-${pkgArch}`, 'bin', binName),
    // Nested under @relayfile/sdk when npm can't hoist it.
    join(nodeModules, '@relayfile', 'sdk', 'node_modules', '@relayfile', `mount-${pkgArch}`, 'bin', binName)
  ].map(unpackIfPackaged)
}

export function resolveRelayfileMountBinary(): string | null {
  if (canExecute(process.env.RELAYFILE_MOUNT_BIN)) return resolve(process.env.RELAYFILE_MOUNT_BIN)

  const appPath = app.getAppPath()
  const candidates = [
    // Primary production path: the per-platform optional-dependency package.
    ...optionalPackageMountBinaries(),
    // Development / source-checkout fallbacks.
    ...(app.isPackaged
      ? [
          join(process.resourcesPath, 'bin', 'relayfile-mount'),
          join(appPath.replace('app.asar', 'app.asar.unpacked'), 'bin', 'relayfile-mount')
        ]
      : [
          join(appPath, 'bin', 'relayfile-mount'),
          join(process.cwd(), 'bin', 'relayfile-mount'),
          join(appPath, '..', 'relayfile', 'dist', `relayfile-mount-${archSuffix()}`),
          join(process.cwd(), '..', 'relayfile', 'dist', `relayfile-mount-${archSuffix()}`)
        ])
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
    await mkdir(join(localDir, '.relay'), { recursive: true })
    const tmpPath = `${credsPath}.tmp`
    await writeFile(tmpPath, JSON.stringify({ token, mintedAt: new Date().toISOString() }), 'utf8')
    await rename(tmpPath, credsPath)
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
          ...normalizeRelayServiceEnv(input.env),
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
