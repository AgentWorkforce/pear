import { app, BrowserWindow, shell, Menu, protocol, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { brokerManager } from './broker'
import { cloudAgentManager } from './cloud-agent'
import { registerAvatarCacheProtocol } from './avatar-cache'

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
  createMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await shutdownBrokerOnce()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await shutdownBrokerOnce()
})
