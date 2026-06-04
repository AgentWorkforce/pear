#!/usr/bin/env node
import { access, chmod, copyFile, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const optional = process.argv.includes('--optional')
const scriptDir = dirname(fileURLToPath(import.meta.url))
const pearRoot = resolve(scriptDir, '..')

function archSuffix() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64'
  }
  return `${process.platform}-${process.arch}`
}

async function canRead(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

const source = process.env.RELAYFILE_MOUNT_BIN
  ? resolve(process.env.RELAYFILE_MOUNT_BIN)
  : resolve(
      process.env.RELAYFILE_DIST_DIR || join(pearRoot, '..', 'relayfile', 'dist'),
      `relayfile-mount-${archSuffix()}`
    )
const target = join(pearRoot, 'bin', 'relayfile-mount')

if (!await canRead(source)) {
  const message = `relayfile-mount binary not found at ${source}`
  if (optional) {
    console.warn(`[relayfile-mount] ${message}; skipping optional install`)
    process.exit(0)
  }
  console.error(`[relayfile-mount] ${message}`)
  console.error('[relayfile-mount] Build relayfile first, set RELAYFILE_DIST_DIR, or set RELAYFILE_MOUNT_BIN.')
  process.exit(1)
}

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
await chmod(target, 0o755)
console.log(`[relayfile-mount] installed ${source} -> ${target}`)
