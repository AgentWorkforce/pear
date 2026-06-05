import { accessSync, constants, existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { createRequire } from 'node:module'
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
    return assertNoAsarMcpCommand(resolvePackagedAgentRelayMcpLauncher(options.resourcesPath))
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
