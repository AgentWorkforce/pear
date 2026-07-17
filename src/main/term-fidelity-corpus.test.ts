import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  TERM_FIDELITY_CORPUS_DUMP_GAP_MS,
  TERM_FIDELITY_CORPUS_WARN_GAP_MS,
  TermFidelityCorpusDumper
} from './term-fidelity-corpus'
import type { TermFidelityCorpusInput } from '../shared/types/ipc'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pear-term-fidelity-corpus-'))
  temporaryRoots.push(root)
  return root
}

function corpusInput(agentName = 'codex-1'): TermFidelityCorpusInput {
  return {
    projectId: 'project-1',
    agentName,
    cli: 'codex',
    renderer: { rows: 2, cols: 10, text: 'row one\nGARBAGE' },
    broker: { rows: 2, cols: 10, text: 'row one\nrow two' },
    telemetryLines: [
      '[terminal] viewport diverged from broker screen; confirmed after 2 quiet checks'
    ]
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('TermFidelityCorpusDumper', () => {
  it('rejects malformed IPC payloads before accessing nested fields', () => {
    const dumper = new TermFidelityCorpusDumper()
    const options = {
      rootDir: '/tmp/not-used',
      capturePage: async () => Buffer.from('unused'),
      relayVersions: async () => ({})
    }

    expect(() => dumper.dump(null as unknown as TermFidelityCorpusInput, options)).toThrow(
      'input must be an object'
    )
    expect(() => dumper.dump({ agentName: 'a', cli: 'codex' } as TermFidelityCorpusInput, options)).toThrow(
      'renderer grid must be an object'
    )
  })

  it('writes the production bundle layout and exactly one log line', async () => {
    const rootDir = await temporaryRoot()
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const capturePage = vi.fn(async () => screenshot)
    const log = vi.fn()
    const now = Date.parse('2026-07-17T12:34:56.789Z')
    const dumper = new TermFidelityCorpusDumper({ now: () => now, log })

    const result = await dumper.dump(corpusInput(), {
      rootDir,
      capturePage,
      relayVersions: async () => ({
        broker: '10.6.3',
        '@agent-relay/sdk': '^10.6.3'
      })
    })

    expect(result.dumped).toBe(true)
    if (!result.dumped) throw new Error('Expected a corpus dump')
    expect(basename(result.path)).toBe('2026-07-17T12-34-56-789Z')
    expect(await readFile(join(result.path, 'renderer.txt'), 'utf8')).toBe('row one\nGARBAGE')
    expect(await readFile(join(result.path, 'broker.txt'), 'utf8')).toBe('row one\nrow two')
    expect(await readFile(join(result.path, 'screen.png'))).toEqual(screenshot)
    expect(JSON.parse(await readFile(join(result.path, 'meta.json'), 'utf8'))).toEqual({
      capturedAt: '2026-07-17T12:34:56.789Z',
      projectId: 'project-1',
      agentName: 'codex-1',
      cli: 'codex',
      dims: {
        renderer: { rows: 2, cols: 10 },
        broker: { rows: 2, cols: 10 }
      },
      relayVersions: {
        broker: '10.6.3',
        '@agent-relay/sdk': '^10.6.3'
      },
      reconcilerTelemetryLines: corpusInput().telemetryLines
    })
    expect(capturePage).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(result.path))
  })

  it('coalesces concurrent triggers and rate-limits each project + agent for five minutes', async () => {
    const rootDir = await temporaryRoot()
    let currentTime = 1_000_000
    let releaseCapture: ((png: Buffer) => void) | undefined
    const capturePage = vi.fn(
      () => new Promise<Buffer>((resolve) => {
        releaseCapture = resolve
      })
    )
    const log = vi.fn()
    const dumper = new TermFidelityCorpusDumper({ now: () => currentTime, log })
    const options = { rootDir, capturePage, relayVersions: async () => ({}) }

    const first = dumper.dump(corpusInput(), options)
    const duplicate = dumper.dump(corpusInput(), options)
    expect(duplicate).toBe(first)
    expect(capturePage).toHaveBeenCalledTimes(1)
    releaseCapture?.(Buffer.from('png'))
    expect((await first).dumped).toBe(true)
    expect((await duplicate).dumped).toBe(true)

    const limited = await dumper.dump(corpusInput(), options)
    expect(limited).toEqual({ dumped: false, reason: 'rate-limited' })
    expect(capturePage).toHaveBeenCalledTimes(1)

    // A distinct agent has an independent budget.
    const otherAgent = dumper.dump(corpusInput('codex-2'), {
      ...options,
      capturePage: vi.fn(async () => Buffer.from('other'))
    })
    expect((await otherAgent).dumped).toBe(true)

    currentTime += TERM_FIDELITY_CORPUS_DUMP_GAP_MS
    const afterGap = dumper.dump(corpusInput(), {
      ...options,
      capturePage: vi.fn(async () => Buffer.from('after-gap'))
    })
    expect((await afterGap).dumped).toBe(true)
    expect(log).toHaveBeenCalledTimes(3)
  })

  it('degrades capture failures to a rate-limited warning and allows retry', async () => {
    const rootDir = await temporaryRoot()
    let currentTime = 2_000_000
    const warn = vi.fn()
    const dumper = new TermFidelityCorpusDumper({ now: () => currentTime, warn })
    const failingOptions = {
      rootDir,
      capturePage: async (): Promise<Buffer> => {
        throw new Error('capture\nfailed')
      },
      relayVersions: async () => ({})
    }

    expect(await dumper.dump(corpusInput(), failingOptions)).toEqual({
      dumped: false,
      reason: 'failed'
    })
    expect(await dumper.dump(corpusInput(), failingOptions)).toEqual({
      dumped: false,
      reason: 'failed'
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('\nfailed'))

    currentTime += TERM_FIDELITY_CORPUS_WARN_GAP_MS
    expect(await dumper.dump(corpusInput(), failingOptions)).toEqual({
      dumped: false,
      reason: 'failed'
    })
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
