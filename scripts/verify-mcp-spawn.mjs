#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_NAME = 'Pear by Agent Relay.app'
const MCP_RESOURCE_ROOT = join('agent-relay-mcp', 'node_modules')
const MCP_SCRIPT_RELATIVE = join(MCP_RESOURCE_ROOT, 'agent-relay', 'dist', 'cli', 'agent-relay-mcp.js')
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

function packagePath(nodeModulesPath, packageName) {
  return join(nodeModulesPath, ...packageName.split('/'), 'package.json')
}

function installedDependencyClosure(rootDir) {
  const lockPath = join(rootDir, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const packages = lock.packages ?? {}
  const seen = new Set()

  function visit(packageName) {
    if (seen.has(packageName)) return
    const lockPackage = packages[`node_modules/${packageName}`]
    if (!lockPackage) fail(`package-lock entry missing for ${packageName}`)

    const localPackageJson = packagePath(join(rootDir, 'node_modules'), packageName)
    if (!existsSync(localPackageJson)) return

    seen.add(packageName)
    for (const dependency of Object.keys(lockPackage.dependencies ?? {})) visit(dependency)
    for (const dependency of Object.keys(lockPackage.optionalDependencies ?? {})) visit(dependency)
  }

  visit('agent-relay')
  return [...seen].sort()
}

function assertExternalPayload(rootDir, resourcesPath) {
  const scriptPath = join(resourcesPath, MCP_SCRIPT_RELATIVE)
  const asarSegment = `${sep}app.asar${sep}`
  if (scriptPath.includes(asarSegment)) fail(`MCP script path points inside app.asar: ${scriptPath}`)
  if (!existsSync(scriptPath)) fail(`MCP script missing from packaged resources: ${scriptPath}`)
  if (!statSync(scriptPath).isFile()) fail(`MCP script path is not a file: ${scriptPath}`)

  const payloadNodeModules = join(resourcesPath, MCP_RESOURCE_ROOT)
  for (const packageName of installedDependencyClosure(rootDir)) {
    const payloadPackageJson = packagePath(payloadNodeModules, packageName)
    if (!existsSync(payloadPackageJson)) {
      fail(`packaged MCP payload missing runtime dependency ${packageName}: ${payloadPackageJson}`)
    }
  }

  return scriptPath
}

function encodeMessage(payload) {
  return `${JSON.stringify(payload)}\n`
}

function parseMessages(buffer) {
  const text = buffer.toString('utf8')
  const lines = text.split(/\r?\n/)
  const completeLines = text.endsWith('\n') || text.endsWith('\r\n') ? lines : lines.slice(0, -1)
  return completeLines.filter(Boolean).map((line) => JSON.parse(line))
}

async function verifyInitialize(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], {
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

function smokeEnv() {
  const allowedKeys = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'NODE_EXTRA_CA_CERTS',
    'PATH',
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
  env.RELAY_SKIP_BOOTSTRAP = '1'
  return env
}

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const appPath = findBuiltApp(rootDir)
const resourcesPath = appResourcesPath(appPath)
const scriptPath = assertExternalPayload(rootDir, resourcesPath)

await verifyInitialize(scriptPath).catch((error) => fail(error.message))

console.log(`verify-mcp-spawn: ok (${scriptPath})`)
