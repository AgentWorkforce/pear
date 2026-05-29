#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

let projectId = process.env.PEAR_AUTOPILOT_PROJECT_ID || process.env.PROJECT_ID || ''
let cloudAgentId = process.env.PEAR_AUTOPILOT_CLOUD_AGENT_ID || process.env.CLOUD_AGENT_ID || ''
let dryRun = false
const readyPattern = /\[ipc\] ready port=(\d+)/i
const readyTimeoutMs = Number(process.env.PEAR_AUTOPILOT_READY_TIMEOUT_MS || 120_000)

function usage() {
  console.log(`Usage: scripts/pear-attach-probe.mjs [--project-id <project>] [--cloud-agent-id <agent>] [--dry-run]

Starts Pear with PEAR_AUTOPILOT_PROBE=1 and waits for the dev IPC bridge.

Options:
  --project-id <id>       Project id to attach.
  --cloud-agent-id <id>   Cloud agent id to attach.
  --dry-run               Validate that the dev-only bridge is registered without
                          invoking cloud-agent attach or warming a box.

Environment fallbacks:
  PEAR_AUTOPILOT_PROJECT_ID, PROJECT_ID
  PEAR_AUTOPILOT_CLOUD_AGENT_ID, CLOUD_AGENT_ID`)
}

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      usage()
      process.exit(0)
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--project-id') {
      projectId = argv[index + 1] || ''
      index += 1
      continue
    }
    if (arg === '--cloud-agent-id') {
      cloudAgentId = argv[index + 1] || ''
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let settled = false
    let output = ''
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Timed out waiting for ${readyPattern} after ${readyTimeoutMs}ms`))
    }, readyTimeoutMs)

    const onData = (chunk) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(text)
      const match = output.match(readyPattern)
      if (!settled && match) {
        settled = true
        clearTimeout(timeout)
        resolve(Number(match[1]))
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Pear dev process exited before IPC was ready (code=${code ?? 'null'} signal=${signal ?? 'null'})`))
    })
  })
}

async function requestBridge(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`Probe bridge ${path} failed: ${response.status} ${response.statusText}`)
  }
  return payload
}

async function invokeAutopilotAttach(port) {
  return requestBridge(port, '/cloud-attach', { projectId, cloudAgentId })
}

async function stopProcessTree(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const descendants = child.pid ? descendantPids(child.pid) : []
  const targets = [...descendants.reverse(), child.pid, ...projectDevProcessPids()]
    .filter((pid) => typeof pid === 'number' && pid !== process.pid)
  const signal = (value) => {
    try {
      for (const pid of targets) process.kill(pid, value)
    } catch {
      child.kill(value)
    }
  }

  signal('SIGTERM')

  await Promise.race([exited, delay(5_000)])
  if (child.exitCode !== null || child.signalCode !== null) return

  signal('SIGKILL')
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
  await delay(250)
}

function projectDevProcessPids() {
  try {
    const cwd = process.cwd()
    const output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    const pids = []
    for (const line of output.trim().split('\n')) {
      const trimmed = line.trim()
      const match = trimmed.match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const pid = Number(match[1])
      const command = match[2]
      if (!Number.isFinite(pid)) continue
      if (!command.includes(cwd)) continue
      if (command.includes('node_modules/electron/dist/Electron.app') || command.includes('electron-vite')) {
        pids.push(pid)
      }
    }
    return pids
  } catch {
    return []
  }
}

function descendantPids(rootPid) {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    const childrenByParent = new Map()
    for (const line of output.trim().split('\n')) {
      const [pidText, ppidText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const ppid = Number(ppidText)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      const children = childrenByParent.get(ppid) || []
      children.push(pid)
      childrenByParent.set(ppid, children)
    }

    const descendants = []
    const stack = [...(childrenByParent.get(rootPid) || [])]
    while (stack.length > 0) {
      const pid = stack.pop()
      descendants.push(pid)
      stack.push(...(childrenByParent.get(pid) || []))
    }
    return descendants
  } catch {
    return []
  }
}

async function main() {
  parseArgs(process.argv.slice(2))

  const startedAt = Date.now()
  if (!dryRun && (!projectId || !cloudAgentId)) {
    usage()
    process.exitCode = 2
    return
  }

  const child = spawn('npm', ['run', 'dev'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PEAR_AUTOPILOT_PROBE: '1'
    }
  })

  try {
    const port = await waitForReady(child)
    if (dryRun) {
      const health = await requestBridge(port, '/health')
      const ok = health?.ok === true && health?.ipcChannel === '__autopilot:cloud-attach'
      console.log(JSON.stringify({
        ok,
        dryRun: true,
        bridgePort: port,
        ipcChannel: health?.ipcChannel,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000)
      }))
      process.exitCode = ok ? 0 : 1
      return
    }

    const result = await invokeAutopilotAttach(port)
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    const ok = result?.ok === true && result?.brokerMode === 'persist'
    console.log(JSON.stringify({ ok, brokerMode: result?.brokerMode, elapsedSec, error: result?.error }))
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    console.log(JSON.stringify({
      ok: false,
      brokerMode: null,
      elapsedSec,
      error: error instanceof Error ? error.message : String(error)
    }))
    process.exitCode = 1
  } finally {
    await stopProcessTree(child)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
