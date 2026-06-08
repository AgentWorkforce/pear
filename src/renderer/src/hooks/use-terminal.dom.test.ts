// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { useRef } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import type { Terminal as XTermType } from '@xterm/xterm'
import {
  Terminal as MockTerminal,
  FitAddon as MockFitAddon,
  WebLinksAddon as MockWebLinksAddon,
  WebglAddon as MockWebglAddon,
  createdTerminals,
  resetXtermMock
} from '@/__test__/xterm-mock'

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: MockWebLinksAddon }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: MockWebglAddon }))

vi.mock('@/lib/font-settle', () => ({
  awaitFontSettle: vi.fn(async () => {})
}))

vi.mock('@/lib/ipc', () => ({
  pear: {
    broker: {
      attachTerminal: vi.fn(async () => ({ snapshot: null })),
      resizePty: vi.fn(async () => {}),
      setTerminalMode: vi.fn(async () => {}),
      sendInputFast: vi.fn(),
      inputSrtt: vi.fn(async () => null)
    }
  }
}))

vi.mock('@/lib/predictive-echo', () => ({
  createPredictiveEcho: vi.fn(() => ({
    engine: null,
    dispose: vi.fn()
  }))
}))

// ResizeObserver isn't implemented by happy-dom. The hook constructs one
// but only fires observe callbacks on real layout changes — we just need
// the constructor not to throw.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  StubResizeObserver as unknown as typeof ResizeObserver

let useTerminal: typeof import('./use-terminal').useTerminal
let agentStoreModule: typeof import('@/stores/agent-store')

beforeEach(async () => {
  resetXtermMock()
  vi.resetModules()
  useTerminal = (await import('./use-terminal')).useTerminal
  agentStoreModule = await import('@/stores/agent-store')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

interface ProbeProps {
  agentName: string
  projectId: string
  termHolder: { current: XTermType | null }
  renderCounter: { count: number }
}

function Probe({ agentName, projectId, termHolder, renderCounter }: ProbeProps): React.ReactElement {
  renderCounter.count += 1
  const ref = useRef<HTMLDivElement | null>(null)
  // Give the container layout so initIfReady() doesn't bail.
  const setRef = (node: HTMLDivElement | null): void => {
    if (node) {
      Object.defineProperty(node, 'clientWidth', { configurable: true, value: 800 })
      Object.defineProperty(node, 'clientHeight', { configurable: true, value: 600 })
    }
    ref.current = node
  }
  const term = useTerminal(ref, agentName, projectId, true)
  termHolder.current = term
  return React.createElement('div', { ref: setRef, 'data-testid': 'host' })
}

function seedAgents(names: Array<{ projectId: string; name: string }>): void {
  const baseAgent = {
    cli: 'test',
    status: 'running' as const,
    activity: 'idle' as const,
    currentState: 'idle' as const,
    terminalMode: 'drive' as const,
    pendingDeliveryIds: [] as string[]
  }
  agentStoreModule.useAgentStore.setState({
    agents: names.map((a) => ({ ...baseAgent, name: a.name, projectId: a.projectId }))
  })
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderProbe(agentName: string, projectId: string) {
  const termHolder = { current: null as XTermType | null }
  const renderCounter = { count: 0 }
  const utils = render(
    React.createElement(Probe, { agentName, projectId, termHolder, renderCounter })
  )
  // The hook returns `runtimeRef.current?.term ?? null`. The mount
  // effect runs after render and mutates the ref without triggering a
  // re-render, so we manually re-render after a microtask drain to
  // capture the latest term. When agentName changes, we need
  // rerender → flush (cleanup + new effect run) → rerender (capture).
  const settle = async (name: string = agentName): Promise<void> => {
    utils.rerender(
      React.createElement(Probe, { agentName: name, projectId, termHolder, renderCounter })
    )
    await flushAsync()
    utils.rerender(
      React.createElement(Probe, { agentName: name, projectId, termHolder, renderCounter })
    )
    await flushAsync()
  }
  return { ...utils, termHolder, renderCounter, settle }
}

describe('useTerminal — ref stability', () => {
  it('returns the same Terminal instance across renders for the same agent key', async () => {
    seedAgents([{ projectId: 'p', name: 'alpha' }])
    const probe = renderProbe('alpha', 'p')
    await probe.settle()
    const firstTerm = probe.termHolder.current
    expect(firstTerm).not.toBeNull()

    await probe.settle()
    expect(probe.termHolder.current).toBe(firstTerm)
    expect(createdTerminals).toHaveLength(1)

    await probe.settle()
    expect(probe.termHolder.current).toBe(firstTerm)
    expect(createdTerminals).toHaveLength(1)
  })

  it('switching agentName produces a different Terminal instance', async () => {
    seedAgents([
      { projectId: 'p', name: 'alpha' },
      { projectId: 'p', name: 'beta' }
    ])
    const probe = renderProbe('alpha', 'p')
    await probe.settle()
    const alphaTerm = probe.termHolder.current
    expect(alphaTerm).not.toBeNull()

    await probe.settle('beta')
    const betaTerm = probe.termHolder.current
    expect(betaTerm).not.toBeNull()
    expect(betaTerm).not.toBe(alphaTerm)
    expect(createdTerminals.length).toBeGreaterThanOrEqual(2)
  })
})
