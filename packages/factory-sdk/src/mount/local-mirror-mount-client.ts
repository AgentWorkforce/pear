import { existsSync } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
  watch,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve, sep } from 'node:path'

import type { ChangeEvent, EventPage, MountClient, SubscribeOptions, Subscription } from '../ports'
import { filesystemEventToChangeEvent, globMatchesPath } from '../subscriptions'
import { asRecord } from '../writeback/shared'

const DEFAULT_WORKSPACE_ID = 'rw_7ccfea89'
const DEFAULT_MIRROR_DIR = '/tmp/factory-rf-mirror'
const DEFAULT_DEBOUNCE_MS = 1_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const OUTBOX_STATUSES = ['acked', 'failed', 'pending'] as const

type OutboxStatus = typeof OUTBOX_STATUSES[number]
type WriteStatus = 'acked' | 'pending' | 'failed' | 'timeout'

export interface LocalMirrorMountClientConfig {
  backend?: 'relayfile-mirror'
  workspaceId?: string
  mirrorDir?: string
  debounceMs?: number
  pollIntervalMs?: number
  maxStateAgeMs?: number
}

interface LastWrite {
  path: string
  localPath: string
  contentHash: string
  startedAtMs: number
  ackedBaseline: number
}

interface RelayMetadata {
  state: Record<string, unknown>
  pid: number
}

export class LocalMirrorMountClient implements MountClient {
  readonly workspaceId: string
  readonly mirrorDir: string

  readonly #debounceMs: number
  readonly #pollIntervalMs: number
  readonly #maxStateAgeMs?: number
  readonly #lastWriteByPath = new Map<string, LastWrite>()

  constructor(config: LocalMirrorMountClientConfig = {}) {
    this.workspaceId = config.workspaceId ?? DEFAULT_WORKSPACE_ID
    this.mirrorDir = resolve(config.mirrorDir ?? DEFAULT_MIRROR_DIR)
    this.#debounceMs = Math.max(0, Math.floor(config.debounceMs ?? DEFAULT_DEBOUNCE_MS))
    this.#pollIntervalMs = Math.max(25, Math.floor(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS))
    this.#maxStateAgeMs = config.maxStateAgeMs
  }

  async assertWritebackReady(): Promise<void> {
    await this.#readReadyMetadata()
  }

  async readFile(path: string): Promise<{ content: unknown; revision?: string }> {
    const localPath = this.#localPath(path)
    const [raw, fileStat] = await Promise.all([
      readFile(localPath, 'utf8'),
      stat(localPath),
    ])

    const parsed = parseMirrorContent(raw)
    return {
      content: unwrapMirrorPayload(parsed),
      revision: String(Math.trunc(fileStat.mtimeMs)),
    }
  }

  async writeFile(path: string, content: unknown): Promise<void> {
    const metadata = await this.#readReadyMetadata()
    const localPath = this.#localPath(path)
    const serialized = serializeMirrorContent(content)
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, serialized, 'utf8')
    this.#lastWriteByPath.set(path, {
      path: normalizeRemotePath(path),
      localPath,
      contentHash: hashString(serialized),
      startedAtMs: Date.now(),
      ackedBaseline: outboxCount(metadata.state, 'acked'),
    })
  }

  async listTree(prefix: string): Promise<string[]> {
    const localPath = this.#localPath(prefix)
    const remotePrefix = normalizeRemotePath(prefix)
    try {
      const entry = await stat(localPath)
      if (entry.isFile()) return [remotePrefix]
      if (!entry.isDirectory()) return []
    } catch {
      return []
    }

    const paths: string[] = []
    await walkFiles(localPath, async (filePath) => {
      if (relative(this.mirrorDir, filePath).split(sep).at(0) === '.relay') return
      paths.push(toRemotePath(this.mirrorDir, filePath))
    })
    return paths.sort()
  }

  subscribe(globs: string[], onChange: (event: ChangeEvent) => void, _opts?: SubscribeOptions): Subscription {
    let active = true
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const seenMtimes = new Map<string, number>()
    let pollInitialized = false
    let watcher: AsyncIterableIterator<{ eventType: string; filename: string | Buffer | null }> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let pollingStarted = false

    const emitPath = (path: string): void => {
      if (!active || !globs.some((glob) => globMatchesPath(glob, path))) return
      const existing = timers.get(path)
      if (existing) clearTimeout(existing)
      timers.set(path, setTimeout(() => {
        timers.delete(path)
        if (!active) return
        void stat(this.#localPath(path)).then(async (fileStat) => {
          if (!active) return
          const paths = fileStat.isDirectory()
            ? (await this.listTree(path)).filter((childPath) => globs.some((glob) => globMatchesPath(glob, childPath)))
            : fileStat.isFile()
              ? [path]
              : []
          for (const changedPath of paths) {
            if (!active) return
            onChange(filesystemEventToChangeEvent(null, this.workspaceId, {
              type: 'file.updated',
              path: changedPath,
              eventId: `mirror:${this.workspaceId}:${changedPath}:${Date.now()}`,
              revision: String(Date.now()),
              timestamp: new Date().toISOString(),
            }) as unknown as ChangeEvent)
          }
        }).catch(() => {})
      }, this.#debounceMs))
    }

    const startPolling = (): void => {
      if (pollingStarted) return
      pollingStarted = true
      const poll = async (): Promise<void> => {
        if (!active) return
        const paths = await this.#watchedPaths(globs)
        for (const path of paths) {
          const fileStat = await stat(this.#localPath(path)).catch(() => null)
          if (!fileStat?.isFile()) continue
          const previous = seenMtimes.get(path)
          seenMtimes.set(path, fileStat.mtimeMs)
          if ((previous !== undefined && previous !== fileStat.mtimeMs) || (pollInitialized && previous === undefined)) {
            emitPath(path)
          }
        }
        pollInitialized = true
        pollTimer = setTimeout(() => void poll(), this.#pollIntervalMs)
      }
      void poll()
    }

    try {
      watcher = watch(this.mirrorDir, { recursive: true })
      startPolling()
      void (async () => {
        try {
          for await (const event of watcher) {
            if (!active) break
            if (event.eventType !== 'change' && event.eventType !== 'rename') continue
            if (!event.filename) continue
            const relativePath = event.filename.toString()
            if (!relativePath || relativePath.split(/[\\/]/u).at(0) === '.relay') continue
            emitPath(toRemotePath(this.mirrorDir, resolve(this.mirrorDir, relativePath)))
          }
        } catch {
          if (active) startPolling()
        }
      })()
    } catch {
      startPolling()
    }

    return {
      unsubscribe: async () => {
        active = false
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
        if (pollTimer) clearTimeout(pollTimer)
        await watcher?.return?.()
      },
    }
  }

  async getEvents(_opts: { cursor?: string; limit?: number }): Promise<EventPage> {
    return { events: [], nextCursor: null }
  }

  async confirmWrite(path: string, opts: { timeoutMs?: number } = {}): Promise<WriteStatus> {
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
    for (;;) {
      const status = await this.#currentWriteStatus(path)
      if (status === 'acked' || status === 'failed') return status
      if (Date.now() >= deadline) return 'timeout'
      await sleep(Math.min(500, Math.max(25, deadline - Date.now())))
    }
  }

  async ensureSubRoot(prefix: string, _opts?: { timeoutMs?: number }): Promise<'ready' | 'absent'> {
    return (await this.listTree(prefix)).length > 0 || existsSync(this.#localPath(prefix)) ? 'ready' : 'absent'
  }

  async #watchedPaths(globs: string[]): Promise<string[]> {
    const paths = (await Promise.all(pollRootsForGlobs(globs).map((root) => this.listTree(root)))).flat()
    return paths.filter((path) => globs.some((glob) => globMatchesPath(glob, path)))
  }

  async #readReadyMetadata(): Promise<RelayMetadata> {
    const statePath = resolve(this.mirrorDir, '.relay', 'state.json')
    const pidPath = resolve(this.mirrorDir, '.relay', 'mount.pid')
    const [stateRaw, pidRaw] = await Promise.all([
      readFile(statePath, 'utf8').catch((error: unknown) => {
        throw new Error(`Relayfile mirror writeback is not ready: missing ${statePath}: ${errorMessage(error)}`)
      }),
      readFile(pidPath, 'utf8').catch((error: unknown) => {
        throw new Error(`Relayfile mirror writeback is not ready: missing ${pidPath}: ${errorMessage(error)}`)
      }),
    ])

    const state = asRecord(JSON.parse(stateRaw)) ?? {}
    const pidRecord = parsePidFile(pidRaw)
    const pid = pidRecord.pid
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('Relayfile mirror writeback is not ready: mount.pid does not contain a live pid')
    }
    if (!processIsAlive(pid)) {
      throw new Error(`Relayfile mirror writeback is not ready: mount pid ${pid} is not alive`)
    }

    assertWorkspaceMatches(state, this.workspaceId)
    assertWorkspaceMatches(pidRecord, this.workspaceId)
    assertMirrorDirMatches(state, this.mirrorDir)
    assertMirrorDirMatches(pidRecord, this.mirrorDir)
    assertStateHealthy(state, this.#maxStateAgeMs)

    return { state, pid }
  }

  #localPath(path: string): string {
    const normalized = normalizeRemotePath(path)
    const fullPath = resolve(this.mirrorDir, `.${normalized}`)
    if (fullPath !== this.mirrorDir && !fullPath.startsWith(`${this.mirrorDir}${sep}`)) {
      throw new Error(`Mount path escapes mirror root: ${path}`)
    }
    return fullPath
  }

  async #currentWriteStatus(path: string): Promise<WriteStatus> {
    const normalizedPath = normalizeRemotePath(path)
    const marker = this.#lastWriteByPath.get(path) ?? this.#lastWriteByPath.get(normalizedPath)
    if (await outboxHasMatch(this.mirrorDir, 'acked', normalizedPath, marker)) return 'acked'
    if (await outboxHasMatch(this.mirrorDir, 'failed', normalizedPath, marker)) return 'failed'
    if (await outboxHasMatch(this.mirrorDir, 'pending', normalizedPath, marker)) return 'pending'

    const state = await readRelayState(this.mirrorDir)
    if (state) {
      if (outboxCount(state, 'failed') > 0) return 'failed'
      if (marker && outboxCount(state, 'acked') > marker.ackedBaseline && !hasPendingWriteback(state)) {
        return 'acked'
      }
      if (hasPendingWriteback(state)) return 'pending'
    }

    return marker ? 'pending' : 'acked'
  }
}

const parseMirrorContent = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const unwrapMirrorPayload = (content: unknown): unknown => {
  const record = asRecord(content)
  return asRecord(record?.payload) ?? content
}

const serializeMirrorContent = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content)

const normalizeRemotePath = (path: string): string => {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new Error(`Invalid mount path: ${path}`)
  }
  return `/${parts.join('/')}`
}

const pollRootsForGlobs = (globs: string[]): string[] => {
  const roots = globs.map((glob) => {
    const segments = normalizeRemotePath(glob).split('/').filter(Boolean)
    const staticSegments = []
    for (const segment of segments) {
      if (segment.includes('*')) break
      staticSegments.push(segment)
    }
    return staticSegments.length > 0 ? `/${staticSegments.join('/')}` : '/'
  })
  return [...new Set(roots)]
}

const toRemotePath = (root: string, filePath: string): string =>
  `/${relative(root, filePath).split(sep).join('/')}`

const walkFiles = async (root: string, visit: (path: string) => Promise<void> | void): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(path, visit)
    } else if (entry.isFile()) {
      await visit(path)
    }
  }
}

const parsePidFile = (raw: string): Record<string, unknown> & { pid: number } => {
  const trimmed = raw.trim()
  const parsed = trimmed.startsWith('{') ? asRecord(JSON.parse(trimmed)) : { pid: Number(trimmed) }
  return { ...(parsed ?? {}), pid: Number(parsed?.pid ?? NaN) }
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return asRecord(error)?.code === 'EPERM'
  }
}

const assertWorkspaceMatches = (record: Record<string, unknown>, workspaceId: string): void => {
  const found = stringField(record, ['workspaceId', 'workspace_id'])
  if (found && found !== workspaceId) {
    throw new Error(`Relayfile mirror writeback is not ready: workspace mismatch ${found} !== ${workspaceId}`)
  }
}

const assertMirrorDirMatches = (record: Record<string, unknown>, mirrorDir: string): void => {
  const found = stringField(record, ['localRoot', 'localDir', 'mirrorDir', 'localMirror'])
  if (found && resolve(found) !== mirrorDir) {
    throw new Error(`Relayfile mirror writeback is not ready: mirror mismatch ${found} !== ${mirrorDir}`)
  }
}

const assertStateHealthy = (state: Record<string, unknown>, maxStateAgeMs: number | undefined): void => {
  const status = stringField(state, ['status'])
  if (status && ['dead', 'failed', 'offline', 'stopped', 'error'].includes(status.toLowerCase())) {
    throw new Error(`Relayfile mirror writeback is not ready: daemon status is ${status}`)
  }

  const states = asRecord(state.states)
  if (states?.offline === true) {
    throw new Error('Relayfile mirror writeback is not ready: daemon is offline')
  }
  if (states?.stale === true) {
    throw new Error('Relayfile mirror writeback is not ready: mirror state is stale')
  }

  if (maxStateAgeMs !== undefined) {
    const lastReconcileAt = stringField(state, ['lastReconcileAt', 'last_reconcile_at', 'lastSyncAt'])
    const reconciledAt = lastReconcileAt ? Date.parse(lastReconcileAt) : NaN
    if (!Number.isFinite(reconciledAt) || Date.now() - reconciledAt > maxStateAgeMs) {
      throw new Error('Relayfile mirror writeback is not ready: reconcile state is stale')
    }
  }
}

const readRelayState = async (mirrorDir: string): Promise<Record<string, unknown> | null> => {
  try {
    return asRecord(JSON.parse(await readFile(resolve(mirrorDir, '.relay', 'state.json'), 'utf8'))) ?? null
  } catch {
    return null
  }
}

const outboxCount = (state: Record<string, unknown>, status: OutboxStatus): number => {
  const outbox = asRecord(state.outbox)
  const value = outbox?.[status]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const hasPendingWriteback = (state: Record<string, unknown>): boolean => {
  const states = asRecord(state.states)
  return states?.hasPendingWriteback === true ||
    Number(state.pendingWriteback ?? 0) > 0 ||
    outboxCount(state, 'pending') > 0
}

const outboxHasMatch = async (
  mirrorDir: string,
  status: OutboxStatus,
  path: string,
  marker: LastWrite | undefined,
): Promise<boolean> => {
  const root = resolve(mirrorDir, '.relay', 'outbox', status)
  const files: string[] = []
  await walkFiles(root, (filePath) => {
    files.push(filePath)
  })

  for (const filePath of files) {
    const raw = await readFile(filePath, 'utf8').catch(() => '')
    if (outboxRecordMatches(raw, path, marker)) return true
  }
  return false
}

const outboxRecordMatches = (raw: string, path: string, marker: LastWrite | undefined): boolean => {
  const parsed = parseMirrorContent(raw)
  const strings = collectStrings(parsed)
  if (strings.some((value) => value === path || value === marker?.localPath || value.endsWith(path))) return true
  if (marker && strings.includes(marker.contentHash)) return true
  return raw.includes(path) || (marker ? raw.includes(marker.contentHash) : false)
}

const collectStrings = (value: unknown, depth = 0): string[] => {
  if (depth > 8) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry, depth + 1))
  const record = asRecord(value)
  if (!record) return []
  return Object.values(record).flatMap((entry) => collectStrings(entry, depth + 1))
}

const stringField = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

const hashString = (value: string): string => createHash('sha256').update(value).digest('hex')

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
