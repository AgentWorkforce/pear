import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalMirrorMountClient } from './local-mirror-mount-client'

const tempDirs: string[] = []

const tempMirror = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-mirror-'))
  tempDirs.push(dir)
  await mkdir(join(dir, '.relay', 'outbox', 'acked'), { recursive: true })
  await mkdir(join(dir, '.relay', 'outbox', 'pending'), { recursive: true })
  await mkdir(join(dir, '.relay', 'outbox', 'failed'), { recursive: true })
  return dir
}

const writeReadyMetadata = async (
  mirrorDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  await mkdir(join(mirrorDir, '.relay'), { recursive: true })
  await writeFile(join(mirrorDir, '.relay', 'state.json'), JSON.stringify({
    workspaceId: 'rw_test',
    localRoot: mirrorDir,
    status: 'ready',
    lastReconcileAt: new Date().toISOString(),
    states: { stale: false, offline: false, hasPendingWriteback: false },
    outbox: { acked: 0, pending: 0, failed: 0 },
    ...overrides,
  }))
  await writeFile(join(mirrorDir, '.relay', 'mount.pid'), JSON.stringify({
    pid: process.pid,
    workspaceId: 'rw_test',
    localDir: mirrorDir,
  }))
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('LocalMirrorMountClient', () => {
  it('reads payload-wrapped JSON from the mirror filesystem', async () => {
    const mirrorDir = await tempMirror()
    await writeReadyMetadata(mirrorDir)
    await mkdir(join(mirrorDir, 'linear', 'issues'), { recursive: true })
    await writeFile(join(mirrorDir, 'linear', 'issues', 'AR-1.json'), JSON.stringify({
      provider: 'linear',
      objectType: 'issue',
      payload: {
        identifier: 'AR-1',
        title: '[factory-e2e] mirror read',
      },
    }))

    const mount = new LocalMirrorMountClient({ workspaceId: 'rw_test', mirrorDir })

    await expect(mount.readFile('/linear/issues/AR-1.json')).resolves.toMatchObject({
      content: {
        identifier: 'AR-1',
        title: '[factory-e2e] mirror read',
      },
    })
  })

  it('fails closed before writes when the daemon metadata is missing', async () => {
    const mirrorDir = await tempMirror()
    const mount = new LocalMirrorMountClient({ workspaceId: 'rw_test', mirrorDir })

    await expect(mount.writeFile('/linear/issues/AR-1.json', { stateId: 'next' }))
      .rejects.toThrow(/writeback is not ready/)
    await expect(readFile(join(mirrorDir, 'linear', 'issues', 'AR-1.json'), 'utf8'))
      .rejects.toThrow()
  })

  it('fails closed before writes when the daemon pid is stale', async () => {
    const mirrorDir = await tempMirror()
    await writeReadyMetadata(mirrorDir)
    await writeFile(join(mirrorDir, '.relay', 'mount.pid'), JSON.stringify({
      pid: 9_999_999,
      workspaceId: 'rw_test',
      localDir: mirrorDir,
    }))
    const mount = new LocalMirrorMountClient({ workspaceId: 'rw_test', mirrorDir })

    await expect(mount.assertWritebackReady()).rejects.toThrow(/pid .* is not alive/)
    await expect(mount.writeFile('/linear/issues/AR-1.json', { stateId: 'next' }))
      .rejects.toThrow(/pid .* is not alive/)
  })

  it('writes to the local mirror only after writeback readiness passes', async () => {
    const mirrorDir = await tempMirror()
    await writeReadyMetadata(mirrorDir)
    const mount = new LocalMirrorMountClient({ workspaceId: 'rw_test', mirrorDir })

    await mount.writeFile('/linear/issues/AR-1.json', { stateId: 'next' })

    await expect(readFile(join(mirrorDir, 'linear', 'issues', 'AR-1.json'), 'utf8'))
      .resolves.toBe('{"stateId":"next"}')
  })

  it('lists mirror files under a remote prefix', async () => {
    const mirrorDir = await tempMirror()
    await writeReadyMetadata(mirrorDir)
    await mkdir(join(mirrorDir, 'linear', 'issues'), { recursive: true })
    await writeFile(join(mirrorDir, 'linear', 'issues', 'AR-1.json'), '{}')
    await writeFile(join(mirrorDir, 'linear', 'issues', 'AR-2.json'), '{}')

    const mount = new LocalMirrorMountClient({ workspaceId: 'rw_test', mirrorDir })

    await expect(mount.listTree('/linear/issues')).resolves.toEqual([
      '/linear/issues/AR-1.json',
      '/linear/issues/AR-2.json',
    ])
  })

  it('emits subscribed mirror changes after debounce', async () => {
    const mirrorDir = await tempMirror()
    await writeReadyMetadata(mirrorDir)
    const mount = new LocalMirrorMountClient({
      workspaceId: 'rw_test',
      mirrorDir,
      pollIntervalMs: 50,
    })
    const event = new Promise<string>((resolve) => {
      mount.subscribe(['/linear/issues/**'], (change) => resolve(change.resource.path))
    })

    await mkdir(join(mirrorDir, 'linear', 'issues'), { recursive: true })
    await writeFile(join(mirrorDir, 'linear', 'issues', 'AR-1.json'), '{}')

    await expect(event).resolves.toBe('/linear/issues/AR-1.json')
  }, 3_000)

  it('confirms writes only after the mirror outbox records an ack', async () => {
    const mirrorDir = await tempMirror()
    await writeReadyMetadata(mirrorDir)
    const mount = new LocalMirrorMountClient({ workspaceId: 'rw_test', mirrorDir })

    await mount.writeFile('/linear/issues/AR-1.json', { stateId: 'next' })
    await writeFile(join(mirrorDir, '.relay', 'outbox', 'acked', 'op-1.json'), JSON.stringify({
      path: '/linear/issues/AR-1.json',
      status: 'acked',
    }))

    await expect(mount.confirmWrite('/linear/issues/AR-1.json', { timeoutMs: 10 })).resolves.toBe('acked')
  })

  it('does not treat queued mirror writes as acked', async () => {
    const mirrorDir = await tempMirror()
    await writeReadyMetadata(mirrorDir, {
      states: { stale: false, offline: false, hasPendingWriteback: true },
      outbox: { acked: 0, pending: 1, failed: 0 },
      pendingWriteback: 1,
    })
    const mount = new LocalMirrorMountClient({ workspaceId: 'rw_test', mirrorDir })

    await mount.writeFile('/linear/issues/AR-1.json', { stateId: 'next' })
    await writeFile(join(mirrorDir, '.relay', 'outbox', 'pending', 'op-1.json'), JSON.stringify({
      path: '/linear/issues/AR-1.json',
      status: 'queued',
    }))

    await expect(mount.confirmWrite('/linear/issues/AR-1.json', { timeoutMs: 10 })).resolves.toBe('timeout')
  })
})
