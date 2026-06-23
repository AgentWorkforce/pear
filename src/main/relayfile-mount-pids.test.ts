import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockHome = vi.hoisted(() => ({ dir: '' }))
const mockChild = vi.hoisted(() => ({ execFileSync: vi.fn() }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => mockHome.dir }
})

vi.mock('node:child_process', () => ({
  execFileSync: mockChild.execFileSync
}))

import { forgetMountPid, killMountPid, reapOrphanedMountPids, recordMountPid } from './relayfile-mount-pids'

function registryFile(): string {
  return join(mockHome.dir, '.agentworkforce', 'pear', 'relayfile', 'mount-pids.json')
}

async function readPids(): Promise<number[]> {
  const raw = await readFile(registryFile(), 'utf8')
  return (JSON.parse(raw).pids as Array<{ pid: number }>).map((entry) => entry.pid)
}

describe('relayfile-mount-pids', () => {
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    mockHome.dir = await mkdtemp(join(tmpdir(), 'mount-pids-'))
    mockChild.execFileSync.mockReset()
    // Default: any probed pid resolves to a relayfile-mount executable.
    mockChild.execFileSync.mockReturnValue('relayfile-mount\n')
  })

  afterEach(async () => {
    killSpy?.mockRestore()
    await rm(mockHome.dir, { recursive: true, force: true })
  })

  it('records and forgets pids', async () => {
    await recordMountPid(4242, '/local/a')
    await recordMountPid(4243, '/local/b')
    expect((await readPids()).sort()).toEqual([4242, 4243])

    // Re-recording the same pid does not duplicate it.
    await recordMountPid(4242, '/local/a')
    expect((await readPids()).filter((pid) => pid === 4242)).toHaveLength(1)

    await forgetMountPid(4242)
    expect(await readPids()).toEqual([4243])
  })

  it('ignores invalid pids', async () => {
    await recordMountPid(undefined, '/x')
    await recordMountPid(0, '/x')
    await recordMountPid(1, '/x')
    await expect(readFile(registryFile(), 'utf8')).rejects.toThrow()
  })

  it('reaps an orphaned live relayfile-mount and clears the registry', async () => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await recordMountPid(50_000, '/local/a')

    const killed = await reapOrphanedMountPids(new Set())

    expect(killed).toEqual([50_000])
    expect(killSpy).toHaveBeenCalledWith(50_000, 'SIGKILL')
    expect(await readPids()).toEqual([])
  })

  it('does not reap a pid this instance still manages', async () => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await recordMountPid(50_001, '/local/a')

    const killed = await reapOrphanedMountPids(new Set([50_001]))

    expect(killed).toEqual([])
    expect(killSpy).not.toHaveBeenCalledWith(50_001, 'SIGKILL')
    // The still-managed pid is retained for a future reap.
    expect(await readPids()).toEqual([50_001])
  })

  it('does not reap a recycled pid whose executable is not relayfile-mount', async () => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    mockChild.execFileSync.mockReturnValue('some-other-process\n')
    await recordMountPid(50_002, '/local/a')

    const killed = await reapOrphanedMountPids(new Set())

    expect(killed).toEqual([])
    expect(killSpy).not.toHaveBeenCalledWith(50_002, 'SIGKILL')
  })

  it('does not reap a dead pid', async () => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw new Error('ESRCH')
      return true
    })
    await recordMountPid(50_003, '/local/a')

    const killed = await reapOrphanedMountPids(new Set())

    expect(killed).toEqual([])
    expect(killSpy).not.toHaveBeenCalledWith(50_003, 'SIGKILL')
  })

  it('killMountPid kills a live relayfile-mount and ignores a dead pid', async () => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(killMountPid(50_004)).toBe(true)
    expect(killSpy).toHaveBeenCalledWith(50_004, 'SIGKILL')

    killSpy.mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) throw new Error('ESRCH')
      return true
    })
    expect(killMountPid(50_005)).toBe(false)
  })
})
