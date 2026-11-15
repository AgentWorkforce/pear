import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: vi.fn() } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } } }))

const { shouldCheckForUpdates } = await import('./updater')

describe('shouldCheckForUpdates', () => {
  const hour = 60 * 60 * 1000

  it('checks when the last check is older than the gap', () => {
    expect(shouldCheckForUpdates(null, 0, hour, hour / 4)).toBe(true)
    expect(shouldCheckForUpdates({ kind: 'error', message: 'offline' }, 0, hour, hour / 4)).toBe(true)
  })

  it('skips a repeated focus check inside the gap', () => {
    expect(shouldCheckForUpdates(null, hour, hour + 60_000, hour / 4)).toBe(false)
  })

  it('stops checking while an update downloads or waits for a restart', () => {
    expect(shouldCheckForUpdates({ kind: 'downloading', percent: 40 }, 0, hour, 0)).toBe(false)
    expect(shouldCheckForUpdates({ kind: 'downloaded', version: '2026.11.7' }, 0, hour, 0)).toBe(false)
  })
})
