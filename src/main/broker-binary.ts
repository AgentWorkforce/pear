/**
 * Broker binary resolution and the legacy `--name` compatibility shim.
 *
 * The v8 harness-driver runtime normally locates the bundled broker via
 * `import.meta.url`, but electron-vite bundles the driver into the main
 * process (so `import.meta.url` points at `out/main/` rather than
 * `node_modules/`). These helpers resolve the correct per-platform binary
 * across the packaged/unpacked/local-build layouts and, when the binary only
 * understands the older `--name` flag, launch it through a generated shim that
 * rewrites `--instance-name`/`--workspace-key` arguments.
 *
 * Extracted out of broker.ts: this is stateless infrastructure with no
 * dependency on BrokerManager.
 */
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { canExecute } from './mcp-command'

function resolveBrokerBinaryOverride(): string | null {
  const configured = process.env.AGENT_RELAY_BIN?.trim()
  if (!configured) return null
  if (canExecute(configured)) return configured
  console.warn('[broker] Ignoring AGENT_RELAY_BIN because it is not executable:', configured)
  return null
}

// Resolve the broker binary bundled with the v8 harness-driver runtime.
// The runtime normally resolves this via import.meta.url, but that breaks when
// electron-vite bundles the driver into the main process (import.meta.url points
// to out/main/ instead of node_modules/).
function brokerBinaryNameForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker'
}

export function resolveBundledBrokerBinary(baseDir = __dirname, isPackaged = app.isPackaged): string {
  const configuredBinary = resolveBrokerBinaryOverride()
  if (configuredBinary) {
    console.log('[broker] Using configured Agent Relay broker binary:', configuredBinary)
    return configuredBinary
  }

  const suffix = `${process.platform}-${process.arch}`
  const unpackIfPackaged = (binary: string): string =>
    isPackaged ? binary.replace('app.asar', 'app.asar.unpacked') : binary

  // v8 ships the broker as a per-platform optional package (@agent-relay/broker-*).
  const brokerBinaryName = brokerBinaryNameForPlatform(process.platform)
  const optionalPackageBinary = join(
    baseDir, '..', '..', 'node_modules', '@agent-relay', `broker-${suffix}`, 'bin',
    brokerBinaryName
  )
  const unpackedOptionalPackageBinary = unpackIfPackaged(optionalPackageBinary)
  if (canExecute(unpackedOptionalPackageBinary)) return unpackedOptionalPackageBinary
  if (unpackedOptionalPackageBinary !== optionalPackageBinary && canExecute(optionalPackageBinary)) {
    return optionalPackageBinary
  }

  const localBinary = join(baseDir, '..', '..', '..', 'relay', 'target', 'debug', brokerBinaryName)
  if (canExecute(localBinary)) {
    console.warn('[broker] Bundled Agent Relay broker binary was not found; falling back to local relay build:', localBinary)
    return localBinary
  }

  // Backward-compatible fallback for SDK packages that still carry per-platform
  // broker binaries directly.
  const brokerBinary = join(
    baseDir, '..', '..', 'node_modules', '@agent-relay', 'sdk', 'bin',
    `agent-relay-broker-${suffix}${process.platform === 'win32' ? '.exe' : ''}`
  )
  return unpackIfPackaged(brokerBinary)
}

interface BrokerInitCliFlags {
  supportsInstanceName: boolean
  supportsName: boolean
  supportsWorkspaceKey: boolean
}

export function parseBrokerInitCliFlags(helpText: string): BrokerInitCliFlags {
  return {
    supportsInstanceName: /(?:^|\s)--instance-name(?:\s|[<=[,]|$)/.test(helpText),
    supportsName: /(?:^|\s)--name(?:\s|[<=[,]|$)/.test(helpText),
    supportsWorkspaceKey: /(?:^|\s)--workspace-key(?:\s|[<=[,]|$)/.test(helpText)
  }
}

function inspectBrokerInitCliFlags(binaryPath: string): Promise<BrokerInitCliFlags> {
  return new Promise((resolve) => {
    execFile(binaryPath, ['init', '--help'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true
    }, (err, stdout) => {
      if (err) {
        console.warn(`[broker] Failed to inspect broker init CLI for ${binaryPath}:`, err)
        resolve({
          supportsInstanceName: true,
          supportsName: true,
          supportsWorkspaceKey: true
        })
        return
      }
      resolve(parseBrokerInitCliFlags(stdout))
    })
  })
}

function brokerBinaryCompatShimSource(): string {
  return `#!/usr/bin/env node
const { spawn } = require('node:child_process')

const realBinary = process.env.PEAR_AGENT_RELAY_BROKER_BINARY
if (!realBinary) {
  console.error('[pear-broker-compat] PEAR_AGENT_RELAY_BROKER_BINARY is required')
  process.exit(127)
}

const supportsInstanceName = process.env.PEAR_AGENT_RELAY_BROKER_SUPPORTS_INSTANCE_NAME === '1'
const supportsWorkspaceKey = process.env.PEAR_AGENT_RELAY_BROKER_SUPPORTS_WORKSPACE_KEY === '1'
const inputArgs = process.argv.slice(2)
const outputArgs = []

for (let index = 0; index < inputArgs.length; index += 1) {
  const arg = inputArgs[index]
  if (!supportsInstanceName && arg === '--instance-name') {
    outputArgs.push('--name')
    if (index + 1 < inputArgs.length) outputArgs.push(inputArgs[++index])
    continue
  }
  if (!supportsInstanceName && arg.startsWith('--instance-name=')) {
    outputArgs.push('--name=' + arg.slice('--instance-name='.length))
    continue
  }
  if (!supportsWorkspaceKey && arg === '--workspace-key') {
    index += 1
    continue
  }
  if (!supportsWorkspaceKey && arg.startsWith('--workspace-key=')) {
    continue
  }
  outputArgs.push(arg)
}

const child = spawn(realBinary, outputArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
})

child.on('error', (error) => {
  console.error('[pear-broker-compat] failed to launch broker:', error instanceof Error ? error.message : String(error))
  process.exit(127)
})

child.on('exit', (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal)
    } catch {
      // Re-raising the child's signal failed; exit non-zero so the failure still
      // propagates to the parent. Nothing to log from inside this shim process.
      process.exit(1)
    }
    return
  }
  process.exit(code ?? 0)
})
`
}

async function textFileMatches(filePath: string, source: string): Promise<boolean> {
  try {
    return await readFile(filePath, 'utf8') === source
  } catch {
    return false
  }
}

async function ensureBrokerBinaryCompatShim(): Promise<string> {
  const shimDir = join(app.getPath('userData'), 'broker-compat')
  const shimPath = join(shimDir, process.platform === 'win32' ? 'agent-relay-broker-compat.cmd' : 'agent-relay-broker-compat')
  const source = process.platform === 'win32'
    ? `@echo off\r\nnode "%~dp0agent-relay-broker-compat.js" %*\r\n`
    : brokerBinaryCompatShimSource()

  await mkdir(shimDir, { recursive: true })
  if (!(await textFileMatches(shimPath, source))) {
    await writeFile(shimPath, source)
    await chmod(shimPath, 0o755)
  }
  if (process.platform === 'win32') {
    const jsPath = join(shimDir, 'agent-relay-broker-compat.js')
    const jsSource = brokerBinaryCompatShimSource()
    if (!(await textFileMatches(jsPath, jsSource))) {
      await writeFile(jsPath, jsSource)
    }
  }
  return shimPath
}

// `binaryPath` is what Pear launches (possibly the legacy compat shim);
// `realBinaryPath` is always the actual broker binary, for callers that hand
// the binary itself to other processes.
export async function resolveHarnessBrokerBinary(workspaceKey?: string): Promise<{ binaryPath: string; realBinaryPath: string; env: NodeJS.ProcessEnv }> {
  const binaryPath = resolveBundledBrokerBinary()
  const flags = await inspectBrokerInitCliFlags(binaryPath)

  if (workspaceKey && !flags.supportsWorkspaceKey) {
    throw new Error(
      `Broker binary does not support --workspace-key: ${binaryPath}. Rebuild or update agent-relay-broker, or unset AGENT_RELAY_WORKSPACE_KEY.`
    )
  }

  if (flags.supportsInstanceName) {
    return { binaryPath, realBinaryPath: binaryPath, env: {} }
  }

  if (!flags.supportsName) {
    throw new Error(`Broker binary supports neither --instance-name nor --name: ${binaryPath}`)
  }

  const shimPath = await ensureBrokerBinaryCompatShim()
  console.warn(`[broker] Broker binary uses legacy --name flag; launching through compatibility shim: ${binaryPath}`)
  return {
    binaryPath: shimPath,
    realBinaryPath: binaryPath,
    env: {
      PEAR_AGENT_RELAY_BROKER_BINARY: binaryPath,
      PEAR_AGENT_RELAY_BROKER_SUPPORTS_INSTANCE_NAME: flags.supportsInstanceName ? '1' : '0',
      PEAR_AGENT_RELAY_BROKER_SUPPORTS_WORKSPACE_KEY: flags.supportsWorkspaceKey ? '1' : '0'
    }
  }
}
