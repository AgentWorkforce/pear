import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'path'

const requireForResolve = createRequire(import.meta.url)

export interface AgentRelayMcpCommandOptions {
  configuredCommand?: string
  env?: NodeJS.ProcessEnv
  execPath?: string
  isPackaged: boolean
  resourcesPath?: string
}

const PACKAGED_AGENT_RELAY_MCP_LAUNCHER = [
  'agent-relay-mcp',
  process.platform === 'win32' ? 'launch.cmd' : 'launch.sh'
]

export function canExecute(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH || ''
  const extensions = process.platform === 'win32'
    ? ['', '.cmd', '.exe', '.bat']
    : ['']

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      if (canExecute(candidate)) return candidate
    }
  }

  try {
    const resolved = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore']
    }).split(/\r?\n/)[0]?.trim()
    return resolved || undefined
  } catch {
    return undefined
  }
}

export function resolvePackageBin(packageName: string, binName: string): string | undefined {
  try {
    const packageJsonPath = requireForResolve.resolve(`${packageName}/package.json`)
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const binPath = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[binName]
    if (!binPath) return undefined

    const candidate = join(dirname(packageJsonPath), binPath)
    return canExecute(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function resolveNodeCommandForMcp(options: AgentRelayMcpCommandOptions): string | undefined {
  const execPath = options.execPath || process.execPath
  const execBasename = basename(execPath).toLowerCase()
  if (execBasename === 'node' || execBasename === 'node.exe') {
    return execPath
  }

  return resolveCommandOnPath('node', options.env)
}

function hasAsarPathSegment(value: string): boolean {
  return /(^|[\\/])app\.asar([\\/]|$)/.test(value)
}

function assertNoAsarMcpCommand(command: string): string {
  if (hasAsarPathSegment(command)) {
    throw new Error(`Agent Relay MCP command must not reference app.asar in packaged mode: ${command}`)
  }
  return command
}

function resolvePackagedAgentRelayMcpLauncher(resourcesPath?: string): string {
  if (!resourcesPath?.trim()) {
    throw new Error('Unable to resolve packaged Agent Relay MCP resources path')
  }

  const candidate = join(resourcesPath, ...PACKAGED_AGENT_RELAY_MCP_LAUNCHER)
  if (hasAsarPathSegment(candidate)) {
    throw new Error(`Packaged Agent Relay MCP launcher resolved inside app.asar: ${candidate}`)
  }
  if (!canExecute(candidate)) {
    throw new Error(`Packaged Agent Relay MCP launcher is missing or not executable: ${candidate}`)
  }
  return candidate
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function windowsCmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function packagedMcpShimRoot(): string {
  // Use /tmp on POSIX so the MCP command handed to Codex has no spaces even
  // when the app is installed as "Pear by Agent Relay.app".
  return process.platform === 'win32' ? tmpdir() : '/tmp'
}

function materializePackagedAgentRelayMcpShim(launcherPath: string): string {
  if (!/\s/.test(launcherPath)) return launcherPath

  const hash = createHash('sha256').update(launcherPath).digest('hex').slice(0, 16)
  const shimDir = join(packagedMcpShimRoot(), 'pear-agent-relay-mcp', hash)
  const shimPath = join(shimDir, process.platform === 'win32' ? 'launch.cmd' : 'launch.sh')
  const content = process.platform === 'win32'
    ? `@echo off\r\n${windowsCmdQuote(launcherPath)} %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(launcherPath)} "$@"\n`

  try {
    mkdirSync(shimDir, { recursive: true })
    if (!existsSync(shimPath) || readFileSync(shimPath, 'utf8') !== content) {
      writeFileSync(shimPath, content, 'utf8')
    }
    if (process.platform !== 'win32') chmodSync(shimPath, 0o755)
  } catch (err) {
    throw new Error(`Unable to create packaged Agent Relay MCP launcher shim for ${launcherPath}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!canExecute(shimPath)) {
    throw new Error(`Packaged Agent Relay MCP launcher shim is missing or not executable: ${shimPath}`)
  }
  return shimPath
}

function resolveBundledAgentRelayMcpScript(): string | undefined {
  const packageCommand = resolvePackageBin('agent-relay', 'agent-relay')
  if (packageCommand) {
    const sibling = join(dirname(packageCommand), 'agent-relay-mcp.js')
    if (existsSync(sibling)) return sibling
  }

  try {
    const packageJsonPath = requireForResolve.resolve('agent-relay/package.json')
    const candidate = join(dirname(packageJsonPath), 'dist', 'cli', 'agent-relay-mcp.js')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

export function resolveAgentRelayMcpCommand(options: AgentRelayMcpCommandOptions): string | undefined {
  const configured = options.configuredCommand?.trim()
  if (configured) {
    return options.isPackaged ? assertNoAsarMcpCommand(configured) : configured
  }

  if (options.isPackaged) {
    return assertNoAsarMcpCommand(materializePackagedAgentRelayMcpShim(resolvePackagedAgentRelayMcpLauncher(options.resourcesPath)))
  }

  const bundledMcpScript = resolveBundledAgentRelayMcpScript()
  const nodeCommand = bundledMcpScript ? resolveNodeCommandForMcp(options) : undefined
  if (bundledMcpScript && nodeCommand) {
    return `${nodeCommand} ${bundledMcpScript}`
  }

  const packageCommand = resolvePackageBin('agent-relay', 'agent-relay') || resolveCommandOnPath('agent-relay', options.env)
  if (packageCommand) return `${packageCommand} mcp`

  return undefined
}
