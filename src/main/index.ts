import { app, BrowserWindow, shell, Menu, protocol, nativeImage, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { burnManager } from './burn'
import { brokerManager } from './broker'
import { cloudAgentManager } from './cloud-agent'
import { factoryManager } from './factory-manager'
import { integrationsManager } from './integrations'
import { registerAvatarCacheProtocol } from './avatar-cache'
import { openProjectForPath, parseOpenCommand, type OpenPathDeps } from './cli'
import { addProject, loadStore, setActiveProject } from './store'
import { isDirectory } from './path-utils'
import { initAutoUpdater, registerUpdaterIpc, checkForUpdatesInteractive } from './updater'
import { registerCliInstallIpc, promptInstallPearCli } from './cli-install'

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
const integrationAgentRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Path requested via `pear open <dir>` before the renderer has registered its
// listener; applied once the renderer sends `cli:renderer-ready`.
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
  for (const timer of integrationAgentRefreshTimers.values()) clearTimeout(timer)
  integrationAgentRefreshTimers.clear()
  if (!shutdownPromise) {
    shutdownPromise = Promise.all([
      factoryManager.shutdown(),
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Fire-and-forget: Electron opens the URL in the default browser;
    // errors (e.g. no handler for the scheme) surface in the OS, not here.
    void shell.openExternal(details.url)
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
    // Load errors surface in devtools/crash-reporter; no app-level handler needed.
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: (): void => {
            void checkForUpdatesInteractive()
          }
        },
        { type: 'separator' },
        {
          label: "Install 'pear' command in PATH…",
          click: (): void => {
            void promptInstallPearCli()
          }
        },
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

function scheduleIntegrationAgentRefresh(projectId: string): void {
  if (!projectId.trim()) return
  const existing = integrationAgentRefreshTimers.get(projectId)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    integrationAgentRefreshTimers.delete(projectId)
    void integrationsManager.refreshAgentState(projectId).catch((error) => {
      console.warn('[integrations] Failed to refresh newly ready agent integration state:', error instanceof Error ? error.message : String(error))
    })
  }, 2_000)
  integrationAgentRefreshTimers.set(projectId, timer)
}

function registerIntegrationBrokerHooks(): void {
  brokerManager.onBrokerEvent((projectId, event) => {
    if (event.kind !== 'agent_spawned' && event.kind !== 'worker_ready') return
    scheduleIntegrationAgentRefresh(projectId)
  })
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else if (app.isReady()) {
      createWindow()
    }
  })

  ipcMain.on('cli:renderer-ready', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    rendererReadyForCliOpen = true
    flushPendingOpen()
  })

  app.whenReady().then(() => {
    const appIcon = getAppIcon()
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      iconPath: getAppIconPath()
    })

    if (process.platform === 'darwin' && appIcon) {
      app.dock?.setIcon(appIcon)
    }

    registerAvatarCacheProtocol()
    registerIpcHandlers()
    registerUpdaterIpc()
    registerCliInstallIpc()
    registerIntegrationBrokerHooks()
    initAutoUpdater()
    // Prime the burn ledger off the critical path so the first burn view (and the
    // status-bar summary) queries a warm binding/DB instead of stalling ~1.5-4s.
    burnManager.warmUp()
    void integrationsManager.startLocalMountDaemon().catch((error) => {
      console.warn('[integrations] Failed to start local integration mount daemon:', error instanceof Error ? error.message : String(error))
    })
    createMenu()
    // Resolve any `pear open <dir>` from the initial launch; queued until the
    // renderer registers its listener and sends `cli:renderer-ready`.
    handleOpenCommand(process.argv, process.cwd())
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((err) => {
    // Fail fast: a partially initialized app (no window, no IPC) must not
    // keep running. exitCode 1 preserves the pre-lint unhandled-rejection
    // behavior of exiting non-zero.
    console.error('[main] app initialization failed:', err)
    process.exitCode = 1
    app.quit()
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
