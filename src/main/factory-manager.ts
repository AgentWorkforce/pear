import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'
import {
  FactoryConfigSchema,
  checkFactoryLoopLiveness,
  readFactoryInFlightRegistry,
  readFactoryLoopHeartbeat,
  type FactoryConfig
} from '../../packages/factory-sdk/src'
import type {
  FactoryConfigReadResult,
  FactoryEvent,
  FactoryLogLine,
  FactoryStatus
} from '../shared/types/ipc'
import { brokerManager } from './broker'
import { resolveCommandOnPath } from './mcp-command'

const MAX_FACTORY_LOG_LINES = 500
const FACTORY_STOP_GRACE_MS = 10_000

type FactoryEventListener = (event: FactoryEvent) => void

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appRoot(): string {
  return app.getAppPath()
}

function defaultConfigPath(projectRoot?: string): string {
  const candidates = [
    projectRoot ? join(projectRoot, 'factory.config.json') : undefined,
    join(process.cwd(), 'factory.config.json'),
    join(appRoot(), 'factory.config.json')
  ].filter((candidate): candidate is string => !!candidate)

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function normalizeConfigPath(path?: string, projectRoot?: string): string {
  if (path?.trim()) {
    return isAbsolute(path) ? path : resolve(projectRoot || process.cwd(), path)
  }
  return defaultConfigPath(projectRoot)
}

function factoryLauncherPath(): string {
  return join(appRoot(), 'packages', 'factory-sdk', 'bin', 'fleet.mjs')
}

function nodeRuntime(): { command: string; env: NodeJS.ProcessEnv } {
  if (process.versions.electron) {
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  if (/node(?:\.exe)?$/iu.test(process.execPath)) {
    return { command: process.execPath, env: {} }
  }
  const node = resolveCommandOnPath('node')
  if (node) return { command: node, env: {} }
  throw new Error('Node.js executable not found; cannot launch the factory')
}

function parseConfigDocument(text: string): { wrapped: boolean; config: FactoryConfig; raw: Record<string, unknown> } {
  const raw = JSON.parse(text) as Record<string, unknown>
  const wrapped = raw.factoryConfig !== undefined
  return {
    wrapped,
    raw,
    config: FactoryConfigSchema.parse(wrapped ? raw.factoryConfig : raw)
  }
}

export class FactoryManager {
  private child: ChildProcessWithoutNullStreams | null = null
  private configPath: string | undefined
  private startedAt: number | undefined
  private stopping = false
  private exitCode: number | null | undefined
  private signal: NodeJS.Signals | null | undefined
  private lastError: string | undefined
  private logs: FactoryLogLine[] = []
  private listeners = new Set<FactoryEventListener>()
  private starting: Promise<FactoryStatus> | null = null
  private stoppingPromise: Promise<FactoryStatus> | null = null

  onEvent(listener: FactoryEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async readConfig(configPath?: string, projectRoot?: string): Promise<FactoryConfigReadResult> {
    const path = normalizeConfigPath(configPath, projectRoot)
    if (!existsSync(path)) {
      return { configPath: path, exists: false, config: null, errors: [`Factory config not found: ${path}`] }
    }
    try {
      const parsed = parseConfigDocument(await readFile(path, 'utf8'))
      return { configPath: path, exists: true, config: parsed.config, errors: [] }
    } catch (error) {
      return { configPath: path, exists: true, config: null, errors: [toErrorMessage(error)] }
    }
  }

  async saveConfig(config: unknown, configPath?: string, projectRoot?: string): Promise<FactoryConfigReadResult> {
    const path = normalizeConfigPath(configPath, projectRoot)
    const parsed = FactoryConfigSchema.safeParse(config)
    if (!parsed.success) {
      return {
        configPath: path,
        exists: existsSync(path),
        config,
        errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      }
    }

    let wrapped = false
    let raw: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        const existing = parseConfigDocument(await readFile(path, 'utf8'))
        wrapped = existing.wrapped
        raw = existing.raw
      } catch {
        raw = {}
      }
    }

    const next = wrapped ? { ...raw, factoryConfig: parsed.data } : parsed.data
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return {
      configPath: path,
      exists: true,
      config: parsed.data,
      errors: [],
      warning: this.child ? 'Factory is running; restart it for all setting changes to take effect.' : undefined
    }
  }

  async start(configPath?: string, projectRoot?: string): Promise<FactoryStatus> {
    if (this.starting) return this.starting
    if (this.child && this.child.exitCode === null) return this.status()
    this.starting = this.startOnce(configPath, projectRoot)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startOnce(configPath?: string, projectRoot?: string): Promise<FactoryStatus> {
    const path = normalizeConfigPath(configPath, projectRoot)
    const loaded = await this.readConfig(path)
    if (!loaded.exists || loaded.errors.length > 0) {
      throw new Error(loaded.errors.join('\n') || `Factory config not found: ${path}`)
    }

    const launcher = factoryLauncherPath()
    if (!existsSync(launcher)) throw new Error(`Factory launcher not found: ${launcher}`)

    const runtime = nodeRuntime()
    this.configPath = path
    this.startedAt = Date.now()
    this.stopping = false
    this.exitCode = undefined
    this.signal = undefined
    this.lastError = undefined
    this.appendLog('info', `starting ${path}`)

    const child = spawn(runtime.command, [
      launcher,
      'factory',
      'start',
      '--mode',
      'live',
      '--config',
      path
    ], {
      cwd: dirname(path),
      env: {
        ...process.env,
        ...runtime.env,
        FORCE_COLOR: '0'
      }
    })
    this.child = child

    child.stdout.on('data', (chunk) => this.appendLog('stdout', String(chunk)))
    child.stderr.on('data', (chunk) => this.appendLog('stderr', String(chunk)))
    child.on('error', (error) => {
      this.lastError = toErrorMessage(error)
      this.appendLog('stderr', this.lastError)
      void this.broadcast()
    })
    child.on('exit', (code, signal) => {
      this.exitCode = code
      this.signal = signal
      this.stopping = false
      if (this.child === child) this.child = null
      this.appendLog('info', `exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      void this.releaseRegistryAgents()
      void this.broadcast()
    })

    await this.broadcast()
    return this.status()
  }

  async stop(): Promise<FactoryStatus> {
    if (this.stoppingPromise) return this.stoppingPromise
    this.stoppingPromise = this.stopOnce()
    try {
      return await this.stoppingPromise
    } finally {
      this.stoppingPromise = null
    }
  }

  private async stopOnce(): Promise<FactoryStatus> {
    const child = this.child
    if (child && child.exitCode === null && !child.killed) {
      this.stopping = true
      this.appendLog('info', 'stopping')
      child.kill('SIGTERM')
      const exited = await waitForExit(child, FACTORY_STOP_GRACE_MS)
      if (!exited && this.child === child) {
        this.appendLog('stderr', 'stop grace elapsed; killing')
        child.kill('SIGKILL')
        await waitForExit(child, 1_000)
      }
    }
    this.child = null
    this.stopping = false
    await this.releaseRegistryAgents()
    await this.broadcast()
    return this.status()
  }

  async shutdown(): Promise<FactoryStatus> {
    return this.stop()
  }

  async status(): Promise<FactoryStatus> {
    const configPath = this.configPath ?? defaultConfigPath()
    const loaded = await this.readConfig(configPath).catch(() => undefined)
    const config = loaded?.errors.length === 0 ? FactoryConfigSchema.parse(loaded.config) : undefined
    const heartbeat = config ? await readFactoryLoopHeartbeat(config.loop.heartbeatPath) : undefined
    const liveness = config ? checkFactoryLoopLiveness(heartbeat, { staleMs: config.loop.heartbeatStaleMs }) : undefined
    const registry = config ? await readFactoryInFlightRegistry(config.loop.registryPath) : undefined

    return {
      running: !!this.child && this.child.exitCode === null,
      pid: this.child?.pid,
      configPath,
      logs: this.logs,
      heartbeat: heartbeat
        ? {
            status: heartbeat.status,
            iteration: heartbeat.iteration,
            maxIterations: heartbeat.maxIterations,
            updatedAt: heartbeat.updatedAt,
            updatedAtMs: heartbeat.updatedAtMs,
            registryPath: heartbeat.registryPath,
            ...(liveness?.ageMs !== undefined ? { ageMs: liveness.ageMs } : {}),
            ...(liveness?.reason ? { reason: liveness.reason } : {})
          }
        : undefined,
      agents: (registry?.agents ?? []).map((agent) => ({
        name: agent.name,
        role: agent.role,
        issue: agent.issue ? { key: agent.issue.key, path: agent.issue.path } : undefined,
        pids: agent.pids
      }))
    }
  }

  private async releaseRegistryAgents(): Promise<void> {
    const status = await this.status()
    await Promise.allSettled(
      status.agents.map((agent) =>
        brokerManager.releaseAgent(undefined, agent.name).catch((error) => {
          console.warn(`[factory] Failed to release factory agent ${agent.name}:`, toErrorMessage(error))
        })
      )
    )
  }

  private appendLog(stream: FactoryLogLine['stream'], text: string): void {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue
      this.logs.push({ ts: Date.now(), stream, text: line })
    }
    if (this.logs.length > MAX_FACTORY_LOG_LINES) {
      this.logs = this.logs.slice(this.logs.length - MAX_FACTORY_LOG_LINES)
    }
    void this.broadcast()
  }

  private async broadcast(): Promise<void> {
    const status = await this.status()
    for (const listener of Array.from(this.listeners)) listener({ type: 'factory:status', status })
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    const done = (): void => {
      cleanup()
      resolve(true)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', done)
      child.off('error', done)
    }
    child.once('exit', done)
    child.once('error', done)
  })
}

export const factoryManager = new FactoryManager()
