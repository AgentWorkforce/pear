import { expect, type Page, test } from '@playwright/test'

// Reproduces the terminal-duplication vector the existing fidelity/corruption
// suites miss: a DECSET ?1004 (focus-reporting) TUI — Claude Code's Ink UI —
// re-commits a frame each time it receives a focus report (\x1b[I / \x1b[O).
// The renderer's focus helpers run a container.focus() → textarea.focus()
// dance on every pointer/keyboard interaction. xterm already focuses its
// textarea synchronously on mousedown, so re-running the dance blurs the
// textarea (container.focus()) and refocuses it — under ?1004 that blur+focus
// pair emits a focus report on EVERY click, even though the terminal never
// actually left focus. Each spurious report stacks a duplicate frame in
// scrollback, which is exactly the "blocks rendered 2-3x, accumulating with
// focus/tab interactions" symptom. The broker snapshot (the reconciler's
// ground truth) is correct; the duplicates live in scrollback, which the
// viewport-only reconciler cannot reach — so the only durable fix is to stop
// emitting the spurious focus reports at the source.

const PROJECT_ID = 'mock-project'
const CARD = '[STACK-CARD]'
const CARD_FRAME = `${CARD}\r\n`
const CLICKS = 6

const agentName = (prefix: string, index = 1): string =>
  `${prefix}-${String(index).padStart(4, '0')}`

const terminalFor = (page: Page, name: string) =>
  page.locator(`[data-testid="terminal-instance"][data-agent-name="${name}"]`)

async function bootWithAgent(page: Page, prefix: string): Promise<string> {
  await page.addInitScript(() => {
    window.localStorage.setItem('pear-terminal-layout', 'tabs')
    window.localStorage.setItem('pear-web-initial-tab', 'agents')
  })

  await page.goto('/')
  await expect(page.getByText('Mock Project')).toBeVisible()

  await page.evaluate(({ namePrefix }) => {
    const mock = window.__pearMock
    if (!mock) throw new Error('window.__pearMock is not available')
    mock.spawnAgents(1, { projectId: 'mock-project', namePrefix, channel: 'general' })
  }, { namePrefix: prefix })

  const name = agentName(prefix)
  await page.getByText('general').click()
  await page.getByRole('button', { name }).first().click()
  await expect(terminalFor(page, name)).toBeVisible()
  await expect.poll(
    () => page.evaluate(({ projectId, agent }) =>
      window.__pearMock?.getTerminalBufferText(projectId, agent) ?? null,
    { projectId: PROJECT_ID, agent: name }),
    { message: `terminal runtime mounted for ${name}` }
  ).not.toBeNull()
  return name
}

async function flushFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function countCards(page: Page, name: string): Promise<number> {
  const text = await page.evaluate(({ projectId, agent }) =>
    window.__pearMock?.getTerminalBufferText(projectId, agent) ?? '',
  { projectId: PROJECT_ID, agent: name })
  return (text.match(/\[STACK-CARD\]/g) ?? []).length
}

test.describe('terminal focus-report frame stacking (DECSET ?1004)', () => {
  test('repeated clicks on a focused terminal do not stack ?1004 redraw frames', async ({ page }) => {
    const name = await bootWithAgent(page, 'foc')
    const terminal = terminalFor(page, name)

    // The runtime focuses the xterm textarea exactly once on first mount, so
    // the terminal is already focused here — the realistic state when a user
    // clicks a terminal they are already working in. Confirm it before arming
    // the TUI model, so the one-time legitimate first-focus is never attributed
    // to a click below.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
      .toContain('xterm-helper-textarea')

    // Model the ?1004 TUI: enable focus reporting in xterm, arm the
    // focus-reactive redraw, and lay down a single baseline frame. From here
    // the buffer holds exactly one CARD; any further CARD is a spurious focus
    // report turned into a stacked frame.
    await page.evaluate(({ projectId, agent, frame }) => {
      const mock = window.__pearMock!
      mock.injectPtyChunk(projectId, agent, '\x1b[?1004h')
      mock.setFocusRedraw(frame)
      mock.injectPtyChunk(projectId, agent, frame)
    }, { projectId: PROJECT_ID, agent: name, frame: CARD_FRAME })
    await flushFrame(page)

    // The baseline frame must have rendered through the real PTY → xterm path,
    // proving the harness is live (not a vacuous always-green test).
    expect(await countCards(page, name), 'baseline frame must render').toBeGreaterThanOrEqual(1)

    // Settle the one-time programmatic→user focus handover: the first click
    // lets the browser move focus into the terminal, after which it stays
    // focused. Measure the stack once settled.
    await terminal.click()
    await flushFrame(page)
    const settled = await countCards(page, name)

    // Decisive regression: every further click lands on an already-focused
    // terminal, so the ?1004 TUI must receive NO focus reports and the stack
    // must not grow. The bug ran a container.focus() → textarea.focus() dance
    // on every click, whose blur+refocus pair emitted "\x1b[O\x1b[I" each time
    // and stacked ~2 frames per click (the count climbed without bound). The
    // fix keeps it flat.
    for (let index = 0; index < CLICKS; index += 1) {
      await terminal.click()
      await flushFrame(page)
    }
    await flushFrame(page)

    const cards = await countCards(page, name)
    expect(
      cards,
      `${CLICKS} clicks on an already-focused ?1004 terminal must not stack frames ` +
        `(settled at ${settled}, now ${cards}); growth means focus reports were ` +
        `spuriously re-emitted`
    ).toBe(settled)
  })
})
