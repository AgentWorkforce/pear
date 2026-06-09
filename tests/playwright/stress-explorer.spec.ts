import { appendFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const DEFAULT_AGENT_COUNT = 1_000
const DEFAULT_DURATION_MS = 30_000
const DEFAULT_TICK_MS = 1_000
const DEFAULT_EVENTS_PER_AGENT_PER_SECOND = 10
const DEFAULT_AGENT_BATCH_SIZE = 4
const DEFAULT_CHAT_BUFFER_CAP = 5_000
const DEFAULT_PTY_AGGREGATE_TICKS = 10

type StressProfile = 'pty-heavy' | 'chat-heavy' | 'custom'

type StressConfig = {
  label: string
  profile: StressProfile
  agentCount: number
  durationMs: number
  tickMs: number
  logicalEventsPerAgentPerSecond: number
  agentBatchSize: number
  chatBufferCap: number
  defaultPtyAggregateTicks: number
  chatRatio: number | null
  finalChat: boolean
}

type StressResult = {
  label: string
  profile: StressProfile
  agentCount: number
  durationMs: number
  tickMs: number
  logicalEventsPerAgentPerSecond: number
  agentBatchSize: number
  chatRatio: number
  finalChat: boolean
  chatEvents: number
  ptyEvents: number
  totalEvents: number
  minFps: number
  avgFps: number
  firstWindowFps: number
  lastWindowFps: number
  firstThirtySecondMinFps: number
  lastThirtySecondMinFps: number
  firstThirtySecondAvgFps: number
  lastThirtySecondAvgFps: number
  longestFrameMs: number
  frameCount: number
  wallClockMs: number
  jsHeapUsedStartMb: number | null
  jsHeapUsedEndMb: number | null
  jsHeapUsedDeltaMb: number | null
  finalMockMessageCount: number
  finalMockAgentCount: number
  finalMockBrokerEventCount: number
  ptyChunkKeyCount: number
  ptyChunkEntryCount: number
  ptyChunkCharacterCount: number
  maxPtyChunkCharactersForAgent: number
  terminalSampleAgent: string
}

type RunRecord = StressResult & {
  status: 'PASS' | 'FAIL' | 'ERROR'
  consoleErrorCount: number
  consoleErrorSamples: string[]
  cdpJsHeapUsedStartMb: number | null
  cdpJsHeapUsedEndMb: number | null
  cdpJsHeapUsedPeakMb: number | null
  cdpJsHeapUsedDeltaMb: number | null
  errorMessage?: string
}

const readPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer, received ${raw}`)
  return value
}

const readRatio = (name: string): number | null => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number from 0 to 1, received ${raw}`)
  return value
}

const readBoolean = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

const stressProfile = (): StressProfile => {
  if (process.env.STRESS_PROFILE === 'chat-heavy') return 'chat-heavy'
  if (process.env.STRESS_CHAT_RATIO !== undefined) return 'custom'
  return 'pty-heavy'
}

const profile = stressProfile()
const config: StressConfig = {
  label: process.env.STRESS_LABEL || profile,
  profile,
  agentCount: readPositiveInt('STRESS_AGENT_COUNT', DEFAULT_AGENT_COUNT),
  durationMs: readPositiveInt('STRESS_DURATION_MS', DEFAULT_DURATION_MS),
  tickMs: readPositiveInt('STRESS_TICK_MS', DEFAULT_TICK_MS),
  logicalEventsPerAgentPerSecond: readPositiveInt('STRESS_EVENTS_PER_SEC', DEFAULT_EVENTS_PER_AGENT_PER_SECOND),
  agentBatchSize: readPositiveInt('STRESS_AGENT_BATCH_SIZE', DEFAULT_AGENT_BATCH_SIZE),
  chatBufferCap: readPositiveInt('STRESS_CHAT_BUFFER_CAP', DEFAULT_CHAT_BUFFER_CAP),
  defaultPtyAggregateTicks: readPositiveInt('STRESS_PTY_AGGREGATE_TICKS', DEFAULT_PTY_AGGREGATE_TICKS),
  chatRatio: readRatio('STRESS_CHAT_RATIO'),
  finalChat: readBoolean('STRESS_FINAL_CHAT', false)
}

const appendResult = (record: RunRecord): void => {
  const resultPath = process.env.STRESS_RESULT_PATH
  if (!resultPath) return
  appendFileSync(resultPath, `${JSON.stringify({ ...record, recordedAt: new Date().toISOString() })}\n`)
}

test.describe('renderer stress explorer', () => {
  test.setTimeout(Math.max(120_000, config.durationMs + 180_000))

  test('records renderer behavior under parameterized synthetic broker load', async ({ page }) => {
    const consoleErrors: string[] = []
    const startedAt = Date.now()
    const cdpHeapSamplesMb: number[] = []
    let stopHeapSampling = false
    let heapSampler: Promise<void> | null = null

    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => {
      consoleErrors.push(error.message)
    })

    const baseRecord = {
      label: config.label,
      profile: config.profile,
      agentCount: config.agentCount,
      durationMs: config.durationMs,
      tickMs: config.tickMs,
      logicalEventsPerAgentPerSecond: config.logicalEventsPerAgentPerSecond,
      agentBatchSize: config.agentBatchSize,
      chatRatio: config.chatRatio ?? (config.profile === 'chat-heavy' ? 1 / (6 * config.logicalEventsPerAgentPerSecond) : 0),
      finalChat: config.finalChat,
      chatEvents: 0,
      ptyEvents: 0,
      totalEvents: 0,
      minFps: 0,
      avgFps: 0,
      firstWindowFps: 0,
      lastWindowFps: 0,
      firstThirtySecondMinFps: 0,
      lastThirtySecondMinFps: 0,
      firstThirtySecondAvgFps: 0,
      lastThirtySecondAvgFps: 0,
      longestFrameMs: 0,
      frameCount: 0,
      wallClockMs: 0,
      jsHeapUsedStartMb: null,
      jsHeapUsedEndMb: null,
      jsHeapUsedDeltaMb: null,
      finalMockMessageCount: 0,
      finalMockAgentCount: 0,
      finalMockBrokerEventCount: 0,
      ptyChunkKeyCount: 0,
      ptyChunkEntryCount: 0,
      ptyChunkCharacterCount: 0,
      maxPtyChunkCharactersForAgent: 0,
      terminalSampleAgent: 'agent-0001'
    }

    try {
      await page.goto('/')
      await expect(page.getByText('Mock Project')).toBeVisible()

      try {
        const cdpSession = await page.context().newCDPSession(page)
        await cdpSession.send('Performance.enable')
        const sampleHeap = async (): Promise<void> => {
          const metrics = await cdpSession.send('Performance.getMetrics')
          const usedHeapMetric = metrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize')
          if (typeof usedHeapMetric?.value === 'number') {
            cdpHeapSamplesMb.push(usedHeapMetric.value / (1024 * 1024))
          }
        }
        heapSampler = (async () => {
          while (!stopHeapSampling) {
            try {
              await sampleHeap()
            } catch {
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 10_000))
          }
          try {
            await sampleHeap()
          } catch {
            // Ignore a final sampling race if the page closed after the run.
          }
        })()
      } catch {
        heapSampler = null
      }

      const result = await page.evaluate<StressResult>(
        async ({
          label,
          profile,
          agentCount,
          durationMs,
          tickMs,
          logicalEventsPerAgentPerSecond,
          agentBatchSize,
          chatRatio,
          finalChat,
          defaultPtyAggregateTicks
        }) => {
          const mock = window.__pearMock
          if (!mock) throw new Error('window.__pearMock is not available')

          const readHeapUsedMb = (): number | null => {
            const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
            return typeof memory?.usedJSHeapSize === 'number'
              ? memory.usedJSHeapSize / (1024 * 1024)
              : null
          }

          const logicalEventsPerAgentPerTick = Math.max(1, Math.round(logicalEventsPerAgentPerSecond * (tickMs / 1_000)))
          const explicitChatRatio = chatRatio ?? 0
          const useLegacyChatHeavyCadence = profile === 'chat-heavy' && chatRatio === null
          const effectiveChatRatio = useLegacyChatHeavyCadence ? 1 / (6 * logicalEventsPerAgentPerSecond) : explicitChatRatio

          const chatCountForAgent = (tick: number, agentIndex: number): number => {
            if (useLegacyChatHeavyCadence) return tick % 6 === 0 ? 1 : 0
            const expectedChatEvents = logicalEventsPerAgentPerTick * explicitChatRatio
            const baseChatEvents = Math.floor(expectedChatEvents)
            const fractional = expectedChatEvents - baseChatEvents
            if (fractional <= 0) return baseChatEvents
            const denominator = Math.max(1, Math.round(1 / fractional))
            return baseChatEvents + ((tick + agentIndex) % denominator === 0 ? 1 : 0)
          }

          mock.spawnAgents(agentCount, { projectId: 'mock-project', channel: 'stress-background' })
          for (let batchStart = 0; batchStart < agentCount; batchStart += agentBatchSize) {
            const batchEnd = Math.min(agentCount, batchStart + agentBatchSize)
            for (let index = batchStart; index < batchEnd; index += 1) {
              const agentName = `agent-${String(index + 1).padStart(4, '0')}`
              mock.injectPtyChunk('mock-project', agentName, `[${agentName}] warmup\r\n`)
            }
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000))

          const jsHeapUsedStartMb = readHeapUsedMb()
          const frameDeltas: number[] = []
          const frameTimes: number[] = []
          let lastFrame = performance.now()
          let collectingFrames = true
          const collectFrame = (now: number): void => {
            frameDeltas.push(now - lastFrame)
            frameTimes.push(now)
            lastFrame = now
            if (collectingFrames) requestAnimationFrame(collectFrame)
          }
          requestAnimationFrame(collectFrame)

          let chatEvents = 0
          let ptyEvents = 0
          const start = performance.now()
          let tick = 0
          const ticks = Math.floor(durationMs / tickMs)

          while (tick < ticks) {
            tick += 1
            const emitPty = effectiveChatRatio < 1 && tick % defaultPtyAggregateTicks === 0
            for (let batchStart = 0; batchStart < agentCount; batchStart += agentBatchSize) {
              const events: Array<Record<string, unknown>> = []
              const batchEnd = Math.min(agentCount, batchStart + agentBatchSize)
              for (let index = batchStart; index < batchEnd; index += 1) {
                const agentName = `agent-${String(index + 1).padStart(4, '0')}`
                const eventBase = `stress:${tick}:${index}`
                const chatCount = Math.min(logicalEventsPerAgentPerTick, chatCountForAgent(tick, index))

                for (let chatIndex = 0; chatIndex < chatCount; chatIndex += 1) {
                  chatEvents += 1
                  events.push({
                    kind: 'relay_inbound',
                    projectId: 'mock-project',
                    from: agentName,
                    target: '#general',
                    body: `stress message ${tick}.${chatIndex} ${agentName}`,
                    event_id: `${eventBase}:chat:${chatIndex}`
                  })
                }

                if (emitPty) {
                  let aggregateChatCount = chatCount
                  if (!useLegacyChatHeavyCadence) {
                    aggregateChatCount = 0
                    for (let aggregateTick = tick - defaultPtyAggregateTicks + 1; aggregateTick <= tick; aggregateTick += 1) {
                      aggregateChatCount += chatCountForAgent(aggregateTick, index)
                    }
                  }
                  const ptyLines = (logicalEventsPerAgentPerTick * defaultPtyAggregateTicks) - aggregateChatCount
                  if (ptyLines > 0) {
                    ptyEvents += ptyLines
                    const chunk = Array.from({ length: ptyLines }, (_, lineIndex) =>
                      `[${agentName}] tick=${tick} line=${lineIndex + 1} seq=${eventBase}:${lineIndex}\r\n`
                    ).join('')
                    mock.injectPtyChunk('mock-project', agentName, chunk)
                  }
                }
              }
              if (events.length > 0) mock.injectBrokerEvents(events)
              if (emitPty || events.length > 0) {
                await new Promise((resolve) => requestAnimationFrame(resolve))
              }
            }
            const targetTime = start + tick * tickMs
            const waitMs = Math.max(0, targetTime - performance.now())
            await new Promise((resolve) => setTimeout(resolve, waitMs))
          }

          collectingFrames = false
          await new Promise((resolve) => requestAnimationFrame(resolve))
          const fpsEnd = performance.now()
          const jsHeapUsedEndMb = readHeapUsedMb()

          if (finalChat) {
            for (let batchStart = 0; batchStart < agentCount; batchStart += agentBatchSize) {
              const events: Array<Record<string, unknown>> = []
              const batchEnd = Math.min(agentCount, batchStart + agentBatchSize)
              for (let index = batchStart; index < batchEnd; index += 1) {
                const agentName = `agent-${String(index + 1).padStart(4, '0')}`
                chatEvents += 1
                events.push({
                  kind: 'relay_inbound',
                  projectId: 'mock-project',
                  from: agentName,
                  target: '#general',
                  body: `stress message final ${agentName}`,
                  event_id: `stress:final:${index}:chat`
                })
              }
              mock.injectBrokerEvents(events)
              await new Promise((resolve) => requestAnimationFrame(resolve))
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 250))
          const state = mock.getState()
          const ptyChunkValues = Object.values(state.ptyChunks)
          const ptyChunkCharacterCounts = ptyChunkValues.map((chunks) =>
            chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          )
          const totalFrameMs = frameDeltas.reduce((sum, delta) => sum + delta, 0)
          const longestFrameMs = frameDeltas.length > 0 ? Math.max(...frameDeltas) : 0
          const avgFrameMs = totalFrameMs / Math.max(1, frameDeltas.length)
          const measuredSeconds = Math.max(1, Math.floor((fpsEnd - start) / 1_000))
          const frameWindows = Array.from({ length: measuredSeconds }, (_, second) => {
            const windowStart = start + second * 1_000
            const windowEnd = windowStart + 1_000
            return frameTimes.filter((time) => time >= windowStart && time < windowEnd).length
          })
          const firstThirtySecondWindows = frameWindows.slice(0, 30)
          const lastThirtySecondWindows = frameWindows.slice(-30)
          const averageWindowFps = (windows: number[]): number =>
            windows.reduce((sum, fps) => sum + fps, 0) / Math.max(1, windows.length)

          return {
            label,
            profile,
            agentCount,
            durationMs,
            tickMs,
            logicalEventsPerAgentPerSecond,
            agentBatchSize,
            chatRatio: effectiveChatRatio,
            finalChat,
            chatEvents,
            ptyEvents,
            totalEvents: chatEvents + ptyEvents,
            minFps: frameWindows.length > 0 ? Math.min(...frameWindows) : 0,
            avgFps: 1000 / avgFrameMs,
            firstWindowFps: frameWindows[0] ?? 0,
            lastWindowFps: frameWindows[frameWindows.length - 1] ?? 0,
            firstThirtySecondMinFps: firstThirtySecondWindows.length > 0 ? Math.min(...firstThirtySecondWindows) : 0,
            lastThirtySecondMinFps: lastThirtySecondWindows.length > 0 ? Math.min(...lastThirtySecondWindows) : 0,
            firstThirtySecondAvgFps: averageWindowFps(firstThirtySecondWindows),
            lastThirtySecondAvgFps: averageWindowFps(lastThirtySecondWindows),
            longestFrameMs,
            frameCount: frameDeltas.length,
            wallClockMs: fpsEnd - start,
            jsHeapUsedStartMb,
            jsHeapUsedEndMb,
            jsHeapUsedDeltaMb: jsHeapUsedStartMb !== null && jsHeapUsedEndMb !== null
              ? jsHeapUsedEndMb - jsHeapUsedStartMb
              : null,
            finalMockMessageCount: state.messages.filter((message) => message.kind === 'message' && message.to === '#general').length,
            finalMockAgentCount: state.agents.length,
            finalMockBrokerEventCount: state.events.length,
            ptyChunkKeyCount: Object.keys(state.ptyChunks).length,
            ptyChunkEntryCount: ptyChunkValues.reduce((sum, chunks) => sum + chunks.length, 0),
            ptyChunkCharacterCount: ptyChunkCharacterCounts.reduce((sum, count) => sum + count, 0),
            maxPtyChunkCharactersForAgent: ptyChunkCharacterCounts.length > 0 ? Math.max(...ptyChunkCharacterCounts) : 0,
            terminalSampleAgent: 'agent-0001'
          }
        },
        config
      )

      stopHeapSampling = true
      if (heapSampler) await heapSampler
      const cdpJsHeapUsedStartMb = cdpHeapSamplesMb[0] ?? null
      const cdpJsHeapUsedEndMb = cdpHeapSamplesMb[cdpHeapSamplesMb.length - 1] ?? null

      const record: RunRecord = {
        ...result,
        wallClockMs: Date.now() - startedAt,
        status: result.minFps >= 30 && consoleErrors.length === 0 ? 'PASS' : 'FAIL',
        consoleErrorCount: consoleErrors.length,
        consoleErrorSamples: consoleErrors.slice(0, 5),
        cdpJsHeapUsedStartMb,
        cdpJsHeapUsedEndMb,
        cdpJsHeapUsedPeakMb: cdpHeapSamplesMb.length > 0 ? Math.max(...cdpHeapSamplesMb) : null,
        cdpJsHeapUsedDeltaMb: cdpJsHeapUsedStartMb !== null && cdpJsHeapUsedEndMb !== null
          ? cdpJsHeapUsedEndMb - cdpJsHeapUsedStartMb
          : null
      }
      console.info(`[stress-explorer-result] ${JSON.stringify(record)}`)
      appendResult(record)
    } catch (error) {
      stopHeapSampling = true
      if (heapSampler) await heapSampler
      const cdpJsHeapUsedStartMb = cdpHeapSamplesMb[0] ?? null
      const cdpJsHeapUsedEndMb = cdpHeapSamplesMb[cdpHeapSamplesMb.length - 1] ?? null
      const record: RunRecord = {
        ...baseRecord,
        wallClockMs: Date.now() - startedAt,
        status: 'ERROR',
        consoleErrorCount: consoleErrors.length,
        consoleErrorSamples: consoleErrors.slice(0, 5),
        cdpJsHeapUsedStartMb,
        cdpJsHeapUsedEndMb,
        cdpJsHeapUsedPeakMb: cdpHeapSamplesMb.length > 0 ? Math.max(...cdpHeapSamplesMb) : null,
        cdpJsHeapUsedDeltaMb: cdpJsHeapUsedStartMb !== null && cdpJsHeapUsedEndMb !== null
          ? cdpJsHeapUsedEndMb - cdpJsHeapUsedStartMb
          : null,
        errorMessage: error instanceof Error ? error.message : String(error)
      }
      console.info(`[stress-explorer-result] ${JSON.stringify(record)}`)
      appendResult(record)
    }
  })
})
