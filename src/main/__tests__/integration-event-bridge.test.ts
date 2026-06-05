import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChangeEvent, Subscription } from '@relayfile/sdk'
import { IntegrationEventBridge, integrationSubscriptionSummaries } from '../integration-event-bridge.ts'
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
  options?: { coalesce?: 'none' | 'fire-once'; coalesceMs?: number }
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

function changeEvent(path: string, provider = path.split('/')[1] || 'github'): ChangeEvent {
  return {
    id: `evt:${path}`,
    workspace: 'workspace-id',
    type: 'relayfile.changed',
    occurredAt: '2026-06-04T00:00:00.000Z',
    resource: {
      path,
      provider,
      kind: 'record',
      id: path.split('/').pop() || path
    },
    summary: {
      title: path
    },
    expand: async () => ({
      level: 'summary',
      path,
      summary: {
        title: path
      }
    })
  } as ChangeEvent
}

function makeHarness(agents = ['alice', 'bob']): {
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

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['#triage'])
  assert.deepEqual(harness.listAgentsCalls, [])
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
    '/slack/channels/C123ABC__proj-cloud/**'
  ])
  assert.deepEqual(integrationSubscriptionSummaries([slackIntegration])[0].watches, [
    '.integrations/slack/channels/C123ABC__proj-cloud/**'
  ])

  await harness.emit(changeEvent('/slack/channels/C123ABC__proj-cloud/messages/1713220123_001100/meta.json', 'slack'))

  assert.deepEqual(harness.sent.map((message) => message.input.to), ['alice'])
  assert.match(harness.sent[0].input.text, /Path: \.integrations\/slack\/channels\/C123ABC__proj-cloud\/messages\/1713220123_001100\/meta\.json/u)
  assert.match(harness.sent[0].input.text, /Relayfile path: \/slack\/channels\/C123ABC__proj-cloud\/messages\/1713220123_001100\/meta\.json/u)
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

test('integration events ignore index, discovery, and local writeback command files', async () => {
  const harness = makeHarness()

  await harness.bridge.reconcile('project-1', [
    integration({
      provider: 'github',
      integrationId: 'github-1',
      mountPaths: ['/github/repos']
    })
  ])

  await harness.emit(changeEvent('/github/repos/_index.json', 'github'))
  await harness.emit(changeEvent('/github/repos/discovery/schema.json', 'github'))
  await harness.emit(changeEvent('/github/repos/draft@alice.json', 'github'))
  await harness.emit(changeEvent('/github/repos/create.json', 'github'))

  assert.deepEqual(harness.sent, [])
  assert.deepEqual(harness.listAgentsCalls, [])
})
