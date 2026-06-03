import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// Re-check for updates this often while the app stays open.
const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

let initialized = false

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * Wire up GitHub-Releases auto-update. No-ops outside a packaged build (dev runs
 * have no update feed and electron-updater would throw). Downloads happen in the
 * background; the user is prompted to restart once an update is ready.
 */
export function initAutoUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => broadcast('update:available', { version: info.version }))
  autoUpdater.on('update-not-available', () => broadcast('update:none'))
  autoUpdater.on('download-progress', (progress) =>
    broadcast('update:progress', { percent: progress.percent })
  )
  autoUpdater.on('error', (error) => {
    console.warn('[updater] Error:', error instanceof Error ? error.message : String(error))
    broadcast('update:error', { message: error instanceof Error ? error.message : String(error) })
  })

  autoUpdater.on('update-downloaded', async (info) => {
    broadcast('update:downloaded', { version: info.version })
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Pear ${info.version} has been downloaded.`,
      detail: 'Restart to finish installing the update.'
    })
    if (result.response === 0) autoUpdater.quitAndInstall()
  })

  void checkForUpdates()
  setInterval(() => void checkForUpdates(), UPDATE_POLL_INTERVAL_MS)
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.warn('[updater] Check failed:', error instanceof Error ? error.message : String(error))
  }
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
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())
}
