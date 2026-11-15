import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdaterState } from '../shared/types/ipc'

const { autoUpdater } = electronUpdater

// Re-check for updates this often while the app stays open.
const UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000
// Coming back to the app re-checks too, at most this often.
const FOCUS_CHECK_GAP_MS = 15 * 60 * 1000

let initialized = false

// Latest updater state, replayed to renderers that subscribe after an event has
// already fired (window reload, or a check that resolves before the React effect
// mounts). Null = idle / up to date.
let currentState: UpdaterState | null = null

// Guards overlapping downloadUpdate() calls (e.g. a double-clicked CTA).
let downloading = false

// Startup, the hourly poll, and window focus can all ask at once; they share one check.
let checkInFlight: Promise<void> | null = null
let lastCheckAt = 0

/**
 * Whether a background check is worth running: not once an update is already
 * downloaded and waiting for a restart, and not again within `minGapMs`.
 */
export function shouldCheckForUpdates(
  state: UpdaterState | null,
  lastCheckMs: number,
  nowMs: number,
  minGapMs: number
): boolean {
  if (state?.kind === 'downloaded' || state?.kind === 'downloading') return false
  return nowMs - lastCheckMs >= minGapMs
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * Wire up GitHub-Releases auto-update. No-ops outside a packaged build (dev runs
 * have no update feed and electron-updater would throw). A new version
 * downloads in the background and installs when Pear quits; the banner offers
 * an immediate restart once it's ready.
 */
export function initAutoUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    currentState = { kind: 'available', version: info.version }
    broadcast('update:available', { version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    currentState = null
    broadcast('update:none')
  })
  autoUpdater.on('download-progress', (progress) => {
    currentState = { kind: 'downloading', percent: progress.percent }
    broadcast('update:progress', { percent: progress.percent })
  })
  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[updater] Error:', message)
    currentState = { kind: 'error', message }
    broadcast('update:error', { message })
  })

  // The renderer's update banner drives the restart CTA (-> update:install),
  // so just notify it; no native dialog.
  autoUpdater.on('update-downloaded', (info) => {
    currentState = { kind: 'downloaded', version: info.version }
    broadcast('update:downloaded', { version: info.version })
  })

  void checkForUpdates()
  setInterval(() => void checkForUpdates(UPDATE_POLL_INTERVAL_MS / 2), UPDATE_POLL_INTERVAL_MS)
  app.on('browser-window-focus', () => void checkForUpdates(FOCUS_CHECK_GAP_MS))
}

export function checkForUpdates(minGapMs = 0): Promise<void> {
  if (!app.isPackaged) return Promise.resolve()
  if (checkInFlight) return checkInFlight
  if (!shouldCheckForUpdates(currentState, lastCheckAt, Date.now(), minGapMs)) return Promise.resolve()
  lastCheckAt = Date.now()
  checkInFlight = autoUpdater.checkForUpdates()
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn('[updater] Check failed:', error instanceof Error ? error.message : String(error))
    })
    .finally(() => {
      checkInFlight = null
    })
  return checkInFlight
}

/**
 * Manual "Check for Updates…" entry point — surfaces an "up to date" dialog so a
 * user-initiated check always gives feedback, unlike the silent startup poll.
 */
export async function checkForUpdatesInteractive(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Updates are only available in the packaged app.',
      buttons: ['OK']
    })
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const current = app.getVersion()
    if (result && result.updateInfo.version === current) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'You’re up to date',
        message: `Pear ${current} is the latest version.`,
        buttons: ['OK']
      })
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Update check failed',
      message: error instanceof Error ? error.message : String(error),
      buttons: ['OK']
    })
  }
}

export function registerUpdaterIpc(): void {
  ipcMain.handle('update:check', () => checkForUpdatesInteractive())
  ipcMain.handle('update:get-state', () => currentState)
  ipcMain.handle('update:download', async () => {
    if (downloading) return
    downloading = true
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      // The 'error' event already broadcasts to the renderer; just keep this
      // from surfacing as an unhandled rejection.
      console.warn(
        '[updater] Download failed:',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      downloading = false
    }
  })
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())
}
