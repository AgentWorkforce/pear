import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { getActivity, getRawStream, type FidelityHarness } from './harness'
import { deriveByteAccounting } from './byte-accounting'

export const QUIET_WINDOW_MS = 1_500
const QUIET_TIMEOUT_MS = 90_000

export const WORKLOAD_NAMES = [
  'long-streaming-reply',
  'turn-boundary-follow-up',
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

// Reach the live xterm runtime the same way readRendererGrid does, call
// scrollToBottom(), and report whether that alone re-pins the viewport. If it
// does, a divergence is purely a scroll-position artifact (content/baseY are
// correct and a re-pin fixes it).
export async function probeScrollToBottom(
  page: Page,
  agentName: string
): Promise<{ before: [number, number]; after: [number, number]; atBottomAfter: boolean }> {
  return await page.evaluate((name) => {
    const container = document.querySelector<HTMLElement>(
      `[data-testid="terminal-instance"][data-agent-name="${CSS.escape(name)}"]`
    )
    if (!container) throw new Error(`Terminal container not found for ${name}`)
    const fiberKey = Object.keys(container).find((key) => key.startsWith('__reactFiber$'))
    if (!fiberKey) throw new Error(`React fiber not found for ${name}`)
    type Runtime = {
      term: {
        scrollToBottom(): void
        buffer: { active: { baseY: number; viewportY: number } }
      }
    }
    const looksLikeRuntime = (value: unknown): value is Runtime => {
      const c = value as Partial<Runtime> | null
      return Boolean(
        c && typeof c === 'object' && c.term &&
        typeof (c.term as Runtime['term']).scrollToBottom === 'function' &&
        (c.term as Runtime['term']).buffer?.active
      )
    }
    let runtime: Runtime | null = null
    let fiber: { memoizedState?: unknown; return?: unknown } | null =
      (container as unknown as Record<string, { memoizedState?: unknown; return?: unknown }>)[fiberKey]
    while (fiber && !runtime) {
      let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null
      const seen = new Set<unknown>()
      while (hook && typeof hook === 'object' && !seen.has(hook)) {
        seen.add(hook)
        const state = hook.memoizedState
        const current = state && typeof state === 'object'
          ? (state as { current?: unknown }).current
          : undefined
        if (looksLikeRuntime(current)) { runtime = current; break }
        hook = hook.next as typeof hook
      }
      fiber = (fiber.return as typeof fiber) || null
    }
    if (!runtime) throw new Error(`Live xterm runtime not found for ${name}`)
    const b = runtime.term.buffer.active
    const before: [number, number] = [b.viewportY, b.baseY]
    runtime.term.scrollToBottom()
    const a = runtime.term.buffer.active
    const after: [number, number] = [a.viewportY, a.baseY]
    return { before, after, atBottomAfter: a.viewportY === a.baseY }
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

// Paint an arbitrary raw byte stream into a fresh headless xterm at the given
// dims and read back its cell grid + cursor. Used to replay the exact bytes the
// renderer received (getRawStream) so a clean-emulator render of the delivered
// bytes can be compared against both the broker oracle and the live renderer.
async function replayRawToGrid(
  raw: string,
  rows: number,
  cols: number
): Promise<{ lines: string[]; cells: Cell[][]; cursor: [number, number] }> {
  const term = new HeadlessTerminal({ rows, cols, scrollback: 0, allowProposedApi: true })
  try {
    await writeHeadless(term, raw)
    const buffer = term.buffer.active
    const lines: string[] = []
    const cells: Cell[][] = []
    for (let row = 0; row < rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row)
      lines.push(line ? line.translateToString(true, 0, cols) : '')
      const rowCells: Cell[] = []
      for (let col = 0; col < cols; col += 1) {
        const cell = line?.getCell(col)
        rowCells.push({ chars: cell?.getChars() || '', width: cell?.getWidth() ?? 1 })
      }
      cells.push(rowCells)
    }
    return { lines, cells, cursor: [buffer.cursorY, buffer.cursorX] }
  } finally {
    term.dispose()
  }
}

function countCellDiffs(a: Cell[][], b: Cell[][], rows: number, cols: number): number {
  let total = 0
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const ca = a[row]?.[col]
      const cb = b[row]?.[col]
      if (normalizedCellChars(ca) === normalizedCellChars(cb) && ca?.width === cb?.width) continue
      total += 1
    }
  }
  return total
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

      const activityStable =
        activityBefore.lastVisualOutputAt === activityAfter.lastVisualOutputAt &&
        activityBefore.visualChunks === activityAfter.visualChunks
      // Byte/chunk totals intentionally include screen-neutral terminal
      // queries for delivery accounting. Quietness follows only bytes that can
      // mutate the visible grid; see installActivityProbe in harness.ts.
      const quietFor = Date.now() - activityAfter.lastVisualOutputAt
      const dimsMatch = renderer.rows === broker.rows && renderer.cols === broker.cols
      const atBottom = renderer.viewportY === renderer.baseY
      const quiet = activityAfter.lastVisualOutputAt > 0 &&
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
  // Segregate by Playwright attempt so a retry never overwrites the first
  // attempt's bundle. A retry-then-pass previously clobbered the diverging
  // first-attempt data (which twice turned out to be a REAL divergence event),
  // leaving nothing to examine afterward.
  const artifactDir = join(
    harness.repoRoot,
    'test-results',
    'term-fidelity',
    harness.cli,
    workload,
    `attempt-${harness.attempt}`
  )
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
    // Cursor convention normalization. The renderer cursor comes from xterm's
    // buffer API, which is 0-indexed [row, col]. The broker plain-snapshot
    // cursor is 1-indexed [row, col] — it mirrors the raw CUP coordinates (a
    // stream ending in ESC[40;3H reports broker cursor [40, 3] while xterm
    // reports [39, 2] for the SAME cell). Comparing the raw values makes a
    // faithful render look like an off-by-one bug (this misread #403). Record
    // the raw values WITH their conventions, plus both normalized to a common
    // 0-indexed base and a computed match: a `false` here on an otherwise
    // content-matching bundle is a REAL cursor divergence, not the convention.
    cursor: {
      rendererRaw0Indexed: renderer.cursor,
      brokerRaw1Indexed: broker.cursor,
      normalized0Indexed: {
        renderer: renderer.cursor,
        broker: [broker.cursor[0] - 1, broker.cursor[1] - 1] as [number, number]
      },
      match:
        renderer.cursor[0] === broker.cursor[0] - 1 &&
        renderer.cursor[1] === broker.cursor[1] - 1
    },
    // Self-documenting client-vs-broker byte accounting. Replaces the former
    // bare `brokerOffset` + `quiet.activity.bytes` pair, whose exact-2.0 reading
    // in codex bundles was misread as double delivery (it was a derivation
    // artifact — see byte-accounting.ts / the embedded note). Each figure now
    // declares its baseline and unit, and the ratio is computed on a shared
    // agent-start baseline so ~1.0 is the meaningful "one-to-one delivery" value.
    byteAccounting: deriveByteAccounting({
      clientBytesReceived: quiet.activity.bytes,
      clientChunks: quiet.activity.chunks,
      snapshotOffset: broker.offset
    }),
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
  // Emit the byte-level discriminator on clean checkpoints too. Previously it
  // was calculated only after a cell mismatch, which meant a passing real-CLI
  // regression could establish visual equality but could not leave explicit
  // evidence that the exact delivered byte stream also reproduces the broker
  // screen. Keep this diagnostic non-mutating and retain the richer scroll
  // probe/artifact write in the divergence branch below.
  try {
    const raw = await getRawStream(harness.page, agentName)
    const rawReplay = await replayRawToGrid(raw, broker.rows, broker.cols)
    const brokerCells = await brokerCellGrid(broker)
    const rawVsBroker = countCellDiffs(rawReplay.cells, brokerCells, broker.rows, broker.cols)
    const rawVsRenderer = countCellDiffs(rawReplay.cells, renderer.cells, broker.rows, broker.cols)
    const cursorMatch =
      renderer.cursor[0] === broker.cursor[0] - 1 &&
      renderer.cursor[1] === broker.cursor[1] - 1
    console.log(
      `[term-fidelity] checkpoint evidence ${harness.cli}/${workload}: ` +
      `bufferType=${renderer.bufferType} viewport=[${renderer.viewportY},${renderer.baseY}] ` +
      `cursorMatch=${cursorMatch} rawBytes=${raw.length} ` +
      `rawVsBroker=${rawVsBroker} rawVsRenderer=${rawVsRenderer}`
    )
  } catch (error) {
    console.warn(
      `[term-fidelity] checkpoint byte evidence unavailable for ${harness.cli}/${workload}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    )
  }
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

    // Replay the exact bytes the renderer received through a clean headless
    // emulator to locate where the divergence was introduced:
    //   rawVsBroker == 0 → delivery is byte-clean; the divergence is
    //                      renderer-internal (echo-router / predictive-echo /
    //                      reconciler write path).
    //   rawVsBroker  > 0 → bytes were lost/reordered BEFORE the renderer (main
    //                      IPC / dedup) — a delivery vector.
    // rawVsRenderer shows how far the live grid drifted from a faithful render
    // of the delivered bytes. The scroll probe distinguishes a stranded
    // viewport (content correct, just scrolled) from real content corruption.
    let discriminator = 'raw-stream unavailable'
    try {
      const raw = await getRawStream(harness.page, agentName)
      const rawReplay = await replayRawToGrid(raw, broker.rows, broker.cols)
      const brokerCells = await brokerCellGrid(broker)
      const rawVsBroker = countCellDiffs(rawReplay.cells, brokerCells, broker.rows, broker.cols)
      const rawVsRenderer = countCellDiffs(rawReplay.cells, renderer.cells, broker.rows, broker.cols)
      let scrollProbe = 'skipped'
      try {
        const probe = await probeScrollToBottom(harness.page, agentName)
        scrollProbe =
          `viewport[vY,baseY]before=[${probe.before}] after=[${probe.after}] ` +
          `atBottomAfterScroll=${probe.atBottomAfter}`
      } catch (probeError) {
        scrollProbe = `probe failed: ${probeError instanceof Error ? probeError.message : String(probeError)}`
      }
      discriminator =
        `rawBytes=${raw.length} rawReplayCursor=[${rawReplay.cursor}] ` +
        `rendererViewport=[vY=${renderer.viewportY},baseY=${renderer.baseY}] ` +
        `rawVsBroker=${rawVsBroker} rawVsRenderer=${rawVsRenderer} ` +
        `verdict=${rawVsBroker === 0 ? 'RENDERER-INTERNAL' : 'DELIVERY-LOSS'} ${scrollProbe}`
      await Promise.all([
        writeFile(join(artifactDir, 'raw.bin'), raw),
        writeFile(join(artifactDir, 'raw-replay.txt'), rawReplay.lines.join('\n')),
        writeFile(join(artifactDir, 'discriminator.txt'), `${discriminator}\n`),
        writeFile(join(artifactDir, 'renderer-console.log'), `${harness.rendererConsole.join('\n')}\n`)
      ])
    } catch (error) {
      discriminator = `raw forensics failed: ${error instanceof Error ? error.message : String(error)}`
    }

    throw new Error(
      `${harness.cli}/${workload} diverged in ${differingCells} cells; artifacts: ${artifactDir}\n` +
      `[discriminator] ${discriminator}\n` +
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
    'reconciler-telemetry',
    `attempt-${harness.attempt}`
  )
  await mkdir(artifactDir, { recursive: true })
  const screenshot = await harness.page.screenshot({ animations: 'disabled', type: 'png' })

  // A reconciler repair fired mid-workload, so the LIVE grid was already
  // repainted from the broker snapshot before we got here — the pre-repair grid
  // is gone. But the cumulative raw stream survives: replaying every delivered
  // byte through a clean emulator and diffing against the final broker snapshot
  // still discriminates the class. rawVsBroker==0 ⇒ delivery was byte-clean
  // over the whole session, so the transient divergence the reconciler repaired
  // was RENDERER-INTERNAL (the live grid drifted from a faithful render of the
  // same bytes — a creation vector in the renderer write path). rawVsBroker>0 ⇒
  // bytes were lost/reordered before the renderer and the repair masked it.
  let discriminator = 'raw-stream unavailable'
  try {
    const raw = await getRawStream(harness.page, agentName)
    const broker = await readBrokerSnapshot(harness.connectionPath, agentName)
    const renderer = await readRendererGrid(harness.page, agentName)
    const rawReplay = await replayRawToGrid(raw, broker.rows, broker.cols)
    const brokerCells = await brokerCellGrid(broker)
    const rawVsBroker = countCellDiffs(rawReplay.cells, brokerCells, broker.rows, broker.cols)
    const rawVsRenderer = countCellDiffs(rawReplay.cells, renderer.cells, broker.rows, broker.cols)
    discriminator =
      `rawBytes=${raw.length} bufferType=${renderer.bufferType} ` +
      `rawVsBroker=${rawVsBroker} rawVsRenderer=${rawVsRenderer} ` +
      `verdict=${rawVsBroker === 0 ? 'RENDERER-INTERNAL' : 'DELIVERY-LOSS'} ` +
      `(post-repair grid==broker by construction; this is the session-cumulative delivery check)`
    await Promise.all([
      writeFile(join(artifactDir, 'raw.bin'), raw),
      writeFile(join(artifactDir, 'raw-replay.txt'), rawReplay.lines.join('\n')),
      writeFile(join(artifactDir, 'broker.txt'), broker.screen),
      writeFile(join(artifactDir, 'renderer.txt'), renderer.lines.join('\n')),
      writeFile(join(artifactDir, 'discriminator.txt'), `${discriminator}\n`),
      writeFile(join(artifactDir, 'renderer-console.log'), `${harness.rendererConsole.join('\n')}\n`)
    ])
  } catch (error) {
    discriminator = `raw forensics failed: ${error instanceof Error ? error.message : String(error)}`
  }

  await Promise.all([
    writeFile(join(artifactDir, 'screen.png'), screenshot),
    writeFile(join(artifactDir, 'meta.json'), `${JSON.stringify({
      cli: harness.cli,
      agentName,
      capturedAt: new Date().toISOString(),
      instanceName: harness.instanceName,
      apiPort: harness.apiPort,
      relayVersions: { broker: harness.brokerVersion, ...harness.relayVersions },
      reconcilerTelemetryLines: harness.telemetry,
      discriminator
    }, null, 2)}\n`)
  ])
  return artifactDir
}
