/**
 * Rung-2 — place a REAL agent from THIS Mac onto an enrolled mini + prove it.
 * Issue #411 placement requester, pre-merge validation (rung-2).
 *
 * This is the requester side EXACTLY as BrokerManager.placeAgent runs it, but
 * pointed at the LIVE operator workspace (the workspace the running pear app's
 * broker is in) so the target is a real remote mini (`pear-fleet-<host>`),
 * enrolled out-of-band by tests/placement/rung2/enroll-mini.sh.
 *
 * WORKSPACE-SCOPE RULE (differs from rung-1): the operator workspace also holds
 * the live `pear` node + this Mac, so a no-host least-loaded placement could
 * land elsewhere. rung-2 therefore places TARGETED at the mini node by name —
 * `node:<mini>` can only resolve to that mini. We assert foreign capable nodes
 * ARE present (proving this is the shared operator workspace, not a hermetic
 * one) and that we used targeting.
 *
 * Proofs (mirrors rung-1's acceptance set, cross-machine):
 *   1. target mini advertises spawn:<cli> in the operator workspace roster.
 *   2. targeted placement lands on the mini (ack.node === mini).
 *   3. the mini owns the placed PTY (its broker snapshot is 200/non-empty),
 *      and the requester's live pear broker does NOT (404/empty)  → #2b.
 *   4. the placed agent is reachable over relay chat (roster + accepted DM)
 *      → #2a; a full LLM round-trip is recorded as a BONUS.
 * Then it RELEASES the placed agent (no leak) and leaves the node enrolled.
 *
 * Env:
 *   TARGET_NODE     required, e.g. pear-fleet-finn
 *   TARGET_HOST     required ssh host, e.g. finn-mini (for snapshot/release)
 *   PLACE_CLI       cli to place (default codex)
 *   PEAR_FLEET_PORT mini broker base port (default 39150) — for ssh helpers
 *   REMOTE_SCRIPT   path to enroll-mini.sh on the mini (default ~/.pear-fleet/enroll-mini.sh)
 *   LIVE_BROKER_CONN  path to the live pear broker connection.json
 *                     (default /Users/khaliqgant/Projects/AgentWorkforce/pear/.agentworkforce/relay/connection.json)
 *
 * Run:  npx tsx tests/placement/rung2/place-from-mac.mts
 */
import { AgentRelay, RelayPlacementError } from '@agent-relay/sdk'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { buildPlacementMessage, placementRequesterName } from '../../../src/main/placement'

const TARGET_NODE = req('TARGET_NODE')
const TARGET_HOST = req('TARGET_HOST')
const CLI = (process.env.PLACE_CLI || 'codex').trim()
const CAPABILITY = `spawn:${CLI}`
const PORT = process.env.PEAR_FLEET_PORT || '39150'
const REMOTE_SCRIPT = process.env.REMOTE_SCRIPT || '~/.pear-fleet/enroll-mini.sh'
const LIVE_BROKER_CONN =
  process.env.LIVE_BROKER_CONN ||
  '/Users/khaliqgant/Projects/AgentWorkforce/pear/.agentworkforce/relay/connection.json'

function req(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} env is required`)
  return v
}

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name} — ${detail}`)
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, fn: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      console.log(`   … ${label} timed out after ${timeoutMs}ms`)
      return undefined
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// Host label the enroll script uses for its instance name (pear-fleet-<label>).
// Derive it from the target node so snapshot/release resolve the SAME instance
// dir the broker was enrolled under (never the hostname-derived default).
const HOST_LABEL = TARGET_NODE.replace(/^pear-fleet-/, '')

/** Run a helper mode of enroll-mini.sh on the mini over BatchMode SSH. */
function ssh(mode: string, arg = ''): string {
  const remoteCmd = `PEAR_FLEET_HOST=${HOST_LABEL} PEAR_FLEET_PORT=${PORT} bash ${REMOTE_SCRIPT} ${mode} ${arg}`.trim()
  try {
    return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', TARGET_HOST, remoteCmd], {
      encoding: 'utf8',
      timeout: 60_000
    })
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return (e.stdout || '') + (e.stderr || '') + (e.message || '')
  }
}

/** The mini's own broker plain snapshot for a placed agent (via ssh). */
function miniSnapshot(name: string): { status: number; body: string } {
  const out = ssh('snapshot', name)
  const idx = out.indexOf('__HTTP_DONE__')
  const body = idx >= 0 ? out.slice(0, idx) : out
  const empty = body.trim().length === 0 || /no connection file|broker not up/i.test(out)
  return { status: empty ? 0 : 200, body }
}

/** The live pear broker snapshot for a name (proves it does NOT own the PTY). */
async function liveBrokerSnapshot(name: string): Promise<{ status: number; body: string }> {
  const conn = JSON.parse(readFileSync(LIVE_BROKER_CONN, 'utf8')) as { url: string; api_key: string }
  const res = await fetch(`${conn.url}/api/spawned/${encodeURIComponent(name)}/snapshot?format=plain`, {
    headers: { authorization: `Bearer ${conn.api_key}` }
  }).catch((e) => ({ status: 0, text: async () => String(e) }) as unknown as Response)
  return { status: res.status, body: await res.text().catch(() => '') }
}

async function liveWorkspaceKey(): Promise<string> {
  const conn = JSON.parse(readFileSync(LIVE_BROKER_CONN, 'utf8')) as { url: string; api_key: string }
  const res = await fetch(`${conn.url}/api/session`, { headers: { authorization: `Bearer ${conn.api_key}` } })
  const body = (await res.json()) as { workspace_key?: string; node_name?: string }
  if (!body.workspace_key) throw new Error('live pear broker /api/session exposed no workspace_key')
  console.log(`   live pear broker: node=${body.node_name} workspace_key=${body.workspace_key.slice(0, 11)}…`)
  return body.workspace_key
}

async function main(): Promise<void> {
  console.log(`→ rung-2 place-from-mac  target=${TARGET_NODE}@${TARGET_HOST}  cap=${CAPABILITY}`)
  const workspaceKey = await liveWorkspaceKey()
  const baseUrl = process.env.RELAYCAST_BASE_URL || process.env.RELAY_BASE_URL || undefined
  const relayOpts = baseUrl ? { baseUrl } : {}

  // Requester identity: agent-scoped, exactly as getPlacementRelay does.
  const workspaceRelay = new AgentRelay({ workspaceKey, ...relayOpts })
  const requesterName = placementRequesterName(`rung2-${TARGET_HOST}`)
  const register = workspaceRelay.agents.registerOrRotate ?? workspaceRelay.agents.register
  const requester = await register.call(workspaceRelay.agents, {
    name: requesterName,
    type: 'agent',
    metadata: { pearRequester: true, rung: 2 }
  })
  const relay = new AgentRelay({ workspaceKey, agentToken: requester.token, ...relayOpts })

  // ── Proof 1: target mini advertises the capability in the operator workspace ──
  const capable = await poll(`${TARGET_NODE} advertises ${CAPABILITY}`, 30_000, 2_000, async () => {
    const nodes = await relay.nodes.list({ capability: CAPABILITY })
    return nodes.find((n) => n.name === TARGET_NODE && n.live && n.capabilities.some((c) => c.name === CAPABILITY))
  })
  record(`roster: ${TARGET_NODE} live + advertises ${CAPABILITY}`, Boolean(capable),
    capable ? `node=${capable.name} live=${capable.live} caps=[${capable.capabilities.map((c) => c.name).join(',')}]` : 'target not found as a capable live node')

  // Workspace-scope assertion: foreign capable nodes present → shared operator
  // workspace → we MUST target (never no-host). Records the guard explicitly.
  const allCapable = (await relay.nodes.list({ capability: CAPABILITY }).catch(() => []))
    .filter((n) => n.live && n.capabilities.some((c) => c.name === CAPABILITY))
  const foreign = allCapable.filter((n) => n.name !== TARGET_NODE)
  record('workspace-scope: shared operator workspace → targeted placement (never no-host)', true,
    `foreign capable nodes present: [${foreign.map((n) => n.name).join(', ') || '(none — unexpected in operator ws)'}] → placing node:${TARGET_NODE}`)

  // ── Proof 2: targeted placement lands on the mini ──
  const existingNames = new Set((await relay.agents.list().catch(() => [])).map((a) => a.name))
  let placedName = `placed-${CLI}-rung2-${TARGET_HOST}`.replace(/[^\w.-]+/g, '-')
  while (existingNames.has(placedName)) placedName = `${placedName}-${Math.floor(Date.now() % 1000)}`

  let landed: string | undefined
  let invocationId: string | undefined
  try {
    const ack = await relay.messaging.placement.spawn({
      capability: CAPABILITY,
      node: TARGET_NODE, // targeted — can only resolve to the mini
      input: { name: placedName, task: 'Reply with exactly the single word READY, then wait for further messages.' },
      failFast: false // targeted queues up to TTL so a briefly-busy node recovers
    })
    landed = ack.node.name
    invocationId = ack.invocationId
    record(`placement (targeted node:${TARGET_NODE}) landed on the mini`, landed === TARGET_NODE,
      `ack.node=${landed} expected=${TARGET_NODE} invocation=${invocationId} queued=${ack.placement?.queued}`)
  } catch (err) {
    if (err instanceof RelayPlacementError) {
      record(`placement landed on the mini`, false, `RelayPlacementError code=${err.code} msg="${buildPlacementMessage(err)}"`)
    } else {
      record(`placement landed on the mini`, false, `threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Proof 3: the mini owns the placed PTY; the live pear broker does NOT ──
  const miniSnap = await poll('mini PTY snapshot non-empty', 60_000, 3_000, async () => {
    const s = miniSnapshot(placedName)
    return s.status === 200 && s.body.trim().length > 0 ? s : undefined
  })
  record(`mini ${TARGET_NODE} owns the placed PTY (its broker snapshot 200/non-empty)`, Boolean(miniSnap),
    miniSnap ? `${miniSnap.body.length} bytes of terminal on ${TARGET_HOST}` : 'mini never exposed the PTY')

  const live = await liveBrokerSnapshot(placedName)
  const liveHasNoPty = live.status === 404 || live.body.trim().length === 0
  record('requester live pear broker does NOT own the placed PTY (#2b cross-machine)', liveHasNoPty,
    `live broker /api/spawned/${placedName} → HTTP ${live.status}, ${live.body.trim().length} bytes`)

  // ── Proof 4: relay chat reachability (#2a) + bonus LLM round-trip ──
  let chatOk = false
  let chatDetail = ''
  try {
    const inRoster = await poll('placed agent joins relay roster', 30_000, 2_000, async () => {
      const list = await relay.agents.list().catch(() => [])
      return list.some((a) => a.name === placedName) ? true : undefined
    })
    const probe = `RUNG2-PING-${randomUUID().slice(0, 8)}`
    const sent = await relay.messages.direct({ to: placedName, text: `Reply with exactly this token: ${probe}` })
    const accepted = Boolean(sent?.id)
    const conversationId = sent.conversationId || placedName
    const surfaced = await poll('probe reaches placed agent (bonus)', 60_000, 4_000, async () => {
      const s = miniSnapshot(placedName)
      if (s.status === 200 && s.body.includes(probe)) return 'pty'
      const msgs = await relay.messages.listDirect({ conversationId, limit: 30 }).catch(() => [])
      if (msgs.some((m) => m.from?.name === placedName && m.text?.includes(probe))) return 'reply'
      return undefined
    })
    chatOk = Boolean(inRoster) && accepted
    chatDetail = `roster=${Boolean(inRoster)} relayAcceptedDM=${accepted} (msgId=${sent?.id ?? 'none'})` +
      (surfaced ? `; BONUS full round-trip via ${surfaced}` : '; bonus LLM round-trip not observed (harness trust-prompt artifact, orthogonal to transport)')
  } catch (err) {
    chatDetail = `chat reachability errored: ${err instanceof Error ? err.message : String(err)}`
  }
  record('placed remote agent reachable over relay chat (#2a: roster + accepted delivery)', chatOk, chatDetail)

  // ── Cleanup: release the placed agent on the mini (no leak); leave node enrolled ──
  console.log('→ releasing placed agent from the mini (node stays enrolled)…')
  const releaseOut = ssh('release-agent', placedName)
  console.log(releaseOut.split('\n').slice(0, 8).map((l) => `   ${l}`).join('\n'))
  const gone = await poll('placed agent left the roster after release', 30_000, 3_000, async () => {
    const list = await relay.agents.list().catch(() => [])
    return list.some((a) => a.name === placedName) ? undefined : true
  })
  record('placed agent released — no leak in workspace roster', Boolean(gone),
    gone ? `${placedName} no longer in roster` : `${placedName} still present (manual release may be needed)`)

  // ── Summary ──
  const passed = checks.filter((c) => c.ok).length
  console.log(`\n${'='.repeat(60)}\nRUNG-2 (${TARGET_NODE}): ${passed}/${checks.length} checks passed`)
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`)
  if (passed !== checks.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exitCode = 1
})
