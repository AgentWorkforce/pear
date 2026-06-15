import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkMountStaleness, resolveRelayfileMountBinary } from './relayfile-binary'

const originalRelayfileMountBin = process.env.RELAYFILE_MOUNT_BIN

afterEach(() => {
  if (originalRelayfileMountBin === undefined) {
    delete process.env.RELAYFILE_MOUNT_BIN
  } else {
    process.env.RELAYFILE_MOUNT_BIN = originalRelayfileMountBin
  }
  vi.restoreAllMocks()
})

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'relayfile-binary-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeState(
  dir: string,
  state: { workspaceId?: string; lastReconcileAt?: string; pid?: number },
): Promise<string> {
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify(state), 'utf8')
  return statePath
}

describe('resolveRelayfileMountBinary', () => {
  it('uses RELAYFILE_MOUNT_BIN when it points to an executable file', async () => {
    await withTempDir(async (dir) => {
      const binary = join(dir, 'relayfile-mount')
      await writeFile(binary, '#!/bin/sh\n', 'utf8')
      await chmod(binary, 0o755)
      process.env.RELAYFILE_MOUNT_BIN = binary

      expect(resolveRelayfileMountBinary()).toBe(binary)
    })
  })
})

describe('checkMountStaleness', () => {
  it('leaves missing state non-stale so the caller can decide whether to start', async () => {
    await withTempDir(async (dir) => {
      expect(checkMountStaleness(join(dir, 'missing.json'), 'rw_test')).toEqual({ stale: false })
    })
  })

  it('marks a registered state for another workspace stale', async () => {
    await withTempDir(async (dir) => {
      const statePath = await writeState(dir, {
        workspaceId: 'rw_other',
        lastReconcileAt: new Date().toISOString(),
        pid: process.pid,
      })

      expect(checkMountStaleness(statePath, 'rw_test')).toEqual({
        stale: true,
        reason: 'workspace mismatch: registered=rw_other expected=rw_test',
      })
    })
  })

  it('marks an old reconcile timestamp stale before checking process liveness', async () => {
    await withTempDir(async (dir) => {
      const statePath = await writeState(dir, {
        workspaceId: 'rw_test',
        lastReconcileAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
        pid: process.pid,
      })

      const result = checkMountStaleness(statePath, 'rw_test')
      expect(result.stale).toBe(true)
      expect(result.reason).toMatch(/^last reconcile 16m ago$/u)
      expect(result.pid).toBe(process.pid)
    })
  })

  it('marks a dead mount process stale', async () => {
    await withTempDir(async (dir) => {
      const statePath = await writeState(dir, {
        workspaceId: 'rw_test',
        lastReconcileAt: new Date().toISOString(),
        pid: 12345,
      })
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('not found'), { code: 'ESRCH' })
      })

      expect(checkMountStaleness(statePath, 'rw_test')).toEqual({
        stale: true,
        reason: 'mount process (pid 12345) is not running',
        pid: 12345,
      })
    })
  })

  it('returns non-stale with the mount pid when state is fresh and the process is alive', async () => {
    await withTempDir(async (dir) => {
      const statePath = await writeState(dir, {
        workspaceId: 'rw_test',
        lastReconcileAt: new Date().toISOString(),
        pid: process.pid,
      })

      expect(checkMountStaleness(statePath, 'rw_test')).toEqual({ stale: false, pid: process.pid })
    })
  })
})
