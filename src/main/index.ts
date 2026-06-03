import { app, BrowserWindow, shell, Menu, protocol, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { brokerManager } from './broker'
import { cloudAgentManager } from './cloud-agent'
import { integrationsManager } from './integrations'
import { registerAvatarCacheProtocol } from './avatar-cache'
import { openProjectForPath, parseOpenCommand, type OpenPathDeps } from './cli'
import { addProject, loadStore, setActiveProject } from './store'
import { isDirectory } from './path-utils'

const APP_NAME = 'Pear by Agent Relay'

app.setName(APP_NAME)

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pear-avatar',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let shutdownPromise: Promise<void> | null = null
let quitAfterShutdown = false
// Path requested via `pear open <dir>` before the window exists; applied once
// the renderer is ready to receive the active-project switch.
let pendingOpenPath: string | null = null
let rendererReadyForCliOpen = false

const openPathDeps: OpenPathDeps = { loadStore, addProject, setActiveProject, isDirectory }

/**
 * Handle a `pear open <dir>` invocation: resolve the directory to a project
 * (reusing or creating one) and tell the renderer to switch to it. When the
 * window isn't ready yet the request is queued for `flushPendingOpen()`.
 */
function handleOpenCommand(argv: readonly string[], workingDirectory: string): void {
  const rawPath = parseOpenCommand(argv)
  if (!rawPath) return

  const targetPath = resolve(workingDirectory, rawPath)
  try {
    const result = openProjectForPath(targetPath, openPathDeps)
    if (mainWindow && !mainWindow.isDestroyed() && rendererReadyForCliOpen) {
      mainWindow.webContents.send('cli:open-project', result.projectId)
    } else {
      pendingOpenPath = targetPath
    }
  } catch (error) {
    console.warn('[cli] Failed to open path:', error instanceof Error ? error.message : String(error))
  }
}

function flushPendingOpen(): void {
  if (!pendingOpenPath || !mainWindow || !rendererReadyForCliOpen) return
  const targetPath = pendingOpenPath
  pendingOpenPath = null
  try {
    const result = openProjectForPath(targetPath, openPathDeps)
    mainWindow.webContents.send('cli:open-project', result.projectId)
  } catch (error) {
    console.warn('[cli] Failed to open path:', error instanceof Error ? error.message : String(error))
  }
}

function getAppIconPath(): string {
  const iconPaths = app.isPackaged
    ? [
        join(process.resourcesPath, 'app-icon.png'),
        join(app.getAppPath(), 'resources/app-icon.png')
      ]
    : [join(__dirname, '../../resources/app-icon.png')]

  return iconPaths.find((path) => existsSync(path)) ?? iconPaths[0]
}

function getAppIcon(): Electron.NativeImage | undefined {
  const iconPath = getAppIconPath()
  const icon = nativeImage.createFromPath(iconPath)

  return icon.isEmpty() ? undefined : icon
}

function shutdownBrokerOnce(): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = Promise.all([
      cloudAgentManager.shutdownAll(),
      brokerManager.shutdown()
    ]).then(() => undefined)
  }
  return shutdownPromise
}

function createWindow(): void {
  rendererReadyForCliOpen = false
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: getAppIcon(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 10 },
    backgroundColor: '#08111a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReadyForCliOpen = false
  })

  mainWindow.webContents.on('did-start-loading', () => {
    rendererReadyForCliOpen = false
  })

  // Apply a queued `pear open <dir>` request once the renderer has loaded and
  // registered its `cli:open-project` listener.
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReadyForCliOpen = true
    flushPendingOpen()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (process.platform !== 'darwin') return
    if (input.type !== 'keyDown') return
    if (!input.control || input.meta || input.key.toLowerCase() !== 'w') return

    event.preventDefault()
    mainWindow?.webContents.send('menu:close-tab')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click: (): void => {
            mainWindow?.webContents.send('menu:new-project')
          }
        },
        { type: 'separator' },
        {
          label: 'Spawn Agent',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: (): void => {
            mainWindow?.webContents.send('menu:spawn-agent')
          }
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (): void => {
            mainWindow?.webContents.send('menu:close-tab')
          }
        },
        {
          label: 'Release Agent',
          click: (): void => {
            mainWindow?.webContents.send('menu:release-agent')
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Close Tab',
          click: (): void => {
            mainWindow?.webContents.send('menu:close-tab')
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Ensure a single running instance so `pear open <dir>` from a second launch is
// routed to the existing window instead of starting a duplicate app.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // A second `pear ...` invocation forwards its argv + cwd here.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    handleOpenCommand(argv, workingDirectory)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else if (app.isReady()) {
      createWindow()
    }
  })

  app.whenReady().then(() => {
    const appIcon = getAppIcon()
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      iconPath: getAppIconPath()
    })

    if (process.platform === 'darwin' && appIcon) {
      app.dock.setIcon(appIcon)
    }

    registerAvatarCacheProtocol()
    registerIpcHandlers()
    void integrationsManager.startLocalMountDaemon().catch((error) => {
      console.warn('[integrations] Failed to start local integration mount daemon:', error instanceof Error ? error.message : String(error))
    })
    createMenu()
    // Resolve any `pear open <dir>` from the initial launch; queued until the
    // renderer finishes loading (see `did-finish-load` in createWindow).
    handleOpenCommand(process.argv, process.cwd())
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', async () => {
  await shutdownBrokerOnce()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (!quitAfterShutdown) {
    event.preventDefault()
    const results = await Promise.allSettled([
      integrationsManager.shutdownLocalMounts(),
      shutdownBrokerOnce()
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[shutdown] Cleanup failed:', result.reason instanceof Error ? result.reason.message : String(result.reason))
      }
    }
    quitAfterShutdown = true
    app.quit()
    return
  }
  const results = await Promise.allSettled([
    integrationsManager.shutdownLocalMounts(),
    shutdownBrokerOnce()
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[shutdown] Cleanup failed:', result.reason instanceof Error ? result.reason.message : String(result.reason))
    }
  }
})
