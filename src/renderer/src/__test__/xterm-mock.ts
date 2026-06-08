// Minimal xterm.js mock for happy-dom component tests.
//
// We don't try to emulate xterm's VT parser; tests assert against the raw
// byte sequences passed to `write()` and the lifecycle calls made on the
// terminal. Returns a value-compatible `Terminal` shape covering the
// surface that `terminal-runtime-registry.ts`, `use-terminal.ts`, and
// `predictive-echo.ts` consume.

import { vi } from 'vitest'

export interface MockBufferLine {
  translateToString: () => string
}

export interface MockActiveBuffer {
  type: 'normal' | 'alternate'
  cursorX: number
  cursorY: number
  baseY: number
  viewportY: number
  getLine: (row: number) => MockBufferLine | undefined
}

export interface MockTextarea {
  focus: ReturnType<typeof vi.fn>
}

export interface MockOptions {
  theme?: unknown
}

export type DataHandler = (data: string) => void
export type ResizeHandler = (size: { cols: number; rows: number }) => void

export interface MockTerminal {
  cols: number
  rows: number
  textarea: MockTextarea
  options: MockOptions
  buffer: { active: MockActiveBuffer }
  // Recorded raw byte sequences in call order.
  __writes: string[]
  // Counts so tests can assert without spying.
  __refreshCalls: Array<{ start: number; end: number }>
  __disposed: boolean
  __opened: boolean
  __openContainer: HTMLElement | null
  __addons: unknown[]
  __dataHandlers: DataHandler[]
  __resizeHandlers: ResizeHandler[]

  write: (data: string, cb?: () => void) => void
  open: (container: HTMLElement) => void
  dispose: () => void
  focus: () => void
  refresh: (start: number, end: number) => void
  resize: (cols: number, rows: number) => void
  scrollToBottom: () => void
  loadAddon: (addon: unknown) => void
  onData: (handler: DataHandler) => { dispose: () => void }
  onResize: (handler: ResizeHandler) => { dispose: () => void }
}

export interface MockTerminalConstructorOpts {
  cols?: number
  rows?: number
  [k: string]: unknown
}

// Tracks every Terminal instance ever created so tests can introspect.
export const createdTerminals: MockTerminal[] = []

export function resetXtermMock(): void {
  createdTerminals.length = 0
}

export class Terminal implements MockTerminal {
  cols: number
  rows: number
  textarea: MockTextarea
  options: MockOptions
  buffer: { active: MockActiveBuffer }
  __writes: string[] = []
  __refreshCalls: Array<{ start: number; end: number }> = []
  __disposed = false
  __opened = false
  __openContainer: HTMLElement | null = null
  __addons: unknown[] = []
  __dataHandlers: DataHandler[] = []
  __resizeHandlers: ResizeHandler[] = []

  constructor(opts: MockTerminalConstructorOpts = {}) {
    this.cols = typeof opts.cols === 'number' ? opts.cols : 80
    this.rows = typeof opts.rows === 'number' ? opts.rows : 24
    this.textarea = { focus: vi.fn() }
    this.options = { theme: opts.theme }
    this.buffer = {
      active: {
        type: 'normal',
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        getLine: () => ({ translateToString: () => '' })
      }
    }
    createdTerminals.push(this)
  }

  write(data: string, cb?: () => void): void {
    this.__writes.push(data)
    if (cb) queueMicrotask(cb)
  }

  open(container: HTMLElement): void {
    this.__opened = true
    this.__openContainer = container
  }

  dispose(): void {
    this.__disposed = true
  }

  focus(): void {
    // recorded by tests via spying if needed; cheap no-op otherwise
  }

  refresh(start: number, end: number): void {
    this.__refreshCalls.push({ start, end })
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    for (const h of this.__resizeHandlers) h({ cols, rows })
  }

  scrollToBottom(): void {
    // no-op
  }

  loadAddon(addon: unknown): void {
    this.__addons.push(addon)
  }

  onData(handler: DataHandler): { dispose: () => void } {
    this.__dataHandlers.push(handler)
    return {
      dispose: () => {
        const idx = this.__dataHandlers.indexOf(handler)
        if (idx >= 0) this.__dataHandlers.splice(idx, 1)
      }
    }
  }

  onResize(handler: ResizeHandler): { dispose: () => void } {
    this.__resizeHandlers.push(handler)
    return {
      dispose: () => {
        const idx = this.__resizeHandlers.indexOf(handler)
        if (idx >= 0) this.__resizeHandlers.splice(idx, 1)
      }
    }
  }
}

// Addons used by terminal-runtime-registry.ts. They get `loadAddon()`-ed
// onto the terminal; the runtime only calls `.fit()` on the FitAddon and
// `.onContextLoss()` on the WebglAddon, so other methods are no-ops.

export class FitAddon {
  __fitCalls = 0
  fit(): void {
    this.__fitCalls += 1
  }
  dispose(): void {}
}

export class WebLinksAddon {
  dispose(): void {}
}

export class WebglAddon {
  __contextLossHandlers: Array<() => void> = []
  onContextLoss(handler: () => void): { dispose: () => void } {
    this.__contextLossHandlers.push(handler)
    return { dispose: () => {} }
  }
  dispose(): void {}
}
