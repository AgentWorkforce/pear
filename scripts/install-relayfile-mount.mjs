#!/usr/bin/env node
// Installs the relayfile-mount binary into bin/ so it can be bundled with the
// app (see extraResources in electron-builder.yml) and found at runtime by
// src/main/relayfile-mount-launcher.ts.
//
// Default development resolution order:
//   1. RELAYFILE_MOUNT_BIN          — explicit path to a prebuilt binary
//   2. RELAYFILE_DIST_DIR / sibling — local relayfile source checkout (../relayfile/dist)
//   3. GitHub release download      — relayfile-mount-<platform>-<arch> from the
//                                     AgentWorkforce/relayfile release matching the
//                                     installed @relayfile/sdk version
//
// Release mode (`--release` or RELAYFILE_MOUNT_INSTALL_SOURCE=release) ignores
// local binaries and installs from the matching GitHub release unless that
// release binary is already present.
import { access, chmod, copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { constants, createWriteStream } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

const optional = process.argv.includes('--optional')
const releaseMode = process.argv.includes('--release') || process.env.RELAYFILE_MOUNT_INSTALL_SOURCE === 'release'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const pearRoot = resolve(scriptDir, '..')
const require = createRequire(join(pearRoot, 'package.json'))

const target = join(pearRoot, 'bin', 'relayfile-mount')
const versionMarker = join(pearRoot, 'bin', '.relayfile-mount-version')

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

function sdkVersion() {
  try {
    const packageJsonPath = require.resolve('@relayfile/sdk/package.json')
    const localNodeModules = join(pearRoot, 'node_modules') + sep
    if (!packageJsonPath.startsWith(localNodeModules)) {
      return null
    }
    return require(packageJsonPath).version
  } catch {
    return null
  }
}

function fail(message) {
  if (optional) {
    console.warn(`[relayfile-mount] ${message}; skipping optional install`)
    process.exit(0)
  }
  console.error(`[relayfile-mount] ${message}`)
  console.error(
    '[relayfile-mount] Set RELAYFILE_MOUNT_BIN, set RELAYFILE_DIST_DIR to a relayfile build, or check network access to github.com.'
  )
  process.exit(1)
}

async function installFromFile(source, marker = `local:${source}`) {
  await mkdir(dirname(target), { recursive: true })
  if ((await realpath(source).catch(() => null)) === (await realpath(target).catch(() => null))) {
    await chmod(target, 0o755)
    await writeFile(versionMarker, `${marker}\n`)
    console.log(`[relayfile-mount] already installed at ${target}`)
    return
  }
  await copyFile(source, target)
  await chmod(target, 0o755)
  await writeFile(versionMarker, `${marker}\n`)
  console.log(`[relayfile-mount] installed ${source} -> ${target}`)
}

async function downloadRelease(version) {
  const asset = `relayfile-mount-${archSuffix()}`
  const url = `https://github.com/AgentWorkforce/relayfile/releases/download/v${version}/${asset}`
  console.log(`[relayfile-mount] downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText} for ${url}`)
  }
  await mkdir(dirname(target), { recursive: true })
  const tempPath = `${target}.tmp-${process.pid}`
  try {
    await pipeline(response.body, createWriteStream(tempPath))
    await chmod(tempPath, 0o755)
    await rename(tempPath, target)
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(tempPath, { force: true }))
    throw error
  }
  await writeFile(versionMarker, `${version}\n`)
  console.log(`[relayfile-mount] installed v${version} -> ${target}`)
}

async function installedMarker() {
  return (await canRead(target)) && (await canRead(versionMarker))
    ? (await readFile(versionMarker, 'utf8')).trim()
    : null
}

function requireSdkVersion() {
  const version = sdkVersion()
  if (!version) {
    fail('could not determine @relayfile/sdk version (is it installed?)')
  }
  return version
}

if (releaseMode) {
  const version = requireSdkVersion()
  const installedVersion = await installedMarker()
  if (installedVersion === version) {
    console.log(`[relayfile-mount] v${version} already installed at ${target}`)
    process.exit(0)
  }
  try {
    await downloadRelease(version)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  process.exit(0)
}

// 1. Explicit binary path
if (process.env.RELAYFILE_MOUNT_BIN) {
  const source = resolve(process.env.RELAYFILE_MOUNT_BIN)
  if (!(await canRead(source))) {
    fail(`RELAYFILE_MOUNT_BIN points to an unreadable path: ${source}`)
  }
  await installFromFile(source)
  process.exit(0)
}

// 2. Local relayfile source checkout
const localDist = resolve(
  process.env.RELAYFILE_DIST_DIR || join(pearRoot, '..', 'relayfile', 'dist'),
  `relayfile-mount-${archSuffix()}`
)
if (await canRead(localDist)) {
  await installFromFile(localDist)
  process.exit(0)
}

// 3. GitHub release matching the installed @relayfile/sdk version
const version = requireSdkVersion()
const installedVersion = await installedMarker()
if (installedVersion === version) {
  console.log(`[relayfile-mount] v${version} already installed at ${target}`)
  process.exit(0)
}

try {
  await downloadRelease(version)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
