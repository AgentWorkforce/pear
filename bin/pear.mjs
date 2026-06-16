#!/usr/bin/env node
/**
 * `pear` CLI launcher.
 *
 * Forwards its arguments to the Pear Electron app, e.g.
 *
 *   pear open ./my-directory
 *
 * The Electron main process (src/main/index.ts) parses the `open <dir>` verb,
 * reuses or creates a project rooted at that directory, and routes the request
 * to an already-running instance via the single-instance lock.
 *
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const appMain = join(appRoot, 'out', 'main', 'index.js')
const args = process.argv.slice(2)

if (!existsSync(appMain)) {
  console.error(`Pear is not built yet — run \`npm run build\` first (missing ${appMain}).`)
  process.exit(1)
}

// In a Node context, requiring electron yields the path to its executable.
const electronPath = require('electron')

const child = spawn(electronPath, [appMain, ...args], {
  stdio: 'inherit'
})

child.on('close', (code, signal) => {
  // A signal-terminated child reports code === null; surface that as a failure
  // (128 + signal number, per shell convention) so calling scripts can detect it.
  if (signal) {
    const signalNumber = typeof os.constants.signals[signal] === 'number' ? os.constants.signals[signal] : 0
    process.exit(128 + signalNumber)
  }
  process.exit(code ?? 0)
})
child.on('error', (error) => {
  console.error('Failed to launch Pear:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
