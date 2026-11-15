import { app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const DEFAULT_ZOOM = 1.2
const MIN_ZOOM = 0.8
const MAX_ZOOM = 1.8
const ZOOM_STEP = 0.1
/** CSS height of the app's top bar (`h-14`) before zoom. */
const TOP_BAR_HEIGHT = 56
/** Height macOS reserves around the window buttons, so they center in the bar. */
const WINDOW_BUTTON_BOX = 24

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100
}

/** Where the window buttons sit so they stay centered in the zoomed top bar. */
export function windowButtonPosition(zoom: number): { x: number; y: number } {
  return { x: 16, y: Math.round((TOP_BAR_HEIGHT * zoom - WINDOW_BUTTON_BOX) / 2) }
}

/** A comfortable first size: most of the screen, capped so it isn't sprawling on big displays. */
export function initialWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(960, Math.min(1720, Math.round(workArea.width * 0.92))),
    height: Math.max(600, Math.min(1120, Math.round(workArea.height * 0.92)))
  }
}

function zoomFile(): string {
  return join(app.getPath('userData'), 'window-zoom.json')
}

export function loadZoom(): number {
  try {
    const file = zoomFile()
    if (!existsSync(file)) return DEFAULT_ZOOM
    return clampZoom(Number((JSON.parse(readFileSync(file, 'utf8')) as { zoom?: unknown }).zoom))
  } catch {
    return DEFAULT_ZOOM
  }
}

function saveZoom(zoom: number): void {
  try {
    writeFileSync(zoomFile(), JSON.stringify({ zoom }))
  } catch (error) {
    console.warn('[window] could not save zoom:', error instanceof Error ? error.message : String(error))
  }
}

export function applyZoom(win: BrowserWindow, zoom: number): void {
  win.webContents.setZoomFactor(zoom)
  if (process.platform === 'darwin') win.setWindowButtonPosition(windowButtonPosition(zoom))
}

/** Keeps the saved zoom across reloads; Chromium otherwise resets it per navigation. */
export function attachZoom(win: BrowserWindow): void {
  win.webContents.on('did-finish-load', () => applyZoom(win, loadZoom()))
}

function setZoom(win: BrowserWindow | null, zoom: number): void {
  if (!win) return
  const next = clampZoom(zoom)
  saveZoom(next)
  applyZoom(win, next)
}

export function zoomMenuItems(getWindow: () => BrowserWindow | null): MenuItemConstructorOptions[] {
  return [
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(getWindow(), DEFAULT_ZOOM) },
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => setZoom(getWindow(), loadZoom() + ZOOM_STEP) },
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => setZoom(getWindow(), loadZoom() + ZOOM_STEP) },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoom(getWindow(), loadZoom() - ZOOM_STEP) }
  ]
}
