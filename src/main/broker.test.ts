import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    getAppPath: vi.fn(() => process.cwd()),
    isPackaged: false
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

vi.mock('./auth', () => ({
  getAccessToken: vi.fn(async () => null),
  getApiUrl: vi.fn(() => 'https://cloud.example')
}))

vi.mock('./burn', () => ({
  getBurnLedgerHome: vi.fn(() => undefined),
  getPearBurnAgentKey: vi.fn((projectId: string, name: string) => `${projectId}:${name}`)
}))

vi.mock('./burn-spawn-hook', () => ({
  createPearBurnSpawnListener: vi.fn(() => () => undefined),
  stampPearBurnSpawnedAgent: vi.fn(async () => undefined)
}))

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: vi.fn()
}))

import { BrokerManager } from './broker'

describe('BrokerManager spawnAgent CLI preflight', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('validates relative executable paths from the agent cwd', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-broker-'))
    const toolPath = join(tempDir, 'bin', 'tool')
    await mkdir(join(tempDir, 'bin'), { recursive: true })
    await writeFile(toolPath, '#!/bin/sh\nexit 0\n')
    await chmod(toolPath, 0o755)

    const client = {
      listAgents: vi.fn(async () => []),
      spawnPty: vi.fn(async (input) => ({ name: input.name, runtime: 'pty' }))
    }
    const manager = new BrokerManager()
    ;(manager as unknown as {
      sessions: Map<string, unknown>
    }).sessions.set('project-1', {
      projectId: 'project-1',
      client,
      window: undefined,
      unsubEvent: () => undefined,
      cwd: tempDir,
      name: 'project-1',
      channels: [],
      cloudSandboxId: null,
      pearLineage: new Map()
    })

    await expect(manager.spawnAgent('project-1', {
      name: 'local-tool',
      cli: './bin/tool',
      cwd: tempDir
    })).resolves.toEqual({ name: 'local-tool', runtime: 'pty' })

    expect(client.spawnPty).toHaveBeenCalledWith(expect.objectContaining({
      name: 'local-tool',
      cli: './bin/tool',
      cwd: tempDir
    }))
  })
})
