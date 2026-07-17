import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TermFidelityCorpusInput, TermFidelityCorpusResult } from '../shared/types/ipc'

export const TERM_FIDELITY_CORPUS_DUMP_GAP_MS = 5 * 60_000
export const TERM_FIDELITY_CORPUS_WARN_GAP_MS = 60_000

export interface TermFidelityCorpusDumpOptions {
  rootDir: string
  capturePage(): Promise<Buffer>
  relayVersions(): Promise<Record<string, string>>
}

interface TermFidelityCorpusDumperDeps {
  now?: () => number
  log?: (message: string) => void
  warn?: (message: string) => void
}

function agentKey(input: TermFidelityCorpusInput): string {
  return `${input.projectId || ''}\u0000${input.agentName}`
}

function timestampDirectoryName(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace(/[:.]/gu, '-')
}

function validateInput(input: unknown): asserts input is TermFidelityCorpusInput {
  if (!input || typeof input !== 'object') {
    throw new Error('Term-fidelity corpus input must be an object')
  }
  const candidate = input as Partial<TermFidelityCorpusInput>
  if (typeof candidate.projectId !== 'string' && candidate.projectId !== undefined) {
    throw new Error('Term-fidelity corpus project ID must be a string')
  }
  if (typeof candidate.agentName !== 'string' || !candidate.agentName.trim()) {
    throw new Error('Term-fidelity corpus agent name is required')
  }
  if (typeof candidate.cli !== 'string' || !candidate.cli.trim()) {
    throw new Error('Term-fidelity corpus CLI is required')
  }

  for (const [label, grid] of [
    ['renderer', candidate.renderer],
    ['broker', candidate.broker]
  ] as const) {
    if (!grid || typeof grid !== 'object') {
      throw new Error(`Term-fidelity corpus ${label} grid must be an object`)
    }
    if (!Number.isInteger(grid.rows) || grid.rows <= 0) {
      throw new Error(`Term-fidelity corpus ${label} rows must be a positive integer`)
    }
    if (!Number.isInteger(grid.cols) || grid.cols <= 0) {
      throw new Error(`Term-fidelity corpus ${label} cols must be a positive integer`)
    }
    if (typeof grid.text !== 'string') {
      throw new Error(`Term-fidelity corpus ${label} text must be a string`)
    }
  }

  if (
    !Array.isArray(candidate.telemetryLines) ||
    candidate.telemetryLines.some((line) => typeof line !== 'string')
  ) {
    throw new Error('Term-fidelity corpus telemetry lines must be strings')
  }
}

/**
 * Main-process writer for production terminal-fidelity bundles.
 *
 * Calls for the same project + agent share an in-flight promise. Once a dump
 * starts, later confirmed divergences are suppressed for five minutes. A
 * failed dump releases its reservation so a later confirmation can retry.
 */
export class TermFidelityCorpusDumper {
  private readonly lastDumpAt = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<TermFidelityCorpusResult>>()
  private readonly lastFailureWarnAt = new Map<string, number>()
  private lastBundleTimestampMs = 0
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly warn: (message: string) => void

  constructor(deps: TermFidelityCorpusDumperDeps = {}) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((message) => console.info(message))
    this.warn = deps.warn ?? ((message) => console.warn(message))
  }

  dump(
    input: TermFidelityCorpusInput,
    options: TermFidelityCorpusDumpOptions
  ): Promise<TermFidelityCorpusResult> {
    validateInput(input)
    const key = agentKey(input)
    const pending = this.inFlight.get(key)
    if (pending) return pending

    const startedAt = this.now()
    const previousDumpAt = this.lastDumpAt.get(key)
    if (
      previousDumpAt !== undefined &&
      startedAt - previousDumpAt < TERM_FIDELITY_CORPUS_DUMP_GAP_MS
    ) {
      return Promise.resolve({ dumped: false, reason: 'rate-limited' })
    }

    // Reserve before the first await so duplicate IPC delivery cannot start a
    // second capture. The in-flight promise coalesces truly concurrent calls.
    this.lastDumpAt.set(key, startedAt)
    const promise = this.writeBundle(input, options, startedAt)
      .catch((error: unknown): TermFidelityCorpusResult => {
        if (this.lastDumpAt.get(key) === startedAt) this.lastDumpAt.delete(key)
        const failedAt = this.now()
        const lastWarnAt = this.lastFailureWarnAt.get(key)
        if (lastWarnAt === undefined || failedAt - lastWarnAt >= TERM_FIDELITY_CORPUS_WARN_GAP_MS) {
          this.lastFailureWarnAt.set(key, failedAt)
          const message = error instanceof Error ? error.message : String(error)
          this.warn(
            `[term-fidelity] corpus dump failed for ${JSON.stringify(input.agentName)}: ${message.replace(/[\r\n]+/gu, ' ')}`
          )
        }
        return { dumped: false, reason: 'failed' }
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
      })
    this.inFlight.set(key, promise)
    return promise
  }

  private async writeBundle(
    input: TermFidelityCorpusInput,
    options: TermFidelityCorpusDumpOptions,
    startedAt: number
  ): Promise<TermFidelityCorpusResult> {
    // Two different agents can confirm within the same millisecond. Advance
    // the directory timestamp monotonically so their bundles cannot collide.
    const bundleTimestampMs = Math.max(startedAt, this.lastBundleTimestampMs + 1)
    this.lastBundleTimestampMs = bundleTimestampMs
    const capturedAt = new Date(bundleTimestampMs).toISOString()
    const bundleDir = join(options.rootDir, timestampDirectoryName(bundleTimestampMs))
    const [screenshot, relayVersions] = await Promise.all([
      options.capturePage(),
      options.relayVersions()
    ])
    const meta = {
      capturedAt,
      projectId: input.projectId,
      agentName: input.agentName,
      cli: input.cli,
      dims: {
        renderer: { rows: input.renderer.rows, cols: input.renderer.cols },
        broker: { rows: input.broker.rows, cols: input.broker.cols }
      },
      relayVersions,
      reconcilerTelemetryLines: input.telemetryLines
    }

    await mkdir(bundleDir, { recursive: true })
    await Promise.all([
      writeFile(join(bundleDir, 'renderer.txt'), input.renderer.text),
      writeFile(join(bundleDir, 'broker.txt'), input.broker.text),
      writeFile(join(bundleDir, 'screen.png'), screenshot),
      writeFile(join(bundleDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    ])

    // Exactly one main-process line is emitted for each completed bundle.
    // JSON encoding keeps an unexpected newline in an agent name on one line.
    this.log(
      `[term-fidelity] dumped corpus bundle for ${JSON.stringify(input.agentName)} to ${JSON.stringify(bundleDir)}`
    )
    return { dumped: true, path: bundleDir }
  }
}
