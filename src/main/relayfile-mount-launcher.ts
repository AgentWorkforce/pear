import { accessSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import {
  createDefaultMountLauncher,
  type MountLauncher,
  type MountLauncherStart
} from '@relayfile/sdk'

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

export function createPearMountLauncher(options: { onEvent?: MountLauncherStart['onEvent'] } = {}): MountLauncher {
  const launcher = createDefaultMountLauncher()
  return {
    start: (input) => {
      const binary = ensureRelayfileMountBinary()
      return launcher.start({
        ...input,
        env: {
          ...input.env,
          RELAYFILE_MOUNT_BIN: binary
        },
        onEvent: (event) => {
          options.onEvent?.(event)
          input.onEvent?.(event)
        }
      })
    }
  }
}
