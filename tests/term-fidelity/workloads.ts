import { join } from 'node:path'
import { expect, type Locator } from '@playwright/test'
import { getActivity, type FidelityHarness } from './harness'
import {
  captureCheckpoint,
  readBrokerSnapshot,
  readRendererGrid,
  type WorkloadName
} from './oracle'

const MARKER_TIMEOUT_MS = 5 * 60_000
const AUTOMATIC_PERMISSION_MODE = /(?:bypass permissions|always approve|auto[- ]?approve|auto mode|plan mode|don'?t ask|yolo mode|full access \(current\)).*(?:on|enabled)?/iu

interface SpawnedAgent {
  name: string
  terminal: Locator
}

function finalMarkerInstruction(marker: string): string {
  const parts = marker.split('_').map((part) => `"${part}"`).join(', ')
  return `Finish by printing one token made from the parts ${parts}, joined with one underscore between adjacent parts.`
}

function initialArgs(cli: FidelityHarness['cli']): string[] | undefined {
  // These two CLIs expose a stable explicit default permission mode. Passing
  // it prevents a user's sticky auto-approve setting from silently disabling
  // the canonical approval-panel workload.
  if (cli === 'claude') {
    return ['--permission-mode', 'default', '--setting-sources', '']
  }
  // Relay currently injects Codex's dangerous bypass switch. Codex rejects an
  // approval-policy flag alongside it, so the permission workload switches
  // back to an asking mode through Codex's real `/permissions` UI instead.
  if (cli === 'codex') return ['--no-alt-screen']
  if (cli === 'grok') return ['--no-alt-screen', '--permission-mode', 'default']
  return undefined
}

async function waitForMarker(
  harness: FidelityHarness,
  agentName: string,
  marker: string,
  timeoutMs = MARKER_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastScreen = ''
  while (Date.now() < deadline) {
    try {
      const snapshot = await readBrokerSnapshot(harness.connectionPath, agentName)
      lastScreen = snapshot.screen
      if (lastScreen.includes(marker)) return
    } catch {
      // The worker may not have reached its first PTY snapshot yet.
    }
    await harness.page.waitForTimeout(350)
  }
  throw new Error(
    `${harness.cli} did not render marker ${marker} within ${timeoutMs}ms. Final broker screen:\n${lastScreen}`
  )
}

async function submitPrompt(terminal: Locator, prompt: string): Promise<void> {
  await terminal.click()
  // Clear any text intentionally left by the typing-during-stream workload.
  await terminal.page().keyboard.press('Control+U')
  await terminal.page().keyboard.insertText(prompt)
  await terminal.page().keyboard.press('Enter')
}

async function waitForOutputProgress(
  harness: FidelityHarness,
  agentName: string,
  baseline: Awaited<ReturnType<typeof getActivity>>,
  options: { chunks?: number; bytes?: number; timeoutMs?: number } = {}
): Promise<void> {
  const chunks = options.chunks ?? 4
  const bytes = options.bytes ?? 200
  const timeoutMs = options.timeoutMs ?? 60_000
  await expect.poll(async () => {
    const current = await getActivity(harness.page, agentName)
    return {
      enoughChunks: current.chunks - baseline.chunks >= chunks,
      enoughBytes: current.bytes - baseline.bytes >= bytes
    }
  }, {
    message: `${harness.cli}/${agentName} should produce a live PTY stream`,
    timeout: timeoutMs,
    intervals: [100, 200, 350, 500]
  }).toEqual({ enoughChunks: true, enoughBytes: true })
}

async function acceptWorkspaceTrustIfShown(
  harness: FidelityHarness,
  terminal: Locator,
  agentName: string,
  marker: string
): Promise<void> {
  const deadline = Date.now() + 90_000
  let acceptedTrust = false
  let lastScreen = ''
  while (Date.now() < deadline) {
    try {
      const snapshot = await readBrokerSnapshot(harness.connectionPath, agentName)
      lastScreen = snapshot.screen
      if (lastScreen.includes(marker)) return
      if (
        !acceptedTrust &&
        /(?:do you trust|trust (?:the files in )?this folder|yes,? i trust)/iu.test(lastScreen)
      ) {
        await terminal.click()
        await harness.page.keyboard.press('Enter')
        acceptedTrust = true
      }
      if (
        /(?:not logged in|please (?:run .* )?log in|authentication failed|missing api key|unauthorized)/iu.test(lastScreen)
      ) {
        throw new Error(`${harness.cli} is not authenticated:\n${lastScreen}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not authenticated')) throw error
    }
    await harness.page.waitForTimeout(350)
  }
  throw new Error(`${harness.cli} startup did not reach ${marker}. Final broker screen:\n${lastScreen}`)
}

async function normalizeClaudePermissionMode(
  harness: FidelityHarness,
  terminal: Locator,
  agentName: string
): Promise<void> {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const screen = (await readBrokerSnapshot(harness.connectionPath, agentName)).screen
    if (!AUTOMATIC_PERMISSION_MODE.test(screen)) return
    await terminal.click()
    await harness.page.keyboard.press('Shift+Tab')
    await harness.page.waitForTimeout(450)
  }
  const screen = (await readBrokerSnapshot(harness.connectionPath, agentName)).screen
  if (AUTOMATIC_PERMISSION_MODE.test(screen)) {
    throw new Error('Claude remained in an auto-approve mode during startup normalization')
  }
}

export async function spawnRealAgent(harness: FidelityHarness): Promise<SpawnedAgent> {
  const available = await harness.page.evaluate(async (cli) => {
    return await (window as unknown as Window & {
      pear: { broker: { checkCliAvailable(cliName: string): Promise<boolean> } }
    }).pear.broker.checkCliAvailable(cli)
  }, harness.cli)
  if (!available) throw new Error(`Required CLI ${harness.cli} is not available on the app PATH`)

  const requestedName = `tf-${harness.cli}`
  const marker = `TF_${harness.cli.toUpperCase()}_READY`
  const spawned = await harness.page.evaluate(async ({ projectId, root, cli, name, task, args }) => {
    const api = (window as unknown as Window & {
      pear: {
        broker: {
          spawnAgent(id: string, input: {
            name: string
            cli: string
            cwd: string
            channels: string[]
            task: string
            args?: string[]
          }): Promise<{ name: string }>
        }
      }
    }).pear
    return await api.broker.spawnAgent(projectId, {
      name,
      cli,
      cwd: root,
      channels: ['general'],
      task,
      ...(args ? { args } : {})
    })
  }, {
    projectId: harness.projectId,
    root: harness.projectRoot,
    cli: harness.cli,
    name: requestedName,
    task: `Reply with exactly one token made from the parts "TF", "${harness.cli.toUpperCase()}", "READY", joined with one underscore between adjacent parts. Do not use tools.`,
    args: initialArgs(harness.cli)
  })
  const agentName = spawned.name || requestedName

  const agentButton = harness.page.locator('button').filter({ hasText: agentName }).first()
  await expect(agentButton, `agent ${agentName} should appear in the production sidebar`).toBeVisible({
    timeout: 60_000
  })
  await agentButton.click()
  const terminal = harness.page.locator(
    `[data-testid="terminal-instance"][data-agent-name="${agentName}"]`
  )
  await expect(terminal).toBeVisible({ timeout: 60_000 })
  await expect.poll(
    async () => (await readRendererGrid(harness.page, agentName)).rows,
    { message: `live xterm runtime should mount for ${agentName}`, timeout: 60_000 }
  ).toBeGreaterThan(0)

  await acceptWorkspaceTrustIfShown(harness, terminal, agentName, marker)
  if (harness.cli === 'claude') {
    // Normalize while the startup status is still visible. After workload 1,
    // the bypass badge can scroll out even though the mode remains active.
    await normalizeClaudePermissionMode(harness, terminal, agentName)
  }
  return { name: agentName, terminal }
}

async function checkpointed(
  harness: FidelityHarness,
  agent: SpawnedAgent,
  workload: WorkloadName,
  marker: string,
  telemetryAtStart: number
): Promise<void> {
  await waitForMarker(harness, agent.name, marker)
  await captureCheckpoint(harness, agent.name, workload, { marker, telemetryAtStart })
}

async function longStreamingReply(harness: FidelityHarness, agent: SpawnedAgent): Promise<void> {
  const workload: WorkloadName = 'long-streaming-reply'
  const marker = 'TF_LONG_DONE'
  const telemetryAtStart = harness.telemetry.length
  harness.currentWorkload = workload
  await submitPrompt(
    agent.terminal,
    `Print 60 ASCII lines. Each line must be \`TF-LONG-NNNN abcdefghijklmnopqrstuvwxyz0123456789\` with NNNN increasing from 0001. Do not use tools or omit lines. ${finalMarkerInstruction(marker)}`
  )
  await checkpointed(harness, agent, workload, marker, telemetryAtStart)
}

async function permissionPromptRepaint(harness: FidelityHarness, agent: SpawnedAgent): Promise<void> {
  const workload: WorkloadName = 'permission-prompt-repaint'
  const marker = 'TF_PERMISSION_DONE'
  const telemetryAtStart = harness.telemetry.length
  harness.currentWorkload = workload
  const target = join(harness.userDataDir, `${harness.cli}-tool-panel.txt`)

  // Relay's CLI harness can intentionally start an agent in bypass mode. Use
  // each CLI's real permission UI to return to an asking mode so this workload
  // cannot silently auto-approve the tool.
  let permissionModeScreen = (await readBrokerSnapshot(harness.connectionPath, agent.name)).screen
  let codexAskingConfirmed = false
  if (harness.cli === 'codex') {
    // Do this unconditionally: after a long first workload the YOLO startup
    // banner may have scrolled out even though the session is still bypassing.
    await submitPrompt(agent.terminal, '/permissions')
    await expect.poll(
      async () => (await readBrokerSnapshot(harness.connectionPath, agent.name)).screen,
      { message: 'Codex should open its real permissions selector', timeout: 15_000 }
    ).toMatch(/update model permissions/iu)
    await agent.terminal.click()
    await harness.page.keyboard.press('ArrowUp')
    await harness.page.keyboard.press('ArrowUp')
    await harness.page.keyboard.press('Enter')
    await harness.page.waitForTimeout(500)

    // Re-open the selector and verify the mode instead of trusting a sticky
    // startup banner that can remain visible in Codex's inline transcript.
    await submitPrompt(agent.terminal, '/permissions')
    await expect.poll(
      async () => (await readBrokerSnapshot(harness.connectionPath, agent.name)).screen,
      { message: 'Codex should confirm Ask for approval is current', timeout: 15_000 }
    ).toMatch(/ask for approval \(current\)/iu)
    await harness.page.keyboard.press('Escape')
    codexAskingConfirmed = true
  } else {
    for (let attempt = 0; attempt < 7; attempt += 1) {
      permissionModeScreen = (await readBrokerSnapshot(harness.connectionPath, agent.name)).screen
      if (!AUTOMATIC_PERMISSION_MODE.test(permissionModeScreen)) break
      await agent.terminal.click()
      await harness.page.keyboard.press('Shift+Tab')
      await harness.page.waitForTimeout(450)
    }
  }
  permissionModeScreen = (await readBrokerSnapshot(harness.connectionPath, agent.name)).screen
  if (!codexAskingConfirmed && AUTOMATIC_PERMISSION_MODE.test(permissionModeScreen)) {
    throw new Error(`${harness.cli} remained in an auto-approve mode; cannot exercise its approval TUI`)
  }

  await submitPrompt(
    agent.terminal,
    `Use your shell tool to run this exact command: printf 'term fidelity\\n' > '${target}'. After the command completes, ${finalMarkerInstruction(marker)}`
  )

  const panelPattern = /(?:do you want to (?:proceed|allow)|allow (?:once|always)|approve|run this command\?|yes,? allow|yes, (?:and don'?t ask again|proceed)|press enter to confirm|esc to cancel)/iu
  const deadline = Date.now() + 90_000
  let panelSeen = false
  let lastScreen = ''
  while (Date.now() < deadline) {
    const snapshot = await readBrokerSnapshot(harness.connectionPath, agent.name)
    lastScreen = snapshot.screen
    if (panelPattern.test(lastScreen)) {
      panelSeen = true
      break
    }
    if (lastScreen.includes(marker)) break
    await harness.page.waitForTimeout(250)
  }
  if (!panelSeen) {
    throw new Error(
      `${harness.cli} did not show a tool-approval TUI; the canonical permission repaint was not exercised.\n${lastScreen}`
    )
  }

  // Move the selection away and back to force two real approval-panel paints,
  // then accept the original default choice.
  await agent.terminal.click()
  await harness.page.keyboard.press('ArrowDown')
  await harness.page.waitForTimeout(150)
  await harness.page.keyboard.press('ArrowUp')
  await harness.page.waitForTimeout(150)
  // Grok's first choice enables always-approve. Select its one-time second
  // choice after the required away/back repaint instead of changing the rest
  // of the matrix session into bypass mode.
  if (harness.cli === 'grok') {
    await harness.page.keyboard.press('ArrowDown')
    await harness.page.waitForTimeout(150)
  }
  await harness.page.keyboard.press('Enter')
  await checkpointed(harness, agent, workload, marker, telemetryAtStart)
}

async function resizeMidStream(harness: FidelityHarness, agent: SpawnedAgent): Promise<void> {
  const workload: WorkloadName = 'resize-mid-stream'
  const marker = 'TF_RESIZE_DONE'
  const telemetryAtStart = harness.telemetry.length
  harness.currentWorkload = workload
  const baseline = await getActivity(harness.page, agent.name)
  await submitPrompt(
    agent.terminal,
    `Print 100 ASCII lines numbered TF-RESIZE-0001 through TF-RESIZE-0100, one per line. Do not use tools. ${finalMarkerInstruction(marker)}`
  )
  await waitForOutputProgress(harness, agent.name, baseline)

  const original = await harness.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('Electron window not found')
    return win.getBounds()
  })
  for (const delta of [24, 48, 72, 96, 72, 48, 24, 0]) {
    await harness.electronApp.evaluate(({ BrowserWindow }, bounds) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('Electron window not found')
      win.setBounds(bounds)
    }, {
      ...original,
      width: original.width + delta,
      height: original.height + Math.round(delta / 2)
    })
    await harness.page.waitForTimeout(90)
  }
  await checkpointed(harness, agent, workload, marker, telemetryAtStart)
}

async function typingDuringStream(harness: FidelityHarness, agent: SpawnedAgent): Promise<void> {
  const workload: WorkloadName = 'typing-during-stream'
  const marker = 'TF_TYPING_DONE'
  const telemetryAtStart = harness.telemetry.length
  harness.currentWorkload = workload
  const baseline = await getActivity(harness.page, agent.name)
  await submitPrompt(
    agent.terminal,
    `Print 120 ASCII lines numbered TF-TYPING-0001 through TF-TYPING-0120, one per line. Do not use tools. ${finalMarkerInstruction(marker)}`
  )
  await waitForOutputProgress(harness, agent.name, baseline)
  await agent.terminal.click()
  await harness.page.keyboard.type('concurrent fidelity typing', { delay: 35 })
  await checkpointed(harness, agent, workload, marker, telemetryAtStart)
}

async function hideRevealDuringStream(harness: FidelityHarness, agent: SpawnedAgent): Promise<void> {
  const workload: WorkloadName = 'hide-reveal-during-stream'
  const marker = 'TF_BLUR_DONE'
  const telemetryAtStart = harness.telemetry.length
  harness.currentWorkload = workload
  const baseline = await getActivity(harness.page, agent.name)
  await submitPrompt(
    agent.terminal,
    `Print 100 ASCII lines numbered TF-BLUR-0001 through TF-BLUR-0100, one per line. Do not use tools. ${finalMarkerInstruction(marker)}`
  )
  await waitForOutputProgress(harness, agent.name, baseline)
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('Electron window not found')
    win.blur()
    win.hide()
  })
  await harness.page.waitForTimeout(1_200)
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('Electron window not found')
    win.show()
    win.focus()
  })
  await harness.page.bringToFront()
  await checkpointed(harness, agent, workload, marker, telemetryAtStart)
}

async function scrollbackDuringStream(harness: FidelityHarness, agent: SpawnedAgent): Promise<void> {
  const workload: WorkloadName = 'scrollback-during-stream'
  const marker = 'TF_SCROLL_DONE'
  const telemetryAtStart = harness.telemetry.length
  harness.currentWorkload = workload
  const baseline = await getActivity(harness.page, agent.name)
  await submitPrompt(
    agent.terminal,
    `Print 140 ASCII lines numbered TF-SCROLL-0001 through TF-SCROLL-0140, one per line. Do not use tools. ${finalMarkerInstruction(marker)}`
  )
  await waitForOutputProgress(harness, agent.name, baseline, { chunks: 8, bytes: 1_000 })

  const grid = await readRendererGrid(harness.page, agent.name)
  if (grid.bufferType === 'alternate' && harness.cli === 'claude') {
    // Claude's fullscreen renderer owns a virtualized scrollback inside its
    // alternate-buffer TUI. Ctrl+O enters that real transcript, g scrolls to
    // the top, G returns to the bottom, and Ctrl+O returns to the live view.
    // This is the user-visible scrollback path when xterm baseY cannot move.
    await agent.terminal.click()
    await harness.page.keyboard.press('Control+O')
    await harness.page.waitForTimeout(300)
    await harness.page.keyboard.press('g')
    await harness.page.waitForTimeout(400)
    const scrolled = await readRendererGrid(harness.page, agent.name)
    expect(scrolled.lines.join('\n'), 'Claude transcript should repaint when scrolled to the top')
      .not.toBe(grid.lines.join('\n'))
    await harness.page.keyboard.press('Shift+G')
    await harness.page.waitForTimeout(300)
    await harness.page.keyboard.press('Control+O')
    await harness.page.waitForTimeout(300)
  } else if (grid.bufferType === 'alternate' && harness.cli === 'opencode') {
    // OpenCode owns scrollback inside its alternate-buffer session view.
    // PageUp and End are its default real-user bindings for page-up and last.
    await agent.terminal.click()
    await harness.page.keyboard.press('PageUp')
    await harness.page.waitForTimeout(400)
    const scrolled = await readRendererGrid(harness.page, agent.name)
    expect(scrolled.lines.join('\n'), 'OpenCode session should repaint when paged upward')
      .not.toBe(grid.lines.join('\n'))
    await harness.page.keyboard.press('End')
    await harness.page.waitForTimeout(300)
  } else if (harness.cli === 'grok') {
    // Grok's inline renderer keeps xterm's normal buffer at baseY=0 and owns
    // the visible transcript scroll itself. Its mouse-reporting path is the
    // real user-visible scrollback even though the xterm buffer is "normal".
    await agent.terminal.hover()
    await harness.page.mouse.wheel(0, -1_600)
    await harness.page.waitForTimeout(400)
    const scrolled = await readRendererGrid(harness.page, agent.name)
    expect(scrolled.lines.join('\n'), 'Grok transcript should repaint when scrolled upward')
      .not.toBe(grid.lines.join('\n'))
    for (let page = 0; page < 5; page += 1) {
      await harness.page.mouse.wheel(0, 10_000)
      await harness.page.waitForTimeout(80)
    }
    await harness.page.keyboard.press('End')
    await harness.page.waitForTimeout(300)
  } else {
    await expect.poll(
      async () => (await readRendererGrid(harness.page, agent.name)).baseY,
      {
        message: `stream should create xterm scrollback before scrolling (buffer=${grid.bufferType})`,
        timeout: 30_000
      }
    ).toBeGreaterThan(10)

    await agent.terminal.hover()
    await harness.page.mouse.wheel(0, -1_600)
    await expect.poll(async () => {
      const current = await readRendererGrid(harness.page, agent.name)
      return current.viewportY < current.baseY
    }, { message: 'xterm should leave the bottom while output is streaming' }).toBe(true)
    await harness.page.waitForTimeout(650)
    await harness.page.mouse.wheel(0, 10_000)
    await expect.poll(async () => {
      const current = await readRendererGrid(harness.page, agent.name)
      return current.viewportY === current.baseY
    }, { message: 'xterm should return to the live bottom viewport' }).toBe(true)
  }

  await checkpointed(harness, agent, workload, marker, telemetryAtStart)
}

export async function runCanonicalWorkloads(
  harness: FidelityHarness,
  agent: SpawnedAgent
): Promise<void> {
  const failures: Error[] = []
  const workloads: Array<[WorkloadName, (harness: FidelityHarness, agent: SpawnedAgent) => Promise<void>]> = [
    ['long-streaming-reply', longStreamingReply],
    ['permission-prompt-repaint', permissionPromptRepaint],
    ['resize-mid-stream', resizeMidStream],
    ['typing-during-stream', typingDuringStream],
    ['hide-reveal-during-stream', hideRevealDuringStream],
    ['scrollback-during-stream', scrollbackDuringStream]
  ]
  const only = process.env.TERM_FIDELITY_WORKLOAD?.trim()
  if (only && !workloads.some(([name]) => name === only)) {
    throw new Error(`Unknown TERM_FIDELITY_WORKLOAD=${JSON.stringify(only)}`)
  }

  for (const [name, workload] of workloads) {
    if (only && name !== only) continue
    console.log(`[term-fidelity] ${harness.cli}: starting ${name}`)
    try {
      await workload(harness, agent)
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  harness.currentWorkload = null
  if (failures.length > 0) {
    throw new AggregateError(failures, failures.map((failure) => failure.message).join('\n\n'))
  }
}
