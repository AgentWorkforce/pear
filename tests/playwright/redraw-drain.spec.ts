import { appendFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// Redraw-style drain harness.
//
// WHY THIS EXISTS (the gap #176 left): the fidelity suite injects UNIQUE,
// append-only line markers (`[agent] tick=N line=M`). Append-only output
// under-models the real typing-lag workload because each chunk simply pushes a
// new row into scrollback — cheap per byte, and coalescing N appended lines
// into one rAF flush is near-linear. The actual Claude Code / Ink workload is
// the opposite: it repaints the SAME screen region every frame using
// cursor-addressing CSI sequences (`\x1b[r;cH`, `\x1b[K`, SGR colour runs).
// Under that workload the pipeline coalesces many full-screen repaints into a
// single rAF batch and `writeChunks` feeds EVERY queued frame to the xterm
// parser even though only the last is ever seen — that parse backlog is where
// keystroke echo waits, i.e. where typing lag is born.
//
// This harness drives a high-rate in-place redraw stream through the real
// renderer pipeline (pty-buffer-store rAF coalescing -> predictive echo ->
// xterm) and measures TIME-TO-DRAIN and render backpressure so a fix can be
// proven with a before/after. It is intentionally NON-GATING: it records
// numbers and only asserts the harness itself ran end-to-end.
//
// Run: npm run test:redraw
// Tunables (env): REDRAW_FPS, REDRAW_DURATION_MS, REDRAW_PANEL_ROWS,
//                 REDRAW_PANEL_COLS, REDRAW_DRAIN_TIMEOUT_MS, REDRAW_LABEL,
//                 REDRAW_RESULT_PATH (JSONL append, like STRESS_RESULT_PATH).

const PROJECT_ID = 'mock-project'
const AGENT_NAME = 'agent-0001'

const readPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer, received ${raw}`)
  return value
}

const config = {
  label: process.env.REDRAW_LABEL || 'redraw-baseline',
  fps: readPositiveInt('REDRAW_FPS', 120),
  durationMs: readPositiveInt('REDRAW_DURATION_MS', 10_000),
  panelRows: readPositiveInt('REDRAW_PANEL_ROWS', 24),
  panelCols: readPositiveInt('REDRAW_PANEL_COLS', 80),
  drainTimeoutMs: readPositiveInt('REDRAW_DRAIN_TIMEOUT_MS', 8_000),
  // Burst-mode: how many redraw frames the broker delivers in ONE delivery
  // tick (i.e. how many chunks land in a single rAF flush). This is the axis
  // coalescing acts on — writeChunks feeds all `burstFrames` chunks to
  // predictiveEcho.onServerOutput in one synchronous loop, paying the
  // per-chunk model.write + promise-tick overhead `burstFrames` times.
  burstFrames: readPositiveInt('REDRAW_BURST_FRAMES', 16),
  burstRounds: readPositiveInt('REDRAW_BURST_ROUNDS', 120)
}

type RedrawResult = {
  label: string
  fps: number
  durationMs: number
  panelRows: number
  panelCols: number
  framesInjected: number
  bytesInjected: number
  bytesPerFrame: number
  injectWallMs: number
  effectiveInjectFps: number
  // Backpressure during the burst.
  frameCount: number
  longestFrameMs: number
  avgFrameMs: number
  burstFps: number
  maxRenderLagFrames: number
  avgRenderLagFrames: number
  // Drain after the last injected frame.
  drained: boolean
  timeToDrainMs: number | null
  finalRenderedSeq: number
  // Correctness: did the final repaint actually land?
  finalFrameRendered: boolean
}

test.describe('renderer redraw drain', () => {
  test.setTimeout(config.durationMs + config.drainTimeoutMs + 120_000)

  test('measures time-to-drain under a high-rate in-place redraw stream', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))

    await page.goto('/')
    await expect(page.getByText('Mock Project')).toBeVisible()

    // Spawn a single agent and warm its buffer so the agent button renders.
    await page.evaluate(({ projectId, agentName }) => {
      const mock = window.__pearMock
      if (!mock) throw new Error('window.__pearMock is not available')
      mock.spawnAgents(1, { projectId, channel: 'general' })
      mock.injectPtyChunk(projectId, agentName, `[${agentName}] warmup\r\n`)
    }, { projectId: PROJECT_ID, agentName: AGENT_NAME })

    // Mount + show the terminal so writeChunks is subscribed and the parsed
    // grid is live. Mirrors the proven open-terminal flow in stress-1000.
    await page.getByText('general').click()
    await page.locator('button').filter({ hasText: AGENT_NAME }).first().click()
    const terminal = page.locator(`[data-testid="terminal-instance"][data-agent-name="${AGENT_NAME}"]`)
    await expect(terminal).toBeVisible()
    // Let attach + the 200ms SIGWINCH bounce + font settle land before measuring.
    await page.waitForTimeout(800)

    const result = await page.evaluate<RedrawResult>(async ({ projectId, agentName, fps, durationMs, panelRows, panelCols, drainTimeoutMs, label, burstFrames, burstRounds }) => {
      const mock = window.__pearMock
      if (!mock) throw new Error('window.__pearMock is not available')
      const readViewport = (window as unknown as {
        __pearReadTerminalViewport?: (p: string | undefined, n: string) => string | null
      }).__pearReadTerminalViewport
      if (!readViewport) throw new Error('window.__pearReadTerminalViewport is not available (registry probe missing)')

      const SPINNER = '|/-\\'
      // Build one in-place redraw frame: absolute cursor positioning + erase
      // line + SGR colour runs + content that changes every frame (so the
      // parser can never no-op). SEQ lives on row 1 at a fixed position so the
      // latest rendered frame is recoverable from the viewport text.
      const buildFrame = (seq: number): string => {
        const pad = String(seq).padStart(6, '0')
        let out = '\x1b[H'
        for (let row = 1; row <= panelRows; row += 1) {
          out += `\x1b[${row};1H\x1b[K`
          if (row === 1) {
            out += `\x1b[36mSEQ=${pad}\x1b[0m \x1b[2m── pear redraw-drain panel ──\x1b[0m`
          } else {
            const spinner = SPINNER[seq % SPINNER.length]
            const barLen = (seq + row) % Math.max(1, panelCols - 24)
            const bar = '█'.repeat(barLen)
            out += `\x1b[2m│\x1b[0m \x1b[32m${spinner}\x1b[0m row ${String(row).padStart(2, '0')} \x1b[34m${bar}\x1b[0m`
          }
        }
        return out
      }

      const readRenderedSeq = (): number => {
        const vp = readViewport(projectId, agentName) || ''
        const match = vp.match(/SEQ=(\d+)/)
        return match ? Number.parseInt(match[1], 10) : -1
      }

      // Frame sampler: capture rAF cadence (longest/avg frame) AND render lag
      // (how many injected frames the visible grid is behind) during the burst.
      const frameDeltas: number[] = []
      let lastFrame = performance.now()
      let sampling = true
      let maxRenderLag = 0
      let lagSum = 0
      let lagSamples = 0
      let injected = 0
      const sampler = (now: number): void => {
        frameDeltas.push(now - lastFrame)
        lastFrame = now
        const rendered = readRenderedSeq()
        if (rendered >= 0 && injected > 0) {
          const lag = injected - rendered
          if (lag > maxRenderLag) maxRenderLag = lag
          lagSum += lag
          lagSamples += 1
        }
        if (sampling) requestAnimationFrame(sampler)
      }
      requestAnimationFrame(sampler)

      // Injection loop. Two modes:
      //  - Paced (burstFrames <= 1): one frame per REDRAW_FPS tick. Measures
      //    raw redraw drain; insensitive to write-coalescing because each rAF
      //    flush sees a single chunk.
      //  - Burst (burstFrames > 1): each round delivers `burstFrames` redraw
      //    frames back-to-back with NO await, so all `burstFrames` chunks land
      //    in ONE pty-buffer rAF flush — the exact condition writeChunks
      //    coalescing acts on (N predictiveEcho.onServerOutput model-parses +
      //    N promise ticks collapse to one). This is what isolates #179.
      const start = performance.now()
      let bytesInjected = 0
      let lastInjectAt = start
      if (burstFrames > 1) {
        for (let round = 0; round < burstRounds; round += 1) {
          for (let b = 0; b < burstFrames; b += 1) {
            injected += 1
            const frame = buildFrame(injected)
            bytesInjected += frame.length
            mock.injectPtyChunk(projectId, agentName, frame)
          }
          lastInjectAt = performance.now()
          // Yield exactly one rAF so the batched chunks flush + paint before
          // the next burst lands.
          await new Promise((resolve) => requestAnimationFrame(resolve))
        }
      } else {
        const intervalMs = 1000 / fps
        while (performance.now() - start < durationMs) {
          injected += 1
          const frame = buildFrame(injected)
          bytesInjected += frame.length
          mock.injectPtyChunk(projectId, agentName, frame)
          const targetTime = start + injected * intervalMs
          const waitMs = Math.max(0, targetTime - performance.now())
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }
        lastInjectAt = performance.now()
      }
      const framesInjected = injected
      const injectWallMs = lastInjectAt - start

      // Drain: stop injecting and poll the parsed grid each frame until the
      // final repaint is visible (rendered SEQ catches up to framesInjected).
      let drainedAt: number | null = null
      const drainDeadline = performance.now() + drainTimeoutMs
      while (performance.now() < drainDeadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        if (readRenderedSeq() >= framesInjected) {
          drainedAt = performance.now()
          break
        }
      }
      sampling = false
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const finalRenderedSeq = readRenderedSeq()

      const longestFrameMs = frameDeltas.length > 0 ? Math.max(...frameDeltas) : 0
      const avgFrameMs = frameDeltas.reduce((sum, delta) => sum + delta, 0) / Math.max(1, frameDeltas.length)

      return {
        label,
        fps,
        durationMs,
        panelRows,
        panelCols,
        framesInjected,
        bytesInjected,
        bytesPerFrame: Math.round(bytesInjected / Math.max(1, framesInjected)),
        injectWallMs,
        effectiveInjectFps: framesInjected / (injectWallMs / 1000),
        frameCount: frameDeltas.length,
        longestFrameMs,
        avgFrameMs,
        burstFps: 1000 / avgFrameMs,
        maxRenderLagFrames: maxRenderLag,
        avgRenderLagFrames: lagSamples > 0 ? lagSum / lagSamples : 0,
        drained: drainedAt !== null,
        timeToDrainMs: drainedAt !== null ? drainedAt - lastInjectAt : null,
        finalRenderedSeq,
        finalFrameRendered: finalRenderedSeq >= framesInjected
      }
    }, { projectId: PROJECT_ID, agentName: AGENT_NAME, ...config })

    console.info(`[redraw-drain-result] ${JSON.stringify({ ...result, consoleErrorCount: consoleErrors.length })}`)
    const resultPath = process.env.REDRAW_RESULT_PATH
    if (resultPath) {
      appendFileSync(resultPath, `${JSON.stringify({ ...result, consoleErrorCount: consoleErrors.length, recordedAt: new Date().toISOString() })}\n`)
    }

    expect(result.framesInjected, 'no redraw frames were injected').toBeGreaterThan(0)
    expect(result.finalRenderedSeq, 'terminal grid never rendered any redraw frame').toBeGreaterThan(0)
    // GATING drain invariants (machine-independent booleans, not timing
    // thresholds): after the burst stops, the grid must fully catch up
    // within the drain deadline and the final repaint must be the one on
    // screen. A regression that reintroduces parser backlog (the typing-lag
    // class) shows up here as drained=false long before users feel it.
    expect(result.drained, `terminal never drained within ${config.drainTimeoutMs}ms — render backlog regression: ${JSON.stringify(result)}`).toBe(true)
    expect(result.finalFrameRendered, `final repaint never rendered: ${JSON.stringify(result)}`).toBe(true)
  })
})
