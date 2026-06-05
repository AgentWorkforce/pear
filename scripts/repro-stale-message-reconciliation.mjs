#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

function readArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1 || index + 1 >= process.argv.length) return fallback
  return process.argv[index + 1]
}

function readNumberArg(name, fallback) {
  const value = readArg(name, undefined)
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function runAgentRelay(args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn('agent-relay', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolvePromise({ ok: false, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0, stdout, stderr })
    })
  })
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function main() {
  const cwd = resolve(readArg('--cwd', process.cwd()))
  const channel = readArg('--channel', 'general')
  const idleMs = readNumberArg('--idle-ms', 0)
  const timeoutMs = readNumberArg('--timeout-ms', 10_000)
  const connectionPath = resolve(
    readArg('--connection', join(cwd, '.agentworkforce', 'relay', 'connection.json'))
  )
  const text = readArg('--text', `pear-stale-reconcile-probe ${new Date().toISOString()}`)

  if (!existsSync(connectionPath)) {
    throw new Error(`Broker connection file not found: ${connectionPath}`)
  }

  const connection = JSON.parse(readFileSync(connectionPath, 'utf8'))
  if (!connection.url || !connection.api_key) {
    throw new Error(`Connection file is missing url/api_key: ${connectionPath}`)
  }

  const wsUrl = `${String(connection.url).replace(/^http/, 'ws')}/ws?sinceSeq=0`
  const result = {
    cwd,
    channel,
    text,
    connectionPath,
    wsUrl,
    idleMs,
    postOk: false,
    cliListed: false,
    brokerWsReceived: false,
    brokerEvent: null,
    postError: null
  }

  const socket = new WebSocket(wsUrl, {
    headers: { 'X-API-Key': connection.api_key }
  })

  const completion = new Promise((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise('timeout'), timeoutMs)

    socket.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString())
        if (event?.kind === 'relay_inbound' && event.body === text) {
          result.brokerWsReceived = true
          result.brokerEvent = {
            kind: event.kind,
            from: event.from,
            target: event.target,
            event_id: event.event_id,
            seq: event.seq
          }
          clearTimeout(timeout)
          resolvePromise('event')
        }
      } catch {
        // Ignore non-JSON frames.
      }
    })

    socket.on('error', (error) => {
      result.postError = error.message
      clearTimeout(timeout)
      resolvePromise('error')
    })
  })

  await new Promise((resolvePromise, reject) => {
    socket.once('open', resolvePromise)
    socket.once('error', reject)
  })

  if (idleMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, idleMs))
  }

  const post = await runAgentRelay(['message', 'post', channel, text], cwd)
  result.postOk = post.ok
  if (!post.ok) {
    result.postError = post.stderr || post.stdout || 'agent-relay message post failed'
  }

  await completion

  const list = await runAgentRelay(['message', 'list', channel, '--limit', '10'], cwd)
  const messages = parseJsonArray(list.stdout)
  result.cliListed = messages.some((message) => message?.text === text)

  socket.terminate()
  console.log(JSON.stringify(result, null, 2))

  if (!result.postOk || !result.cliListed || !result.brokerWsReceived) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
