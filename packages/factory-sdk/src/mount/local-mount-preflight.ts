import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { checkMountStaleness, resolveRelayfileMountBinary } from './relayfile-binary'

const STATE_FILE = '.integrations/.relay/state.json'

export async function ensureLocalMount(workspaceId: string, startDir: string): Promise<void> {
  const stateFilePath = join(startDir, STATE_FILE)

  if (!(await isMountStatePresent(stateFilePath))) {
    await spawnMount(workspaceId, startDir)
    await waitForStateFile(stateFilePath)
    return
  }

  const staleness = checkMountStaleness(stateFilePath, workspaceId)
  if (staleness.stale) {
    const suffix = staleness.reason !== undefined ? ` (${staleness.reason})` : ''
    process.stderr.write(
      `[factory] local mount is stale${suffix}; writeback may not propagate. Run: relayfile stop && relayfile start ${workspaceId} .integrations --background\n`,
    )
  }
}

async function isMountStatePresent(stateFilePath: string): Promise<boolean> {
  try {
    const raw = await readFile(stateFilePath, 'utf8')
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

async function spawnMount(workspaceId: string, startDir: string): Promise<void> {
  const binaryPath = resolveRelayfileMountBinary()

  return new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, ['start', workspaceId, '.integrations', '--background', '--rehome'], {
      cwd: startDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    const stderrChunks: Buffer[] = []
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    }

    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (isAuthError(stderr)) {
        reject(new Error(`[factory] relayfile mount not authorized — run: relayfile workspace join ${workspaceId} --write`))
        return
      }
      if (code !== 0) {
        reject(new Error(`[factory] relayfile mount start failed (exit ${code ?? 'null'}): ${stderr.trim()}`))
        return
      }
      resolve()
    })

    child.on('error', (err: Error) => {
      reject(new Error(`[factory] relayfile mount start error: ${err.message}`))
    })
  })
}

async function waitForStateFile(stateFilePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(stateFilePath, 'utf8')
      return
    } catch {
      // not yet present
    }
    await sleep(200)
  }
}

const isAuthError = (stderr: string): boolean =>
  stderr.includes('workspace join') ||
  stderr.includes('unauthorized') ||
  stderr.includes('no credentials')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
