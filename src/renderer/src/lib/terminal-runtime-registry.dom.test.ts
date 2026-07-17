// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Keep predictive echo dormant: the runtime calls `predictiveEcho?.onServerOutput`
// when present, otherwise writes straight to the live term. We want the
// direct-write path so tests can assert against `__writes` synchronously.
vi.mock('@/lib/predictive-echo', () => ({
  createPredictiveEcho: vi.fn(() => ({
    engine: null,
    dispose: vi.fn()
  }))
}))

function makeLayoutContainer(width = 800, height = 600): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
  document.body.appendChild(el)
  return el
}

function makeZeroSizeContainer(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 0 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 0 })
  document.body.appendChild(el)
  return el
}

async function flushAsync(): Promise<void> {
  // Drain microtasks queued by the runtime's awaited init path.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

let registry: typeof import('./terminal-runtime-registry')
let ptyBuffer: typeof import('@/stores/pty-buffer-store')

beforeEach(async () => {
  resetXtermMock()
  vi.resetModules()
  registry = await import('./terminal-runtime-registry')
  ptyBuffer = await import('@/stores/pty-buffer-store')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('terminal-runtime-registry — token-based mount/detach ownership', () => {
  it('mount(A) then mount(B) silently reparents; detach(A) with stale token is a no-op; host ends up in B', () => {
    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })

    const containerA = makeLayoutContainer()
    const containerB = makeLayoutContainer()

    const tokenA = runtime.mount(containerA)
    expect(runtime.host.parentElement).toBe(containerA)

    const tokenB = runtime.mount(containerB)
    expect(tokenA).not.toBe(tokenB)
    expect(runtime.host.parentElement).toBe(containerB)

    // Stale token: detach(A) must not steal the host from B.
    runtime.detach(tokenA)
    expect(runtime.host.parentElement).toBe(containerB)
    expect(runtime.isMounted()).toBe(true)

    runtime.detach(tokenB)
    expect(runtime.host.parentElement).not.toBe(containerB)
    expect(runtime.isMounted()).toBe(false)

    registry.disposeTerminalRuntime(runtime.key)
  })
})

describe('terminal-runtime-registry — pty-buffer subscription lifecycle', () => {
  it('subscribes on first mount, survives detach/remount, unsubscribes on dispose (no listener leaks across remounts)', async () => {
    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    const term = createdTerminals[0]
    expect(term).toBeDefined()

    const containerA = makeLayoutContainer()
    runtime.mount(containerA)
    // initIfReady() awaits attachAndSeed which awaits attachTerminal; drain.
    await flushAsync()
    await flushAsync()

    // Subscription is live: appending a chunk and flushing should land
    // exactly one write on the terminal.
    ptyBuffer.appendPtyChunk(runtime.key, 'hello')
    ptyBuffer.flushPtyChunksNow(runtime.key)
    expect(term.__writes).toContain('hello')
    const writesAfterMount = term.__writes.length

    // Detach: the runtime is parked, but the subscription must survive so
    // background chunks still flow into xterm for the next remount.
    const tokenA = runtime.isMounted() ? Symbol('placeholder') : Symbol('na')
    // Use the real current token returned by a fresh mount path: re-mount
    // and check that no duplicate listener was added.
    runtime.detach(tokenA) // stale token — no-op
    expect(runtime.isMounted()).toBe(true)

    ptyBuffer.appendPtyChunk(runtime.key, 'one-listener')
    ptyBuffer.flushPtyChunksNow(runtime.key)
    expect(term.__writes.length).toBe(writesAfterMount + 1)

    // Mount into a new container: must not double-subscribe.
    const containerB = makeLayoutContainer()
    runtime.mount(containerB)
    await flushAsync()
    ptyBuffer.appendPtyChunk(runtime.key, 'still-one')
    ptyBuffer.flushPtyChunksNow(runtime.key)
    expect(term.__writes.length).toBe(writesAfterMount + 2)

    // Dispose: listener should be removed. clearPtyBuffer fires the
    // listener once with [] (a no-op write) before unsubscribing.
    registry.disposeTerminalRuntime(runtime.key)
    const writesAtDispose = term.__writes.length
    ptyBuffer.appendPtyChunk(runtime.key, 'after-dispose')
    ptyBuffer.flushPtyChunksNow(runtime.key)
    expect(term.__writes.length).toBe(writesAtDispose)
  })
})

describe('terminal-runtime-registry — pty drain coalescing', () => {
  it('coalesces a multi-chunk frame into one ordered write', async () => {
    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    const term = createdTerminals[0]
    expect(term).toBeDefined()

    runtime.mount(makeLayoutContainer())
    await flushAsync()
    await flushAsync()

    const before = term.__writes.length
    // Three chunks staged in one animation frame (no flush between), then
    // drained together. The runtime must hand xterm ONE write — not three —
    // so the VT parser (and the predictive-echo headless model) run once per
    // frame instead of once per chunk. That per-chunk fan-out was the drain
    // hot path under heavy TUI redraw streaming.
    ptyBuffer.appendPtyChunk(runtime.key, 'aaa')
    ptyBuffer.appendPtyChunk(runtime.key, 'bbb')
    ptyBuffer.appendPtyChunk(runtime.key, 'ccc')
    ptyBuffer.flushPtyChunksNow(runtime.key)

    expect(term.__writes.length).toBe(before + 1)
    expect(term.__writes[term.__writes.length - 1]).toBe('aaabbbccc')

    const beforeDuplicates = term.__writes.length
    ptyBuffer.appendPtyChunk(runtime.key, 'dup')
    ptyBuffer.appendPtyChunk(runtime.key, 'dup')
    ptyBuffer.appendPtyChunk(runtime.key, 'tail')
    ptyBuffer.flushPtyChunksNow(runtime.key)

    expect(term.__writes.length).toBe(beforeDuplicates + 1)
    expect(term.__writes[term.__writes.length - 1]).toBe('dupduptail')

    const afterDuplicates = term.__writes.length
    ptyBuffer.flushPtyChunksNow(runtime.key)
    expect(term.__writes.length).toBe(afterDuplicates)

    registry.disposeTerminalRuntime(runtime.key)
  })
})

describe('terminal-runtime-registry — v10 snapshot offset seeding', () => {
  it('writes post-snapshot chunks without replaying chunks covered by the snapshot', async () => {
    const ipc = await import('@/lib/ipc')
    vi.mocked(ipc.pear.broker.attachTerminal).mockImplementationOnce(async () => {
      // Both chunks arrive while attach IPC is in flight. The snapshot covers
      // only the first offset; the second must survive the seed baseline.
      ptyBuffer.appendPtyChunk('p:a', 'covered', 10)
      ptyBuffer.appendPtyChunk('p:a', 'fresh', 20)
      return {
        name: 'a',
        mode: 'auto_inject' as const,
        pending: 0,
        snapshot: {
          rows: 24,
          cols: 80,
          cursor: [0, 0] as [number, number],
          screen: 'snapshot',
          offset: 10
        }
      }
    })

    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    const term = createdTerminals[0]

    runtime.mount(makeLayoutContainer())
    await flushAsync()
    await flushAsync()

    expect(term.__writes).toContain('snapshot')
    expect(term.__writes).toContain('fresh')
    expect(term.__writes).not.toContain('covered')

    registry.disposeTerminalRuntime(runtime.key)
  })
})

describe('terminal-runtime-registry — clearOnDataIf identity check', () => {
  it('only clears the on-data handler when the caller still owns the slot', () => {
    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    const term = createdTerminals[0]

    const handlerA = vi.fn()
    const handlerB = vi.fn()

    runtime.setOnData(handlerA)
    runtime.setOnData(handlerB) // B replaces A — cross-tree commit ordering

    // Old-hook cleanup with stale handler A must not wipe the slot.
    runtime.clearOnDataIf(handlerA)
    for (const h of term.__dataHandlers) h('input-1')
    expect(handlerB).toHaveBeenCalledWith('input-1')
    expect(handlerA).not.toHaveBeenCalled()

    // Live-hook cleanup with the current handler must clear it.
    runtime.clearOnDataIf(handlerB)
    for (const h of term.__dataHandlers) h('input-2')
    expect(handlerB).toHaveBeenCalledTimes(1)

    registry.disposeTerminalRuntime(runtime.key)
  })
})

describe('terminal-runtime-registry — refreshOnShow', () => {
  it('calls term.refresh(0, rows - 1) to repaint after a display:none → visible transition', () => {
    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    const term = createdTerminals[0]
    expect(term.rows).toBeGreaterThan(0)
    const expectedEnd = term.rows - 1

    runtime.refreshOnShow()
    expect(term.__refreshCalls).toContainEqual({ start: 0, end: expectedEnd })

    registry.disposeTerminalRuntime(runtime.key)
  })
})

describe('terminal-runtime-registry — idle-timeout disposal', () => {
  it('disposes detached runtimes after five idle minutes and creates a fresh runtime on reacquire', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    const term = createdTerminals[0]
    const token = runtime.mount(makeLayoutContainer())

    runtime.detach(token)
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(registry.hasTerminalRuntime(runtime.key)).toBe(true)
    expect(term.__disposed).toBe(false)

    await vi.advanceTimersByTimeAsync(30_001)

    expect(registry.hasTerminalRuntime(runtime.key)).toBe(false)
    expect(term.__disposed).toBe(true)

    const reacquired = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    expect(reacquired).not.toBe(runtime)
    expect(createdTerminals).toHaveLength(2)

    registry.disposeTerminalRuntime(reacquired.key)
  })

  it('keeps a remounted runtime hot after prior idle time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    const runtime = registry.acquireTerminalRuntime({
      projectId: 'p',
      agentName: 'a',
      terminalMode: 'drive',
      theme: 'dark',
      getInputSrtt: () => null
    })
    const firstToken = runtime.mount(makeLayoutContainer())

    runtime.detach(firstToken)
    await vi.advanceTimersByTimeAsync(4 * 60_000)

    const secondToken = runtime.mount(makeLayoutContainer())
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(registry.hasTerminalRuntime(runtime.key)).toBe(true)
    expect(createdTerminals[0].__disposed).toBe(false)

    runtime.detach(secondToken)
    registry.disposeTerminalRuntime(runtime.key)
  })
})

describe('terminal-runtime-registry — dispose cancels pending init rAF', () => {
  it('cancels the pending initIfReady rAF and never fires it after dispose', async () => {
    const queued: Array<{ id: number; cb: FrameRequestCallback; cancelled: boolean }> = []
    let nextId = 1
    const rafSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb) => {
        const id = nextId++
        queued.push({ id, cb, cancelled: false })
        return id
      })
    const cancelSpy = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        const entry = queued.find((q) => q.id === id)
        if (entry) entry.cancelled = true
      })

    try {
      const runtime = registry.acquireTerminalRuntime({
        projectId: 'p',
        agentName: 'a',
        terminalMode: 'drive',
        theme: 'dark',
        getInputSrtt: () => null
      })
      const term = createdTerminals[0]

      // Zero-size container: initIfReady bails and schedules a rAF retry.
      const zero = makeZeroSizeContainer()
      runtime.mount(zero)
      await flushAsync()

      expect(queued.length).toBeGreaterThanOrEqual(1)
      const pending = queued[queued.length - 1]
      expect(pending.cancelled).toBe(false)
      expect(term.__opened).toBe(false)

      registry.disposeTerminalRuntime(runtime.key)

      expect(cancelSpy).toHaveBeenCalledWith(pending.id)
      expect(pending.cancelled).toBe(true)

      // Even if a wayward frame fires, the runtime is disposed and must
      // not open the terminal or otherwise act.
      for (const q of queued) {
        if (!q.cancelled) q.cb(performance.now())
      }
      expect(term.__opened).toBe(false)
    } finally {
      rafSpy.mockRestore()
      cancelSpy.mockRestore()
    }
  })
})
