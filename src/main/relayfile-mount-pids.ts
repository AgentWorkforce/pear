import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from './guards'
import { toErrorMessage } from './errors'

// A persisted registry of relayfile-mount child PIDs this app has spawned.
//
// Mounts run as detached (`background: true`) daemons, so a hard kill of the
// Electron main process — a crash, a `kill -9`, a dev hot-reload — leaves them
// orphaned and reparented to launchd/init. They never get reaped, accumulate
// across restarts (observed: 6 stale relayfile-mount procs outliving their
// parent), and the wedged ones keep spinning CPU. before-quit cleanup only
// covers the graceful path; this registry covers the rest by letting the next
// boot reap any mount PID a prior instance recorded but never stopped.
//
// Safety: we ONLY ever kill a PID we recorded AND that still resolves to a
// relayfile-mount executable (guards against PID reuse), so a user's manually
// `relayfile start`-ed mount — a different process tree — is never touched.

interface MountPidEntry {
  pid: number
  localDir: string
  recordedAt: string
}

function registryPath(): string {
  return join(homedir(), '.agentworkforce', 'pear', 'relayfile', 'mount-pids.json')
}

async function readRegistry(): Promise<MountPidEntry[]> {
  let raw: string
  try {
    raw = await readFile(registryPath(), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.pids)) return []
    return parsed.pids.filter(
      (entry): entry is MountPidEntry =>
        isRecord(entry) && typeof entry.pid === 'number' && typeof entry.localDir === 'string'
    )
  } catch {
    return []
  }
}

async function writeRegistry(entries: MountPidEntry[]): Promise<void> {
  const path = registryPath()
  try {
    await mkdir(join(homedir(), '.agentworkforce', 'pear', 'relayfile'), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify({ pids: entries }), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    console.warn('[relayfile-mount-pids] Failed to persist mount PID registry:', toErrorMessage(error))
  }
}

// True only if the PID is alive AND its executable is a relayfile-mount binary.
// The comm check defends against PID reuse: a recorded PID that has since been
// recycled for an unrelated process must never be killed.
function isLiveRelayfileMount(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'win32') return true
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
    return /relayfile-mount/.test(comm)
  } catch {
    // ps failed / process vanished between the liveness probe and here.
    return false
  }
}

export async function recordMountPid(pid: number | undefined, localDir: string): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return
  const entries = (await readRegistry()).filter((entry) => entry.pid !== pid)
  entries.push({ pid, localDir, recordedAt: new Date().toISOString() })
  await writeRegistry(entries)
}

export async function forgetMountPid(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number') return
  const entries = await readRegistry()
  const next = entries.filter((entry) => entry.pid !== pid)
  if (next.length !== entries.length) await writeRegistry(next)
}

// Kill any recorded mount PID that is still a live relayfile-mount — these are
// orphans from a prior app instance that never shut down cleanly. Returns the
// PIDs actually killed. Resets the registry to only the entries we could not
// verify-and-kill (none, on success).
export async function reapOrphanedMountPids(livePids: ReadonlySet<number>): Promise<number[]> {
  const entries = await readRegistry()
  if (entries.length === 0) return []
  const killed: number[] = []
  for (const entry of entries) {
    // A PID this instance is actively managing is not an orphan.
    if (livePids.has(entry.pid)) continue
    if (!isLiveRelayfileMount(entry.pid)) continue
    try {
      process.kill(entry.pid, 'SIGKILL')
      killed.push(entry.pid)
    } catch (error) {
      console.warn(`[relayfile-mount-pids] Failed to reap orphan mount pid ${entry.pid}:`, toErrorMessage(error))
    }
  }
  // Drop everything we recorded; the live handles re-record their own PIDs as
  // they (re)mount, and a still-live PID we manage is in livePids.
  await writeRegistry(entries.filter((entry) => livePids.has(entry.pid)))
  return killed
}

// Best-effort synchronous SIGKILL of a single PID, used as a backstop after the
// SDK's async stop() so a detached daemon that ignored stop() is still reaped.
export function killMountPid(pid: number | undefined): boolean {
  if (!isLiveRelayfileMount(pid ?? -1)) return false
  try {
    process.kill(pid as number, 'SIGKILL')
    return true
  } catch (error) {
    console.warn(`[relayfile-mount-pids] Failed to kill mount pid ${pid}:`, toErrorMessage(error))
    return false
  }
}
