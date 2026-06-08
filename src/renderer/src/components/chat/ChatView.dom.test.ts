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
const VIEWPORT_HEIGHT = 100
const VIEWPORT_WIDTH = 800

class TestResizeObserver {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element): void {
    const height = target instanceof HTMLElement ? target.offsetHeight : ROW_HEIGHT
    const width = target instanceof HTMLElement ? target.offsetWidth : VIEWPORT_WIDTH
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
  seedChat(makeMessages(1000))
})

afterEach(() => {
  cleanup()
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
})
