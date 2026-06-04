import type { ChangeEvent, Subscription } from '@relayfile/sdk'
import type { ConnectedIntegration } from './integrations'

type WatchRegistration = {
  glob: string
  coalesceMs: number
}

type DeliveryTargets = {
  agents: string[]
  channels: string[]
}

type SubscriptionSpec = {
  integrationId: string
  provider: string
  mountPaths: string[]
  watches: WatchRegistration[]
  targets: DeliveryTargets
}

type ProjectSubscription = {
  subscriptions: Subscription[]
  signature: string
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

type RelayfileEventClient = {
  subscribe(
    globs: string[],
    onChange: (event: ChangeEvent) => void,
    options?: { coalesce?: 'none' | 'fire-once'; coalesceMs?: number }
  ): Subscription
}

type RelayfileWorkspaceHandle = {
  workspaceId: string
  client(): RelayfileEventClient
}

type IntegrationEventBridgeDeps = {
  broker?: BrokerEventBridge
  getWorkspaceHandle?: () => Promise<RelayfileWorkspaceHandle>
}

export type IntegrationSubscriptionSummary = {
  provider: string
  watches: string[]
  targets: string[]
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

// Provider adapters materialize data at the workspace root (`/github/...`,
// `/linear/...`), so watch globs must target the root-level provider layout.
// Tolerates the legacy `/integrations/<provider>/...` catalog form.
function canonicalMountPaths(integration: ConnectedIntegration): string[] {
  if (integration.mountPaths.length === 0) return []
  const provider = toRelayfileProvider(integration.provider)
  return dedupeStrings(integration.mountPaths.map((path) => {
    const prefixed = path.match(/^\/integrations\/[^/]+(\/.*)?$/)
    if (prefixed) return `/${provider}${prefixed[1] ?? ''}`
    const rootLevel = path.match(/^\/[^/]+(\/.*)?$/)
    if (rootLevel) return `/${provider}${rootLevel[1] ?? ''}`
    return path
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
      coalesceMs: 750
    }))
}

function normalizeAgentTarget(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() || null : trimmed
}

function normalizeChannelTarget(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

function deliveryTargetsFor(integrations: ConnectedIntegration[]): DeliveryTargets {
  const agents: string[] = []
  const channels: string[] = []
  for (const integration of integrations) {
    const scope = integration.scope
    agents.push(
      ...[
        ...stringList(scope.notifyAgents),
        ...stringList(scope.notificationAgents),
        ...stringList(scope.listenerAgents),
        ...stringList(scope.agentListeners)
      ].map(normalizeAgentTarget).filter((entry): entry is string => entry !== null)
    )
    channels.push(
      ...[
        ...stringList(scope.notifyChannels),
        ...stringList(scope.notificationChannels),
        ...stringList(scope.listenerChannels),
        ...stringList(scope.channelListeners),
        ...stringList(scope.relayChannels)
      ].map(normalizeChannelTarget).filter((entry): entry is string => entry !== null)
    )
  }
  return {
    agents: dedupeStrings(agents),
    channels: dedupeStrings(channels)
  }
}

function targetLabels(targets: DeliveryTargets): string[] {
  return [...targets.agents.map((agent) => `@${agent}`), ...targets.channels]
}

function subscriptionSpecsFor(integrations: ConnectedIntegration[]): SubscriptionSpec[] {
  return integrations.map((integration) => {
    const mountPaths = canonicalMountPaths(integration)
    return {
      integrationId: integration.integrationId,
      provider: integration.provider,
      mountPaths,
      watches: mountPaths.map(watchGlobForPath).map((glob) => ({
        glob,
        coalesceMs: 750
      })),
      targets: deliveryTargetsFor([integration])
    }
  }).filter((spec) => spec.watches.length > 0)
}

function pathIsInsideMount(path: string, mountPath: string): boolean {
  const normalizedPath = path.trim().replace(/\/+$/u, '') || '/'
  const normalizedMountPath = mountPath.trim().replace(/\/+$/u, '') || '/'
  return normalizedPath === normalizedMountPath || normalizedPath.startsWith(`${normalizedMountPath}/`)
}

function specsForEvent(event: ChangeEvent, specs: SubscriptionSpec[]): SubscriptionSpec[] {
  const path = event.resource.path
  return specs.filter((spec) => spec.mountPaths.some((mountPath) => pathIsInsideMount(path, mountPath)))
}

export function integrationSubscriptionSummaries(
  integrations: ConnectedIntegration[]
): IntegrationSubscriptionSummary[] {
  return integrations
    .filter((integration) => integration.subscribeAgent === true)
    .map((integration) => {
      const targets = deliveryTargetsFor([integration])
      return {
        provider: integration.provider,
        watches: watchRegistrationsFor([integration]).map((watch) => watch.glob),
        targets: targetLabels(targets)
      }
    })
    .filter((summary) => summary.watches.length > 0)
}

function eventSummaryValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value) && value.length > 0) return value.map((entry) => String(entry)).join(', ')
  return undefined
}

function shouldNotifyRelayfileChange(event: ChangeEvent): boolean {
  const path = event.resource.path.trim()
  if (!path || !path.startsWith('/')) return false

  const leaf = path.split('/').pop() || ''
  if (
    leaf === 'LAYOUT.md' ||
    leaf === '_index.json' ||
    leaf === '.schema.json' ||
    leaf === '.create.example.json' ||
    path.includes('/discovery/') ||
    path.includes('/.relay/') ||
    path.includes('/.relayfile-') ||
    path.endsWith('/.schema.json') ||
    path.endsWith('/.create.example.json')
  ) {
    return false
  }

  // Local writeback drafts are commands from an agent, not provider-originated
  // updates. Notifying agents about their own draft files creates loops.
  if (/\/(?:draft[@-][^/]*|create)\.json$/u.test(path)) return false

  return true
}

function formatIntegrationEventMessage(event: ChangeEvent): string {
  const summary = isRecord(event.summary) ? event.summary : {}
  const resource = isRecord(event.resource) ? event.resource : {}
  const provider = eventSummaryValue(resource.provider) || 'integration'
  const path = eventSummaryValue(resource.path)
  const resourceKind = eventSummaryValue(resource.kind)
  const resourceId = eventSummaryValue(resource.id)
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
  if (resourceKind) lines.push(`Resource kind: ${resourceKind}`)
  if (resourceId) lines.push(`Resource id: ${resourceId}`)
  if (title) lines.push(`Title: ${title}`)
  if (status) lines.push(`Status: ${status}`)
  if (actor) lines.push(`Actor: ${actor}`)
  if (fieldsChanged) lines.push(`Fields changed: ${fieldsChanged}`)
  if (labels) lines.push(`Labels: ${labels}`)

  lines.push(
    'Handle this like an incoming user-relevant integration update. Use the mounted integration files for context and the existing writeback/messaging path when a response is needed.',
    '</integration-event>'
  )
  return lines.join('\n')
}

export class IntegrationEventBridge {
  private subscriptions = new Map<string, ProjectSubscription>()
  private readonly deps: IntegrationEventBridgeDeps

  constructor(deps: IntegrationEventBridgeDeps = {}) {
    this.deps = deps
  }

  async reconcile(projectId: string, integrations: ConnectedIntegration[]): Promise<void> {
    const subscribed = integrations.filter((integration) => integration.subscribeAgent === true)
    if (subscribed.length === 0) {
      await this.close(projectId)
      return
    }

    const specs = subscriptionSpecsFor(subscribed)
    const watches = dedupeStrings(specs.flatMap((spec) => spec.watches.map((watch) => watch.glob))).map((glob) => ({
      glob,
      coalesceMs: 750
    }))
    if (watches.length === 0) {
      await this.close(projectId)
      return
    }

    const handle = await this.getWorkspaceHandle()
    const signature = JSON.stringify({
      workspaceId: handle.workspaceId,
      watches,
      specs: specs.map((spec) => ({
        integrationId: spec.integrationId,
        provider: spec.provider,
        mountPaths: spec.mountPaths,
        targets: spec.targets
      }))
    })
    if (this.subscriptions.get(projectId)?.signature === signature) return

    await this.close(projectId)
    const subscriptions: Subscription[] = []
    try {
      subscriptions.push(
        handle.client().subscribe(
          watches.map((watch) => watch.glob),
          (event) => {
            void this.injectEvent(projectId, event, specs).catch((error) => {
              console.warn('[integration-events] Event delivery failed:', {
                projectId,
                eventId: event.id,
                error: toErrorMessage(error)
              })
            })
          },
          {
            coalesce: 'fire-once',
            coalesceMs: Math.max(...watches.map((watch) => watch.coalesceMs), 750)
          }
        )
      )
      this.subscriptions.set(projectId, { subscriptions, signature })
    } catch (error) {
      await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe().catch(() => undefined)))
      throw error
    }
  }

  async close(projectId: string): Promise<void> {
    const subscription = this.subscriptions.get(projectId)
    this.subscriptions.delete(projectId)
    if (!subscription) return
    await Promise.all(subscription.subscriptions.map((entry) => entry.unsubscribe().catch(() => undefined)))
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.subscriptions.keys()).map((projectId) => this.close(projectId)))
  }

  private async injectEvent(projectId: string, event: ChangeEvent, specs: SubscriptionSpec[]): Promise<void> {
    if (!shouldNotifyRelayfileChange(event)) return

    const matchedSpecs = specsForEvent(event, specs)
    if (matchedSpecs.length === 0) return

    const bridge = await this.bridge()
    let allProjectAgents: string[] | null = null
    const recipients: string[] = []

    for (const spec of matchedSpecs) {
      const explicitTargets = dedupeStrings([...spec.targets.agents, ...spec.targets.channels])
      if (explicitTargets.length === 0) {
        allProjectAgents ??= (await bridge.listAgents(projectId))
          .filter((agent) => agent.projectId === undefined || agent.projectId === projectId)
          .map((agent) => agent.name)
        recipients.push(...allProjectAgents)
      } else {
        recipients.push(...spec.targets.agents, ...spec.targets.channels)
      }
    }

    await Promise.all(
      dedupeStrings(recipients).map((recipient) => bridge.sendMessage(projectId, {
        to: recipient,
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
          path: event.resource.path
        }
      }))
    )
  }

  private async getWorkspaceHandle(): Promise<RelayfileWorkspaceHandle> {
    if (this.deps.getWorkspaceHandle) return this.deps.getWorkspaceHandle()
    const { getRelayWorkspaceManager } = await import('./relay-workspace')
    return getRelayWorkspaceManager().getWorkspaceHandle() as Promise<RelayfileWorkspaceHandle>
  }

  private async bridge(): Promise<BrokerEventBridge> {
    if (this.deps.broker) return this.deps.broker
    const { brokerManager } = await import('./broker')
    return brokerManager as unknown as BrokerEventBridge
  }
}

export const integrationEventBridge = new IntegrationEventBridge()
