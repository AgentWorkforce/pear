import { expect, type Page, test } from '@playwright/test'

const PROJECT_ID = 'mock-project'
const HIGH_RATE_TOTAL = 1_000
const VARIANT_TOTAL = 700
// This suite asserts final-state fidelity, not live throughput. Synthetic
// xterm drain can lag by a contiguous tail under high-rate bursts (for
// example 1000 canonical markers / 762 rendered after a 10s settle), so keep
// a finite deadline with enough headroom to catch permanent stalls without
// failing on natural xterm write drain.
const FINAL_DRAIN_DEADLINE_MS = 30_000

type TerminalLayout = 'tabs' | 'horizontal-split'

type StreamSpec = {
  name: string
  markerPrefix: string
  total: number
}

const agentName = (prefix: string, index = 1): string =>
  `${prefix}-${String(index).padStart(4, '0')}`

const marker = (prefix: string, index: number): string =>
  `[${prefix}-${String(index).padStart(4, '0')}]`

const terminalFor = (page: Page, name: string) =>
  page.locator(`[data-testid="terminal-instance"][data-agent-name="${name}"]`)

async function waitForTerminalVisible(page: Page, name: string, timeout = 1_000): Promise<boolean> {
  try {
    await terminalFor(page, name).waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

async function expectSplitTerminalVisible(page: Page, name: string): Promise<void> {
  if (await waitForTerminalVisible(page, name)) return

  const pageTabs = page.getByRole('tab', { name: /Show terminal page \d+/ })
  // Wait for tabs to attach before counting; an immediate count() can race the
  // render and skip the page-switch loop entirely.
  await pageTabs.first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => {})
  const pageCount = await pageTabs.count()
  for (let index = 0; index < pageCount; index += 1) {
    await pageTabs.nth(index).click()
    if (await waitForTerminalVisible(page, name)) return
  }

  await expect(terminalFor(page, name)).toBeVisible()
}

async function bootWithAgents(
  page: Page,
  count: number,
  prefix: string,
  layout: TerminalLayout = 'tabs'
): Promise<void> {
  await page.addInitScript((initialLayout) => {
    window.localStorage.setItem('pear-terminal-layout', initialLayout)
    // The web-mock build defaults to the Attention Inbox tab; the fidelity
    // harness needs the Agents view so terminal runtimes mount.
    window.localStorage.setItem('pear-web-initial-tab', 'agents')
  }, layout)

  await page.goto('/')
  await expect(page.getByText('Mock Project')).toBeVisible()

  await page.evaluate(({ agentCount, namePrefix }) => {
    const mock = window.__pearMock
    if (!mock) throw new Error('window.__pearMock is not available')
    mock.spawnAgents(agentCount, { projectId: 'mock-project', namePrefix, channel: 'general' })
  }, { agentCount: count, namePrefix: prefix })

  // Select the spawned agent so its terminal runtime mounts (the mock build
  // boots with demo agents; spawning does not auto-select).
  const firstAgent = agentName(prefix)
  await page.getByText('general').click()
  // Role-scoped but not exact: the button's accessible name includes status
  // text beyond the agent name (exact-match never resolves).
  await page.getByRole('button', { name: firstAgent }).first().click()
  await expect(terminalFor(page, firstAgent)).toBeVisible()
  await expect.poll(
    () => page.evaluate(({ projectId, name }) =>
      window.__pearMock?.getTerminalBufferText(projectId, name) ?? null,
    { projectId: PROJECT_ID, name: firstAgent }),
    { message: `terminal runtime mounted for ${firstAgent}` }
  ).not.toBeNull()
}

async function startStream(page: Page, streams: StreamSpec[], yieldEvery = 25): Promise<void> {
  await page.evaluate(({ projectId, streamSpecs, frameYieldEvery }) => {
    const win = window as Window & { __fidelityStreamDone?: Promise<void> }
    const mock = window.__pearMock
    if (!mock) throw new Error('window.__pearMock is not available')

    win.__fidelityStreamDone = (async () => {
      const maxTotal = Math.max(...streamSpecs.map((stream) => stream.total))
      for (let index = 0; index < maxTotal; index += 1) {
        for (const stream of streamSpecs) {
          if (index < stream.total) {
            const id = String(index).padStart(4, '0')
            mock.injectPtyChunk(projectId, stream.name, `[${stream.markerPrefix}-${id}]\r\n`)
          }
        }
        if (index % frameYieldEvery === 0) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
      }
    })()
  }, { projectId: PROJECT_ID, streamSpecs: streams, frameYieldEvery: yieldEvery })
}

async function waitForStream(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as Window & { __fidelityStreamDone?: Promise<void> }
    return win.__fidelityStreamDone
  })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await page.waitForTimeout(1_500)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function readMarkerStats(
  page: Page,
  name: string,
  markerPrefix: string,
  total: number
): Promise<{
  renderedCount: number
  canonicalCount: number
  missing: string[]
  duplicates: string[]
}> {
  return page.evaluate(({ projectId, agent, prefix, expectedTotal }) => {
    const mock = window.__pearMock
    const renderedText = mock?.getTerminalBufferText(projectId, agent) ?? ''
    const state = mock?.getState()
    const canonicalText = state?.ptyChunks[`${projectId}:${agent}`]?.join('') ?? ''
    const markerPattern = /\[[a-z0-9-]+-\d{4}\]/g
    const renderedMarkers = (renderedText.match(markerPattern) ?? [])
      .filter((entry) => entry.startsWith(`[${prefix}-`))
    const canonicalMarkers = (canonicalText.match(markerPattern) ?? [])
      .filter((entry) => entry.startsWith(`[${prefix}-`))
    const renderedSet = new Set(renderedMarkers)
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const entry of renderedMarkers) {
      if (seen.has(entry)) duplicates.push(entry)
      seen.add(entry)
    }
    const missing: string[] = []
    for (let index = 0; index < expectedTotal; index += 1) {
      const expected = `[${prefix}-${String(index).padStart(4, '0')}]`
      if (!renderedSet.has(expected)) missing.push(expected)
    }
    return {
      renderedCount: renderedMarkers.length,
      canonicalCount: canonicalMarkers.length,
      missing: missing.slice(0, 12),
      duplicates: duplicates.slice(0, 12)
    }
  }, { projectId: PROJECT_ID, agent: name, prefix: markerPrefix, expectedTotal: total })
}

async function waitForFinalMarkerStats(
  page: Page,
  name: string,
  markerPrefix: string,
  total: number,
  deadlineMs: number
): Promise<{
  finalStats: Awaited<ReturnType<typeof readMarkerStats>>
  snapshots: Array<Awaited<ReturnType<typeof readMarkerStats>>>
  elapsedMs: number
  deadlineMs: number
}> {
  const snapshots: Array<Awaited<ReturnType<typeof readMarkerStats>>> = []
  const startedAt = Date.now()
  const deadline = startedAt + deadlineMs
  let finalStats = await readMarkerStats(page, name, markerPrefix, total)

  while (true) {
    const done = finalStats.canonicalCount === total && finalStats.renderedCount === total
    if (snapshots.length < 8 || done || Date.now() >= deadline) {
      snapshots.push(finalStats)
    }
    if (done) {
      return { finalStats, snapshots, elapsedMs: Date.now() - startedAt, deadlineMs }
    }
    if (Date.now() >= deadline) {
      return { finalStats, snapshots, elapsedMs: Date.now() - startedAt, deadlineMs }
    }
    await page.waitForTimeout(500)
    finalStats = await readMarkerStats(page, name, markerPrefix, total)
  }
}

async function expectFidelity(
  page: Page,
  trigger: string,
  name: string,
  markerPrefix: string,
  total: number,
  deadlineMs = FINAL_DRAIN_DEADLINE_MS
): Promise<void> {
  const { finalStats, snapshots, elapsedMs } = await waitForFinalMarkerStats(page, name, markerPrefix, total, deadlineMs)
  const diagnostic = `${trigger}: marker stats for ${name}; elapsedMs=${elapsedMs}; deadlineMs=${deadlineMs}; snapshots=${JSON.stringify(snapshots)}`

  expect(finalStats.canonicalCount, diagnostic).toBe(total)
  expect(finalStats.renderedCount, diagnostic).toBe(total)
  expect(finalStats.duplicates, diagnostic).toEqual([])
  expect(finalStats.missing, diagnostic).toEqual([])

  const bufferText = await page.evaluate(({ projectId, agent }) =>
    window.__pearMock?.getTerminalBufferText(projectId, agent) ?? null,
  { projectId: PROJECT_ID, agent: name })

  expect(bufferText, `${trigger}: terminal buffer for ${name}`).not.toBeNull()

  const markers = (bufferText ?? '').match(/\[[a-z0-9-]+-\d{4}\]/g) ?? []
  const targetMarkers = markers.filter((entry) => entry.startsWith(`[${markerPrefix}-`))
  expect(targetMarkers.length, `${trigger}: marker count for ${name}`).toBe(total)

  const seen = new Set<string>()
  let prev = -1
  for (const entry of targetMarkers) {
    expect(seen.has(entry), `${trigger}: duplicate marker ${entry} in ${name}`).toBe(false)
    seen.add(entry)

    const parsed = entry.match(/\d{4}/)
    expect(parsed, `${trigger}: malformed marker ${entry} in ${name}`).not.toBeNull()
    const current = Number.parseInt(parsed![0], 10)
    expect(current, `${trigger}: out-of-order marker ${entry} after ${prev} in ${name}`).toBeGreaterThan(prev)
    prev = current
  }

  expect(seen.has(marker(markerPrefix, 0)), `${trigger}: first marker missing for ${name}`).toBe(true)
  expect(seen.has(marker(markerPrefix, total - 1)), `${trigger}: final marker missing for ${name}`).toBe(true)
}

test.describe('terminal output fidelity under high-rate PTY streaming', () => {
  test('terminal output matches injected chunks under high-rate streaming', async ({ page }) => {
    await bootWithAgents(page, 1, 'fid')

    const name = agentName('fid')
    await startStream(page, [{ name, markerPrefix: 'chunk', total: HIGH_RATE_TOTAL }])
    await waitForStream(page)

    await expectFidelity(page, 'high-rate stream', name, 'chunk', HIGH_RATE_TOTAL)
  })

  test('tab-switch during stream preserves output fidelity', async ({ page }) => {
    await bootWithAgents(page, 2, 'tab')

    const first = agentName('tab', 1)
    const second = agentName('tab', 2)
    await startStream(page, [{ name: first, markerPrefix: 'tab-a', total: VARIANT_TOTAL }])

    for (let index = 0; index < 8; index += 1) {
      await page.locator('button').filter({ hasText: index % 2 === 0 ? second : first }).first().click()
      await page.waitForTimeout(100)
    }
    await page.locator('button').filter({ hasText: first }).first().click()
    await waitForStream(page)

    await expectFidelity(page, 'tab-switch during stream', first, 'tab-a', VARIANT_TOTAL)
  })

  test('split-pane transition during stream preserves output fidelity', async ({ page }) => {
    await bootWithAgents(page, 2, 'split', 'tabs')

    const first = agentName('split', 1)
    const second = agentName('split', 2)
    await startStream(page, [
      { name: first, markerPrefix: 'split-a', total: VARIANT_TOTAL },
      { name: second, markerPrefix: 'split-b', total: VARIANT_TOTAL }
    ])

    await page.waitForTimeout(150)
    await page.getByRole('button', { name: 'Show split terminal pages' }).click()
    await expectSplitTerminalVisible(page, first)
    await expectSplitTerminalVisible(page, second)
    await waitForStream(page)

    await expectFidelity(page, 'split-pane transition during stream', first, 'split-a', VARIANT_TOTAL)
    await expectFidelity(page, 'split-pane transition during stream', second, 'split-b', VARIANT_TOTAL)
  })

  test('window resize during stream preserves output fidelity', async ({ page }) => {
    await bootWithAgents(page, 1, 'resize')

    const name = agentName('resize')
    await startStream(page, [{ name, markerPrefix: 'resize-a', total: VARIANT_TOTAL }])

    for (const viewport of [
      { width: 1200, height: 760 },
      { width: 1560, height: 980 },
      { width: 980, height: 720 },
      { width: 1440, height: 960 }
    ]) {
      await page.waitForTimeout(90)
      await page.setViewportSize(viewport)
    }
    await waitForStream(page)

    await expectFidelity(page, 'window resize during stream', name, 'resize-a', VARIANT_TOTAL)
  })

  test('window focus events during stream preserve output fidelity', async ({ page }) => {
    await bootWithAgents(page, 1, 'focus')

    const name = agentName('focus')
    await startStream(page, [{ name, markerPrefix: 'focus-a', total: VARIANT_TOTAL }])

    for (let index = 0; index < 6; index += 1) {
      await page.waitForTimeout(80)
      await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'))
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
      })
    }
    await waitForStream(page)

    await expectFidelity(page, 'window focus events during stream', name, 'focus-a', VARIANT_TOTAL)
  })

  test('runtime remount mid-stream preserves output fidelity', async ({ page }) => {
    await bootWithAgents(page, 1, 'remount')

    const name = agentName('remount')
    await startStream(page, [{ name, markerPrefix: 'remount-a', total: VARIANT_TOTAL }])

    // Leave the Agents view entirely (Issues tab) and come back mid-stream —
    // the cross-view unmount/remount that used to replay duplicate buffer
    // content on top of the parked runtime. (The old 'agent graph' layout
    // this test used no longer exists.)
    await page.waitForTimeout(120)
    await page.getByRole('button', { name: 'Show split terminal pages' }).click()
    await expectSplitTerminalVisible(page, name)
    await page.waitForTimeout(120)
    await page.getByRole('button', { name: 'Move terminals back to tabs' }).click()
    await expect(terminalFor(page, name)).toBeVisible()
    await waitForStream(page)

    await expectFidelity(page, 'runtime remount mid-stream', name, 'remount-a', VARIANT_TOTAL)
  })
})
