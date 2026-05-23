/**
 * Tests for the Pear burn spawn hook.
 *
 * Uses `node:test` + `node:assert` (zero deps) so it can run without
 * adding a test framework to Pear. Stubs `@relayburn/sdk` via the
 * `loadBurn` option so the test doesn't require the burn binding to be
 * installed in `node_modules`.
 *
 * Run with: `node --import tsx --test src/main/__tests__/burn-spawn-hook.test.ts`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPearBurnSpawnListener } from '../burn-spawn-hook.ts'
import type { BeforeAgentSpawnContext } from '@agent-relay/sdk'

interface BurnCalls {
  writeStamp: Array<{ sessionId: string; enrichment: Record<string, string>; ledgerHome?: string }>
  writePendingStamp: Array<{
    harness: 'claude' | 'codex' | 'opencode'
    cwd: string
    enrichment: Record<string, string>
    spawnerPid?: number
    spawnStartTs?: string
    ledgerHome?: string
  }>
}

function makeBurnStub(): { loadBurn: () => Promise<unknown>; calls: BurnCalls } {
  const calls: BurnCalls = { writeStamp: [], writePendingStamp: [] }
  const burn = {
    writeStamp: async (opts: BurnCalls['writeStamp'][number]) => {
      calls.writeStamp.push(opts)
    },
    writePendingStamp: async (opts: BurnCalls['writePendingStamp'][number]) => {
      calls.writePendingStamp.push(opts)
      return { file: '/tmp/manifest', stamp: opts }
    }
  }
  return {
    loadBurn: async () => burn,
    calls
  }
}

function makeCtx(
  overrides: Partial<BeforeAgentSpawnContext> & { cli?: string; provider?: string } = {}
): BeforeAgentSpawnContext {
  const { cli, provider, ...rest } = overrides
  const baseInput = {
    name: 'agent-test',
    args: [] as string[],
    cwd: '/tmp/proj'
  }
  const input = provider
    ? { ...baseInput, provider }
    : { ...baseInput, cli: cli ?? 'claude' }
  return {
    kind: provider ? 'provider' : 'pty',
    input: input as BeforeAgentSpawnContext['input'],
    spawnerPid: 9999,
    spawnStartTs: '2026-05-21T12:00:00.000Z',
    baseUrl: 'http://broker.test',
    ...rest
  } as BeforeAgentSpawnContext
}

test('Claude branch: returns --session-id patch and calls writeStamp', async () => {
  const stub = makeBurnStub()
  const listener = createPearBurnSpawnListener({ loadBurn: stub.loadBurn })

  const patch = await listener(makeCtx({ cli: 'claude' }))

  assert.ok(patch, 'patch should be returned')
  assert.ok(Array.isArray(patch.args), 'patch.args must be an array')
  assert.equal(patch.args!.length, 2, 'patch.args appends ["--session-id", uuid]')
  assert.equal(patch.args![0], '--session-id')
  assert.match(patch.args![1], /^[0-9a-f-]{36}$/i)

  assert.equal(stub.calls.writeStamp.length, 1, 'writeStamp called once')
  assert.equal(stub.calls.writeStamp[0].sessionId, patch.args![1])
  assert.equal(stub.calls.writeStamp[0].enrichment.spawner, 'pear')
  assert.equal(stub.calls.writeStamp[0].enrichment.spawned_by, 'direct')
  assert.equal(stub.calls.writeStamp[0].enrichment.on_relay, 'true')
  assert.equal(stub.calls.writePendingStamp.length, 0, 'writePendingStamp NOT called for claude')
})

test('Claude branch: spreads existing args before appending --session-id', async () => {
  const stub = makeBurnStub()
  const listener = createPearBurnSpawnListener({ loadBurn: stub.loadBurn })

  const ctx = makeCtx({ cli: 'claude' })
  ;(ctx.input as { args?: string[] }).args = ['--keep-this', '--and-this']
  const patch = await listener(ctx)

  assert.deepEqual(patch?.args?.slice(0, 2), ['--keep-this', '--and-this'])
  assert.equal(patch?.args?.[2], '--session-id')
  assert.match(patch!.args![3], /^[0-9a-f-]{36}$/i)
})

test('Codex branch: calls writePendingStamp with the right harness, no patch returned', async () => {
  const stub = makeBurnStub()
  const listener = createPearBurnSpawnListener({ loadBurn: stub.loadBurn })

  const patch = await listener(makeCtx({ cli: 'codex' }))

  assert.equal(patch, undefined, 'no patch — observe-only for codex')
  assert.equal(stub.calls.writeStamp.length, 0)
  assert.equal(stub.calls.writePendingStamp.length, 1)
  assert.equal(stub.calls.writePendingStamp[0].harness, 'codex')
  assert.equal(stub.calls.writePendingStamp[0].cwd, '/tmp/proj')
  assert.equal(stub.calls.writePendingStamp[0].spawnerPid, 9999)
  assert.equal(stub.calls.writePendingStamp[0].spawnStartTs, '2026-05-21T12:00:00.000Z')
  assert.equal(stub.calls.writePendingStamp[0].enrichment.spawner, 'pear')
})

test('OpenCode branch: calls writePendingStamp with harness=opencode', async () => {
  const stub = makeBurnStub()
  const listener = createPearBurnSpawnListener({ loadBurn: stub.loadBurn })

  const patch = await listener(makeCtx({ cli: 'opencode' }))

  assert.equal(patch, undefined)
  assert.equal(stub.calls.writePendingStamp.length, 1)
  assert.equal(stub.calls.writePendingStamp[0].harness, 'opencode')
})

test('Provider spawn (via SpawnProviderInput): infers harness from provider field', async () => {
  const stub = makeBurnStub()
  const listener = createPearBurnSpawnListener({ loadBurn: stub.loadBurn })

  const patch = await listener(makeCtx({ provider: 'claude' }))

  assert.ok(patch, 'claude provider should get a session-id patch')
  assert.equal(patch?.args?.[0], '--session-id')
  assert.equal(stub.calls.writeStamp.length, 1)
})

test('Dynamic enrich() merges over the static defaults', async () => {
  const stub = makeBurnStub()
  const listener = createPearBurnSpawnListener({
    loadBurn: stub.loadBurn,
    enrich: (ctx) => ({
      relay_team: 'team-x',
      model_requested: ctx.input.model ?? 'unset'
    })
  })

  const ctx = makeCtx({ cli: 'claude' })
  ;(ctx.input as { model?: string; team?: string }).model = 'sonnet'
  await listener(ctx)

  const enrichment = stub.calls.writeStamp[0].enrichment
  assert.equal(enrichment.spawner, 'pear', 'static defaults preserved')
  assert.equal(enrichment.spawned_by, 'direct')
  assert.equal(enrichment.relay_team, 'team-x', 'dynamic merged in')
  assert.equal(enrichment.model_requested, 'sonnet')
})

test('Dynamic enrich() overrides static defaults on conflict', async () => {
  const stub = makeBurnStub()
  const listener = createPearBurnSpawnListener({
    loadBurn: stub.loadBurn,
    enrichment: { spawner: 'pear', spawned_by: 'direct' },
    enrich: () => ({ spawned_by: 'agent' })
  })

  await listener(makeCtx({ cli: 'claude' }))

  assert.equal(stub.calls.writeStamp[0].enrichment.spawned_by, 'agent')
})

test('ledgerHome option threads through to both stamping calls', async () => {
  const stub = makeBurnStub()
  const listenerClaude = createPearBurnSpawnListener({
    loadBurn: stub.loadBurn,
    ledgerHome: '/custom/ledger'
  })

  await listenerClaude(makeCtx({ cli: 'claude' }))
  assert.equal(stub.calls.writeStamp[0].ledgerHome, '/custom/ledger')

  await listenerClaude(makeCtx({ cli: 'codex' }))
  assert.equal(stub.calls.writePendingStamp[0].ledgerHome, '/custom/ledger')
})

test('writeStamp failure does not return a patch — spawn proceeds un-stamped', async () => {
  const listener = createPearBurnSpawnListener({
    loadBurn: async () => ({
      writeStamp: async () => {
        throw new Error('ledger locked')
      },
      writePendingStamp: async () => ({ file: '', stamp: {} })
    })
  })

  const patch = await listener(makeCtx({ cli: 'claude' }))

  assert.equal(patch, undefined, 'no patch should be returned when writeStamp fails')
})

test('When @relayburn/sdk is unavailable, the hook is a silent no-op', async () => {
  const listener = createPearBurnSpawnListener({
    loadBurn: async () => {
      throw new Error('Cannot find module @relayburn/sdk')
    }
  })

  const patch = await listener(makeCtx({ cli: 'claude' }))

  assert.equal(patch, undefined)
})
