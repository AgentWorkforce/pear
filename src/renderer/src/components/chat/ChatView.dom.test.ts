// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ChatView } from './ChatView'
import type { ChatMessage } from '@/stores/agent-store'
import { useAgentStore } from '@/stores/agent-store'
import type { Project } from '@/stores/project-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

vi.mock('@/lib/ipc', () => ({
  pear: {
    auth: {
      status: vi.fn(async () => ({ loggedIn: false, user: null }))
    },
    broker: {
      start: vi.fn(async () => {}),
      subscribeAgentChannel: vi.fn(async () => {}),
      unsubscribeAgentChannel: vi.fn(async () => {}),
      syncChannels: vi.fn(async () => {})
    },
    project: {
      list: vi.fn(async () => ({ projects: [], activeId: null })),
      setActive: vi.fn(async () => {}),
      addChannel: vi.fn(async () => {}),
      removeChannel: vi.fn(async () => {}),
      setChannelPeople: vi.fn(async () => [])
    }
  }
}))

const ROW_HEIGHT = 88
const MESSAGE_LINE_HEIGHT = 20
const VIEWPORT_HEIGHT = 100
const VIEWPORT_WIDTH = 800

const resizeObserverHeights = new WeakMap<Element, number>()

class TestResizeObserver {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element): void {
    const height = target instanceof HTMLElement ? target.offsetHeight : ROW_HEIGHT
    const width = target instanceof HTMLElement ? target.offsetWidth : VIEWPORT_WIDTH
    resizeObserverHeights.set(target, height)
    queueMicrotask(() => {
      this.callback([{
        target,
        borderBoxSize: [{ blockSize: height, inlineSize: width }] as ResizeObserverSize[],
        contentBoxSize: [{ blockSize: height, inlineSize: width }] as ResizeObserverSize[],
        contentRect: {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
          width,
          height,
          toJSON: () => ({})
        } as DOMRectReadOnly,
        devicePixelContentBoxSize: [{ blockSize: height, inlineSize: width }] as ResizeObserverSize[]
      }], this as unknown as ResizeObserver)
    })
  }

  unobserve(): void {}
  disconnect(): void {}
}

function getStyledHeight(element: HTMLElement): number | null {
  const parsed = Number.parseFloat(element.style.height || '')
  return Number.isFinite(parsed) ? parsed : null
}

function getVirtualRows(container: HTMLElement = document.body): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-virtual-row"]'))
}

function getVirtualRowStart(row: HTMLElement): number {
  const match = row.style.transform.match(/^translateY\((-?[\d.]+)px\)$/)
  return match ? Number(match[1]) : Number.NaN
}

function expectMountedRowsNotToOverlap(container: HTMLElement): void {
  const rows = getVirtualRows(container).sort(
    (left, right) => Number(left.dataset.index) - Number(right.dataset.index)
  )

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]
    const current = rows[index]
    if (Number(current.dataset.index) !== Number(previous.dataset.index) + 1) continue

    expect(getVirtualRowStart(current)).toBeGreaterThanOrEqual(
      getVirtualRowStart(previous) + previous.offsetHeight
    )
  }
}

function getMountedIndexes(container: HTMLElement = document.body): number[] {
  return getVirtualRows(container)
    .map((row) => Number(row.dataset.index))
    .filter((index) => Number.isFinite(index))
}

function makeMessages(count: number): ChatMessage[] {
  const timestamp = Date.UTC(2026, 0, 1, 9, 0, 0)

  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    from: `agent-${index % 20}`,
    to: '#general',
    body: `Message ${index}`,
    timestamp: timestamp + index * 1000,
    isHuman: false,
    projectId: 'project-1'
  }))
}

function makeLargeToolCallPayload(lines = 24): string {
  return [
    'Called agent_relay.post_message({ channel: "term-fidelity", result: {',
    ...Array.from({ length: lines - 2 }, (_, index) =>
      `  chunk_${index}: "status-${index}-sha-0123456789abcdef"`
    ),
    '} })'
  ].join('\n')
}

function seedChat(messages: ChatMessage[]): void {
  const project: Project = {
    id: 'project-1',
    name: 'Project 1',
    relayWorkspaceId: 'project-1',
    rootPath: '/tmp/project-1',
    rootPathExists: true,
    roots: [{ id: 'root-1', name: 'Project 1', path: '/tmp/project-1', pathExists: true }],
    channels: ['general'],
    channelPeople: {},
    integrations: []
  }

  useProjectStore.setState({
    projects: [project],
    activeProjectId: project.id,
    activeRootId: 'root-1',
    activeChannelName: 'general',
    brokerStarted: true,
    brokerProjectId: project.id,
    loading: false,
    pendingRootConflict: null
  })
  useAgentStore.setState({
    agents: [{
      name: 'agent-0',
      cli: 'codex',
      status: 'running',
      activity: 'idle',
      currentState: 'idle',
      projectId: project.id,
      channels: ['general'],
      terminalMode: 'passthrough',
      pendingDeliveryIds: []
    }],
    messages
  })
  useUIStore.setState({
    tabs: [{
      id: 'channel:project-1:general',
      kind: 'channel',
      title: 'general',
      projectId: project.id,
      channelName: 'general'
    }],
    activeTabId: 'channel:project-1:general',
    viewMode: 'chat'
  })
}

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get() {
        const element = this as HTMLElement
        if (element.classList.contains('overflow-y-auto')) return VIEWPORT_HEIGHT
        if (element.dataset.testid === 'chat-virtual-row') {
          return ROW_HEIGHT + element.querySelectorAll('br').length * MESSAGE_LINE_HEIGHT
        }
        return getStyledHeight(element) ?? ROW_HEIGHT
      }
    },
    offsetWidth: {
      configurable: true,
      get() {
        return VIEWPORT_WIDTH
      }
    },
    clientHeight: {
      configurable: true,
      get() {
        const element = this as HTMLElement
        return element.classList.contains('overflow-y-auto') ? VIEWPORT_HEIGHT : element.offsetHeight
      }
    },
    scrollHeight: {
      configurable: true,
      get() {
        const element = this as HTMLElement
        const sizedChild = Array.from(element.children).find((child): child is HTMLElement =>
          child instanceof HTMLElement && child.style.height.length > 0
        )
        return getStyledHeight(sizedChild || element) ?? element.offsetHeight
      }
    }
  })
  HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number, y?: number): void {
    const nextTop = typeof options === 'number' ? (y || 0) : Number(options?.top || 0)
    this.scrollTop = nextTop
    this.dispatchEvent(new Event('scroll'))
  }
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    TestResizeObserver as unknown as typeof ResizeObserver
  ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    TestResizeObserver as unknown as typeof ResizeObserver
})

beforeEach(() => {
  // Fake timers so the @tanstack/react-virtual scroll debounce (a setTimeout
  // it schedules on every scroll to reset `isScrolling`, and does NOT clear on
  // unmount) is created in a registry we control. `shouldAdvanceTime` keeps the
  // clock progressing with real time so React Testing Library's `waitFor` and
  // async `act` still resolve normally. See afterEach for why this matters.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  seedChat(makeMessages(1000))
})

afterEach(() => {
  cleanup()
  // Drain and drop any timer react-virtual left pending BEFORE the DOM env is
  // torn down. Its scroll debounce survives unmount; if it fired after teardown
  // it threw `ReferenceError: window is not defined` inside Timeout._onTimeout,
  // an unhandled error that false-red CI even though every assertion passed
  // (#406). Clearing while the env still exists closes the race deterministically.
  vi.clearAllTimers()
  vi.useRealTimers()
  useAgentStore.getState().clearAll()
  useProjectStore.setState({
    projects: [],
    activeProjectId: null,
    activeRootId: null,
    activeChannelName: null,
    brokerStarted: false,
    brokerProjectId: null,
    loading: false,
    pendingRootConflict: null
  })
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('ChatView virtualization', () => {
  it('mounts only the visible message window for a 1000-message channel', async () => {
    const { container } = render(React.createElement(ChatView))

    await waitFor(() => {
      const rows = getVirtualRows(container)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThanOrEqual(15)
    })

    expect(container.querySelectorAll('[data-testid="chat-virtual-row"]').length).not.toBe(1000)
  })

  it('mounts a different row window after scrolling', async () => {
    const { container } = render(React.createElement(ChatView))

    await waitFor(() => {
      expect(getVirtualRows(container).length).toBeGreaterThan(0)
    })

    const before = getMountedIndexes(container)
    const scroller = container.querySelector<HTMLElement>('.overflow-y-auto')
    expect(scroller).not.toBeNull()

    await act(async () => {
      scroller!.scrollTop = ROW_HEIGHT * 250
      scroller!.dispatchEvent(new Event('scroll'))
      await Promise.resolve()
    })

    await waitFor(() => {
      const after = getMountedIndexes(container)
      expect(after.length).toBeGreaterThan(0)
      expect(after[0]).toBeGreaterThan(200)
      expect(after).not.toEqual(before)
    })
  })

  it('uses the observed layout height for an initially large tool-call result', async () => {
    const messages = makeMessages(3)
    messages[0] = { ...messages[0], body: makeLargeToolCallPayload() }
    seedChat(messages)

    const { container } = render(React.createElement(ChatView))

    await waitFor(() => {
      const rows = getVirtualRows(container)
      expect(rows).toHaveLength(messages.length)
      expect(rows[0].offsetHeight).toBeGreaterThan(ROW_HEIGHT)
      expect(resizeObserverHeights.get(rows[0])).toBe(rows[0].offsetHeight)
      expectMountedRowsNotToOverlap(container)
    })
  })

  it('remeasures a live-growing tool-call result before the next row can overlap', async () => {
    const messages = makeMessages(3)
    seedChat(messages)

    const { container } = render(React.createElement(ChatView))
    let firstRowBeforeGrowth: HTMLElement | null = null

    await waitFor(() => {
      const rows = getVirtualRows(container)
      expect(rows).toHaveLength(messages.length)
      expect(resizeObserverHeights.get(rows[0])).toBe(rows[0].offsetHeight)
      expectMountedRowsNotToOverlap(container)
      firstRowBeforeGrowth = rows[0]
    })

    // The test observer deliberately has not delivered a follow-up entry yet,
    // reproducing the pre-paint window where the DOM has grown but the
    // virtualizer would otherwise retain the mounted row's cached 88px size.
    act(() => {
      useAgentStore.setState((state) => ({
        messages: state.messages.map((message, index) =>
          index === 0
            ? { ...message, body: makeLargeToolCallPayload(36) }
            : message
        )
      }))
    })

    await waitFor(() => {
      const firstRow = getVirtualRows(container)[0]
      expect(firstRow).toBe(firstRowBeforeGrowth)
      expect(firstRow.offsetHeight).toBeGreaterThan(ROW_HEIGHT)
      expect(resizeObserverHeights.get(firstRow)).toBe(ROW_HEIGHT)
      expectMountedRowsNotToOverlap(container)
    })
  })
})
