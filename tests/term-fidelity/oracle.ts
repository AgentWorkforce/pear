import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { getActivity, type FidelityHarness } from './harness'

export const QUIET_WINDOW_MS = 1_500
const QUIET_TIMEOUT_MS = 90_000

export const WORKLOAD_NAMES = [
  'long-streaming-reply',
  'permission-prompt-repaint',
  'resize-mid-stream',
  'typing-during-stream',
  'hide-reveal-during-stream',
  'scrollback-during-stream'
] as const

export type WorkloadName = (typeof WORKLOAD_NAMES)[number]

interface Cell {
  chars: string
  width: number
}

export interface RendererGrid {
  rows: number
  cols: number
  bufferType: string
  lines: string[]
  cells: Cell[][]
  baseY: number
  viewportY: number
  cursor: [number, number]
  hasPredictions: boolean
}

export interface BrokerSnapshot {
  format: 'plain'
  rows: number
  cols: number
  cursor: [number, number]
  screen: string
  offset?: number
}

interface QuietResult {
  reached: boolean
  waitedMs: number
  activity: Awaited<ReturnType<typeof getActivity>>
  renderer: RendererGrid
  broker: BrokerSnapshot
  reason?: string
}

interface CheckpointOptions {
  marker: string
  telemetryAtStart: number
}

interface ReactFiberLike {
  memoizedState?: unknown
  return?: ReactFiberLike | null
}

// The production renderer deliberately exposes no test API. The terminal
// runtime is already held by useTerminal's runtimeRef, so Playwright follows
// the host node's React fiber to that ref and reads the public xterm buffer.
// Nothing is patched, written, or added to the renderer bundle.
export async function readRendererGrid(page: Page, agentName: string): Promise<RendererGrid> {
  return await page.evaluate((name) => {
    const container = document.querySelector<HTMLElement>(
      `[data-testid="terminal-instance"][data-agent-name="${CSS.escape(name)}"]`
    )
    if (!container) throw new Error(`Terminal container not found for ${name}`)

    const fiberKey = Object.keys(container).find((key) => key.startsWith('__reactFiber$'))
    if (!fiberKey) throw new Error(`React fiber not found for terminal ${name}`)

    type Runtime = {
      term: {
        rows: number
        cols: number
        buffer: {
          active: {
            baseY: number
            viewportY: number
            cursorX: number
            cursorY: number
            type: string
            getLine(row: number): {
              translateToString(trimRight: boolean, start?: number, end?: number): string
              getCell(col: number): { getChars(): string; getWidth(): number } | undefined
            } | undefined
          }
        }
      }
      getPredictiveEcho(): { hasPredictions?: boolean } | null
    }

    const looksLikeRuntime = (value: unknown): value is Runtime => {
      if (!value || typeof value !== 'object') return false
      const candidate = value as Partial<Runtime>
      return Boolean(
        candidate.term?.buffer?.active &&
        typeof candidate.term.rows === 'number' &&
        typeof candidate.term.cols === 'number' &&
        typeof candidate.getPredictiveEcho === 'function'
      )
    }

    let runtime: Runtime | null = null
    let fiber: ReactFiberLike | null =
      (container as unknown as Record<string, ReactFiberLike>)[fiberKey]
    while (fiber && !runtime) {
      let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null
      const seen = new Set<unknown>()
      while (hook && typeof hook === 'object' && !seen.has(hook)) {
        seen.add(hook)
        const state = hook.memoizedState
        const current = state && typeof state === 'object'
          ? (state as { current?: unknown }).current
          : undefined
        if (looksLikeRuntime(current)) {
          runtime = current
          break
        }
        hook = hook.next as typeof hook
      }
      fiber = fiber.return || null
    }

    if (!runtime) throw new Error(`Live xterm runtime not found in React hook state for ${name}`)
    const term = runtime.term
    const buffer = term.buffer.active
    const lines: string[] = []
    const cells: Array<Array<{ chars: string; width: number }>> = []
    for (let row = 0; row < term.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row)
      lines.push(line ? line.translateToString(true, 0, term.cols) : '')
      const rowCells: Array<{ chars: string; width: number }> = []
      for (let col = 0; col < term.cols; col += 1) {
        const cell = line?.getCell(col)
        rowCells.push({
          chars: cell?.getChars() || '',
          width: cell?.getWidth() ?? 1
        })
      }
      cells.push(rowCells)
    }

    return {
      rows: term.rows,
      cols: term.cols,
      bufferType: buffer.type,
      lines,
      cells,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursor: [buffer.cursorY, buffer.cursorX] as [number, number],
      hasPredictions: Boolean(runtime.getPredictiveEcho()?.hasPredictions)
    }
  }, agentName)
}

export async function readBrokerSnapshot(
  connectionPath: string,
  agentName: string
): Promise<BrokerSnapshot> {
  const connection = JSON.parse(await readFile(connectionPath, 'utf8')) as {
    url?: string
    api_key?: string
  }
  if (!connection.url || !connection.api_key) {
    throw new Error(`Broker connection is incomplete: ${connectionPath}`)
  }

  const endpoint = new URL(
    `/api/spawned/${encodeURIComponent(agentName)}/snapshot?format=plain`,
    connection.url
  )
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${connection.api_key}`,
      'X-API-Key': connection.api_key
    },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) {
    throw new Error(`Broker snapshot failed for ${agentName}: ${response.status} ${await response.text()}`)
  }
  const snapshot = await response.json() as Partial<BrokerSnapshot>
  if (
    snapshot.format !== 'plain' ||
    typeof snapshot.rows !== 'number' ||
    typeof snapshot.cols !== 'number' ||
    typeof snapshot.screen !== 'string' ||
    !Array.isArray(snapshot.cursor)
  ) {
    throw new Error(`Broker returned a malformed plain snapshot for ${agentName}`)
  }
  return snapshot as BrokerSnapshot
}

function writeHeadless(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolveWrite) => term.write(data, resolveWrite))
}

async function brokerCellGrid(snapshot: BrokerSnapshot): Promise<Cell[][]> {
  const term = new HeadlessTerminal({
    rows: snapshot.rows,
    cols: snapshot.cols,
    scrollback: 0,
    allowProposedApi: true
  })
  try {
    const rows = snapshot.screen.split('\n')
    let paint = '\x1b[2J'
    for (let row = 0; row < snapshot.rows; row += 1) {
      paint += `\x1b[${row + 1};1H${rows[row] || ''}`
    }
    await writeHeadless(term, paint)

    const cells: Cell[][] = []
    const buffer = term.buffer.active
    for (let row = 0; row < snapshot.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row)
      const rowCells: Cell[] = []
      for (let col = 0; col < snapshot.cols; col += 1) {
        const cell = line?.getCell(col)
        rowCells.push({
          chars: cell?.getChars() || '',
          width: cell?.getWidth() ?? 1
        })
      }
      cells.push(rowCells)
    }
    return cells
  } finally {
    term.dispose()
  }
}

function visibleCell(cell: Cell | undefined): string {
  if (!cell) return '<missing>'
  const chars = cell.chars === '' || cell.chars === ' ' ? '<blank>' : cell.chars
  return `${JSON.stringify(chars)}(w=${cell.width})`
}

function normalizedCellChars(cell: Cell | undefined): string | undefined {
  // A cleared xterm cell reports an empty string, while painting a broker
  // plain-snapshot row through headless xterm materializes the same visual
  // blank as one literal space. Both are the same empty text cell.
  if (cell?.chars === '' || cell?.chars === ' ') return ''
  return cell?.chars
}

interface CellDiffResult {
  differences: string[]
  total: number
}

async function cellDiff(renderer: RendererGrid, broker: BrokerSnapshot): Promise<CellDiffResult> {
  const expected = await brokerCellGrid(broker)
  const differences: string[] = []
  let total = 0
  if (renderer.rows !== broker.rows || renderer.cols !== broker.cols) {
    total += 1
    differences.push(
      `dimension mismatch: renderer=${renderer.rows}x${renderer.cols} broker=${broker.rows}x${broker.cols}`
    )
  }

  const rows = Math.max(renderer.rows, broker.rows)
  const cols = Math.max(renderer.cols, broker.cols)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const actualCell = renderer.cells[row]?.[col]
      const expectedCell = expected[row]?.[col]
      if (
        normalizedCellChars(actualCell) === normalizedCellChars(expectedCell) &&
        actualCell?.width === expectedCell?.width
      ) continue

      total += 1
      if (differences.length < 400) {
        differences.push(
          `row=${row + 1} col=${col + 1} broker=${visibleCell(expectedCell)} renderer=${visibleCell(actualCell)}`
        )
      }
    }
  }

  if (total > differences.length) {
    differences.push(`... ${total - differences.length} additional differing cells omitted`)
  }
  return { differences, total }
}

async function waitForQuiet(
  harness: FidelityHarness,
  agentName: string,
  timeoutMs = QUIET_TIMEOUT_MS
): Promise<QuietResult> {
  const startedAt = Date.now()
  let stablePasses = 0
  let lastRenderer: RendererGrid | null = null
  let lastBroker: BrokerSnapshot | null = null
  let lastActivity = await getActivity(harness.page, agentName)
  let reason = 'terminal did not reach the quiet gate'

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const activityBefore = await getActivity(harness.page, agentName)
      const renderer = await readRendererGrid(harness.page, agentName)
      const broker = await readBrokerSnapshot(harness.connectionPath, agentName)
      const activityAfter = await getActivity(harness.page, agentName)
      lastRenderer = renderer
      lastBroker = broker
      lastActivity = activityAfter

      const activityStable = activityBefore.lastOutputAt === activityAfter.lastOutputAt &&
        activityBefore.bytes === activityAfter.bytes
      const quietFor = Date.now() - activityAfter.lastOutputAt
      const dimsMatch = renderer.rows === broker.rows && renderer.cols === broker.cols
      const atBottom = renderer.viewportY === renderer.baseY
      const quiet = activityAfter.lastOutputAt > 0 &&
        quietFor >= QUIET_WINDOW_MS &&
        activityStable &&
        !renderer.hasPredictions &&
        dimsMatch &&
        atBottom

      if (quiet) {
        stablePasses += 1
        if (stablePasses >= 2) {
          return {
            reached: true,
            waitedMs: Date.now() - startedAt,
            activity: activityAfter,
            renderer,
            broker
          }
        }
      } else {
        stablePasses = 0
        reason = [
          `quietFor=${quietFor}ms`,
          `activityStable=${activityStable}`,
          `hasPredictions=${renderer.hasPredictions}`,
          `dims=${renderer.rows}x${renderer.cols}/${broker.rows}x${broker.cols}`,
          `viewportAtBottom=${atBottom}`
        ].join(' ')
      }
    } catch (error) {
      stablePasses = 0
      reason = error instanceof Error ? error.message : String(error)
    }
    await harness.page.waitForTimeout(250)
  }

  if (!lastRenderer || !lastBroker) {
    throw new Error(`Could not capture terminal state while waiting for quiet: ${reason}`)
  }
  return {
    reached: false,
    waitedMs: Date.now() - startedAt,
    activity: lastActivity,
    renderer: lastRenderer,
    broker: lastBroker,
    reason
  }
}

async function writeDivergenceBundle(
  harness: FidelityHarness,
  agentName: string,
  workload: WorkloadName,
  renderer: RendererGrid,
  broker: BrokerSnapshot,
  screenshot: Buffer,
  differences: string[],
  differingCells: number,
  quiet: QuietResult,
  options: CheckpointOptions
): Promise<string> {
  const artifactDir = join(harness.repoRoot, 'test-results', 'term-fidelity', harness.cli, workload)
  await mkdir(artifactDir, { recursive: true })
  const telemetry = harness.telemetry.slice(options.telemetryAtStart)
  const meta = {
    cli: harness.cli,
    workload,
    agentName,
    marker: options.marker,
    capturedAt: new Date().toISOString(),
    instanceName: harness.instanceName,
    apiPort: harness.apiPort,
    projectRoot: harness.projectRoot,
    userDataDir: harness.userDataDir,
    brokerStateDir: harness.brokerStateDir,
    dims: {
      renderer: { rows: renderer.rows, cols: renderer.cols },
      broker: { rows: broker.rows, cols: broker.cols }
    },
    rendererBufferType: renderer.bufferType,
    cursor: {
      renderer: renderer.cursor,
      broker: broker.cursor
    },
    brokerOffset: broker.offset,
    quiet: {
      reached: quiet.reached,
      waitedMs: quiet.waitedMs,
      reason: quiet.reason,
      activity: quiet.activity,
      hasPredictions: renderer.hasPredictions,
      viewportAtBottom: renderer.viewportY === renderer.baseY
    },
    relayVersions: {
      broker: harness.brokerVersion,
      ...harness.relayVersions
    },
    reconcilerTelemetryLines: telemetry,
    differingCells
  }
  await Promise.all([
    writeFile(join(artifactDir, 'renderer.txt'), renderer.lines.join('\n')),
    writeFile(join(artifactDir, 'broker.txt'), broker.screen),
    writeFile(join(artifactDir, 'diff.txt'), `${differences.join('\n')}\n`),
    writeFile(join(artifactDir, 'screen.png'), screenshot),
    writeFile(join(artifactDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  ])
  return artifactDir
}

export async function captureCheckpoint(
  harness: FidelityHarness,
  agentName: string,
  workload: WorkloadName,
  options: CheckpointOptions
): Promise<void> {
  const quiet = await waitForQuiet(harness, agentName)
  // The quiet gate already captures both grids inside an activity-serial
  // recheck. Reuse that guarded pair instead of taking an unguarded second
  // pair that could straddle a late PTY chunk.
  const { renderer, broker } = quiet
  const screenshot = await harness.page.screenshot({ animations: 'disabled', type: 'png' })
  const { differences, total: differingCells } = await cellDiff(renderer, broker)
  if (!quiet.reached) {
    differences.unshift(`quiet gate timeout after ${quiet.waitedMs}ms: ${quiet.reason || 'unknown'}`)
  }

  if (!quiet.reached || differingCells > 0) {
    const artifactDir = await writeDivergenceBundle(
      harness,
      agentName,
      workload,
      renderer,
      broker,
      screenshot,
      differences,
      differingCells,
      quiet,
      options
    )
    throw new Error(
      `${harness.cli}/${workload} diverged in ${differingCells} cells; artifacts: ${artifactDir}\n` +
      differences.slice(0, 20).join('\n')
    )
  }
}

export async function writeTelemetryArtifact(
  harness: FidelityHarness,
  agentName: string
): Promise<string> {
  const artifactDir = join(
    harness.repoRoot,
    'test-results',
    'term-fidelity',
    harness.cli,
    'reconciler-telemetry'
  )
  await mkdir(artifactDir, { recursive: true })
  const screenshot = await harness.page.screenshot({ animations: 'disabled', type: 'png' })
  await Promise.all([
    writeFile(join(artifactDir, 'screen.png'), screenshot),
    writeFile(join(artifactDir, 'meta.json'), `${JSON.stringify({
      cli: harness.cli,
      agentName,
      capturedAt: new Date().toISOString(),
      instanceName: harness.instanceName,
      apiPort: harness.apiPort,
      relayVersions: { broker: harness.brokerVersion, ...harness.relayVersions },
      reconcilerTelemetryLines: harness.telemetry
    }, null, 2)}\n`)
  ])
  return artifactDir
}
