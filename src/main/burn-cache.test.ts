import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdkMock = vi.hoisted(() => ({
  exportStamps: vi.fn(async () => []),
  sessionCost: vi.fn(async (input: { session: string }) => ({
    totalTokens: 100,
    totalUSD: 0.01,
    turnCount: 1,
    models: [input.session]
  }))
}))

vi.mock('@relayburn/sdk', () => sdkMock)

describe('burn session lookup cache', () => {
  const originalRelayBurnHome = process.env.RELAYBURN_HOME

  beforeEach(() => {
    vi.resetModules()
    sdkMock.exportStamps.mockClear()
    sdkMock.sessionCost.mockClear()
    process.env.RELAYBURN_HOME = join(tmpdir(), `pear-burn-cache-missing-${Date.now()}-${Math.random()}`)
  })

  afterEach(() => {
    if (originalRelayBurnHome === undefined) {
      delete process.env.RELAYBURN_HOME
    } else {
      process.env.RELAYBURN_HOME = originalRelayBurnHome
    }
  })

  it('evicts least recently used session lookups after the max cache size', async () => {
    const { burnManager } = await import('./burn')

    for (let index = 0; index < 500; index += 1) {
      await burnManager.lookupSessions([`session-${index}`])
    }
    expect(sdkMock.sessionCost).toHaveBeenCalledTimes(500)

    await burnManager.lookupSessions(['session-0'])
    expect(sdkMock.sessionCost).toHaveBeenCalledTimes(500)

    await burnManager.lookupSessions(['session-500'])
    expect(sdkMock.sessionCost).toHaveBeenCalledTimes(501)

    await burnManager.lookupSessions(['session-0'])
    expect(sdkMock.sessionCost).toHaveBeenCalledTimes(501)

    await burnManager.lookupSessions(['session-1'])
    expect(sdkMock.sessionCost).toHaveBeenCalledTimes(502)
  })
})
