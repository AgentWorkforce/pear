import assert from 'node:assert/strict'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import type { ChangeEvent, Subscription } from '@relayfile/sdk'
import {
  getIntegrationEventTelemetrySnapshot,
  IntegrationEventBridge,
  integrationSubscriptionSummaries,
  localWatchEventPathsForFilename,
  localWatchRootsFor,
  resetIntegrationEventTelemetryForTests
} from '../integration-event-bridge.ts'
import type { ConnectedIntegration } from '../integrations.ts'

type SentMessage = {
  projectId: string
  input: {
    to: string
    text: string
    from?: string
    data?: Record<string, unknown>
    priority?: number
    mode?: 'wait' | 'steer'
  }
}

type SubscribeCall = {
  globs: string[]
  onChange: (event: ChangeEvent) => void
  options?: {
    coalesce?: 'none' | 'fire-once'
    coalesceMs?: number
    pathScope?: string[]
    from?: 'now' | 'legacy'
    onCoalesced?: () => void
    onQueueDepth?: (depth: number) => void
  }
}

function integration(overrides: Partial<ConnectedIntegration> & {
  provider: string
  integrationId: string
  mountPaths: string[]
}): ConnectedIntegration {
  return {
    scope: {},
    connectedAt: '2026-06-04T00:00:00.000Z',
    notifyAgent: true,
    subscribeAgent: true,
    ...overrides
  }
}

function changeEvent(
  path: string,
  provider = path.split('/')[1] || 'github',
  options: string | { digest?: string; occurredAt?: string; origin?: string; revision?: string } = {}
): ChangeEvent {
  const overrides = typeof options === 'string' ? { occurredAt: options } : options
  const slackTs = provider === 'slack'
    ? path.match(/\/(?:messages|replies)\/(\d{10})_(\d+)(?:\/|\.json$)/u)
    : null
  const occurredAt = overrides.occurredAt ?? (slackTs?.[1]
    ? new Date(Number(`${slackTs[1]}.${slackTs[2] || '0'}`) * 1000).toISOString()
    : new Date(Date.now() + 1000).toISOString())
  return {
    id: `evt:${path}`,
    workspace: 'workspace-id',
    type: 'relayfile.changed',
    occurredAt,
    resource: {
      path,
      provider,
      kind: 'record',
      id: path.split('/').pop() || path,
      origin: overrides.origin,
      revision: overrides.revision
    },
    summary: {
      title: path
    },
    digest: overrides.digest,
    origin: overrides.origin,
    expand: async () => ({
      level: 'summary',
      path,
      summary: {
        title: path
      }
    })
  } as ChangeEvent
}

async function withMockedNow<T>(isoTimestamp: string, fn: () => Promise<T>): Promise<T> {
  const originalDateNow = Date.now
  Date.now = () => Date.parse(isoTimestamp)
  try {
    return await fn()
  } finally {
    Date.now = originalDateNow
  }
}

async function waitForDispatcherTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true)
}

function makeHarness(
  agents = ['alice', 'bob'],
  options: {
    failSend?: boolean
    readFileResponse?: (workspaceId: string, path: string) => {
      path: string
      revision: string
      contentType: string
      content: string
      encoding: 'utf-8' | 'base64'
    }
    sendDelayMs?: number
    onSendStart?: (activeSends: number) => void
  } = {}
): {
  bridge: IntegrationEventBridge
  subscribeCalls: SubscribeCall[]
  readFileCalls: Array<{ workspaceId: string; path: string }>
  sent: SentMessage[]
  listAgentsCalls: string[]
  emit(event: ChangeEvent): Promise<void>
} {
  const subscribeCalls: SubscribeCall[] = []
  const readFileCalls: Array<{ workspaceId: string; path: string }> = []
  const sent: SentMessage[] = []
  const listAgentsCalls: string[] = []
  const subscriptions: Subscription[] = []
  let activeSends = 0

  const bridge = new IntegrationEventBridge({
    getWorkspaceHandle: async () => ({
      workspaceId: 'workspace-id',
      localMountWorkspaceId: 'workspace-id',
      client: () => ({
        subscribe(globs, onChange, options) {
          subscribeCalls.push({ globs: [...globs], onChange, options })
          const subscription = { unsubscribe: async () => undefined }
          subscriptions.push(subscription)
          return subscription
        },
        async readFile(workspaceId, path) {
          readFileCalls.push({ workspaceId, path })
          return options.readFileResponse?.(workspaceId, path) ?? {
            path,
            revision: 'rev-1',
            contentType: 'application/json',
            content: JSON.stringify({ provider: 'slack', text: 'targeted Slack context' }),
            encoding: 'utf-8'
          }
        }
      })
    }),
    broker: {
      listAgents: async (projectId) => {
        listAgentsCalls.push(projectId || '')
        return agents.map((name) => ({ name, projectId }))
      },
      sendMessage: async (projectId, input) => {
        activeSends += 1
        options.onSendStart?.(activeSends)
        try {
          if (options.sendDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs))
          }
          if (options.failSend) throw new Error('broker unavailable')
          sent.push({ projectId, input })
        } finally {
          activeSends -= 1
        }
      }
    }
  })

  async function emit(event: ChangeEvent): Promise<void> {
    assert.equal(subscribeCalls.length, 1, 'expected a single relayfile subscription')
    subscribeCalls[0].onChange(event)
    await waitForDispatcherTick()
  }

  return { bridge, subscribeCalls, readFileCalls, sent, listAgentsCalls, emit }
}

beforeEach(() => {
  resetIntegrationEventTelemetryForTests()
  delete process.env.PEAR_INTEGRATION_EVENTS_DEBUG
})

async function waitForSent(harness: { sent: SentMessage[] }, count: number): Promise<void> {
  const deadline = Date.now() + 1_000
  while (harness.sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForDropped(projectId: string, count: number): Promise<void> {
  const deadline = Date.now() + 1_000
  while ((getIntegrationEventTelemetrySnapshot().projects[projectId]?.eventsDropped || 0) < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('integration events route only to the targets for the matching integration path', async () => {
  const harness = makeHarness()

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'github',
      integrationId: 'github-1',
      mountPaths: ['/github/repos'],
      scope: { notifyAgents: ['alice'] }
    }),
    integration({
      provider: 'linear',
      integrationId: 'linear-1',
      mountPaths: ['/linear/issues']
    })
  ])

  assert.deepEqual(harness.subscribeCalls[0].globs, ['/github/repos/**', '/linear/issues/**'])
  assert.deepEqual(harness.subscribeCalls[0].options?.pathScope, ['/github/repos/**', '/linear/issues/**'])
  assert.equal(harness.subscribeCalls[0].options?.from, 'now')

  await harness.emit(changeEvent('/github/repos/acme/widgets.json', 'github'))
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])

  harness.sent.splice(0)
  await harness.emit(changeEvent('/linear/issues/AR-1.json', 'linear'))
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'bob'])
})

test('channel notification targets do not fall back to all project agents', async () => {
  const harness = makeHarness()

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels'],
      scope: { notifyChannels: ['#triage'] }
    })
  ])

  await harness.emit(changeEvent('/slack/channels/general/messages/123.json', 'slack'))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['#triage'])
  assert.deepEqual(harness.listAgentsCalls, [])
})

test('offline notification agents fall back to current project agents', async () => {
  const harness = makeHarness(['alice', 'bob'])

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels'],
      scope: { notifyAgents: ['claude-1'] }
    })
  ])

  await harness.emit(changeEvent('/slack/channels/general/messages/123.json', 'slack'))
  await waitForSent(harness, 2)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'bob'])
  assert.deepEqual(harness.listAgentsCalls, ['project-1'])
})

test('integration events watch selected relayfile mount paths', async () => {
  const harness = makeHarness()
  const slackIntegration = integration({
    provider: 'slack',
    integrationId: 'slack-1',
    mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
    scope: {
      channels: ['C123ABC'],
      resources: [{ id: 'C123ABC', label: '#proj-cloud' }],
      notifyAgents: ['alice']
    }
  })

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [slackIntegration])
  })

  assert.deepEqual(harness.subscribeCalls[0].globs, [
    '/slack/channels/C123ABC__proj-cloud/**',
    '/slack/channels/D*/**',
    '/slack/dms/*/**',
    '/slack/users/*/messages/**'
  ])
  assert.deepEqual(harness.subscribeCalls[0].options?.pathScope, [
    '/slack/channels/C123ABC__proj-cloud/**',
    '/slack/channels/D*/**',
    '/slack/dms/*/**',
    '/slack/users/*/messages/**'
  ])
  assert.equal(harness.subscribeCalls[0].options?.from, 'now')
  assert.deepEqual(integrationSubscriptionSummaries([slackIntegration])[0].watches, [
    '.integrations/slack/channels/C123ABC__proj-cloud/**',
    '.integrations/slack/channels/D*/**',
    '.integrations/slack/dms/*/**',
    '.integrations/slack/users/*/messages/**'
  ])

  const selectedPath = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
  await harness.emit(changeEvent(selectedPath, 'slack'))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC__proj-cloud\/messages\/1780668000_000000\/meta\.json/u)
  assert.match(harness.sent[0].input.text, /Relayfile path: \/slack\/channels\/C123ABC__proj-cloud\/messages\/1780668000_000000\/meta\.json/u)
  assert.match(harness.sent[0].input.text, /Inline context preview:/u)
  assert.match(harness.sent[0].input.text, /targeted Slack context/u)
  assert.equal(harness.sent[0].input.data?.provider, 'slack')
  assert.equal(harness.sent[0].input.data?.resourcePath, selectedPath)
  assert.equal(harness.sent[0].input.data?.resourceId, 'meta.json')
  assert.deepEqual(harness.readFileCalls, [
    {
      workspaceId: 'workspace-id',
      path: selectedPath
    }
  ])
  assert.equal((harness.sent[0].input.data?.contextPreview as { kind?: string } | undefined)?.kind, 'text')
  assert.equal((harness.sent[0].input.data?.contextPreview as { content?: string } | undefined)?.content, undefined)

  harness.sent.splice(0)
  harness.readFileCalls.splice(0)
  await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780668060_000000/meta.json', 'slack'))
  assert.deepEqual(harness.sent, [])

  harness.sent.splice(0)
  await harness.emit(changeEvent('/slack/channels/C999XYZ/messages/1780668120_000000/meta.json', 'slack'))
  assert.deepEqual(harness.sent, [])

  await harness.emit(changeEvent('/slack/channels/D123ABC/messages/1780668180_000000/meta.json', 'slack'))
  await waitForSent(harness, 1)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('stale subscription callbacks after close or resubscribe are ignored', async () => {
  const harness = makeHarness(['alice'])
  const githubIntegration = integration({
    provider: 'github',
    integrationId: 'github-1',
    mountPaths: ['/github/repos'],
    scope: { notifyAgents: ['alice'] }
  })

  await harness.bridge.reconcile('project-1', [githubIntegration])
  const staleOnChange = harness.subscribeCalls[0].onChange

  await harness.bridge.close('project-1')
  staleOnChange(changeEvent('/github/repos/acme/stale-after-close.json', 'github'))
  await waitForDispatcherTick()

  assert.deepEqual(harness.sent, [])
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsReceived, 0)

  await harness.bridge.reconcile('project-1', [githubIntegration])
  assert.equal(harness.subscribeCalls.length, 2)

  staleOnChange(changeEvent('/github/repos/acme/stale-after-resubscribe.json', 'github'))
  harness.subscribeCalls[1].onChange(changeEvent('/github/repos/acme/current.json', 'github'))
  await waitUntil(() => harness.sent.length === 1)

  assert.match(harness.sent[0].input.text, /Relayfile path: \/github\/repos\/acme\/current\.json/u)
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsReceived, 1)
})

test('remote replayed events older than the subscription session are dropped by default', async () => {
  const harness = makeHarness()

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780315200_000000/meta.json',
    'slack',
    '2026-06-01T12:00:00.000Z'
  ))

  assert.deepEqual(harness.sent, [])
  assert.deepEqual(harness.listAgentsCalls, [])
  await waitForDropped('project-1', 1)
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsDropped, 1)
})

test('remote events at or after the subscription session are still injected', async () => {
  const harness = makeHarness()

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
    'slack',
    '2026-06-05T14:00:00.000Z'
  ))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('remote events within replay skew before the subscription session are still injected', async () => {
  const harness = makeHarness()

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780667400_000000/meta.json',
    'slack',
    '2026-06-05T13:50:00.000Z'
  ))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('historical download subscriptions can receive older remote events', async () => {
  const harness = makeHarness()

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        downloadHistoricalData: true,
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780315200_000000/meta.json',
    'slack',
    '2026-06-01T12:00:00.000Z'
  ))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('slack direct message event scope can be disabled', async () => {
  const harness = makeHarness()
  const slackIntegration = integration({
    provider: 'slack',
    integrationId: 'slack-1',
    mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
    scope: {
      channels: ['C123ABC'],
      listenDms: false,
      notifyAgents: ['alice']
    }
  })

  await harness.bridge.reconcile('project-1', [slackIntegration])

  assert.deepEqual(harness.subscribeCalls[0].globs, [
    '/slack/channels/C123ABC__proj-cloud/**'
  ])

  await harness.emit(changeEvent('/slack/channels/D123ABC/messages/1713220126_001100/meta.json', 'slack'))
  assert.deepEqual(harness.sent, [])
})

test('slack backfill and malformed nested message paths are not injected', async () => {
  const harness = makeHarness(['alice'])
  const stalePath = '/slack/channels/C123ABC__proj-cloud/messages/1780017507_077969/meta.json'

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit({
    ...changeEvent(stalePath, 'slack'),
    occurredAt: '2026-06-05T14:14:57.314Z'
  })
  assert.deepEqual(harness.sent, [])
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsDropped, 0)

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668181_544139/slack/channels/C123ABC__proj-cloud/messages/1780668181_544139/meta.json',
    'slack'
  ))
  assert.deepEqual(harness.sent, [])
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsDropped, 0)
})

test('slack context resolves with history off through one targeted remote preview', async () => {
  const harness = makeHarness(['alice'])
  const replyPath = '/slack/channels/C123ABC__proj-cloud/threads/1780667635_192799/replies/1780668181_544139.json'

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        downloadHistoricalData: false,
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit(changeEvent(replyPath, 'slack'))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.match(harness.sent[0].input.text, /Inline context preview:/u)
  assert.match(harness.sent[0].input.text, /targeted Slack context/u)
  assert.equal(harness.sent[0].input.text.match(/Inline context preview:/gu)?.length, 1)
  assert.doesNotMatch(harness.sent[0].input.text, /Slack text:/u)
  assert.deepEqual(harness.readFileCalls, [
    {
      workspaceId: 'workspace-id',
      path: replyPath
    }
  ])
  assert.equal((harness.sent[0].input.data?.contextPreview as { kind?: string } | undefined)?.kind, 'text')
  assert.equal((harness.sent[0].input.data?.contextPreview as { content?: string } | undefined)?.content, undefined)
})

test('integration event targeted context previews skip binary files', async () => {
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => ({
      path,
      revision: 'rev-binary',
      contentType: 'application/octet-stream',
      content: Buffer.from([0, 1, 2, 3]).toString('base64'),
      encoding: 'base64'
    })
  })

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC'],
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780668000_000000/meta.json', 'slack'))
  await waitForSent(harness, 1)

  assert.match(harness.sent[0].input.text, /Context preview skipped: binary content/u)
  assert.equal((harness.sent[0].input.data?.contextPreview as { kind?: string } | undefined)?.kind, 'binary')
})

test('integration event targeted context previews skip files above the injection cap', async () => {
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => ({
      path,
      revision: 'rev-large',
      contentType: 'application/json',
      content: 'x'.repeat(33 * 1024),
      encoding: 'utf-8'
    })
  })

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC'],
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780668000_000000/meta.json', 'slack'))
  await waitForSent(harness, 1)

  assert.match(harness.sent[0].input.text, /exceeds the injection preview cap/u)
  assert.equal((harness.sent[0].input.data?.contextPreview as { kind?: string } | undefined)?.kind, 'too-large')
})

test('integration event targeted context read is skipped for deleted files', async () => {
  const harness = makeHarness(['alice'])

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC'],
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit({
    ...changeEvent('/slack/channels/C123ABC/messages/1780668000_000000/meta.json', 'slack'),
    type: 'file.deleted'
  })
  await waitForSent(harness, 1)

  assert.deepEqual(harness.readFileCalls, [])
  assert.equal(harness.sent[0].input.data?.contextPreview, undefined)
})

test('historical replay allowance is scoped to the matching integration', async () => {
  const harness = makeHarness()

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-history',
        mountPaths: ['/slack/channels'],
        downloadHistoricalData: true,
        scope: { notifyAgents: ['alice'] }
      }),
      integration({
        provider: 'slack',
        integrationId: 'slack-live',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['bob'] }
      })
    ])
  })

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780315200_000000/meta.json',
    'slack',
    '2026-06-01T12:00:00.000Z'
  ))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('local fallback watchers are disabled when historical download is off', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'discovery', 'slack'),
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C123ABC__proj-cloud')
        ]
      })
    ],
    [
      '/slack/channels/D*/**',
      '/slack/channels/C123ABC/**',
      '/slack/channels/C123ABC__proj-cloud/**',
      '/slack/dms/D123ABC/**'
    ]
  )

  assert.deepEqual(roots, [])
})

test('local fallback watchers require historical download even for command roots', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/.outbox'],
        downloadHistoricalData: false,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', '.outbox')
        ]
      })
    ],
    [
      '/slack/.outbox/**'
    ]
  )

  assert.deepEqual(roots, [])
})

test('local fallback watchers reject bare outbox command roots', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/outbox'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'outbox')
        ]
      })
    ],
    [
      '/slack/outbox/**'
    ]
  )

  assert.deepEqual(roots, [])
})

test('local fallback watchers do not watch broad provider history paths', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C123ABC__proj-cloud')
        ]
      })
    ],
    [
      '/slack/channels/C123ABC/**',
      '/slack/channels/C123ABC__proj-cloud/**'
    ]
  )

  assert.deepEqual(roots, [])
})

test('local fallback watchers are limited to bounded command roots when historical download is on', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/.outbox'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', '.outbox')
        ]
      })
    ],
    [
      '/slack/.outbox/**',
      '/slack/channels/C123ABC/**'
    ]
  )

  const byRemoteRoot = new Map(roots.map((root) => [root.remoteRoot, root.localRoot]))

  assert.equal(
    byRemoteRoot.get('/slack/.outbox')?.endsWith(join('workspace-id', 'slack', '.outbox')),
    true
  )
  assert.deepEqual(Array.from(byRemoteRoot.keys()), ['/slack/.outbox'])
})

test('local fallback watchers accept legacy integration command mount paths', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/integrations/slack/.outbox'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', '.outbox')
        ]
      })
    ],
    [
      '/slack/.outbox/**'
    ]
  )

  assert.equal(roots.some((root) => root.remoteRoot === '/slack/.outbox'), true)
})

test('local watcher path construction does not duplicate remote path segments', () => {
  const messageLocalRoot = join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C0AD7UU0J1G', 'messages', '1780019742_971719')
  const messageRemoteRoot = '/slack/channels/C0AD7UU0J1G/messages/1780019742_971719'

  assert.deepEqual(
    localWatchEventPathsForFilename(
      messageLocalRoot,
      messageRemoteRoot,
      '/slack/channels/C0AD7UU0J1G/messages/1780019742_971719/meta.json'
    ),
    {
      localPath: join(messageLocalRoot, 'meta.json'),
      remotePath: '/slack/channels/C0AD7UU0J1G/messages/1780019742_971719/meta.json'
    }
  )

  const messagesLocalRoot = join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C0AD7UU0J1G', 'messages')
  const messagesRemoteRoot = '/slack/channels/C0AD7UU0J1G/messages'

  assert.deepEqual(
    localWatchEventPathsForFilename(
      messagesLocalRoot,
      messagesRemoteRoot,
      'slack/channels/C0AD7UU0J1G/messages/1779632411_869369/meta.json'
    ),
    {
      localPath: join(messagesLocalRoot, '1779632411_869369', 'meta.json'),
      remotePath: '/slack/channels/C0AD7UU0J1G/messages/1779632411_869369/meta.json'
    }
  )
})

test('integration events preserve discovery mount paths', async () => {
  const harness = makeHarness()
  const slackIntegration = integration({
    provider: 'slack',
    integrationId: 'slack-1',
    mountPaths: ['/discovery/slack']
  })

  await harness.bridge.reconcile('project-1', [slackIntegration])

  assert.deepEqual(harness.subscribeCalls[0].globs, [
    '/discovery/slack/**',
    '/slack/channels/D*/**',
    '/slack/dms/*/**',
    '/slack/users/*/messages/**'
  ])
  assert.deepEqual(integrationSubscriptionSummaries([slackIntegration])[0].watches, [
    '.integrations/discovery/slack/**',
    '.integrations/slack/channels/D*/**',
    '.integrations/slack/dms/*/**',
    '.integrations/slack/users/*/messages/**'
  ])

  await harness.emit(changeEvent('/discovery/slack/actions/create-message/.schema.json', 'slack'))
  assert.deepEqual(harness.sent, [])
  assert.deepEqual(harness.listAgentsCalls, [])
})

test('resource alias mount paths inject the same relative event only once', async () => {
  const harness = makeHarness()
  const chatIntegration = integration({
    provider: 'chat',
    integrationId: 'chat-1',
    mountPaths: ['/chat/channels/C123ABC', '/chat/channels/C123ABC__proj-cloud'],
    scope: {
      notifyAgents: ['alice']
    }
  })

  await withMockedNow('2026-06-04T21:10:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [chatIntegration])
  })

  await harness.emit(changeEvent('/chat/channels/C123ABC/threads/1780607825_485189/replies/1780611452_510669.json', 'chat'))
  await harness.emit(changeEvent('/chat/channels/C123ABC__proj-cloud/threads/1780607825_485189/replies/1780611452_510669.json', 'chat'))

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('resource alias mount paths with the same revision inject one logical change only once', async () => {
  const harness = makeHarness()
  const slackIntegration = integration({
    provider: 'slack',
    integrationId: 'slack-1',
    mountPaths: ['/slack/channels/C123ABC', '/slack/channels/C123ABC__proj-cloud'],
    scope: {
      notifyAgents: ['alice']
    }
  })

  await withMockedNow('2026-06-04T21:10:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [slackIntegration])
  })

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC/messages/1780607825_485189/meta.json',
    'slack',
    { revision: 'same-content' }
  ))
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780607825_485189/meta.json',
    'slack',
    { revision: 'same-content' }
  ))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('generic provider agent scope keys are not treated as notification targets', async () => {
  const harness = makeHarness()

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'github',
      integrationId: 'github-1',
      mountPaths: ['/github/repos'],
      scope: {
        agents: ['not-a-notification-target'],
        agentNames: ['also-not-a-notification-target']
      }
    })
  ])

  await harness.emit(changeEvent('/github/repos/acme/widgets.json', 'github'))

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'bob'])
})

test('integration events ignore index, discovery, tmp, dotfile, and local writeback command files', async () => {
  const harness = makeHarness()

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'github',
      integrationId: 'github-1',
      mountPaths: ['/github/repos']
    }),
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels/C123ABC']
    })
  ])

  await harness.emit(changeEvent('/github/repos/_index.json', 'github'))
  await harness.emit(changeEvent('/github/repos/discovery/schema.json', 'github'))
  await harness.emit(changeEvent('/github/repos/acme/widgets/.meta.json.tmp-3507823867', 'github'))
  await harness.emit(changeEvent('/github/repos/acme/widgets/.internal.json', 'github'))
  await harness.emit(changeEvent('/github/repos/draft@alice.json', 'github'))
  await harness.emit(changeEvent('/github/repos/create.json', 'github'))
  await harness.emit(changeEvent('/slack/channels/C123ABC/messages/claude-1-codex-spawned.json', 'slack'))
  await harness.emit(changeEvent('/slack/channels/C123ABC/threads/1780607825_485189/replies/claude-1-issue82-ack.json', 'slack'))
  await harness.emit(changeEvent('/github/repos/.widgets.json.tmp-123', 'github'))

  assert.deepEqual(harness.sent, [])
  assert.deepEqual(harness.listAgentsCalls, [])
})

test('integration events ignore agent-originated Relayfile writes', async () => {
  const harness = makeHarness()

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels/C123ABC'],
      scope: {
        notifyAgents: ['alice']
      }
    })
  ])

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC/messages/1780607825_485189/meta.json',
    'slack',
    { origin: 'agent_write', revision: 'local-write' }
  ))

  assert.deepEqual(harness.sent, [])
  assert.deepEqual(harness.listAgentsCalls, [])
})

test('integration event delivery is quiet by default while counters remain available', async () => {
  const harness = makeHarness(['alice'])
  const debugCalls: unknown[][] = []
  const infoCalls: unknown[][] = []
  const originalDebug = console.debug
  const originalInfo = console.info
  console.debug = (...args: unknown[]) => {
    debugCalls.push(args)
  }
  console.info = (...args: unknown[]) => {
    infoCalls.push(args)
  }

  try {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'github',
        integrationId: 'github-1',
        mountPaths: ['/github/repos'],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    await harness.emit(changeEvent('/github/repos/acme/widgets.json', 'github'))
    await harness.emit(changeEvent('/github/repos/_index.json', 'github'))
    await harness.emit(changeEvent('/github/repos/acme/widgets.json', 'github'))
  } finally {
    console.debug = originalDebug
    console.info = originalInfo
  }

  assert.equal(debugCalls.length, 0)
  assert.equal(infoCalls.length, 0)
  assert.deepEqual(getIntegrationEventTelemetrySnapshot().projects['project-1'], {
    eventsReceived: 3,
    eventsInjected: 1,
    eventsCoalesced: 0,
    eventsDropped: 1,
    queueDepth: 0,
    mountCount: 0
  })
})

test('integration event debug flag enables verbose delivery logs', async () => {
  process.env.PEAR_INTEGRATION_EVENTS_DEBUG = '1'
  const harness = makeHarness(['alice'])
  const debugCalls: unknown[][] = []
  const originalDebug = console.debug
  console.debug = (...args: unknown[]) => {
    debugCalls.push(args)
  }

  try {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'github',
        integrationId: 'github-1',
        mountPaths: ['/github/repos'],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    await harness.emit(changeEvent('/github/repos/acme/widgets.json', 'github'))
  } finally {
    console.debug = originalDebug
  }

  assert.ok(debugCalls.some((call) => call[0] === '[integration-events] received'))
  assert.ok(debugCalls.some((call) => call[0] === '[integration-events] injecting'))
})

test('integration event delivery failures use aggregated warn cadence by default without verbose logs', async () => {
  const harness = makeHarness(['alice'], { failSend: true })
  const debugCalls: unknown[][] = []
  const warnCalls: unknown[][] = []
  const originalDebug = console.debug
  const originalWarn = console.warn
  console.debug = (...args: unknown[]) => {
    debugCalls.push(args)
  }
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }

  try {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'github',
        integrationId: 'github-1',
        mountPaths: ['/github/repos'],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    for (let index = 1; index <= 26; index += 1) {
      await harness.emit(changeEvent(`/github/repos/acme/widgets-${index}.json`, 'github'))
    }
    await waitUntil(() => warnCalls.length === 2)
  } finally {
    console.debug = originalDebug
    console.warn = originalWarn
  }

  assert.equal(debugCalls.length, 0)
  assert.equal(warnCalls.length, 2)
  assert.equal(warnCalls[0][0], '[integration-events] event delivery failed')
  assert.equal(warnCalls[1][0], '[integration-events] event delivery failed')
  assert.deepEqual(warnCalls.map((call) => (call[1] as { occurrences: number }).occurrences), [1, 26])
  assert.deepEqual(
    warnCalls.map((call) => (call[1] as { suppressedSinceLastLog: number }).suppressedSinceLastLog),
    [0, 24]
  )
  assert.deepEqual(getIntegrationEventTelemetrySnapshot().projects['project-1'], {
    eventsReceived: 26,
    eventsInjected: 0,
    eventsCoalesced: 0,
    eventsDropped: 0,
    queueDepth: 0,
    mountCount: 0
  })
})

test('integration event dispatcher compacts large bursts into a bounded summary', async () => {
  const harness = makeHarness(['alice'])

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
      scope: { notifyAgents: ['alice'] }
    })
  ])

  for (let index = 0; index < 1_000; index += 1) {
    harness.subscribeCalls[0].onChange(changeEvent(
      `/slack/channels/C123ABC__proj-cloud/messages/1780607${String(index).padStart(4, '0')}/meta.json`,
      'slack',
      { revision: `rev-${index}` }
    ))
  }

  await waitUntil(
    () => harness.sent.some((message) => /950 Slack messages changed in #proj-cloud/u.test(message.input.text)),
    5_000
  )

  assert.equal(harness.sent.length, 51)
  assert.ok(harness.sent.length < 1_000)
  const summary = harness.sent.find((message) => /Slack messages changed/u.test(message.input.text))
  assert.ok(summary)
  assert.match(summary.input.text, /950 Slack messages changed in #proj-cloud/u)
  assert.equal(summary.input.data?.eventType, 'relayfile.changed.summary')
  assert.deepEqual(getIntegrationEventTelemetrySnapshot().projects['project-1'], {
    eventsReceived: 1_000,
    eventsInjected: 51,
    eventsCoalesced: 950,
    eventsDropped: 0,
    queueDepth: 0,
    mountCount: 0
  })
})

test('integration event dispatcher filters noise before queue admission', async () => {
  const harness = makeHarness(['alice'])

  await withMockedNow('2026-06-05T15:50:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    for (let index = 0; index < 1_000; index += 1) {
      harness.subscribeCalls[0].onChange(changeEvent(
        `/slack/channels/C123ABC__proj-cloud/messages/1780607${String(index).padStart(4, '0')}/.meta.json.tmp-${index}`,
        'slack',
        { revision: `tmp-${index}` }
      ))
    }
    harness.subscribeCalls[0].onChange(changeEvent(
      '/slack/channels/C123ABC__proj-cloud/messages/1780674600_000000/meta.json',
      'slack',
      { revision: 'real-change' }
    ))
  })

  await waitUntil(() => harness.sent.length === 1)

  assert.match(harness.sent[0].input.text, /Relayfile path: \/slack\/channels\/C123ABC__proj-cloud\/messages\/1780674600_000000\/meta\.json/u)
  assert.doesNotMatch(harness.sent[0].input.text, /Slack messages changed/u)
  assert.deepEqual(getIntegrationEventTelemetrySnapshot().projects['project-1'], {
    eventsReceived: 1_001,
    eventsInjected: 1,
    eventsCoalesced: 0,
    eventsDropped: 0,
    queueDepth: 0,
    mountCount: 0
  })
})

test('integration event dispatcher coalesces rapid distinct revisions for the same path', async () => {
  const harness = makeHarness(['alice'])

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'github',
      integrationId: 'github-1',
      mountPaths: ['/github/repos'],
      scope: { notifyAgents: ['alice'] }
    })
  ])

  for (let index = 0; index < 10; index += 1) {
    harness.subscribeCalls[0].onChange(changeEvent(
      '/github/repos/acme/widgets.json',
      'github',
      { revision: `rev-${index}` }
    ))
  }

  await waitUntil(() => harness.sent.length === 1)

  assert.equal(harness.sent[0].input.data?.eventId, 'evt:/github/repos/acme/widgets.json')
  assert.deepEqual(getIntegrationEventTelemetrySnapshot().projects['project-1'], {
    eventsReceived: 10,
    eventsInjected: 1,
    eventsCoalesced: 9,
    eventsDropped: 0,
    queueDepth: 0,
    mountCount: 0
  })
})

test('integration event fanout sends to recipients sequentially', async () => {
  let maxActiveSends = 0
  const harness = makeHarness(
    Array.from({ length: 12 }, (_, index) => `agent-${index}`),
    {
      sendDelayMs: 2,
      onSendStart: (activeSends) => {
        maxActiveSends = Math.max(maxActiveSends, activeSends)
      }
    }
  )

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'linear',
      integrationId: 'linear-1',
      mountPaths: ['/linear/issues']
    })
  ])

  await harness.emit(changeEvent('/linear/issues/AR-1.json', 'linear'))
  await waitUntil(() => harness.sent.length === 12)

  assert.equal(maxActiveSends, 1)
  assert.deepEqual(harness.sent.map((message) => message.input.to), [
    'agent-0',
    'agent-1',
    'agent-10',
    'agent-11',
    'agent-2',
    'agent-3',
    'agent-4',
    'agent-5',
    'agent-6',
    'agent-7',
    'agent-8',
    'agent-9'
  ])
})

test('integration event telemetry records coalescing and queue depth callbacks', async () => {
  const harness = makeHarness(['alice'])

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'github',
      integrationId: 'github-1',
      mountPaths: ['/github/repos'],
      scope: { notifyAgents: ['alice'] }
    })
  ])

  harness.subscribeCalls[0].options?.onCoalesced?.()
  harness.subscribeCalls[0].options?.onQueueDepth?.(7)

  assert.deepEqual(getIntegrationEventTelemetrySnapshot().projects['project-1'], {
    eventsReceived: 0,
    eventsInjected: 0,
    eventsCoalesced: 1,
    eventsDropped: 0,
    queueDepth: 7,
    mountCount: 0
  })
})
