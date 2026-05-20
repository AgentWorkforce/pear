import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater, { type AppUpdater } from 'electron-updater'

const { autoUpdater } = electronUpdater

const UPDATE_CHECK_DELAY_MS = 30 * 1000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let updaterConfigured = false
let updateTimer: NodeJS.Timeout | null = null

function logUpdaterError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.warn('[updater] Update check failed:', message)
}

function getAutoUpdater(): AppUpdater {
  return autoUpdater
}

async function notifyManualCheckUnavailable(): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    message: 'Updates are available in the packaged Pear app.',
    detail: 'Run a signed installer build to test automatic updates.'
  })
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) {
    if (manual) await notifyManualCheckUnavailable()
    return
  }

  try {
    await getAutoUpdater().checkForUpdatesAndNotify()
  } catch (err) {
    logUpdaterError(err)
    if (manual) {
      await dialog.showMessageBox({
        type: 'error',
        message: 'Unable to check for updates.',
        detail: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

export function configureAutoUpdates(mainWindow: BrowserWindow): void {
  if (updaterConfigured) return
  updaterConfigured = true

  if (!app.isPackaged) {
    console.log('[updater] Skipping automatic update checks in development.')
    return
  }

  const updater = getAutoUpdater()
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true

  updater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates.')
  })

  updater.on('update-available', (info) => {
    console.log(`[updater] Update available: ${info.version}`)
  })

  updater.on('update-not-available', (info) => {
    console.log(`[updater] No update available. Current version: ${info.version}`)
  })

  updater.on('download-progress', (progress) => {
    console.log(`[updater] Download progress: ${Math.round(progress.percent)}%`)
  })

  updater.on('update-downloaded', async (info) => {
    console.log(`[updater] Update downloaded: ${info.version}`)
    if (mainWindow.isDestroyed()) return

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: 'A Pear update is ready to install.',
      detail: 'Restart Pear to apply the downloaded update.'
    })

    if (result.response === 0) {
      updater.quitAndInstall()
    }
  })

  updater.on('error', logUpdaterError)

  setTimeout(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_DELAY_MS)

  updateTimer = setInterval(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_INTERVAL_MS)

  updateTimer.unref?.()
}
