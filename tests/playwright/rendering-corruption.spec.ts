// Rendering-corruption reproduction harness.
//
// Recreates the live-session workload that produced the interleaved-rows /
// stacked-lines corruption reports: a Claude Code-style Ink TUI that
// repaints a panel in place with cursor-up + erase-down sequences, large
// integration-update text dumps, >32KB single-chunk floods (which trip the
// echo router's engine bypass), and a human typing mid-flood with the
// predictive-echo engine engaged (forced high input SRTT + delayed echo).
//
// Verification is byte-faithfulness, not markers: after the storm settles,
// the live terminal's parsed viewport must equal a reference @xterm/headless
// terminal fed the exact canonical chunk stream the renderer received. ANY
// dropped, duplicated, reordered, or misparsed byte — or a stranded
// prediction glyph — shows up as a diff. A screenshot is saved for human
// inspection either way.
//
// Run: npm run test:fidelity (shares the fidelity Playwright config).

import { expect, test } from '@playwright/test'
import { Terminal } from '@xterm/headless'

const PROJECT_ID = 'mock-project'
const AGENT = 'storm-0001'
const PANEL_ROWS = 12

// Deterministic PRNG so chunk boundaries are reproducible across runs.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function integrationDump(blocks: number): string {
  let out = ''
  for (let b = 0; b < blocks; b += 1) {
    out += `<integration-event provider="slack" block="${String(b).padStart(3, '0')}">\r\n`
    out += 'Writeback discovery schemas and examples are mounted through '
    out += '.integrations/discovery/<provider>/ for connected integrations. '
    out += 'Local historical provider records are not broadly downloaded.\r\n'
    out += `channels/C0B9F02GU9__gtm-world-cup-soccer/messages entry ${b} `
    out += 'live thread context roots are mounted on demand or through incoming events.\r\n'
  }
  return out
}

function panelFrame(frame: number, first: boolean): string {
  const lines: string[] = []
  for (let row = 0; row < PANEL_ROWS; row += 1) {
    if (row === 0) {
      lines.push(`\x1b[36mFRAME=${String(frame).padStart(5, '0')}\x1b[0m ── pear corruption repro panel ──`)
    } else {
      const spinner = '|/-\\'[frame % 4]
      lines.push(`\x1b[2m│\x1b[0m ${spinner} row ${String(row).padStart(2, '0')} ${'█'.repeat((frame + row) % 40)}`)
    }
  }
  const body = lines.join('\r\n')
  // First paint appends; repaints move up over the previous panel and erase
  // down — the Ink in-place redraw shape.
  return first ? body : `\x1b[${PANEL_ROWS - 1}A\r\x1b[J${body}`
}

function chunkRandomly(data: string, rng: () => number): string[] {
  const chunks: string[] = []
  let i = 0
  while (i < data.length) {
    const size = 64 + Math.floor(rng() * 2048)
    chunks.push(data.slice(i, i + size))
    i += size
  }
  return chunks
}

function readReferenceViewport(stream: string, rows: number, cols: number): Promise<string> {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 3000 })
  return new Promise<string>((resolve) => {
    term.write(stream, () => {
      const buf = term.buffer.active
      const lines: string[] = []
      for (let row = 0; row < rows; row += 1) {
        const line = buf.getLine(buf.baseY + row)
        lines.push(line ? line.translateToString(true) : '')
      }
      term.dispose()
      resolve(lines.join('\n'))
    })
  })
}

// Bisect knobs for iterating on a divergence:
//   STORM_SRTT=0   → engine never engages (direct route only)
//   STORM_TYPE=0   → no typing (no predictions, no echo traffic)
//   STORM_CPU=4    → 4x CDP CPU throttling (reproduces slow-CI timing)
const STORM_SRTT = process.env.STORM_SRTT === '0' ? null : 80
const STORM_TYPE = process.env.STORM_TYPE !== '0'
const STORM_CPU = Number(process.env.STORM_CPU || '1')

test.describe('rendering corruption repro — flood + typing + engine routing', () => {
  test('screen stays byte-faithful through an Ink-style storm with engaged predictions', async ({ page }, testInfo) => {
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))

    await page.addInitScript(() => {
      window.localStorage.setItem('pear-web-initial-tab', 'agents')
      window.localStorage.setItem('pear-terminal-layout', 'tabs')
    })
    if (STORM_CPU > 1) {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: STORM_CPU })
    }
    await page.goto('/')
    await expect(page.getByText('Mock Project')).toBeVisible()

    await page.evaluate(({ projectId, srtt }) => {
      const mock = window.__pearMock
      if (!mock) throw new Error('window.__pearMock is not available')
      // Engage the predictive-echo engine route: high input SRTT + delayed
      // raw echo so optimistic glyphs render and later reconcile.
      mock.setInputSrtt(srtt)
      mock.setInputEcho(srtt === null ? null : { delayMs: 60 })
      mock.spawnAgents(1, { projectId, namePrefix: 'storm' })
    }, { projectId: PROJECT_ID, srtt: STORM_SRTT })

    await page.locator('button').filter({ hasText: AGENT }).first().click()
    const terminal = page.locator(`[data-testid="terminal-instance"][data-agent-name="${AGENT}"]`)
    await expect(terminal).toBeVisible()
    // Attach + SIGWINCH bounce + font settle.
    await page.waitForTimeout(900)
    await terminal.click()

    // Build the storm byte stream in the TEST (so the node-side reference
    // sees the identical bytes), then drive it into the page in phases with
    // typing interleaved between them.
    const rng = mulberry32(0xc0ffee)
    const phaseA = integrationDump(40) // scrolling text dump
    let panel = panelFrame(0, true)
    const repaintBatch = (from: number, count: number): string => {
      let out = ''
      for (let f = from; f < from + count; f += 1) out += panelFrame(f, false)
      return out
    }
    const phaseB = panel + repaintBatch(1, 60)
    // One chunk big enough to trip the engine flood bypass.
    let flood = repaintBatch(61, 1)
    let floodFrame = 62
    while (flood.length <= 40_000) {
      flood += panelFrame(floodFrame, false)
      floodFrame += 1
    }
    const phaseD = repaintBatch(floodFrame, 40)
    const FINAL_FRAME = `FRAME=${String(floodFrame + 39).padStart(5, '0')}`

    const inject = async (chunks: string[]): Promise<void> => {
      await page.evaluate(async ({ projectId, agent, payload }) => {
        const mock = window.__pearMock
        if (!mock) throw new Error('mock missing')
        for (let i = 0; i < payload.length; i += 1) {
          mock.injectPtyChunk(projectId, agent, payload[i])
          if (i % 6 === 5) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          }
        }
      }, { projectId: PROJECT_ID, agent: AGENT, payload: chunks })
    }

    // Phase A: text dump while the user types (predictions engage here).
    const typingA = STORM_TYPE ? page.keyboard.type('status check', { delay: 45 }) : Promise.resolve()
    await inject(chunkRandomly(phaseA, rng))
    await typingA

    // Phase B: in-place repaints, randomly split mid-sequence.
    const typingB = STORM_TYPE ? page.keyboard.type('and more', { delay: 35 }) : Promise.resolve()
    await inject(chunkRandomly(phaseB, rng))
    await typingB

    // Phase C: the >32KB flood lands as ONE chunk (engine bypass), with a
    // keystroke racing it.
    const typingC = STORM_TYPE ? page.keyboard.type('x', { delay: 10 }) : Promise.resolve()
    await inject([flood])
    await typingC

    // Phase D: post-flood repaints on the direct route.
    await inject(chunkRandomly(phaseD, rng))

    // Settle: final repaint visible, echoes drained, engine tail flushed.
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ projectId, agent }) =>
              (window as unknown as {
                __pearReadTerminalViewport?: (p: string, n: string) => string | null
              }).__pearReadTerminalViewport?.(projectId, agent) ?? '',
            { projectId: PROJECT_ID, agent: AGENT }
          ),
        { timeout: 20_000, message: 'final repaint never rendered' }
      )
      .toContain(FINAL_FRAME)

    // Phase E: the stream is quiet now — this is the predictions regime.
    // Typing here engages the engine route (transition + reseed from the
    // live screen), renders optimistic glyphs, and reconciles them against
    // the delayed echo. The final screen must still be byte-faithful.
    if (STORM_TYPE) {
      await page.waitForTimeout(500) // clear the streaming quiet window
      await terminal.click()
      await page.keyboard.type('done', { delay: 60 })
    }
    await page.waitForTimeout(700)

    const screenshotPath = testInfo.outputPath('storm-final.png')
    await page.screenshot({ path: screenshotPath, fullPage: false })
    await testInfo.attach('storm-final', { path: screenshotPath, contentType: 'image/png' })

    const { viewport, dims, canonical } = await page.evaluate(({ projectId, agent }) => {
      const probe = window as unknown as {
        __pearReadTerminalViewport?: (p: string, n: string) => string | null
        __pearReadTerminalDims?: (p: string, n: string) => { rows: number; cols: number } | null
      }
      const mock = window.__pearMock
      return {
        viewport: probe.__pearReadTerminalViewport?.(projectId, agent) ?? null,
        dims: probe.__pearReadTerminalDims?.(projectId, agent) ?? null,
        canonical: mock?.getState().ptyChunks[`${projectId}:${agent}`]?.join('') ?? null
      }
    }, { projectId: PROJECT_ID, agent: AGENT })

    expect(viewport, 'viewport probe missing').not.toBeNull()
    expect(dims, 'dims probe missing').not.toBeNull()
    expect(canonical, 'canonical chunk stream missing').not.toBeNull()

    const reference = await readReferenceViewport(canonical!, dims!.rows, dims!.cols)
    expect(viewport!, 'live screen diverged from the canonical byte stream — rendering corruption').toBe(reference)
    expect(consoleErrors, 'renderer console errors during the storm').toEqual([])
  })
})
