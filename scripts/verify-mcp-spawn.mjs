#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedDependencyClosure, packagePath } from './lib/dependency-closure.mjs'

const APP_NAME = 'Pear by Agent Relay.app'
const MCP_RESOURCE_ROOT = join('agent-relay-mcp', 'node_modules')
const MCP_SCRIPT_RELATIVE = join(MCP_RESOURCE_ROOT, 'agent-relay', 'dist', 'cli', 'agent-relay-mcp.js')
const MCP_LAUNCHER_RELATIVE = join('agent-relay-mcp', process.platform === 'win32' ? 'launch.cmd' : 'launch.sh')
const TIMEOUT_MS = 10_000

function fail(message) {
  console.error(`verify-mcp-spawn: ${message}`)
  process.exit(1)
}

function findBuiltApp(rootDir) {
  const explicit = process.argv[2]
  if (explicit) {
    const appPath = resolve(explicit)
    if (!existsSync(appPath)) fail(`app path does not exist: ${appPath}`)
    return appPath
  }

  const distDir = join(rootDir, 'dist')
  if (!existsSync(distDir)) fail(`dist directory not found: ${distDir}`)

  const candidates = []
  const stack = [distDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        candidates.push(fullPath)
        continue
      }
      if (entry.isDirectory() && !entry.name.endsWith('.app')) stack.push(fullPath)
    }
  }

  if (candidates.length === 0) fail(`could not find ${APP_NAME} under ${distDir}`)
  candidates.sort((left, right) => {
    const leftPreferred = left.endsWith(APP_NAME) ? 0 : 1
    const rightPreferred = right.endsWith(APP_NAME) ? 0 : 1
    return leftPreferred - rightPreferred || left.localeCompare(right)
  })
  return candidates[0]
}

function appResourcesPath(appPath) {
  if (process.platform === 'darwin' || appPath.endsWith('.app')) {
    return join(appPath, 'Contents', 'Resources')
  }
  return join(appPath, 'resources')
}

function appExecutablePath(appPath) {
  if (process.platform === 'darwin' || appPath.endsWith('.app')) {
    const macosDir = join(appPath, 'Contents', 'MacOS')
    const executable = readdirSync(macosDir)
      .map((entry) => join(macosDir, entry))
      .find((entryPath) => {
        const stat = statSync(entryPath)
        return stat.isFile() && (stat.mode & 0o111) !== 0
      })
    if (!executable) fail(`could not find app executable in ${macosDir}`)
    return executable
  }
  return appPath
}

function assertExternalPayload(rootDir, resourcesPath) {
  const scriptPath = join(resourcesPath, MCP_SCRIPT_RELATIVE)
  const launcherPath = join(resourcesPath, MCP_LAUNCHER_RELATIVE)
  const asarSegment = `${sep}app.asar${sep}`
  for (const candidate of [scriptPath, launcherPath]) {
    if (candidate.includes(asarSegment)) fail(`MCP path points inside app.asar: ${candidate}`)
  }
  if (!existsSync(scriptPath)) fail(`MCP script missing from packaged resources: ${scriptPath}`)
  if (!statSync(scriptPath).isFile()) fail(`MCP script path is not a file: ${scriptPath}`)
  if (!existsSync(launcherPath)) fail(`MCP launcher missing from packaged resources: ${launcherPath}`)
  if (!statSync(launcherPath).isFile()) fail(`MCP launcher path is not a file: ${launcherPath}`)
  if (process.platform !== 'win32' && (statSync(launcherPath).mode & 0o111) === 0) {
    fail(`MCP launcher is not executable: ${launcherPath}`)
  }

  const payloadNodeModules = join(resourcesPath, MCP_RESOURCE_ROOT)
  for (const packageName of installedDependencyClosure(rootDir)) {
    const payloadPackageJson = packagePath(payloadNodeModules, packageName)
    if (!existsSync(payloadPackageJson)) {
      fail(`packaged MCP payload missing runtime dependency ${packageName}: ${payloadPackageJson}`)
    }
  }

  return { launcherPath, scriptPath }
}

function encodeMessage(payload) {
  return `${JSON.stringify(payload)}\n`
}

function parseMessages(buffer) {
  const text = buffer.toString('utf8')
  const lines = text.split(/\r?\n/)
  const completeLines = text.endsWith('\n') || text.endsWith('\r\n') ? lines : lines.slice(0, -1)
  const messages = []
  for (const line of completeLines.filter(Boolean)) {
    try {
      messages.push(JSON.parse(line))
    } catch {
      // Ignore stdout noise; MCP JSON-RPC responses are still required below.
    }
  }
  return messages
}

async function verifyInitialize(commandPath) {
  const child = spawn(commandPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: smokeEnv()
  })

  let stdout = Buffer.alloc(0)
  let stderr = ''
  let settled = false

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'pear-packaged-mcp-smoke',
        version: '1.0.0'
      }
    }
  }

  child.stdin.write(encodeMessage(request))

  return await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      finish(new Error(`timed out waiting for MCP initialize response\nstderr:\n${stderr}`))
    }, TIMEOUT_MS)

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk])
      for (const message of parseMessages(stdout)) {
        if (message.id !== 1) continue
        const serverInfo = message.result?.serverInfo
        if (serverInfo?.name !== 'agent-relay') {
          finish(new Error(`unexpected MCP initialize response: ${JSON.stringify(message)}`))
          return
        }
        finish()
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', finish)
    child.on('exit', (code, signal) => {
      if (!settled && code !== null) finish(new Error(`MCP process exited before initialize response: code=${code} signal=${signal}\nstderr:\n${stderr}`))
    })
  })
}

async function resolvePackagedMcpCommand(rootDir, resourcesPath, executablePath) {
  const harnessPath = join(rootDir, 'scripts', 'resolve-packaged-mcp-command.mjs')
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--no-warnings',
    harnessPath,
    resourcesPath,
    executablePath
  ], {
    cwd: rootDir,
    env: smokeEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  return await new Promise((resolvePromise, rejectPromise) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', rejectPromise)
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        rejectPromise(new Error(`resolver harness failed: code=${code} signal=${signal}\nstderr:\n${stderr}`))
        return
      }
      resolvePromise(stdout.trim())
    })
  })
}

function smokeEnv() {
  const allowedKeys = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USER'
  ]
  const env = {}
  for (const key of allowedKeys) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin'
  env.RELAY_SKIP_BOOTSTRAP = '1'
  return env
}

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const appPath = findBuiltApp(rootDir)
const resourcesPath = appResourcesPath(appPath)
const { launcherPath } = assertExternalPayload(rootDir, resourcesPath)
const commandPath = await resolvePackagedMcpCommand(rootDir, resourcesPath, appExecutablePath(appPath))

if (!existsSync(commandPath)) {
  fail(`resolver emitted missing MCP command path: ${commandPath}`)
}
if (!statSync(commandPath).isFile()) {
  fail(`resolver emitted non-file MCP command path: ${commandPath}`)
}
if (process.platform !== 'win32' && (statSync(commandPath).mode & 0o111) === 0) {
  fail(`resolver emitted non-executable MCP command path: ${commandPath}`)
}
if (commandPath.includes('app.asar')) {
  fail(`resolver emitted app.asar MCP command path: ${commandPath}`)
}
if (/\s/.test(commandPath)) {
  fail(`resolver emitted MCP command path with whitespace: ${commandPath}`)
}
if (commandPath !== launcherPath && !commandPath.includes(`${sep}pear-agent-relay-mcp${sep}`)) {
  fail(`resolver emitted unexpected MCP shim path ${commandPath}, packaged launcher was ${launcherPath}`)
}

await verifyInitialize(commandPath).catch((error) => fail(error.message))

console.log(`verify-mcp-spawn: ok (${commandPath})`)
