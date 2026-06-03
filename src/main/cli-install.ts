import { app, dialog, ipcMain } from 'electron'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CLI_TARGET = '/usr/local/bin/pear'

/**
 * Install a `pear` shim into PATH that forwards to the packaged app binary.
 *
 * The app's main process already parses `open <dir>` from argv and routes it to
 * the running instance via the single-instance lock, so the shim just needs to
 * exec the bundle's executable with the user's arguments.
 *
 * Writing into /usr/local/bin needs admin rights, so we stage the shim in a temp
 * file and copy it into place via a single privileged osascript prompt (the same
 * UX as VS Code's "Install 'code' command").
 */
export async function installPearCli(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'Installing the pear CLI is currently supported on macOS only.' }
  }
  if (!app.isPackaged) {
    return { ok: false, message: 'The pear CLI can only be installed from the packaged app.' }
  }

  const exePath = app.getPath('exe')
  const shim = `#!/bin/sh\nexec "${exePath}" "$@"\n`

  const stagingDir = mkdtempSync(join(tmpdir(), 'pear-cli-'))
  const stagingPath = join(stagingDir, 'pear')
  writeFileSync(stagingPath, shim, { mode: 0o755 })

  // Single privileged step: ensure the dir exists, copy the shim, make it
  // executable. Quotes guard against spaces in the staging path.
  const script = `do shell script "mkdir -p /usr/local/bin && cp '${stagingPath}' '${CLI_TARGET}' && chmod 755 '${CLI_TARGET}'" with administrator privileges`

  try {
    await execFileAsync('osascript', ['-e', script])
    return { ok: true, message: `Installed the \`pear\` command at ${CLI_TARGET}.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // User cancelling the auth prompt surfaces as error code -128.
    if (message.includes('-128')) {
      return { ok: false, message: 'CLI installation was cancelled.' }
    }
    return { ok: false, message: `Failed to install the pear CLI: ${message}` }
  }
}

/** Menu/IPC entry point that runs the install and reports the result. */
export async function promptInstallPearCli(): Promise<void> {
  const result = await installPearCli()
  await dialog.showMessageBox({
    type: result.ok ? 'info' : 'warning',
    title: result.ok ? 'pear CLI installed' : 'pear CLI',
    message: result.ok ? 'You can now run `pear open <dir>` from your terminal.' : result.message,
    detail: result.ok ? result.message : undefined,
    buttons: ['OK']
  })
}

export function registerCliInstallIpc(): void {
  ipcMain.handle('cli:install', () => installPearCli())
}
