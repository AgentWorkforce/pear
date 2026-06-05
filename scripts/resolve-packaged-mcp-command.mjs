#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  console.error(`resolve-packaged-mcp-command: ${message}`)
  process.exit(1)
}

const resourcesPathArg = process.argv[2]
if (!resourcesPathArg) {
  fail('usage: node --experimental-strip-types scripts/resolve-packaged-mcp-command.mjs <resources-path> [electron-exec-path]')
}

const resourcesPath = resolve(resourcesPathArg)
if (!existsSync(resourcesPath)) {
  fail(`resources path does not exist: ${resourcesPath}`)
}
const execPath = process.argv[3] ? resolve(process.argv[3]) : process.env.PEAR_PACKAGED_EXEC_PATH || process.execPath

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const resolverUrl = new URL('../src/main/mcp-command.ts', import.meta.url)
const { resolveAgentRelayMcpCommand } = await import(resolverUrl)

const command = resolveAgentRelayMcpCommand({
  configuredCommand: undefined,
  env: process.env,
  execPath,
  isPackaged: true,
  resourcesPath
})

if (!command) {
  fail(`resolver returned no command for ${rootDir}`)
}

process.stdout.write(`${command}\n`)
