import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import type { ChangeEvent, Subscription } from '@relayfile/sdk'
import {
  getIntegrationEventTelemetrySnapshot,
  IntegrationEventBridge,
  createWorkspaceScopedEventClient,
  eventPathGlobsForIntegration,
  integrationSubscriptionSummaries,
  integrationRelayFileSyncOptions,
  localWatchEventPathsForFilename,
  localWatchRootsFor,
  relayfileSdkPathFiltersFor,
  resetIntegrationEventTelemetryForTests,
  subscriptionSpecsFor
} from '../integration-event-bridge.ts'
import type { ConnectedIntegration } from '../integrations.ts'

type RelayFileSyncHandlerName = 'event' | 'error' | 'state' | 'open' | 'close' | 'pong'

class FakeRelayFileSync {
  handlers = new Map<RelayFileSyncHandlerName, Set<(payload: unknown) => void>>()
  started = false
  stopped = false

  on(event: RelayFileSyncHandlerName, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set<(payload: unknown) => void>()
    handlers.add(handler)
    this.handlers.set(event, handlers)
    return () => handlers.delete(handler)
  }

  start(): void {
    this.started = true
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  emit(event: RelayFileSyncHandlerName, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
}

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

type PendingInjectedConfirmation = {
  input: SentMessage['input']
  resolve: () => void
  reject: (error: unknown) => void
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

async function waitForPathMissing(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const stats = await stat(path).catch(() => null)
    if (!stats) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(await stat(path).then(() => true).catch(() => false), false)
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
    readFileFailuresBeforeSuccess?: number
    failReadFile?: boolean
    readFileError?: Error
    sendDelayMs?: number
    onSendStart?: (activeSends: number) => void
    waitForDeliveryNeverSettles?: boolean
    waitForInjectedNeverSettles?: boolean
    manualInjectedConfirmations?: boolean
    failInjected?: boolean
    localMountWorkspaceId?: string
  } = {}
): {
  bridge: IntegrationEventBridge
  subscribeCalls: SubscribeCall[]
  readFileCalls: Array<{ workspaceId: string; path: string }>
  sent: SentMessage[]
  listAgentsCalls: string[]
  deliveryConfirmationCalls: SentMessage[]
  injectedConfirmationCalls: SentMessage[]
  pendingInjectedConfirmations: PendingInjectedConfirmation[]
  unsubscribedCount: () => number
  emit(event: ChangeEvent): Promise<void>
} {
  const subscribeCalls: SubscribeCall[] = []
  const readFileCalls: Array<{ workspaceId: string; path: string }> = []
  const sent: SentMessage[] = []
  const listAgentsCalls: string[] = []
  const deliveryConfirmationCalls: SentMessage[] = []
  const injectedConfirmationCalls: SentMessage[] = []
  const pendingInjectedConfirmations: PendingInjectedConfirmation[] = []
  const subscriptions: Subscription[] = []
  let unsubscribedCount = 0
  let activeSends = 0
  let readFileAttempts = 0

  const bridge = new IntegrationEventBridge({
    getWorkspaceHandle: async () => ({
      workspaceId: 'workspace-id',
      localMountWorkspaceId: options.localMountWorkspaceId ?? 'workspace-id',
      client: () => ({
        subscribe(globs, onChange, options) {
          subscribeCalls.push({ globs: [...globs], onChange, options })
          const subscription = { unsubscribe: async () => { unsubscribedCount += 1 } }
          subscriptions.push(subscription)
          return subscription
        },
        async readFile(workspaceId, path) {
          readFileCalls.push({ workspaceId, path })
          readFileAttempts += 1
          if (options.readFileFailuresBeforeSuccess && readFileAttempts <= options.readFileFailuresBeforeSuccess) {
            throw new Error('remote file not ready')
          }
          if (options.readFileError) throw options.readFileError
          if (options.failReadFile) throw new Error('remote file not ready')
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
      },
      sendMessageAndWaitForDelivery: options.waitForDeliveryNeverSettles
        ? async (projectId, input) => {
            deliveryConfirmationCalls.push({ projectId, input })
            await new Promise(() => undefined)
          }
        : undefined,
      sendMessageAndWaitForInjected: async (projectId, input) => {
        injectedConfirmationCalls.push({ projectId, input })
        activeSends += 1
        options.onSendStart?.(activeSends)
        try {
          if (options.sendDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs))
          }
          if (options.failSend) throw new Error('broker unavailable')
          sent.push({ projectId, input })
          if (options.failInjected) throw new Error('delivery injection timed out')
          if (options.manualInjectedConfirmations) {
            await new Promise<void>((resolve, reject) => {
              pendingInjectedConfirmations.push({
                input,
                resolve,
                reject
              })
            })
          }
          if (options.waitForInjectedNeverSettles) {
            await new Promise(() => undefined)
          }
          return { eventId: `evt-${injectedConfirmationCalls.length}`, targets: [input.to] }
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

  return {
    bridge,
    subscribeCalls,
    readFileCalls,
    sent,
    listAgentsCalls,
    deliveryConfirmationCalls,
    injectedConfirmationCalls,
    pendingInjectedConfirmations,
    unsubscribedCount: () => unsubscribedCount,
    emit
  }
}

beforeEach(() => {
  resetIntegrationEventTelemetryForTests()
  delete process.env.PEAR_INTEGRATION_EVENTS_DEBUG
  delete process.env.PEAR_INTEGRATION_EVENT_INJECTED_CONFIRMATION_TIMEOUT_MS
})

test('relayfile sdk path filters broaden partial-segment Slack DM globs', () => {
  assert.deepEqual(relayfileSdkPathFiltersFor([
    '/slack/channels/C123ABC/**',
    '/slack/channels/C123ABC__proj-cloud/**',
    '/slack/channels/D*/**',
    '/slack/dms/*/**',
    '/slack/users/*/messages/**'
  ]), [
    '/slack/channels/*/**',
    '/slack/channels/C123ABC/**',
    '/slack/channels/C123ABC__proj-cloud/**',
    '/slack/dms/*/**',
    '/slack/users/*/messages/**'
  ])
})

test('slack DM watch globs use the user-message model and drop vestigial /slack/dms', () => {
  const slackDm = integration({
    provider: 'slack',
    integrationId: 'slack-1',
    mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
    scope: { listenDms: true }
  })
  const globs = eventPathGlobsForIntegration(slackDm)
  assert.ok(globs.includes('/slack/users/*/messages/**'), 'canonical user-message DM watch present')
  assert.ok(globs.includes('/slack/channels/D*/**'), 'raw-D diagnostic alias retained')
  assert.ok(!globs.includes('/slack/dms/*/**'), 'vestigial /slack/dms watch glob dropped')

  const noDm = integration({
    provider: 'slack',
    integrationId: 'slack-2',
    mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
    scope: { listenDms: false }
  })
  const noDmGlobs = eventPathGlobsForIntegration(noDm)
  assert.ok(!noDmGlobs.includes('/slack/users/*/messages/**'), 'no DM watch when listenDms is off')
  assert.ok(!noDmGlobs.includes('/slack/channels/D*/**'), 'no raw-D diagnostic watch when listenDms is off')
})

test('integration event remote stream keeps a refreshable relayfile token provider', () => {
  const tokenProvider = async () => 'workspace-token'
  const options = integrationRelayFileSyncOptions({
    client: {} as never,
    workspaceId: 'workspace-id',
    baseUrl: 'https://relayfile.example',
    tokenProvider,
    from: 'legacy',
    paths: ['/slack/channels/*/**']
  })

  assert.equal(options.token, tokenProvider)
})

test('integration event remote stream falls back to event feed polling after repeated stream errors', async () => {
  const syncs: FakeRelayFileSync[] = []
  const received: ChangeEvent[] = []
  const getEventsCalls: Array<{ cursor?: string; limit?: number }> = []
  const pollEvent = {
    eventId: 'ws:file.created:/slack/channels/C123/messages/1780735314_000000/meta.json:rev-2:2026-06-06T08:41:00.000Z',
    type: 'file.created',
    path: '/slack/channels/C123/messages/1780735314_000000/meta.json',
    revision: 'rev-2',
    timestamp: '2026-06-06T08:41:00.000Z'
  } as const
  const client = {
    async getEvents(_workspaceId: string, options: { cursor?: string; limit?: number }) {
      getEventsCalls.push({ cursor: options.cursor, limit: options.limit })
      return getEventsCalls.length === 1
        ? { events: [pollEvent], nextCursor: null }
        : { events: [], nextCursor: null }
    },
    async getResourceAtEvent() {
      throw new Error('not used')
    }
  }
  const eventClient = createWorkspaceScopedEventClient(
    client as never,
    'workspace-id',
    async () => 'workspace-token',
    'https://relayfile.example',
    (options) => {
      assert.equal(options.cursor, undefined)
      const sync = new FakeRelayFileSync()
      syncs.push(sync)
      return sync as never
    }
  )

  const subscription = eventClient.subscribe(
    ['/slack/channels/C123/**'],
    (event) => {
      received.push(event)
    },
    { coalesce: 'none', from: 'legacy', pathScope: ['/slack/channels/C123/**'] }
  )

  await waitUntil(() => syncs.length === 1)
  syncs[0].emit('event', {
    eventId: 'ws:file.created:/slack/channels/C123/messages/1780735200_000000/meta.json:rev-1:2026-06-06T08:40:00.000Z',
    type: 'file.created',
    path: '/slack/channels/C123/messages/1780735200_000000/meta.json',
    revision: 'rev-1',
    timestamp: '2026-06-06T08:40:00.000Z'
  })
  await waitUntil(() => received.length === 1)

  for (let index = 0; index < 5; index += 1) {
    syncs[0].emit('error', new Error('websocket reconnect failed'))
  }

  await waitUntil(() => received.length === 2)
  assert.equal(syncs[0].stopped, true)
  assert.deepEqual(getEventsCalls[0], {
    cursor: 'ws:file.created:/slack/channels/C123/messages/1780735200_000000/meta.json:rev-1:2026-06-06T08:40:00.000Z',
    limit: 1000
  })
  assert.equal(received[1].resource.path, '/slack/channels/C123/messages/1780735314_000000/meta.json')

  await subscription.unsubscribe()
})

test('integration event remote stream fallback replays the outage gap and logs non-empty error details', async () => {
  const syncs: FakeRelayFileSync[] = []
  const received: ChangeEvent[] = []
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }

  try {
    const client = {
      async getEvents(_workspaceId: string, options: { cursor?: string; limit?: number }) {
        assert.equal(
          options.cursor,
          'ws:file.created:/slack/channels/C123/messages/1780735200_000000/meta.json:rev-1:2026-06-06T08:40:00.000Z'
        )
        return {
          events: [
            {
              eventId: 'ws:file.created:/slack/channels/C123/messages/1780735250_000000/meta.json:rev-gap-1:2026-06-06T08:40:50.000Z',
              type: 'file.created',
              path: '/slack/channels/C123/messages/1780735250_000000/meta.json',
              revision: 'rev-gap-1',
              timestamp: '2026-06-06T08:40:50.000Z'
            },
            {
              eventId: 'ws:file.created:/slack/channels/C123/messages/1780735314_000000/meta.json:rev-gap-2:2026-06-06T08:41:00.000Z',
              type: 'file.created',
              path: '/slack/channels/C123/messages/1780735314_000000/meta.json',
              revision: 'rev-gap-2',
              timestamp: '2026-06-06T08:41:00.000Z'
            }
          ],
          nextCursor: null
        }
      },
      async getResourceAtEvent() {
        throw new Error('not used')
      }
    }
    const eventClient = createWorkspaceScopedEventClient(
      client as never,
      'workspace-id',
      async () => 'workspace-token',
      'https://relayfile.example',
      () => {
        const sync = new FakeRelayFileSync()
        syncs.push(sync)
        return sync as never
      }
    )

    const subscription = eventClient.subscribe(
      ['/slack/channels/C123/**'],
      (event) => {
        received.push(event)
      },
      { coalesce: 'none', from: 'legacy', pathScope: ['/slack/channels/C123/**'] }
    )

    await waitUntil(() => syncs.length === 1)
    syncs[0].emit('event', {
      eventId: 'ws:file.created:/slack/channels/C123/messages/1780735200_000000/meta.json:rev-1:2026-06-06T08:40:00.000Z',
      type: 'file.created',
      path: '/slack/channels/C123/messages/1780735200_000000/meta.json',
      revision: 'rev-1',
      timestamp: '2026-06-06T08:40:00.000Z'
    })
    await waitUntil(() => received.length === 1)

    for (let index = 0; index < 5; index += 1) {
      syncs[0].emit('error', { type: 'error' })
    }

    await waitUntil(() => received.length === 3)
    assert.deepEqual(received.slice(1).map((event) => event.resource.path), [
      '/slack/channels/C123/messages/1780735250_000000/meta.json',
      '/slack/channels/C123/messages/1780735314_000000/meta.json'
    ])
    const remoteStreamError = warnCalls.find((call) => call[0] === '[integration-events] remote stream error')
    assert.ok(remoteStreamError)
    assert.equal((remoteStreamError[1] as { error?: string }).error, 'type=error')

    await subscription.unsubscribe()
  } finally {
    console.warn = originalWarn
  }
})

async function waitForSent(harness: { sent: SentMessage[] }, count: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (harness.sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(harness.sent.length >= count, true)
}

async function waitForDropped(projectId: string, count: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while ((getIntegrationEventTelemetrySnapshot().projects[projectId]?.eventsDropped || 0) < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal((getIntegrationEventTelemetrySnapshot().projects[projectId]?.eventsDropped || 0) >= count, true)
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
  assert.equal(harness.subscribeCalls[0].options?.from, 'legacy')

  await harness.emit(changeEvent('/github/repos/acme/widgets.json', 'github'))
  await waitForSent(harness, 1)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])

  harness.sent.splice(0)
  await harness.emit(changeEvent('/linear/issues/AR-1.json', 'linear'))
  await waitForSent(harness, 2)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'bob'])
})

test('Linear issue predicates filter delivery by project, label, and assignee fields', async () => {
  const issueRecords: Record<string, Record<string, unknown>> = {
    '/linear/issues/PEAR-145.json': {
      id: 'lin-pear-145',
      identifier: 'PEAR-145',
      projectId: 'project-control-center',
      project: { id: 'project-control-center', name: 'Issue Control Center' },
      labelIds: ['label-human', 'label-review'],
      labels: [{ id: 'label-human', name: 'human' }],
      assigneeId: 'agent-implementer',
      assignee: { id: 'agent-implementer', name: 'implementer', email: 'implementer@agents.local' }
    },
    '/linear/issues/PEAR-149.json': {
      id: 'lin-pear-149',
      identifier: 'PEAR-149',
      projectId: 'project-control-center',
      project: { id: 'project-control-center', name: 'Issue Control Center' },
      labelIds: ['label-human'],
      labels: [{ id: 'label-human', name: 'human' }],
      assigneeId: 'agent-claude-1',
      assignee: { id: 'agent-claude-1', name: 'claude-1', email: 'claude-1@agents.local' }
    }
  }
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => ({
      path,
      revision: 'rev-1',
      contentType: 'application/json',
      content: JSON.stringify(issueRecords[path] ?? {}),
      encoding: 'utf-8'
    })
  })

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'linear',
      integrationId: 'linear-1',
      mountPaths: ['/linear/issues'],
      scope: {
        notifyAgents: ['alice'],
        projects: ['Issue Control Center'],
        labels: ['human'],
        assignees: ['implementer']
      }
    })
  ])

  await harness.emit(changeEvent('/linear/issues/PEAR-145.json', 'linear', { revision: 'rev-1' }))
  await waitForSent(harness, 1)
  assert.equal(harness.sent[0].input.to, 'alice')

  await harness.emit(changeEvent('/linear/issues/PEAR-149.json', 'linear', { revision: 'rev-2' }))
  await waitForDropped('project-1', 1)
  assert.equal(harness.sent.length, 1)
})

test('Linear issue predicates fail closed when the issue record cannot be read', async () => {
  const harness = makeHarness(['alice'], { failReadFile: true })

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'linear',
      integrationId: 'linear-1',
      mountPaths: ['/linear/issues'],
      scope: {
        notifyAgents: ['alice'],
        projects: ['project-control-center']
      }
    })
  ])

  await harness.emit(changeEvent('/linear/issues/PEAR-145.json', 'linear', { revision: 'rev-1' }))
  await waitForDropped('project-1', 1)
  assert.equal(harness.sent.length, 0)
})

test('can close stale project subscriptions while keeping the active project stream', async () => {
  const harness = makeHarness()

  await harness.bridge.reconcile('stale-project', [
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels/C123'],
      scope: { notifyAgents: ['alice'] }
    })
  ])
  await harness.bridge.reconcile('active-project', [
    integration({
      provider: 'slack',
      integrationId: 'slack-1',
      mountPaths: ['/slack/channels/C123'],
      scope: { notifyAgents: ['alice'] }
    })
  ])

  assert.equal(harness.subscribeCalls.length, 2)

  await harness.bridge.closeAllExcept('active-project')
  assert.equal(harness.unsubscribedCount(), 1)

  await harness.bridge.close('active-project')
  assert.equal(harness.unsubscribedCount(), 2)
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
    '/slack/channels/C123ABC/**',
    '/slack/channels/C123ABC__proj-cloud/**'
  ])
  assert.deepEqual(harness.subscribeCalls[0].options?.pathScope, [
    '/slack/channels/C123ABC/**',
    '/slack/channels/C123ABC__proj-cloud/**'
  ])
  assert.equal(harness.subscribeCalls[0].options?.from, 'legacy')
  assert.deepEqual(integrationSubscriptionSummaries([slackIntegration])[0].watches, [
    '.integrations/slack/channels/C123ABC/**',
    '.integrations/slack/channels/C123ABC__proj-cloud/**'
  ])

  const selectedPath = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
  await harness.emit(changeEvent(selectedPath, 'slack'))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.match(harness.sent[0].input.text, /Slack message event/u)
  assert.match(harness.sent[0].input.text, /Location: #proj-cloud/u)
  assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC__proj-cloud\/messages\/1780668000_000000\/meta\.json/u)
  assert.match(harness.sent[0].input.text, /Message:\ntargeted Slack context/u)
  assert.doesNotMatch(harness.sent[0].input.text, /Relayfile path:/u)
  assert.doesNotMatch(harness.sent[0].input.text, /Inline context preview:/u)
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
  const canonicalPath = '/slack/channels/C123ABC/messages/1780668060_000000/meta.json'
  await harness.emit(changeEvent(canonicalPath, 'slack'))
  await waitForSent(harness, 1)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC\/messages\/1780668060_000000\/meta\.json/u)
  assert.deepEqual(harness.readFileCalls, [
    {
      workspaceId: 'workspace-id',
      path: canonicalPath
    }
  ])

  harness.sent.splice(0)
  await harness.emit(changeEvent('/slack/channels/C999XYZ/messages/1780668120_000000/meta.json', 'slack'))
  assert.deepEqual(harness.sent, [])

  await harness.emit(changeEvent('/slack/channels/D123ABC/messages/1780668180_000000/meta.json', 'slack'))
  assert.deepEqual(harness.sent, [])
})

test('slack raw-id and slug alias paths with distinct revisions inject once per logical message', async () => {
  let slackText = 'original Slack message'
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => ({
      path,
      revision: 'rev-context',
      contentType: 'application/json',
      content: JSON.stringify({ provider: 'slack', text: slackText }),
      encoding: 'utf-8'
    })
  })

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

  // Cloud writes the same Slack message to both the raw channel-id tree and
  // the `<id>__<name>` slug tree; each copy is a distinct file with a distinct
  // revision, so revision-based fingerprints can never match across the
  // copies (probe #1: evt_143356 raw / evt_143358 slug both injected).
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:raw-copy-1' }
  ))
  await waitForSent(harness, 1)

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:slug-copy-1' }
  ))
  await waitForDropped('project-1', 1)
  assert.equal(harness.sent.length, 1)

  // A real edit to the same Slack record must not be swallowed by the
  // long-lived retry/alias dedupe window.
  slackText = 'edited Slack message'
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:raw-copy-2' }
  ))
  await waitForSent(harness, 2)
  assert.match(harness.sent[1].input.text, /Message:\nedited Slack message/u)

  slackText = 'original Slack message'
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:slug-copy-replay' }
  ))
  await waitForDropped('project-1', 2)
  assert.equal(harness.sent.length, 2)

  // A different logical message via either alias form still injects.
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668060_000000/meta.json',
    'slack',
    { digest: 'revision:slug-copy-2' }
  ))
  await waitForSent(harness, 3)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'alice', 'alice'])
})

test('slack thread parent materialized under both messages and threads trees injects once', async () => {
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => ({
      path,
      revision: 'rev-context',
      contentType: 'application/json',
      content: JSON.stringify({ provider: 'slack', text: 'thread parent message' }),
      encoding: 'utf-8'
    })
  })

  // Production mounts messages and threads as separate roots, so the dedupe
  // path-tail is identical for both copies — only the logical fingerprint
  // differentiates them.
  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: [
          '/slack/channels/C123ABC__proj-cloud/messages',
          '/slack/channels/C123ABC__proj-cloud/threads'
        ],
        downloadHistoricalData: false,
        scope: { notifyAgents: ['alice'] }
      })
    ])
  })

  // A thread PARENT (thread_ts == parent ts) materializes as BOTH the flat
  // messages/<ts> record and the threads/<ts> root, each a distinct file with a
  // distinct revision. They are one logical message and must inject once.
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:messages-tree' }
  ))
  await waitForSent(harness, 1)

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/threads/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:threads-tree' }
  ))
  await waitForDropped('project-1', 1)
  assert.equal(harness.sent.length, 1)

  // A reply inside that thread is a distinct logical message and still injects.
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/threads/1780668000_000000/replies/1780668060_000000.json',
    'slack',
    { digest: 'revision:reply-1' }
  ))
  await waitForSent(harness, 2)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'alice'])
})

test('slack raw-id and slug alias duplicates suppress when one context read is sparse', async () => {
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => {
      if (path.includes('__proj-cloud')) throw new Error('remote file not ready')
      return {
        path,
        revision: 'rev-context',
        contentType: 'application/json',
        content: JSON.stringify({ provider: 'slack', text: 'readable Slack message' }),
        encoding: 'utf-8'
      }
    }
  })

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

  await harness.emit(changeEvent(
    '/slack/channels/C123ABC/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:raw-copy' }
  ))
  await waitForSent(harness, 1)

  await harness.emit({
    ...changeEvent(
      '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
      'slack',
      { digest: 'revision:slug-copy' }
    ),
    expand: async () => ({
      level: 'full',
      path: '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
      data: {
        path: '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
        deleted: false
      }
    })
  } as ChangeEvent)
  await waitForDropped('project-1', 1, 2_500)

  assert.equal(harness.sent.length, 1)
  assert.match(harness.sent[0].input.text, /Message:\nreadable Slack message/u)
})

test('slack raw-id event resolves context through mounted slug alias', async () => {
  let messageText = 'original Slack message'
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => {
      if (!path.includes('__proj-cloud')) throw new Error('remote file not ready')
      return {
        path,
        revision: 'rev-context',
        contentType: 'application/json',
        content: JSON.stringify({ provider: 'slack', text: messageText }),
        encoding: 'utf-8'
      }
    }
  })

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

  // Raw-id copy first: the raw targeted read fails, then the bridge retries the
  // selected mounted slug alias so the injection has usable context.
  await harness.emit({
    ...changeEvent(
      '/slack/channels/C123ABC/messages/1780668000_000000/meta.json',
      'slack',
      { digest: 'revision:raw-copy' }
    ),
    expand: async () => ({
      level: 'full',
      path: '/slack/channels/C123ABC/messages/1780668000_000000/meta.json',
      data: {
        path: '/slack/channels/C123ABC/messages/1780668000_000000/meta.json',
        deleted: false
      }
    })
  } as ChangeEvent)
  await waitForSent(harness, 1, 2_500)
  assert.equal(harness.sent.length, 1)
  assert.match(harness.sent[0].input.text, /Message:\noriginal Slack message/u)
  assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC__proj-cloud\/messages\/1780668000_000000\/meta\.json/u)
  assert.deepEqual(harness.readFileCalls.slice(0, 2), [
    {
      workspaceId: 'workspace-id',
      path: '/slack/channels/C123ABC/messages/1780668000_000000/meta.json'
    },
    {
      workspaceId: 'workspace-id',
      path: '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
    }
  ])

  // The slug alias copy of the same record is now a duplicate of the
  // content-bearing raw delivery.
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:slug-copy' }
  ))
  await waitForDropped('project-1', 1, 2_500)
  assert.equal(harness.sent.length, 1)

  // A genuine edit changes the content hash and must inject again.
  messageText = 'edited Slack message'
  await harness.emit(changeEvent(
    '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json',
    'slack',
    { digest: 'revision:slug-edit' }
  ))
  await waitForSent(harness, 2)
  assert.equal(harness.sent.length, 2)
  assert.match(harness.sent[1].input.text, /Message:\nedited Slack message/u)
})

test('slack raw-id event falls back to matched local suffixed mount when remote read misses', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pear-slack-local-context-'))
  const localRoot = join(tempRoot, 'workspace-id', 'slack', 'channels', 'C123ABC__proj-cloud')
  const remotePath = '/slack/channels/C123ABC/messages/1780668000_000000/meta.json'
  const localRemotePath = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'

  try {
    await mkdir(join(localRoot, 'messages', '1780668000_000000'), { recursive: true })
    await writeFile(
      join(localRoot, 'messages', '1780668000_000000', 'meta.json'),
      JSON.stringify({ provider: 'slack', text: 'local mounted Slack message' })
    )
    const harness = makeHarness(['alice'], {
      failReadFile: true
    })

    await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
      await harness.bridge.reconcile('project-1', [
        integration({
          provider: 'slack',
          integrationId: 'slack-1',
          mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
          localMountPaths: [localRoot],
          downloadHistoricalData: false,
          scope: { notifyAgents: ['alice'] }
        })
      ])
    })

    await harness.emit({
      ...changeEvent(
        remotePath,
        'slack',
        { digest: 'revision:raw-copy' }
      ),
      expand: async () => ({
        level: 'full',
        path: remotePath,
        data: {
          path: remotePath,
          deleted: false
        }
      })
    } as ChangeEvent)
    await waitForSent(harness, 1, 2_500)

    assert.match(harness.sent[0].input.text, /Message:\nlocal mounted Slack message/u)
    assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC__proj-cloud\/messages\/1780668000_000000\/meta\.json/u)
    assert.equal(harness.sent[0].input.data?.path, localRemotePath)
    assert.deepEqual(
      (harness.sent[0].input.data?.resource as { path?: string } | undefined)?.path,
      localRemotePath
    )
    assert.equal((harness.sent[0].input.data?.contextPreview as { path?: string } | undefined)?.path, localRemotePath)
    assert.deepEqual(harness.readFileCalls.slice(0, 2), [
      {
        workspaceId: 'workspace-id',
        path: remotePath
      },
      {
        workspaceId: 'workspace-id',
        path: localRemotePath
      }
    ])

    await harness.emit(changeEvent(
      localRemotePath,
      'slack',
      { digest: 'revision:slug-copy' }
    ))
    await waitForDropped('project-1', 1, 2_500)

    assert.equal(harness.sent.length, 1)
    assert.deepEqual(harness.readFileCalls.slice(8, 10), [
      {
        workspaceId: 'workspace-id',
        path: localRemotePath
      },
      {
        workspaceId: 'workspace-id',
        path: remotePath
      }
    ])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('slack local context fallback rejects traversal outside matched mount root', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pear-slack-local-traversal-'))
  const localRoot = join(tempRoot, 'workspace-id', 'slack', 'channels', 'C123ABC__proj-cloud')
  const escapedRoot = join(tempRoot, 'workspace-id', 'slack', 'leaked')
  const remotePath = '/slack/channels/C123ABC/messages/1780668000_000000/../../../../leaked/meta.json'
  const localRemotePath = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/../../../../leaked/meta.json'

  try {
    await mkdir(escapedRoot, { recursive: true })
    await writeFile(
      join(escapedRoot, 'meta.json'),
      JSON.stringify({ provider: 'slack', text: 'escaped Slack message' })
    )
    const harness = makeHarness(['alice'], {
      failReadFile: true
    })

    await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
      await harness.bridge.reconcile('project-1', [
        integration({
          provider: 'slack',
          integrationId: 'slack-1',
          mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
          localMountPaths: [localRoot],
          downloadHistoricalData: false,
          scope: { notifyAgents: ['alice'] }
        })
      ])
    })

    await harness.emit({
      ...changeEvent(
        remotePath,
        'slack',
        { digest: 'revision:traversal-copy' }
      ),
      expand: async () => ({
        level: 'full',
        path: remotePath,
        data: {
          path: remotePath,
          deleted: false
        }
      })
    } as ChangeEvent)
    await waitForSent(harness, 1, 2_500)

    assert.doesNotMatch(harness.sent[0].input.text, /escaped Slack message/u)
    assert.match(harness.sent[0].input.text, /Message: unavailable/u)
    assert.equal(harness.sent[0].input.data?.contextPreview, undefined)
    assert.deepEqual(harness.readFileCalls.slice(0, 2), [
      {
        workspaceId: 'workspace-id',
        path: remotePath
      },
      {
        workspaceId: 'workspace-id',
        path: localRemotePath
      }
    ])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('slack unchanged-content replay re-drives after injected delivery is not confirmed', async () => {
  const options = { failInjected: true }
  const harness = makeHarness(['alice'], options)
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }

  try {
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

    const path = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
    await harness.emit(changeEvent(path, 'slack'))
    await waitForSent(harness, 1)
    await waitUntil(() => warnCalls.some((call) => call[0] === '[integration-events] delivery injected confirmation failed'))

    options.failInjected = false
    await harness.emit(changeEvent(path, 'slack'))
    await waitForSent(harness, 2)
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'alice'])
})

test('content-present slack replay waits for hung injected delivery then re-drives after timeout release', async () => {
  process.env.PEAR_INTEGRATION_EVENT_INJECTED_CONFIRMATION_TIMEOUT_MS = '20'
  const options = { waitForInjectedNeverSettles: true }
  const harness = makeHarness(['slack-comms'], options)
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }

  try {
    await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
      await harness.bridge.reconcile('project-1', [
        integration({
          provider: 'slack',
          integrationId: 'slack-1',
          mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
          scope: { notifyAgents: ['slack-comms'] }
        })
      ])
    })

    const path = '/slack/channels/C123ABC__proj-cloud/threads/1780893336_601259/replies/1780893336_601259.json'
    await harness.emit(changeEvent(path, 'slack'))
    await waitForSent(harness, 1)

    // A replay of the same human message arrives while the original steer has
    // been accepted but has not produced delivery_injected. It must not be
    // finalized as a duplicate skip; after timeout releases the provisional
    // claim, this replay re-drives delivery.
    options.waitForInjectedNeverSettles = false
    await harness.emit(changeEvent(path, 'slack'))
    await waitForSent(harness, 2, 1_500)
    await waitUntil(() => warnCalls.some((call) => call[0] === '[integration-events] delivery injected confirmation failed'))
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['slack-comms', 'slack-comms'])
  assert.match(harness.sent[0].input.text, /Message:\ntargeted Slack context/u)
  assert.match(harness.sent[1].input.text, /Message:\ntargeted Slack context/u)
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsDropped || 0, 0)
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsInjected, 1)
})

test('slack unchanged-content replay is suppressed after injected delivery commits', async () => {
  const harness = makeHarness(['alice'])

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

  const path = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
  await harness.emit(changeEvent(path, 'slack'))
  await waitForSent(harness, 1)
  await harness.emit(changeEvent(path, 'slack'))
  await waitForDropped('project-1', 1)

  assert.equal(harness.sent.length, 1)
})

test('slack channel targets do not pin unresolved injected-delivery claims', async () => {
  const harness = makeHarness(['alice'])

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyChannels: ['#triage'] }
      })
    ])
  })

  const path = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
  await harness.emit(changeEvent(path, 'slack'))
  await waitForSent(harness, 1)
  await harness.emit(changeEvent(path, 'slack'))
  await waitForSent(harness, 2)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['#triage', '#triage'])
  assert.equal(harness.injectedConfirmationCalls.length, 0)
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

test('slack direct message event scope is opt-in', async () => {
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
  assert.match(harness.sent[0].input.text, /Slack message event/u)
  assert.match(harness.sent[0].input.text, /Location: #proj-cloud/u)
  assert.match(harness.sent[0].input.text, /Message:\ntargeted Slack context/u)
  assert.doesNotMatch(harness.sent[0].input.text, /Inline context preview:/u)
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

test('slack context falls back to expanded event data when targeted remote preview is missing', async () => {
  const harness = makeHarness(['alice'], { failReadFile: true })
  const messagePath = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'

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

  await harness.emit({
    ...changeEvent(messagePath, 'slack'),
    expand: async () => ({
      level: 'full',
      path: messagePath,
      data: {
        text: 'expanded Slack context',
        userName: 'Khaliq'
      }
    })
  } as ChangeEvent)
  await waitForSent(harness, 1, 2_500)

  assert.match(harness.sent[0].input.text, /Slack message event/u)
  assert.match(harness.sent[0].input.text, /Author: Khaliq/u)
  assert.match(harness.sent[0].input.text, /Message:\nexpanded Slack context/u)
  assert.equal(harness.readFileCalls.length, 8)
  assert.deepEqual(harness.readFileCalls.slice(0, 2), [
    {
      workspaceId: 'workspace-id',
      path: messagePath
    },
    {
      workspaceId: 'workspace-id',
      path: '/slack/channels/C123ABC/messages/1780668000_000000/meta.json'
    }
  ])
  assert.equal((harness.sent[0].input.data?.contextPreview as { kind?: string } | undefined)?.kind, 'text')
  assert.equal((harness.sent[0].input.data?.contextPreview as { content?: string } | undefined)?.content, undefined)
})

test('slack DM context uses materialized local file when targeted remote preview is missing', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pear-event-preview-'))
  const localRoot = join(workspaceRoot, 'workspace-id', 'slack', 'users', 'U0ADJH4P83T', 'messages')
  const messagePath = '/slack/users/U0ADJH4P83T/messages/1780905125_300069/meta.json'
  await mkdir(join(localRoot, '1780905125_300069'), { recursive: true })
  await writeFile(
    join(localRoot, '1780905125_300069', 'meta.json'),
    JSON.stringify({
      provider: 'slack',
      text: 'local Slack DM context',
      user: 'U123',
      dm_user_id: 'U0ADJH4P83T'
    })
  )

  try {
    const harness = makeHarness(['alice'], { failReadFile: true })

    await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
      await harness.bridge.reconcile('project-1', [
        integration({
          provider: 'slack',
          integrationId: 'slack-1',
          mountPaths: ['/slack/users/U0ADJH4P83T/messages'],
          localMountPaths: [localRoot],
          downloadHistoricalData: false,
          scope: { listenDms: true, notifyAgents: ['alice'] }
        })
      ])
    })

    await harness.emit({
      ...changeEvent(messagePath, 'slack'),
      expand: async () => ({
        level: 'full',
        path: messagePath,
        data: {
          path: messagePath,
          deleted: false
        }
      })
    } as ChangeEvent)
    await waitForSent(harness, 1, 2_500)

    assert.match(harness.sent[0].input.text, /Slack message event/u)
    assert.match(harness.sent[0].input.text, /Location: User U0ADJH4P83T/u)
    assert.match(harness.sent[0].input.text, /Author: U123/u)
    assert.match(harness.sent[0].input.text, /Message:\nlocal Slack DM context/u)
    assert.doesNotMatch(harness.sent[0].input.text, /Message: unavailable/u)
    assert.equal(
      (harness.sent[0].input.data?.contextPreview as { path?: string } | undefined)?.path,
      messagePath
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('slack context retries targeted remote preview before falling back to sparse event data', async () => {
  const harness = makeHarness(['alice'], { readFileFailuresBeforeSuccess: 1 })
  const messagePath = '/slack/channels/D123ABC/messages/1780668000_000000/meta.json'

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        downloadHistoricalData: false,
        scope: { listenDms: true, notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit({
    ...changeEvent(messagePath, 'slack'),
    expand: async () => ({
      level: 'full',
      path: messagePath,
      data: {
        path: messagePath,
        deleted: false
      }
    })
  } as ChangeEvent)
  await waitForSent(harness, 1)

  assert.equal(harness.readFileCalls.length, 2)
  assert.match(harness.sent[0].input.text, /Slack message event/u)
  assert.match(harness.sent[0].input.text, /Message:\ntargeted Slack context/u)
  assert.doesNotMatch(harness.sent[0].input.text, /"deleted": false/u)
})

test('slack context stops targeted remote preview retries on auth failures', async () => {
  const error = new Error('http 403 forbidden') as Error & { status: number }
  error.status = 403
  const harness = makeHarness(['alice'], { readFileError: error })
  const messagePath = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'

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

  await harness.emit({
    ...changeEvent(messagePath, 'slack'),
    expand: async () => ({
      level: 'full',
      path: messagePath,
      data: {
        text: 'expanded Slack context'
      }
    })
  } as ChangeEvent)
  await waitForSent(harness, 1, 2_500)

  assert.deepEqual(harness.readFileCalls, [
    {
      workspaceId: 'workspace-id',
      path: messagePath
    }
  ])
  assert.match(harness.sent[0].input.text, /Message:\nexpanded Slack context/u)
})

test('slack context does not inject sparse relayfile pointer fallback as message content', async () => {
  const harness = makeHarness(['alice'], { failReadFile: true })
  const messagePath = '/slack/channels/D123ABC/messages/1780668000_000000/meta.json'

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        downloadHistoricalData: false,
        scope: { listenDms: true, notifyAgents: ['alice'] }
      })
    ])
  })

  await harness.emit({
    ...changeEvent(messagePath, 'slack'),
    expand: async () => ({
      level: 'full',
      path: messagePath,
      data: {
        path: messagePath,
        deleted: false
      }
    })
  } as ChangeEvent)
  await waitForSent(harness, 1, 2_500)

  assert.match(harness.sent[0].input.text, /Message: unavailable; targeted context read did not return content\./u)
  assert.doesNotMatch(harness.sent[0].input.text, /"path":/u)
  assert.doesNotMatch(harness.sent[0].input.text, /"deleted": false/u)
})

test('slack blind thread-reply delivery does not suppress a later content-bearing replay', async () => {
  let readable = false
  const replyPath = '/slack/channels/C123ABC__proj-cloud/threads/1780871788_370329/replies/1780914176_827829.json'
  const harness = makeHarness(['alice'], {
    readFileResponse: (_workspaceId, path) => {
      if (!readable) throw new Error('remote file not ready')
      return {
        path,
        revision: 'rev-content',
        contentType: 'application/json',
        content: JSON.stringify({ provider: 'slack', text: 'late thread reply content' }),
        encoding: 'utf-8'
      }
    }
  })

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

  await harness.emit({
    ...changeEvent(replyPath, 'slack', { digest: 'revision:blind' }),
    expand: async () => ({
      level: 'full',
      path: replyPath,
      data: {
        path: replyPath,
        deleted: false
      }
    })
  } as ChangeEvent)
  await waitForSent(harness, 1, 2_500)
  assert.match(harness.sent[0].input.text, /Message: unavailable/u)
  await waitUntil(() => (getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsInjected || 0) >= 1)

  readable = true
  await harness.emit(changeEvent(replyPath, 'slack', { digest: 'revision:content' }))
  await waitForSent(harness, 2, 2_500)

  assert.match(harness.sent[1].input.text, /Slack message event/u)
  assert.match(harness.sent[1].input.text, /Message:\nlate thread reply content/u)

  await harness.emit(changeEvent(replyPath, 'slack', { digest: 'revision:content-replay' }))
  await waitForDropped('project-1', 1, 2_500)
  assert.equal(harness.sent.length, 2)
})

test('slack blind commit does not commit an in-flight content-bearing replay hash', async () => {
  let readable = false
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }
  const replyPath = '/slack/channels/C123ABC__proj-cloud/threads/1780871788_370329/replies/1780914176_827829.json'
  const harness = makeHarness(['alice'], {
    manualInjectedConfirmations: true,
    readFileResponse: (_workspaceId, path) => {
      if (!readable) throw new Error('remote file not ready')
      return {
        path,
        revision: 'rev-content',
        contentType: 'application/json',
        content: JSON.stringify({ provider: 'slack', text: 'late thread reply content' }),
        encoding: 'utf-8'
      }
    }
  })

  try {
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

    await harness.emit({
      ...changeEvent(replyPath, 'slack', { digest: 'revision:blind' }),
      expand: async () => ({
        level: 'full',
        path: replyPath,
        data: {
          path: replyPath,
          deleted: false
        }
      })
    } as ChangeEvent)
    await waitForSent(harness, 1, 2_500)

    readable = true
    await harness.emit(changeEvent(replyPath, 'slack', { digest: 'revision:content' }))
    await waitForSent(harness, 2, 2_500)
    assert.equal(harness.pendingInjectedConfirmations.length, 2)

    harness.pendingInjectedConfirmations[0].resolve()
    await waitUntil(() => (getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsInjected || 0) >= 1)
    harness.pendingInjectedConfirmations[1].reject(new Error('content replay was not injected'))
    await waitUntil(() => warnCalls.some((call) => call[0] === '[integration-events] delivery injected confirmation failed'))

    await harness.emit(changeEvent(replyPath, 'slack', { digest: 'revision:content-retry' }))
    await waitForSent(harness, 3, 2_500)
  } finally {
    console.warn = originalWarn
  }

  assert.match(harness.sent[0].input.text, /Message: unavailable/u)
  assert.match(harness.sent[1].input.text, /Message:\nlate thread reply content/u)
  assert.match(harness.sent[2].input.text, /Message:\nlate thread reply content/u)
})

test('slack blind release does not release an in-flight content-bearing replay hash', async () => {
  let readable = false
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }
  const replyPath = '/slack/channels/C123ABC__proj-cloud/threads/1780871788_370329/replies/1780914176_827829.json'
  const harness = makeHarness(['alice'], {
    manualInjectedConfirmations: true,
    readFileResponse: (_workspaceId, path) => {
      if (!readable) throw new Error('remote file not ready')
      return {
        path,
        revision: 'rev-content',
        contentType: 'application/json',
        content: JSON.stringify({ provider: 'slack', text: 'late thread reply content' }),
        encoding: 'utf-8'
      }
    }
  })

  try {
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

    await harness.emit({
      ...changeEvent(replyPath, 'slack', { digest: 'revision:blind' }),
      expand: async () => ({
        level: 'full',
        path: replyPath,
        data: {
          path: replyPath,
          deleted: false
        }
      })
    } as ChangeEvent)
    await waitForSent(harness, 1, 2_500)

    readable = true
    await harness.emit(changeEvent(replyPath, 'slack', { digest: 'revision:content' }))
    await waitForSent(harness, 2, 2_500)
    assert.equal(harness.pendingInjectedConfirmations.length, 2)

    harness.pendingInjectedConfirmations[0].reject(new Error('blind delivery was not injected'))
    await waitUntil(() => warnCalls.some((call) => call[0] === '[integration-events] delivery injected confirmation failed'))

    const duplicateDelivery = harness.emit(changeEvent(replyPath, 'slack', { digest: 'revision:content-duplicate' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(harness.sent.length, 2)

    harness.pendingInjectedConfirmations[1].resolve()
    await duplicateDelivery
    await waitForDropped('project-1', 1, 2_500)
  } finally {
    console.warn = originalWarn
  }

  assert.match(harness.sent[0].input.text, /Message: unavailable/u)
  assert.match(harness.sent[1].input.text, /Message:\nlate thread reply content/u)
  assert.equal(harness.sent.length, 2)
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

  assert.match(harness.sent[0].input.text, /Message: skipped; context preview is binary/u)
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

  assert.match(harness.sent[0].input.text, /Message: skipped; context preview is 33792 bytes/u)
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
        mountPaths: ['/slack/channels/C123ABC/messages'],
        downloadHistoricalData: false,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C123ABC', 'messages')
        ]
      })
    ],
    [
      '/slack/channels/C123ABC/messages/**'
    ]
  )

  assert.deepEqual(roots, [])
})

test('local fallback watchers reject non-canonical command-looking roots', () => {
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

test('local fallback watchers reject command roots with traversal segments', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC/../messages'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C123ABC', '..', 'messages')
        ]
      })
    ],
    [
      '/slack/channels/C123ABC/../messages/**'
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
        mountPaths: ['/slack/channels/C123ABC/messages'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C123ABC', 'messages')
        ]
      })
    ],
    [
      '/slack/channels/C123ABC/messages/**',
      '/slack/channels/C123ABC/**'
    ]
  )

  const byRemoteRoot = new Map(roots.map((root) => [root.remoteRoot, root.localRoot]))

  assert.equal(
    byRemoteRoot.get('/slack/channels/C123ABC/messages')?.endsWith(join('workspace-id', 'slack', 'channels', 'C123ABC', 'messages')),
    true
  )
  assert.deepEqual(Array.from(byRemoteRoot.keys()), ['/slack/channels/C123ABC/messages'])
})

test('local fallback watchers accept legacy integration command mount paths', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/integrations/slack/channels/C123ABC/messages'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'channels', 'C123ABC', 'messages')
        ]
      })
    ],
    [
      '/slack/channels/C123ABC/messages/**'
    ]
  )

  assert.equal(roots.some((root) => root.remoteRoot === '/slack/channels/C123ABC/messages'), true)
})

test('local fallback watchers use the shared Slack users command-root grammar', () => {
  const roots = localWatchRootsFor(
    'workspace-id',
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/users/U123/messages'],
        downloadHistoricalData: true,
        localMountPaths: [
          join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'users', 'U123', 'messages')
        ]
      })
    ],
    [
      '/slack/users/U123/messages/**'
    ]
  )

  assert.equal(
    roots.some((root) =>
      root.remoteRoot === '/slack/users/U123/messages' &&
      root.localRoot === join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'users', 'U123', 'messages')
    ),
    true
  )
})

test('subscription specs include concrete local roots for Slack user message mounts', () => {
  const localRoot = join('/tmp', 'relayfile', 'workspaces', 'workspace-id', 'slack', 'users', 'U123', 'messages')
  const specs = subscriptionSpecsFor(
    [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/users/U123/messages'],
        localMountPaths: [localRoot],
        scope: { listenDms: true }
      })
    ],
    'workspace-id'
  )

  assert.equal(specs.length, 1)
  assert.deepEqual(specs[0].localMountRoots, [
    {
      localRoot,
      remoteRoot: '/slack/users/U123/messages'
    }
  ])
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
    '/discovery/slack/**'
  ])
  assert.deepEqual(integrationSubscriptionSummaries([slackIntegration])[0].watches, [
    '.integrations/discovery/slack/**'
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

test('slack channel aliases without revision inject one logical message only once', async () => {
  const harness = makeHarness()
  const slackIntegration = integration({
    provider: 'slack',
    integrationId: 'slack-1',
    mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
    scope: {
      notifyAgents: ['alice']
    }
  })

  await withMockedNow('2026-06-04T21:10:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [slackIntegration])
  })

  await withMockedNow('2026-06-04T21:10:05.000Z', async () => {
    await harness.emit(changeEvent(
      '/slack/channels/C123ABC/messages/1780607825_485189/meta.json',
      'slack'
    ))
    await waitForSent(harness, 1)
  })

  await withMockedNow('2026-06-04T21:11:05.000Z', async () => {
    await harness.emit(changeEvent(
      '/slack/channels/C123ABC__proj-cloud/messages/1780607825_485189/meta.json',
      'slack'
    ))
    await waitForDispatcherTick()
  })

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.equal(getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsDropped, 1)
})

test('slack self-bot writeback echoes are suppressed without dropping humans or other bots', async () => {
  const localMountWorkspaceId = `pear-self-echo-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`
  const workspaceRoot = join(homedir(), '.agentworkforce', 'pear', 'relayfile', 'workspaces', localMountWorkspaceId)
  const localRoot = join(workspaceRoot, 'slack', 'channels', 'C123ABC', 'messages')
  const localDraftPath = join(localRoot, 'codex-175-self-echo.json')
  const remoteDraftPath = '/slack/channels/C123ABC/messages/codex-175-self-echo.json'
  const outboundText = 'Pear posted this from an agent'
  await mkdir(localRoot, { recursive: true })

  const recordsByPath = new Map<string, Record<string, unknown>>([
    ['/slack/channels/C123ABC/messages/1780668000_000000/meta.json', {
      provider: 'slack',
      payload: {
        user: 'U0B2596R7EZ',
        user_is_bot: true,
        user_name: 'file_by_agent_relay',
        text: outboundText
      }
    }],
    ['/slack/channels/C123ABC/messages/1780668030_000000/meta.json', {
      provider: 'slack',
      payload: {
        user: 'U0B2596R7EZ',
        user_is_bot: true,
        user_name: 'file_by_agent_relay',
        text: 'a later unrelated bot post'
      }
    }],
    ['/slack/channels/C123ABC/messages/1780668060_000000/meta.json', {
      provider: 'slack',
      payload: {
        user: 'U0HUMAN1234',
        user_is_bot: false,
        user_name: 'khaliq',
        text: outboundText
      }
    }],
    ['/slack/channels/C123ABC/messages/1780668120_000000/meta.json', {
      provider: 'slack',
      payload: {
        user: 'U0OTHERBOT1',
        user_is_bot: true,
        user_name: 'coderabbit',
        text: 'different bot message'
      }
    }]
  ])

  let harness: ReturnType<typeof makeHarness> | undefined
  try {
    harness = makeHarness(['alice'], {
      localMountWorkspaceId,
      readFileResponse: (_workspaceId, path) => ({
        path,
        revision: 'rev-1',
        contentType: 'application/json',
        content: JSON.stringify(recordsByPath.get(path) ?? { provider: 'slack', text: 'fallback' }),
        encoding: 'utf-8'
      })
    })
    await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
      await harness!.bridge.reconcile('project-1', [
        integration({
          provider: 'slack',
          integrationId: 'slack-1',
          mountPaths: ['/slack/channels/C123ABC/messages'],
          downloadHistoricalData: false,
          scope: { notifyAgents: ['alice'] }
        })
      ])
    })

    await writeFile(localDraftPath, JSON.stringify({ text: `  ${outboundText}\n` }))
    await waitUntil(() => {
      const recentOutboundWritebacks = (harness!.bridge as unknown as {
        recentOutboundWritebacks?: Map<string, Map<string, number>>
      }).recentOutboundWritebacks
      return (recentOutboundWritebacks?.get('project-1')?.size || 0) > 0
    })

    await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780668000_000000/meta.json', 'slack'))
    await waitUntil(() =>
      (getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsSelfEchoSuppressed || 0) === 1
    )
    assert.deepEqual(harness.sent, [])

    await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780668030_000000/meta.json', 'slack'))
    await waitUntil(() =>
      (getIntegrationEventTelemetrySnapshot().projects['project-1']?.eventsSelfEchoSuppressed || 0) === 2
    )
    assert.deepEqual(harness.sent, [])

    await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780668060_000000/meta.json', 'slack'))
    await waitForSent(harness, 1)
    await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780668120_000000/meta.json', 'slack'))
    await waitForSent(harness, 2)

    assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'alice'])
    assert.match(harness.sent[0].input.text, /Author: khaliq/u)
    assert.match(harness.sent[0].input.text, /Message:\nPear posted this from an agent/u)
    assert.match(harness.sent[1].input.text, /Author: coderabbit/u)
    assert.match(harness.sent[1].input.text, /Message:\ndifferent bot message/u)
    const telemetry = getIntegrationEventTelemetrySnapshot().projects['project-1']
    assert.equal(telemetry?.eventsSelfEchoSuppressed, 2)
    assert.equal(telemetry?.eventsDropped, 0)
  } finally {
    await harness?.bridge.closeAll()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
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
  await waitForSent(harness, 2)

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

test('confirmed Slack writeback success removes the local draft command file', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pear-writeback-cleanup-'))
  const localRoot = join(workspaceRoot, 'workspace-id', 'slack', 'channels', 'C123ABC', 'messages')
  const localDraftPath = join(localRoot, 'reply-confirmed.json')
  const remoteDraftPath = '/slack/channels/C123ABC/messages/reply-confirmed.json'
  await mkdir(localRoot, { recursive: true })
  await writeFile(localDraftPath, JSON.stringify({ text: 'confirmed send' }))

  try {
    const harness = makeHarness(['alice'])
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC/messages'],
        localMountPaths: [localRoot],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    await harness.emit({
      ...changeEvent(remoteDraftPath, 'slack'),
      type: 'writeback.succeeded'
    } as ChangeEvent)
    await waitForPathMissing(localDraftPath)

    assert.deepEqual(harness.sent, [])
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('Slack writeback draft cleanup waits for confirmed dispatch', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pear-writeback-cleanup-'))
  const localRoot = join(workspaceRoot, 'workspace-id', 'slack', 'channels', 'C123ABC', 'messages')
  const localDraftPath = join(localRoot, 'reply-pending.json')
  const remoteDraftPath = '/slack/channels/C123ABC/messages/reply-pending.json'
  await mkdir(localRoot, { recursive: true })
  await writeFile(localDraftPath, JSON.stringify({ text: 'pending send' }))

  try {
    const harness = makeHarness(['alice'])
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC/messages'],
        localMountPaths: [localRoot],
        scope: { notifyAgents: ['alice'] }
      })
    ])

    await harness.emit(changeEvent(remoteDraftPath, 'slack'))
    await waitForDispatcherTick()

    assert.equal(await stat(localDraftPath).then(() => true).catch(() => false), true)
    assert.deepEqual(harness.sent, [])
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('integration events notify nested non-numeric Slack message records', async () => {
  const harness = makeHarness()

  await withMockedNow('2026-06-04T21:20:00.000Z', async () => {
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

    await harness.emit(changeEvent('/slack/channels/C123ABC/messages/1780607825_485189/files/attachment.json', 'slack'))
    await waitForSent(harness, 1)
  })

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.equal(harness.sent[0].input.data?.path, '/slack/channels/C123ABC/messages/1780607825_485189/files/attachment.json')
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
    await waitForSent(harness, 1)
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
    eventsSelfEchoSuppressed: 0,
    brokerSends: 1,
    brokerSendsDeferred: 0,
    queueDepth: 0,
    mountCount: 0,
    brokerSendQueueDepth: 0
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
    await waitForSent(harness, 1)
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
  assert.equal(warnCalls[0][0], '[integration-events] delivery injected confirmation failed')
  assert.equal(warnCalls[1][0], '[integration-events] delivery injected confirmation failed')
  assert.deepEqual(warnCalls.map((call) => (call[1] as { occurrences: number }).occurrences), [1, 26])
  assert.deepEqual(
    warnCalls.map((call) => (call[1] as { suppressedSinceLastLog: number }).suppressedSinceLastLog),
    [0, 24]
  )
  const telemetry = getIntegrationEventTelemetrySnapshot().projects['project-1']
  assert.ok(telemetry)
  assert.equal(telemetry.brokerSendsDeferred >= 0, true)
  assert.deepEqual({ ...telemetry, brokerSendsDeferred: 0 }, {
    eventsReceived: 26,
    eventsInjected: 0,
    eventsCoalesced: 0,
    eventsDropped: 0,
    eventsSelfEchoSuppressed: 0,
    brokerSends: 26,
    brokerSendsDeferred: 0,
    queueDepth: 0,
    mountCount: 0,
    brokerSendQueueDepth: 0
  })
})

test('failed deliveries release the dedupe key so duplicate events retry', async () => {
  const options = { failSend: true }
  const harness = makeHarness(['alice'], options)
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }

  try {
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

    const path = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
    await harness.emit(changeEvent(path, 'slack'))
    await waitUntil(() => warnCalls.some((call) => call[0] === '[integration-events] delivery injected confirmation failed'))
    assert.equal(harness.sent.length, 0)

    // The same logical change arrives again (remote copy of a local mount
    // change). The failed injection must not have pinned the dedupe key.
    options.failSend = false
    await harness.emit(changeEvent(path, 'slack'))
    await waitForSent(harness, 1)
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
})

test('no-recipient drops release the dedupe key so duplicates deliver after an agent registers', async () => {
  const agents: string[] = []
  const harness = makeHarness(agents)
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }

  try {
    await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
      await harness.bridge.reconcile('project-1', [
        integration({
          provider: 'slack',
          integrationId: 'slack-1',
          mountPaths: ['/slack/channels/C123ABC__proj-cloud']
        })
      ])
    })

    const path = '/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json'
    await harness.emit(changeEvent(path, 'slack'))
    await waitForDropped('project-1', 1)
    assert.equal(harness.sent.length, 0)
    assert.ok(warnCalls.some((call) => call[0] === '[integration-events] skipped no recipients'))

    // The configured recipient registers and a duplicate of the event arrives:
    // the earlier no-recipient drop must not suppress delivery.
    agents.push('claude-1')
    harness.bridge.invalidateProjectAgentCache('project-1')
    await harness.emit(changeEvent(path, 'slack'))
    await waitForSent(harness, 1)
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['claude-1'])
})

test('explicit notification agents are used while project roster is still empty', async () => {
  const harness = makeHarness([])

  await withMockedNow('2026-06-05T14:00:00.000Z', async () => {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'slack',
        integrationId: 'slack-1',
        mountPaths: ['/slack/channels/C123ABC__proj-cloud'],
        scope: { notifyAgents: ['claude-1'] }
      })
    ])
  })

  await harness.emit(changeEvent('/slack/channels/C123ABC__proj-cloud/messages/1780668000_000000/meta.json', 'slack'))
  await waitForSent(harness, 1)

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['claude-1'])
  assert.deepEqual(harness.listAgentsCalls, ['project-1'])
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
  const telemetry = getIntegrationEventTelemetrySnapshot().projects['project-1']
  assert.ok(telemetry)
  assert.equal(telemetry.brokerSendsDeferred >= 0, true)
  assert.deepEqual({ ...telemetry, brokerSendsDeferred: 0 }, {
    eventsReceived: 1_000,
    eventsInjected: 51,
    eventsCoalesced: 950,
    eventsDropped: 0,
    eventsSelfEchoSuppressed: 0,
    brokerSends: 51,
    brokerSendsDeferred: 0,
    queueDepth: 0,
    mountCount: 0,
    brokerSendQueueDepth: 0
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

  assert.match(harness.sent[0].input.text, /Slack message event/u)
  assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC__proj-cloud\/messages\/1780674600_000000\/meta\.json/u)
  assert.doesNotMatch(harness.sent[0].input.text, /Slack messages changed/u)
  assert.deepEqual(getIntegrationEventTelemetrySnapshot().projects['project-1'], {
    eventsReceived: 1_001,
    eventsInjected: 1,
    eventsCoalesced: 0,
    eventsDropped: 0,
    eventsSelfEchoSuppressed: 0,
    brokerSends: 1,
    brokerSendsDeferred: 0,
    queueDepth: 0,
    mountCount: 0,
    brokerSendQueueDepth: 0
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
    eventsSelfEchoSuppressed: 0,
    brokerSends: 1,
    brokerSendsDeferred: 0,
    queueDepth: 0,
    mountCount: 0,
    brokerSendQueueDepth: 0
  })
})

test('integration event fanout sends to recipients in stable order', async () => {
  const harness = makeHarness(
    Array.from({ length: 12 }, (_, index) => `agent-${index}`),
    { sendDelayMs: 2 }
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

test('integration event recipient cache avoids listAgents per event during bursts', async () => {
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
      `/github/repos/acme/widgets-${index}.json`,
      'github',
      { revision: `rev-${index}` }
    ))
  }
  await waitUntil(() => harness.sent.length === 10)

  assert.deepEqual(harness.listAgentsCalls, ['project-1'])
  assert.deepEqual(harness.sent.map((message) => message.input.to), Array(10).fill('alice'))
})

test('integration event agent cache invalidates for newly spawned agents and expires briefly', async () => {
  const agents = ['alice']
  const harness = makeHarness(agents)
  let now = Date.parse('2026-06-05T14:00:00.000Z')
  const originalDateNow = Date.now
  Date.now = () => now

  try {
    await harness.bridge.reconcile('project-1', [
      integration({
        provider: 'linear',
        integrationId: 'linear-1',
        mountPaths: ['/linear/issues']
      })
    ])

    await harness.emit(changeEvent('/linear/issues/AR-1.json', 'linear', { revision: 'rev-1' }))
    await waitForSent(harness, 1)
    assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
    assert.deepEqual(harness.listAgentsCalls, ['project-1'])

    agents.push('bob')
    harness.bridge.invalidateProjectAgentCache('project-1')
    await harness.emit(changeEvent('/linear/issues/AR-2.json', 'linear', { revision: 'rev-2' }))
    await waitForSent(harness, 3)
    assert.deepEqual(harness.sent.slice(1).map((message) => message.input.to), ['alice', 'bob'])
    assert.deepEqual(harness.listAgentsCalls, ['project-1', 'project-1'])

    agents.push('carol')
    now += 2_001
    await harness.emit(changeEvent('/linear/issues/AR-3.json', 'linear', { revision: 'rev-3' }))
    await waitForSent(harness, 6)
    assert.deepEqual(harness.sent.slice(3).map((message) => message.input.to), ['alice', 'bob', 'carol'])
    assert.deepEqual(harness.listAgentsCalls, ['project-1', 'project-1', 'project-1'])
  } finally {
    Date.now = originalDateNow
  }
})

test('integration event broker sends are paced per project across many recipients', async () => {
  const sendStartedAt: number[] = []
  const harness = makeHarness(
    Array.from({ length: 26 }, (_, index) => `agent-${index}`),
    {
      onSendStart: () => {
        sendStartedAt.push(Date.now())
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
  await waitForSent(harness, 26, 2_500)

  assert.equal(harness.sent.length, 26)
  assert.ok(sendStartedAt[25] - sendStartedAt[0] >= 900)
  const telemetry = getIntegrationEventTelemetrySnapshot().projects['project-1']
  assert.equal(telemetry?.brokerSends, 26)
  assert.equal(telemetry?.brokerSendsDeferred, 1)
  assert.equal(telemetry?.brokerSendQueueDepth, 0)
})

test('integration event broker pacing does not wait on delivery confirmation path', async () => {
  const harness = makeHarness(['alice', 'bob'], { waitForDeliveryNeverSettles: true })

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'linear',
      integrationId: 'linear-1',
      mountPaths: ['/linear/issues']
    })
  ])

  await harness.emit(changeEvent('/linear/issues/AR-1.json', 'linear'))
  await waitForSent(harness, 2)

  assert.equal(harness.deliveryConfirmationCalls.length, 0)
  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice', 'bob'])
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
    eventsSelfEchoSuppressed: 0,
    brokerSends: 0,
    brokerSendsDeferred: 0,
    queueDepth: 7,
    mountCount: 0,
    brokerSendQueueDepth: 0
  })
})
