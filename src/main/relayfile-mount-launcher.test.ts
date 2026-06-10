import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  start: vi.fn(async (input: { env: Record<string, string> }) => input)
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/pear-app'),
    isPackaged: false
  }
}))

vi.mock('@relayfile/sdk/mount-launcher', () => ({
  createDefaultMountLauncher: vi.fn(() => ({
    start: mock.start
  }))
}))

import { createPearMountLauncher } from './relayfile-mount-launcher'

describe('createPearMountLauncher', () => {
  let tempDir: string
  let previousRelayfileMountBin: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-mount-launcher-'))
    previousRelayfileMountBin = process.env.RELAYFILE_MOUNT_BIN
    const binaryPath = join(tempDir, 'relayfile-mount')
    await writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env.RELAYFILE_MOUNT_BIN = binaryPath
    mock.start.mockClear()
  })

  afterEach(async () => {
    if (previousRelayfileMountBin === undefined) {
      delete process.env.RELAYFILE_MOUNT_BIN
    } else {
      process.env.RELAYFILE_MOUNT_BIN = previousRelayfileMountBin
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes mount credentials atomically and passes the creds file env', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T14:00:00.000Z'))
    const localDir = join(tempDir, 'mount')
    const launcher = createPearMountLauncher()

    await launcher.start({
      env: {
        RELAYFILE_TOKEN: 'relay_pa_test-token',
        RELAYFILE_LOCAL_DIR: localDir
      },
      readyTimeoutMs: 5_000
    })

    const credsPath = join(localDir, '.relay', 'creds.json')
    expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        RELAYFILE_MOUNT_BIN: process.env.RELAYFILE_MOUNT_BIN,
        RELAYFILE_MOUNT_CREDS_FILE: credsPath
      })
    }))
    await expect(stat(`${credsPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(credsPath, 'utf8'))).toEqual({
      token: 'relay_pa_test-token',
      mintedAt: '2026-06-06T14:00:00.000Z'
    })
    vi.useRealTimers()
  })

  it('does not set a creds file when mount token or local dir is missing', async () => {
    const launcher = createPearMountLauncher()

    await launcher.start({
      env: {
        RELAYFILE_LOCAL_DIR: join(tempDir, 'missing-token')
      },
      readyTimeoutMs: 5_000
    })
    await launcher.start({
      env: {
        RELAYFILE_TOKEN: 'relay_pa_test-token'
      },
      readyTimeoutMs: 5_000
    })

    expect(mock.start).toHaveBeenCalledTimes(2)
    for (const call of mock.start.mock.calls) {
      expect(call[0].env).not.toHaveProperty('RELAYFILE_MOUNT_CREDS_FILE')
      expect(call[0].env).toMatchObject({
        RELAYFILE_MOUNT_BIN: process.env.RELAYFILE_MOUNT_BIN
      })
    }
  })
})
