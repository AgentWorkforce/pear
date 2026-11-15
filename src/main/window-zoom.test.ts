import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { clampZoom, initialWindowSize, windowButtonPosition, DEFAULT_ZOOM } = await import('./window-zoom')

describe('window zoom', () => {
  it('keeps zoom in range and falls back on garbage', () => {
    expect(clampZoom(1.3)).toBe(1.3)
    expect(clampZoom(5)).toBe(1.8)
    expect(clampZoom(0.1)).toBe(0.8)
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM)
    expect(clampZoom(1.2 + 0.1)).toBe(1.3)
  })

  it('centers the window buttons in the zoomed top bar', () => {
    expect(windowButtonPosition(1)).toEqual({ x: 16, y: 20 })
    expect(windowButtonPosition(1.2)).toEqual({ x: 16, y: 26 })
  })

  it('opens at most of the screen, within limits', () => {
    expect(initialWindowSize({ width: 1512, height: 944 })).toEqual({ width: 1391, height: 868 })
    expect(initialWindowSize({ width: 3008, height: 1692 })).toEqual({ width: 1720, height: 1120 })
  })
})
