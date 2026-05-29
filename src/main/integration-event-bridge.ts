import {
  events,
  type AgentEvent,
  type EventStreamHandle,
  type WatchRegistration
} from '@agent-relay/events'
import { getAccountWorkspaceId, resolveCloudAuth } from './auth'
import { brokerManager } from './broker'
import { getRelayWorkspaceManager } from './relay-workspace'
import type { ConnectedIntegration } from './integrations'

type CloudAgentEventsConfig = {
  workspaceId: string
  agentId: string
  gatewayUrl: string
  apiKey: string
}

type ProjectSubscription = {
  handle: EventStreamHandle
  signature: string
  abort: AbortController
}

type BrokerEventBridge = {
  listAgents: (projectId?: string) => Promise<Array<{ name: string; projectId?: string }>>
  sendMessage: (
    projectId: string,
    input: {
      to: string
      text: string
      from?: string
      data?: Record<string, unknown>
      priority?: number
      mode?: 'wait' | 'steer'
    }
  ) => Promise<void> | void
}

export type IntegrationSubscriptionSummary = {
  provider: string
  watches: string[]
  inboxes: string[]
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort()
}

function toRelayfileProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  return normalized === 'gmail' ? 'google-mail' : normalized
}

function canonicalMountPaths(integration: ConnectedIntegration): string[] {
  if (integration.mountPaths.length === 0) return []
  const provider = toRelayfileProvider(integration.provider)
  return dedupeStrings(integration.mountPaths.map((path) => {
    const match = path.match(/^\/integrations\/[^/]+(\/.*)?$/)
    return match ? `/integrations/${provider}${match[1] ?? ''}` : path
  }))
}

function watchGlobForPath(path: string): string {
  const root = path.trim().replace(/\/+$/u, '')
  return root.endsWith('/**') ? root : `${root || '/'}/**`
}

function watchRegistrationsFor(integrations: ConnectedIntegration[]): WatchRegistration[] {
  return dedupeStrings(integrations.flatMap((integration) => canonicalMountPaths(integration).map(watchGlobForPath)))
    .map((glob) => ({
      glob,
      coalesceMs: 750,
      replayOnStart: 'none'
    }))
}

function inboxSelectorsFor(integrations: ConnectedIntegration[]): string[] {
  const selectors: string[] = []
  for (const integration of integrations) {
    if (integration.mountPaths.length === 0) continue
    if (toRelayfileProvider(integration.provider) !== 'slack') continue
    const scope = integration.scope
    const rawSelectors = [
      ...stringList(scope.inboxSelectors),
      ...stringList(scope.inboxes),
      ...stringList(scope.channels)
    ]
    for (const selector of rawSelectors) {
      const trimmed = selector.trim()
      if (!trimmed) continue
      selectors.push(trimmed.startsWith('#') || trimmed.startsWith('@') ? trimmed : `#${trimmed}`)
    }
  }
  return dedupeStrings(selectors)
}

export function integrationSubscriptionSummaries(
  integrations: ConnectedIntegration[]
): IntegrationSubscriptionSummary[] {
  return integrations
    .filter((integration) => integration.subscribeAgent === true)
    .map((integration) => ({
      provider: integration.provider,
      watches: watchRegistrationsFor([integration]).map((watch) => watch.glob),
      inboxes: inboxSelectorsFor([integration])
    }))
    .filter((summary) => summary.watches.length > 0 || summary.inboxes.length > 0)
}

function normalizeGatewayEventsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const url = new URL(trimmed)
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v1/agent-events'
  } else if (!url.pathname.endsWith('/v1/agent-events')) {
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/v1/agent-events`
  }
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  return url.toString()
}

function projectAgentId(agentId: string, projectId: string): string {
  return `${agentId}-${projectId}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'pear-cloud-agent-events'
}

function eventSummaryValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value) && value.length > 0) return value.map((entry) => String(entry)).join(', ')
  return undefined
}

function formatIntegrationEventMessage(event: AgentEvent): string {
  const summary = isRecord(event.summary) ? event.summary : {}
  const resource = isRecord(event.resource) ? event.resource : {}
  const provider = eventSummaryValue(resource.provider) || 'integration'
  const path = eventSummaryValue((event as { path?: unknown }).path) || eventSummaryValue(resource.path)
  const title = eventSummaryValue(summary.title)
  const status = eventSummaryValue(summary.status)
  const actor = isRecord(summary.actor)
    ? eventSummaryValue(summary.actor.displayName) || eventSummaryValue(summary.actor.id)
    : undefined
  const fieldsChanged = eventSummaryValue(summary.fieldsChanged)
  const labels = eventSummaryValue(summary.labels) || eventSummaryValue(summary.tags)

  const lines = [
    '<integration-event>',
    `Provider: ${provider}`,
    `Type: ${event.type}`,
    `Occurred at: ${event.occurredAt}`,
    `Event id: ${event.id}`
  ]

  if (path) lines.push(`Path: ${path}`)
  if (title) lines.push(`Title: ${title}`)
  if (status) lines.push(`Status: ${status}`)
  if (actor) lines.push(`Actor: ${actor}`)
  if (fieldsChanged) lines.push(`Fields changed: ${fieldsChanged}`)
  if (labels) lines.push(`Labels: ${labels}`)

  if (event.type === 'relaycast.message') {
    const message = event as { channel?: string; messageId?: string; threadId?: string }
    if (message.channel) lines.push(`Channel: ${message.channel}`)
    if (message.messageId) lines.push(`Message id: ${message.messageId}`)
    if (message.threadId) lines.push(`Thread id: ${message.threadId}`)
  }

  lines.push(
    'Handle this like an incoming user-relevant integration update. Use the mounted integration files for context and the existing writeback/messaging path when a response is needed.',
    '</integration-event>'
  )
  return lines.join('\n')
}

export class IntegrationEventBridge {
  private subscriptions = new Map<string, ProjectSubscription>()

  async reconcile(projectId: string, integrations: ConnectedIntegration[]): Promise<void> {
    const subscribed = integrations.filter((integration) => integration.subscribeAgent === true)
    if (subscribed.length === 0) {
      await this.close(projectId)
      return
    }

    const watches = watchRegistrationsFor(subscribed)
    const inbox = inboxSelectorsFor(subscribed)
    if (watches.length === 0 && inbox.length === 0) {
      await this.close(projectId)
      return
    }

    const config = await this.resolveEventsConfig()
    const agentId = projectAgentId(config.agentId, projectId)
    const signature = JSON.stringify({
      workspaceId: config.workspaceId,
      agentId,
      gatewayUrl: config.gatewayUrl,
      watches,
      inbox
    })
    if (this.subscriptions.get(projectId)?.signature === signature) return

    await this.close(projectId)
    const abort = new AbortController()
    let handle: EventStreamHandle | null = null
    try {
      handle = events({
        workspace: config.workspaceId,
        apiKey: config.apiKey,
        agentId,
        gatewayUrl: config.gatewayUrl,
        signal: abort.signal,
        onEvent: async (event) => {
          await this.injectEvent(projectId, event)
        },
        onError: (error, event) => {
          console.warn('[integration-events] Event delivery failed:', {
            projectId,
            eventId: event.id,
            error: toErrorMessage(error)
          })
        }
      })

      await handle.ready
      if (watches.length > 0) await handle.registerWatches(watches)
      if (inbox.length > 0) await handle.registerInboxes(inbox)
      this.subscriptions.set(projectId, { handle, signature, abort })
    } catch (error) {
      abort.abort()
      await handle?.close().catch(() => undefined)
      throw error
    }
  }

  async close(projectId: string): Promise<void> {
    const subscription = this.subscriptions.get(projectId)
    this.subscriptions.delete(projectId)
    if (!subscription) return
    subscription.abort.abort()
    await subscription.handle.close().catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.subscriptions.keys()).map((projectId) => this.close(projectId)))
  }

  private async resolveEventsConfig(): Promise<CloudAgentEventsConfig> {
    const auth = await resolveCloudAuth()
    if (auth) {
      const workspaceId = await getAccountWorkspaceId()
      const response = await fetch(`${auth.apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-events`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` }
      })
      if (response.ok) {
        const config = this.normalizeCloudConfig(await response.json().catch(() => null))
        if (config) return config
      } else if (![404, 405, 501].includes(response.status)) {
        const body = await response.json().catch(() => null)
        throw new Error(`Cloud agent events config failed: ${response.status} ${this.payloadMessage(body, response.statusText)}`)
      }
    }

    const gatewayUrl = normalizeGatewayEventsUrl(
      process.env.PEAR_AGENT_EVENTS_URL ||
      process.env.RELAY_AGENT_EVENTS_URL ||
      process.env.AGENT_GATEWAY_BASE_URL ||
      process.env.NEXT_PUBLIC_AGENT_GATEWAY_BASE_URL
    )
    if (!gatewayUrl) {
      throw new Error('agent-events-gateway-unconfigured')
    }

    const handle = await getRelayWorkspaceManager().getWorkspaceHandle()
    return {
      workspaceId: handle.workspaceId,
      agentId: 'pear-project-events',
      gatewayUrl,
      apiKey: handle.getToken()
    }
  }

  private normalizeCloudConfig(value: unknown): CloudAgentEventsConfig | null {
    if (!isRecord(value)) return null
    const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId.trim() : ''
    const agentId = typeof value.agentId === 'string' ? value.agentId.trim() : ''
    const gatewayUrl = normalizeGatewayEventsUrl(typeof value.gatewayUrl === 'string' ? value.gatewayUrl : undefined)
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
    if (!workspaceId || !agentId || !gatewayUrl || !apiKey) return null
    return { workspaceId, agentId, gatewayUrl, apiKey }
  }

  private payloadMessage(payload: unknown, fallback: string): string {
    if (isRecord(payload)) {
      for (const key of ['error', 'message', 'detail']) {
        const value = payload[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    return fallback
  }

  private async injectEvent(projectId: string, event: AgentEvent): Promise<void> {
    const bridge = this.bridge()
    const agents = await bridge.listAgents(projectId)
    await Promise.all(
      agents
        .filter((agent) => agent.projectId === undefined || agent.projectId === projectId)
        .map((agent) => bridge.sendMessage(projectId, {
          to: agent.name,
          from: 'integration',
          text: formatIntegrationEventMessage(event),
          priority: 0,
          mode: 'steer',
          data: {
            kind: 'integration-event',
            system: true,
            eventId: event.id,
            eventType: event.type,
            occurredAt: event.occurredAt,
            resource: isRecord(event.resource) ? { ...event.resource } : undefined,
            path: (event as { path?: unknown }).path
          }
        }))
    )
  }

  private bridge(): BrokerEventBridge {
    return brokerManager as unknown as BrokerEventBridge
  }
}

export const integrationEventBridge = new IntegrationEventBridge()
