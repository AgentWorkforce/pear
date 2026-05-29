#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const projectId = process.env.PEAR_AUTOPILOT_PROJECT_ID || process.env.PROJECT_ID || ''
const cloudAgentId = process.env.PEAR_AUTOPILOT_CLOUD_AGENT_ID || process.env.CLOUD_AGENT_ID || ''
const readyPattern = /\[ipc\] ready/i
const defaultReadyTimeoutMs = 120_000
const readyTimeoutMs = parsePositiveNumber(process.env.PEAR_AUTOPILOT_READY_TIMEOUT_MS, defaultReadyTimeoutMs)
const outputBufferLimit = 10_000

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function usage() {
  console.log(`Usage: PEAR_AUTOPILOT_PROJECT_ID=<project> PEAR_AUTOPILOT_CLOUD_AGENT_ID=<agent> scripts/pear-attach-probe.mjs

Starts Pear with PEAR_AUTOPILOT_PROBE=1 and waits for the dev IPC bridge.

Current limitation:
  The required dev-only __autopilot:cloud-attach IPC handler/socket bridge is
  intentionally not implemented in this scaffold PR. Once that handler exists
  in src/main/ipc-handlers.ts, replace invokeAutopilotAttach() with the local
  socket/electron-remote invocation and assert brokerMode === "persist".`)
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage()
    process.exit(0)
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
      output = (output + text).slice(-outputBufferLimit)
      process.stdout.write(text)
      if (!settled && readyPattern.test(output)) {
        settled = true
        clearTimeout(timeout)
        resolve()
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Failed to start Pear dev process: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Pear dev process exited before IPC was ready (code=${code ?? 'null'} signal=${signal ?? 'null'})`))
    })
  })
}

async function invokeAutopilotAttach() {
  await delay(0)
  throw new Error(
    'PEAR_AUTOPILOT_PROBE_STUB: __autopilot:cloud-attach IPC socket/electron-remote bridge is not implemented yet'
  )
}

async function main() {
  parseArgs(process.argv.slice(2))

  const startedAt = Date.now()
  if (!projectId || !cloudAgentId) {
    usage()
    process.exitCode = 2
    return
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npmCmd, ['run', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PEAR_AUTOPILOT_PROBE: '1'
    }
  })

  try {
    await waitForReady(child)
    const result = await invokeAutopilotAttach({ projectId, cloudAgentId })
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
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
