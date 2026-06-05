import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  overrides: { digest?: string; occurredAt?: string; origin?: string; revision?: string } = {}
): ChangeEvent {
  const slackTs = path.match(/\/(?:messages|replies)\/(\d{10})_(\d+)(?:\/|\.json$)/u)
  const occurredAt = overrides.occurredAt ?? (slackTs?.[1]
    ? new Date(Number(`${slackTs[1]}.${slackTs[2] || '0'}`) * 1000).toISOString()
    : '2026-06-04T00:00:00.000Z')
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

function changeEventWithFullData(
  path: string,
  provider: string,
  data: Record<string, unknown>
): ChangeEvent {
  return {
    ...changeEvent(path, provider),
    expand: async (level = 'summary') => level === 'full'
      ? {
          level,
          path,
          data
        }
      : {
          level,
          path,
          summary: {
            title: path
          }
        }
  } as ChangeEvent
}

function makeHarness(agents = ['alice', 'bob'], options: { failSend?: boolean } = {}): {
  bridge: IntegrationEventBridge
  subscribeCalls: SubscribeCall[]
  sent: SentMessage[]
  listAgentsCalls: string[]
  emit(event: ChangeEvent): Promise<void>
} {
  const subscribeCalls: SubscribeCall[] = []
  const sent: SentMessage[] = []
  const listAgentsCalls: string[] = []
  const subscriptions: Subscription[] = []

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
        }
      })
    }),
    broker: {
      listAgents: async (projectId) => {
        listAgentsCalls.push(projectId || '')
        return agents.map((name) => ({ name, projectId }))
      },
      sendMessage: async (projectId, input) => {
        if (options.failSend) throw new Error('broker unavailable')
        sent.push({ projectId, input })
      }
    }
  })

  async function emit(event: ChangeEvent): Promise<void> {
    assert.equal(subscribeCalls.length, 1, 'expected a single relayfile subscription')
    subscribeCalls[0].onChange(event)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }

  return { bridge, subscribeCalls, sent, listAgentsCalls, emit }
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

  await harness.bridge.reconcile('project-1', [slackIntegration])

  assert.deepEqual(harness.subscribeCalls[0].globs, [
    '/slack/channels/C123ABC/**',
    '/slack/channels/C123ABC__proj-cloud/**',
    '/slack/channels/D*/**',
    '/slack/dms/*/**',
    '/slack/users/*/messages/**'
  ])
  assert.deepEqual(integrationSubscriptionSummaries([slackIntegration])[0].watches, [
    '.integrations/slack/channels/C123ABC/**',
    '.integrations/slack/channels/C123ABC__proj-cloud/**',
    '.integrations/slack/channels/D*/**',
    '.integrations/slack/dms/*/**',
    '.integrations/slack/users/*/messages/**'
  ])

  await harness.emit(changeEvent('/slack/channels/C123ABC__proj-cloud/messages/1713220123_001100/meta.json', 'slack'))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC__proj-cloud\/messages\/1713220123_001100\/meta\.json/u)
  assert.match(harness.sent[0].input.text, /Relayfile path: \/slack\/channels\/C123ABC__proj-cloud\/messages\/1713220123_001100\/meta\.json/u)

  harness.sent.splice(0)
  await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1713220124_001100/meta.json', 'slack'))
  await waitForSent(harness, 1)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])

  harness.sent.splice(0)
  await harness.emit(changeEvent('/slack/channels/C999XYZ/messages/1713220125_001100/meta.json', 'slack'))
  assert.deepEqual(harness.sent, [])

  await harness.emit(changeEvent('/slack/channels/D123ABC/messages/1713220126_001100/meta.json', 'slack'))
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
    '/slack/channels/C123ABC/**',
    '/slack/channels/C123ABC__proj-cloud/**'
  ])

  await harness.emit(changeEvent('/slack/channels/D123ABC/messages/1713220126_001100/meta.json', 'slack'))
  assert.deepEqual(harness.sent, [])
})

test('slack backfill and malformed nested message paths are not injected', async () => {
  const harness = makeHarness(['alice'])
  const workspaceId = 'workspace-id'
  const originalHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'pear-integration-event-'))
  const workspaceRoot = join(tempHome, '.agentworkforce', 'pear', 'relayfile', 'workspaces', workspaceId)
  const stalePath = '/slack/channels/C123ABC__proj-cloud/messages/1780017507_077969/meta.json'
  const staleLocalPath = join(workspaceRoot, ...stalePath.split('/').filter(Boolean))

  try {
    process.env.HOME = tempHome
    await mkdir(join(staleLocalPath, '..'), { recursive: true })
    await writeFile(staleLocalPath, JSON.stringify({
      provider: 'slack',
      objectType: 'message',
      payload: {
        text: 'old synced message',
        channel: 'C123ABC',
        ts: '1780017507.077969'
      }
    }))

    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    await harness.emit({
      ...changeEvent(stalePath, 'slack'),
      occurredAt: '2026-06-05T14:14:57.314Z'
    })
    assert.deepEqual(harness.sent, [])

    await harness.emit(changeEvent(
      '/slack/channels/C123ABC__proj-cloud/messages/1780668181_544139/slack/channels/C123ABC__proj-cloud/messages/1780668181_544139/meta.json',
      'slack'
    ))
    assert.deepEqual(harness.sent, [])
  } finally {
    await harness.bridge.close('project-1')
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('slack thread reply events include local message text in the injected system message', async () => {
  const harness = makeHarness(['alice'])
  const workspaceId = 'workspace-id'
  const originalHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'pear-integration-event-'))

  try {
    process.env.HOME = tempHome
    const replyPath = '/slack/channels/C123ABC__proj-cloud/threads/1780667635_192799/replies/1780668181_544139.json'
    const localPath = join(tempHome, '.agentworkforce', 'pear', 'relayfile', 'workspaces', workspaceId, ...replyPath.split('/').filter(Boolean))
    await mkdir(join(localPath, '..'), { recursive: true })
    await writeFile(localPath, JSON.stringify({
      provider: 'slack',
      objectType: 'thread_reply',
      payload: {
        text: '<@U123> please handle this thread request',
        channel: 'C123ABC',
        thread_ts: '1780667635.192799',
        ts: '1780668181.544139',
        user: 'U456'
      }
    }))

    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    await harness.emit(changeEvent(replyPath, 'slack'))
    await waitForSent(harness, 1)

    assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
    assert.match(harness.sent[0].input.text, /Slack text: <@U123> please handle this thread request/u)
    assert.match(harness.sent[0].input.text, /Slack thread ts: 1780667635\.192799/u)
  } finally {
    await harness.bridge.close('project-1')
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('remote slack events include expanded message text before local mount sync catches up', async () => {
  const harness = makeHarness(['alice'])
  const replyPath = '/slack/channels/C123ABC__proj-cloud/threads/1780667635_192799/replies/1780668181_544139.json'

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
      scope: { notifyAgents: ['alice'] }
    })
  ])

  await harness.emit(changeEventWithFullData(replyPath, 'slack', {
    provider: 'slack',
    objectType: 'thread_reply',
    payload: {
      text: '<@U123> remote stream text',
      channel: 'C123ABC',
      thread_ts: '1780667635.192799',
      ts: '1780668181.544139',
      user: 'U456'
    }
  }))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.match(harness.sent[0].input.text, /Slack text: <@U123> remote stream text/u)
  assert.match(harness.sent[0].input.text, /Slack thread ts: 1780667635\.192799/u)
})

test('slack local event context rejects traversal paths', async () => {
  const harness = makeHarness(['alice'])
  const workspaceId = 'workspace-id'
  const originalHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'pear-integration-event-'))

  try {
    process.env.HOME = tempHome
    const escapedPath = join(tempHome, '.agentworkforce', 'pear', 'relayfile', 'workspaces', 'leak.json')
    await mkdir(join(escapedPath, '..'), { recursive: true })
    await writeFile(escapedPath, JSON.stringify({
      payload: {
        text: 'escaped local file should not be injected',
        _webhook: {
          receivedAt: '2026-06-04T00:00:00.000Z'
        }
      }
    }))

    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    await harness.emit(changeEvent(
      '/slack/channels/C123ABC__proj-cloud/threads/../../../../../leak.json',
      'slack',
      { occurredAt: '2026-06-05T00:00:00.000Z' }
    ))
    await waitForSent(harness, 1)

    assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
    assert.doesNotMatch(harness.sent[0].input.text, /escaped local file should not be injected/u)
  } finally {
    await harness.bridge.close('project-1')
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await rm(tempHome, { recursive: true, force: true })
  }
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

  await harness.bridge.reconcile('project-1', [chatIntegration])

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

  await harness.bridge.reconcile('project-1', [slackIntegration])

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
    eventsDropped: 2,
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
