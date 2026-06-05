import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  BellOff,
  Bot,
  Check,
  Database,
  Eye,
  EyeOff,
  Folder,
  Hash,
  Loader2,
  Plug,
  Plus,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { ProactiveAgentsSection } from '@/components/proactive/ProactiveAgentsSection'
import { pear, type ConnectedIntegration } from '@/lib/ipc'
import {
  SlackChannelPicker,
  type IntegrationAccessibleResource,
  type ScopePickerValue
} from '@/components/settings/scope-pickers'
import { useAgentStore } from '@/stores/agent-store'
import {
  normalizeChannelName,
  useProjectStore,
  type CloudAgentWorkspaceMode,
  type ProjectRoot
} from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

function StatPill({
  icon: Icon,
  label,
  value
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: number
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] px-3 py-2 text-xs text-[var(--pear-text-dim)]">
      <Icon size={13} className="text-[var(--pear-text-faint)]" />
      <span>{label}</span>
      <span className="text-[var(--pear-text)]">{value}</span>
    </div>
  )
}

function Section({
  title,
  action,
  children
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <section className="border-t border-[var(--pear-border-subtle)] pt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function IconButton({
  label,
  onClick,
  children,
  variant = 'default',
  disabled = false
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  variant?: 'default' | 'danger'
  disabled?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md p-1.5 transition-colors disabled:opacity-40 ${
        variant === 'danger'
          ? 'text-[var(--pear-red)] hover:bg-[var(--pear-red)]/10'
          : 'text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]'
      }`}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  )
}

function RootRow({
  root,
  selected,
  removable,
  onSelect,
  onRemove
}: {
  root: ProjectRoot
  selected: boolean
  removable: boolean
  onSelect: () => void
  onRemove: () => void
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={root.path}
      >
        <Folder size={15} className="shrink-0 text-[var(--pear-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-[var(--pear-text)]">{root.name}</span>
            {selected && (
              <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-accent-bright)]">
                Active
              </span>
            )}
            {!root.pathExists && (
              <span className="flex items-center gap-1 rounded-full bg-[var(--pear-yellow)]/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-yellow)]">
                <AlertTriangle size={10} />
                Missing
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-[var(--pear-text-faint)]">{root.path}</div>
        </div>
      </button>
      <IconButton label="Remove root" onClick={onRemove} disabled={!removable} variant="danger">
        <X size={13} />
      </IconButton>
    </div>
  )
}

type ProjectVisibilityMetadata = {
  visible?: boolean
  previousMountPaths?: string[]
}

function projectVisibilityFromScope(scope: Record<string, unknown>): ProjectVisibilityMetadata {
  const value = scope.projectVisibility
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const record = value as Record<string, unknown>
  return {
    visible: typeof record.visible === 'boolean' ? record.visible : undefined,
    previousMountPaths: Array.isArray(record.previousMountPaths)
      ? record.previousMountPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : undefined
  }
}

function providerMountRoot(provider: string): string {
  return `/${provider}`
}

function isSlackProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase().replace(/-(app-oauth|app|oauth|bot-oauth|bot|api-key|apikey)$/, '')
  return normalized === 'slack' || normalized.startsWith('slack-')
}

function cloudAgentWorkspaceMode(project: unknown): CloudAgentWorkspaceMode {
  const mode = project && typeof project === 'object'
    ? (project as { cloudAgentWorkspaceMode?: unknown }).cloudAgentWorkspaceMode
    : undefined
  return mode === 'git' || mode === 'relayfile'
    ? mode
    : 'git-overlay'
}

function visibilityMountPaths(integration: ConnectedIntegration, visibility: ProjectVisibilityMetadata): string[] {
  const currentPaths = integration.mountPaths.filter(Boolean)
  if (currentPaths.length > 0) return currentPaths
  if (visibility.previousMountPaths && visibility.previousMountPaths.length > 0) return visibility.previousMountPaths
  return [providerMountRoot(integration.provider)]
}

const NOTIFICATION_AGENT_SCOPE_KEYS = [
  'notifyAgents',
  'notificationAgents',
  'listenerAgents',
  'agentListeners'
]

const NOTIFICATION_CHANNEL_SCOPE_KEYS = [
  'notifyChannels',
  'notificationChannels',
  'listenerChannels',
  'channelListeners',
  'relayChannels'
]

function firstScopeString(scope: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = scope[key]
    if (!Array.isArray(value)) continue
    const first = value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    if (first) return first.trim()
  }
  return null
}

function scopeStringList(scope: Record<string, unknown>, key: string): string[] {
  const value = scope[key]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function scopeBooleanDefault(scope: Record<string, unknown>, keys: string[], defaultValue: boolean): boolean {
  for (const key of keys) {
    const value = scope[key]
    if (typeof value === 'boolean') return value
  }
  return defaultValue
}

function slackListenDmsFromScope(scope: Record<string, unknown>): boolean {
  return scopeBooleanDefault(scope, ['listenDms', 'listenDirectMessages', 'directMessages'], true)
}

function localPathSegments(path: string): string[] {
  return path.split(/[\\/]+/u).filter(Boolean)
}

function providerLocalMountPath(integration: ConnectedIntegration, provider: string): string | null {
  const providerSegment = provider.trim().toLowerCase()
  const providerRoots = (integration.localMountPaths || [])
    .filter((root) => localPathSegments(root).at(-1)?.toLowerCase() === providerSegment)
  return providerRoots.find((root) => !localPathSegments(root).includes('discovery')) || null
}

function joinLocalPath(root: string, ...segments: string[]): string {
  const suffix = segments
    .map((segment) => segment.replace(/^[/\\]+|[/\\]+$/gu, ''))
    .filter(Boolean)
    .join('/')
  return suffix ? `${root.replace(/[/\\]+$/u, '')}/${suffix}` : root
}

function slackChannelResourceFromEntry(entry: { name: string; path: string }): IntegrationAccessibleResource {
  const channelId = entry.name.includes('__')
    ? entry.name.split('__')[0]
    : entry.name.includes('--')
      ? entry.name.split('--').at(-1) || entry.name
      : entry.name
  const name = entry.name.includes('__')
    ? entry.name.split('__').slice(1).join('__')
    : entry.name.includes('--')
      ? entry.name.split('--').slice(0, -1).join('--')
      : entry.name
  const remotePath = `/slack/channels/${entry.name}`
  return {
    id: remotePath,
    displayName: name || channelId,
    name: name || channelId,
    path: entry.path,
    metadata: {
      channelFolder: entry.name,
      channelId,
      remotePath
    }
  }
}

function isConcreteSlackChannelEntry(entry: { name: string; path: string }): boolean {
  if (!entry.name || entry.name.startsWith('_') || entry.name === 'by-name') return false
  if (entry.name.includes('{') || entry.name.includes('}')) return false
  if (localPathSegments(entry.path).includes('discovery')) return false
  return true
}

function slackChannelResourceFromOption(option: { value: string; label: string; hint?: string }): IntegrationAccessibleResource {
  const id = option.value.trim()
  const name = option.label.replace(/^#/u, '').trim() || id
  return {
    id,
    displayName: option.label,
    name,
    metadata: {
      channelId: id,
      ...(option.hint ? { hint: option.hint } : {})
    }
  }
}

function integrationStatusSummary(
  integration: ConnectedIntegration,
  visibility: ProjectVisibilityMetadata,
  visible: boolean
): string {
  if (!visible) return 'Hidden'
  if (integration.downloadHistoricalData === true) return visibilityMountPaths(integration, visibility).join(', ')
  if (integration.subscribeAgent === true) return 'Listening for events'
  return 'Historical files not mounted'
}

const RESOURCE_CACHE_TTL_MS = 5 * 60 * 1000

type ResourceCacheEntry = {
  expiresAt: number
  resources?: IntegrationAccessibleResource[]
  promise?: Promise<IntegrationAccessibleResource[]>
}

function notificationTargetValue(scope: Record<string, unknown>): string {
  const agent = firstScopeString(scope, NOTIFICATION_AGENT_SCOPE_KEYS)
  if (agent) return `agent:${agent.replace(/^@/u, '')}`
  const channel = firstScopeString(scope, NOTIFICATION_CHANNEL_SCOPE_KEYS)
  if (channel) return `channel:${channel.replace(/^#/u, '')}`
  return 'all'
}

function resolvedNotificationTargetValue(value: string, knownValues: Set<string>): string {
  return knownValues.has(value) ? value : 'all'
}

function clearNotificationTargetScope(scope: Record<string, unknown>): Record<string, unknown> {
  const nextScope = { ...scope }
  for (const key of [...NOTIFICATION_AGENT_SCOPE_KEYS, ...NOTIFICATION_CHANNEL_SCOPE_KEYS]) {
    delete nextScope[key]
  }
  return nextScope
}

function IntegrationVisibilitySection({
  projectId,
  channels,
  agentNames
}: {
  projectId: string
  channels: string[]
  agentNames: string[]
}): React.ReactNode {
  const [integrations, setIntegrations] = useState<ConnectedIntegration[]>([])
  const [loading, setLoading] = useState(true)
  const [busyIntegrationId, setBusyIntegrationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scopeEditorIntegrationId, setScopeEditorIntegrationId] = useState<string | null>(null)
  const [pendingScopeValue, setPendingScopeValue] = useState<ScopePickerValue | null>(null)
  const [pendingSlackListenDms, setPendingSlackListenDms] = useState<boolean | null>(null)
  const resourceCacheRef = useRef(new Map<string, ResourceCacheEntry>())

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      setIntegrations(await pear.integrations.list(projectId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return pear.integrations.onEvent((event) => {
      if ('projectId' in event && event.projectId === projectId) void load()
    })
  }, [load, projectId])

  const setVisibility = useCallback(async (integration: ConnectedIntegration, visible: boolean) => {
    const visibility = projectVisibilityFromScope(integration.scope)
    const previousMountPaths = visibilityMountPaths(integration, visibility)
    const nextMountPaths = visible ? previousMountPaths : []
    const nextScope = {
      ...integration.scope,
      projectVisibility: {
        visible,
        previousMountPaths
      }
    }

    setBusyIntegrationId(integration.integrationId)
    setError(null)
    try {
      const nextIntegration = await pear.integrations.updateScope(
        projectId,
        integration.integrationId,
        nextScope,
        nextMountPaths
      )
      setIntegrations((current) =>
        current.map((entry) =>
          entry.integrationId === nextIntegration.integrationId ? nextIntegration : entry
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIntegrationId(null)
    }
  }, [projectId])

  const setSubscription = useCallback(async (integration: ConnectedIntegration, subscribeAgent: boolean) => {
    setBusyIntegrationId(integration.integrationId)
    setError(null)
    try {
      const nextIntegration = await pear.integrations.updateSubscription(
        projectId,
        integration.integrationId,
        subscribeAgent
      )
      setIntegrations((current) =>
        current.map((entry) =>
          entry.integrationId === nextIntegration.integrationId ? nextIntegration : entry
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIntegrationId(null)
    }
  }, [projectId])

  const setHistoricalDownload = useCallback(async (integration: ConnectedIntegration, downloadHistoricalData: boolean) => {
    setBusyIntegrationId(integration.integrationId)
    setError(null)
    try {
      const nextIntegration = await pear.integrations.updateHistoricalDownload(
        projectId,
        integration.integrationId,
        downloadHistoricalData
      )
      setIntegrations((current) =>
        current.map((entry) =>
          entry.integrationId === nextIntegration.integrationId ? nextIntegration : entry
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIntegrationId(null)
    }
  }, [projectId])

  const setNotificationTarget = useCallback(async (integration: ConnectedIntegration, value: string) => {
    const nextScope = clearNotificationTargetScope(integration.scope)
    if (value.startsWith('agent:')) {
      const agent = value.slice('agent:'.length).trim()
      if (agent) nextScope.notifyAgents = [agent]
    } else if (value.startsWith('channel:')) {
      const channel = value.slice('channel:'.length).trim().replace(/^#/u, '')
      if (channel) nextScope.notifyChannels = [`#${channel}`]
    }

    setBusyIntegrationId(integration.integrationId)
    setError(null)
    try {
      const nextIntegration = await pear.integrations.updateScope(
        projectId,
        integration.integrationId,
        nextScope,
        integration.mountPaths
      )
      setIntegrations((current) =>
        current.map((entry) =>
          entry.integrationId === nextIntegration.integrationId ? nextIntegration : entry
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIntegrationId(null)
    }
  }, [projectId])

  const cachedResources = useCallback(
    async (cacheKey: string, loadResources: () => Promise<IntegrationAccessibleResource[]>): Promise<IntegrationAccessibleResource[]> => {
      const now = Date.now()
      const cached = resourceCacheRef.current.get(cacheKey)
      if (cached?.resources && cached.expiresAt > now) return cached.resources
      if (cached?.promise) return cached.promise

      const promise = loadResources()
        .then((resources) => {
          resourceCacheRef.current.set(cacheKey, {
            resources,
            expiresAt: Date.now() + RESOURCE_CACHE_TTL_MS
          })
          return resources
        })
        .catch((err) => {
          resourceCacheRef.current.delete(cacheKey)
          throw err
        })

      resourceCacheRef.current.set(cacheKey, {
        promise,
        expiresAt: now + RESOURCE_CACHE_TTL_MS
      })
      return promise
    },
    []
  )

  const listSlackChannelResources = useCallback(async (integration: ConnectedIntegration): Promise<IntegrationAccessibleResource[]> => {
    const cacheKey = `slack-channels:${projectId}:${integration.integrationId}`
    return cachedResources(cacheKey, async () => {
      const listRemoteSlackChannels = async (): Promise<IntegrationAccessibleResource[]> => {
        const listRemoteDir = (pear.integrations as typeof pear.integrations & {
          listRemoteDir?: typeof pear.integrations.listRemoteDir
        }).listRemoteDir
        if (typeof listRemoteDir !== 'function') throw new Error('Slack Relayfile remote directory listing is not available yet.')

        const entries = await listRemoteDir(projectId, '/slack/channels')
        return entries
          .filter((entry) => entry.type === 'directory' && isConcreteSlackChannelEntry(entry))
          .map(slackChannelResourceFromEntry)
      }

      const listMountedSlackChannels = async (): Promise<IntegrationAccessibleResource[]> => {
        const slackRoot = providerLocalMountPath(integration, 'slack')
        if (!slackRoot) throw new Error('Slack Relayfile mount is not available yet.')
        const channelsPath = joinLocalPath(slackRoot, 'channels')
        const entries = await pear.integrations.listMountDir(projectId, integration.integrationId, channelsPath)
        return entries
          .filter((entry) => entry.type === 'directory' && isConcreteSlackChannelEntry(entry))
          .map((entry) => slackChannelResourceFromEntry({
            name: entry.name,
            path: joinLocalPath(channelsPath, entry.name)
          }))
      }
      const listOptions = (pear.integrations as typeof pear.integrations & {
        listOptions?: typeof pear.integrations.listOptions
      }).listOptions

      if (typeof listOptions === 'function') {
        try {
          const options = await listOptions(projectId, integration.provider, 'channels')
          const optionChannels = options.map(slackChannelResourceFromOption)
          if (optionChannels.length > 0) return optionChannels
        } catch (err) {
          console.warn('[integrations] Failed to list Slack channel options:', err)
          const mountedChannels = await listMountedSlackChannels().catch(() => [])
          if (mountedChannels.length > 0) return mountedChannels
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Slack channel options are unavailable: ${message}`)
        }
      }

      const remoteChannels = await listRemoteSlackChannels().catch((err) => {
        console.warn('[integrations] Failed to list remote Slack channels:', err)
        return []
      })
      if (remoteChannels.length > 0) return remoteChannels

      return listMountedSlackChannels().catch(() => [])
    })
  }, [cachedResources, projectId])

  const saveSlackSourceChannels = useCallback(async (integration: ConnectedIntegration) => {
    const listenDms = pendingSlackListenDms ?? slackListenDmsFromScope(integration.scope)
    const nextScope = {
      ...integration.scope,
      provider: pendingScopeValue?.scope.provider ?? integration.scope.provider ?? 'slack',
      selection: pendingScopeValue?.scope.selection ?? integration.scope.selection ?? 'selected',
      channels: pendingScopeValue?.scope.channels ?? integration.scope.channels ?? [],
      resources: pendingScopeValue?.scope.resources ?? integration.scope.resources ?? [],
      listenDms
    }

    setBusyIntegrationId(integration.integrationId)
    setError(null)
    try {
      const nextIntegration = await pear.integrations.updateScope(
        projectId,
        integration.integrationId,
        nextScope,
        pendingScopeValue?.mountPaths ?? integration.mountPaths
      )
      setIntegrations((current) =>
        current.map((entry) =>
          entry.integrationId === nextIntegration.integrationId ? nextIntegration : entry
        )
      )
      setScopeEditorIntegrationId(null)
      setPendingScopeValue(null)
      setPendingSlackListenDms(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIntegrationId(null)
    }
  }, [pendingScopeValue, pendingSlackListenDms, projectId])

  return (
    <Section
      title="Integration visibility"
      action={loading ? <Loader2 size={13} className="animate-spin text-[var(--pear-text-faint)]" /> : null}
    >
      {error && (
        <div className="mb-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
          {error}
        </div>
      )}
      <div className="space-y-2">
        {loading && integrations.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-faint)]">
            <Loader2 size={13} className="animate-spin" />
            Loading integrations
          </div>
        ) : integrations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-faint)]">
            No account integrations connected
          </div>
        ) : (
          integrations.map((integration) => {
            const visibility = projectVisibilityFromScope(integration.scope)
            const visible = integration.visibleInProject !== false
            const subscribed = integration.subscribeAgent === true
            const historyDownload = integration.downloadHistoricalData === true
            const busy = busyIntegrationId === integration.integrationId
            const slack = isSlackProvider(integration.provider)
            const scopeEditorOpen = scopeEditorIntegrationId === integration.integrationId
            const savedSlackListenDms = slackListenDmsFromScope(integration.scope)
            const slackListenDms = pendingSlackListenDms ?? savedSlackListenDms
            const selectedSlackSourceIds = Array.from(new Set([
              ...integration.mountPaths,
              ...scopeStringList(integration.scope, 'channels')
            ]))
            const slackScopeDirty = !!pendingScopeValue || (
              pendingSlackListenDms !== null && pendingSlackListenDms !== savedSlackListenDms
            )
            const knownTargetValues = new Set([
              'all',
              ...agentNames.map((agent) => `agent:${agent}`),
              ...channels.map((channel) => `channel:${channel}`)
            ])
            const notificationTarget = resolvedNotificationTargetValue(
              notificationTargetValue(integration.scope),
              knownTargetValues
            )

            return (
              <div key={integration.integrationId} className="space-y-2">
                <div className="flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5">
                  <Plug size={15} className="shrink-0 text-[var(--pear-text-faint)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[var(--pear-text)]">{integration.provider}</div>
                    <div className="truncate text-xs text-[var(--pear-text-faint)]">
                      {integrationStatusSummary(integration, visibility, visible)}
                    </div>
                    {historyDownload && integration.localMountPaths && integration.localMountPaths.length > 0 && (
                      <div className="truncate text-[11px] text-[var(--pear-text-faint)]">
                        {integration.localMountPaths.join(', ')}
                      </div>
                    )}
                  </div>
                  {slack && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setPendingScopeValue(null)
                        setPendingSlackListenDms(scopeEditorOpen ? null : savedSlackListenDms)
                        setScopeEditorIntegrationId(scopeEditorOpen ? null : integration.integrationId)
                      }}
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-40 ${
                        scopeEditorOpen
                          ? 'border-[var(--pear-accent-dim)] text-[var(--pear-accent-bright)] hover:bg-[var(--pear-bg-overlay)]'
                          : 'border-[var(--pear-border)] text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]'
                      }`}
                      aria-expanded={scopeEditorOpen}
                      title="Choose Slack channels to listen to"
                      aria-label="Choose Slack channels to listen to"
                    >
                      <Hash size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setSubscription(integration, !subscribed)}
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-40 ${
                      subscribed
                        ? 'border-[var(--pear-accent-dim)] text-[var(--pear-accent-bright)] hover:bg-[var(--pear-bg-overlay)]'
                        : 'border-[var(--pear-border)] text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]'
                    }`}
                    aria-pressed={subscribed}
                    title={subscribed ? 'Stop sending events to agents' : 'Send events to agents'}
                    aria-label={subscribed ? 'Stop sending events to agents' : 'Send events to agents'}
                  >
                    {subscribed ? <Bell size={13} /> : <BellOff size={13} />}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setHistoricalDownload(integration, !historyDownload)}
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-40 ${
                      historyDownload
                        ? 'border-[var(--pear-accent-dim)] text-[var(--pear-accent-bright)] hover:bg-[var(--pear-bg-overlay)]'
                        : 'border-[var(--pear-border)] text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]'
                    }`}
                    aria-pressed={historyDownload}
                    title={historyDownload ? 'Stop downloading historical files' : 'Download historical files'}
                    aria-label={historyDownload ? 'Stop downloading historical files' : 'Download historical files'}
                  >
                    <Database size={13} />
                  </button>
                  {subscribed && (
                    <select
                      value={notificationTarget}
                      disabled={busy}
                      onChange={(event) => void setNotificationTarget(integration, event.target.value)}
                      className="h-8 max-w-[160px] rounded-md border border-[var(--pear-border)] bg-[var(--pear-bg-raised)] px-2 text-xs text-[var(--pear-text-dim)] outline-none disabled:opacity-40"
                      title="Integration event delivery target"
                      aria-label="Integration event delivery target"
                    >
                      <option value="all">All agents</option>
                      {agentNames.length > 0 && (
                        <optgroup label="Agents">
                          {agentNames.map((agent) => (
                            <option key={`agent:${agent}`} value={`agent:${agent}`}>@{agent}</option>
                          ))}
                        </optgroup>
                      )}
                      {channels.length > 0 && (
                        <optgroup label="Channels">
                          {channels.map((channel) => (
                            <option key={`channel:${channel}`} value={`channel:${channel}`}>#{channel}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setVisibility(integration, !visible)}
                    className={`flex h-8 items-center gap-2 rounded-md border px-3 text-xs transition-colors disabled:opacity-40 ${
                      visible
                        ? 'border-[var(--pear-accent-dim)] text-[var(--pear-accent-bright)] hover:bg-[var(--pear-bg-overlay)]'
                        : 'border-[var(--pear-border)] text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]'
                    }`}
                    aria-pressed={visible}
                  >
                    {visible ? <Eye size={13} /> : <EyeOff size={13} />}
                    {visible ? 'Visible' : 'Hidden'}
                  </button>
                </div>

                {scopeEditorOpen && slack && (
                  <div className="pl-0 md:pl-8">
                    <SlackChannelPicker
                      provider="slack"
                      disabled={busy}
                      initialSelectedIds={selectedSlackSourceIds}
                      listAccessibleResources={() => listSlackChannelResources(integration)}
                      onChange={setPendingScopeValue}
                    />
                    <label className="mt-3 flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-4 py-3">
                      <input
                        type="checkbox"
                        checked={slackListenDms}
                        disabled={busy}
                        onChange={(event) => setPendingSlackListenDms(event.target.checked)}
                        className="h-4 w-4 accent-[var(--pear-accent)]"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-[var(--pear-text)]">Direct messages</span>
                        <span className="block text-xs text-[var(--pear-text-faint)]">Listen for Slack DMs</span>
                      </span>
                    </label>
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setScopeEditorIntegrationId(null)
                          setPendingScopeValue(null)
                          setPendingSlackListenDms(null)
                        }}
                        className="h-8 rounded-md border border-[var(--pear-border)] px-3 text-xs text-[var(--pear-text-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy || !slackScopeDirty}
                        onClick={() => void saveSlackSourceChannels(integration)}
                        className="flex h-8 items-center gap-2 rounded-md border border-[var(--pear-accent-dim)] px-3 text-xs text-[var(--pear-accent-bright)] hover:bg-[var(--pear-bg-overlay)] disabled:opacity-40"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </Section>
  )
}

export function ProjectSettings(): React.ReactNode {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeRootId = useProjectStore((s) => s.activeRootId)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const setActiveRoot = useProjectStore((s) => s.setActiveRoot)
  const setActiveChannel = useProjectStore((s) => s.setActiveChannel)
  const updateProject = useProjectStore((s) => s.updateProject)
  const removeProject = useProjectStore((s) => s.removeProject)
  const addRoot = useProjectStore((s) => s.addRoot)
  const removeRoot = useProjectStore((s) => s.removeRoot)
  const addChannel = useProjectStore((s) => s.addChannel)
  const removeChannel = useProjectStore((s) => s.removeChannel)
  const addIntegration = useProjectStore((s) => s.addIntegration)
  const removeIntegration = useProjectStore((s) => s.removeIntegration)
  const allAgents = useAgentStore((s) => s.agents)
  const openDialog = useUIStore((s) => s.openDialog)
  const openTab = useUIStore((s) => s.openTab)
  const closeActiveTab = useUIStore((s) => s.closeActiveTab)
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === activeProjectId),
    [activeProjectId, projects]
  )
  const agents = useMemo(
    () => allAgents.filter((agent) => agent.projectId === project?.id),
    [allAgents, project?.id]
  )

  const [draftName, setDraftName] = useState('')
  const [channelName, setChannelName] = useState('')
  const [integrationName, setIntegrationName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraftName(project?.name || '')
    setError(null)
  }, [project?.id, project?.name])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await operation()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)] px-8">
        <div className="text-center">
          <Settings size={24} className="mx-auto mb-3 text-[var(--pear-text-faint)]" />
          <div className="text-sm text-[var(--pear-text-dim)]">No project selected</div>
          <button
            type="button"
            onClick={() => openDialog('add-project')}
            className="mt-4 rounded-lg border border-[var(--pear-border)] px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
          >
            Add project
          </button>
        </div>
      </div>
    )
  }

  const selectedRootId =
    activeRootId && project.roots.some((root) => root.id === activeRootId)
      ? activeRootId
      : project.roots.find((root) => root.path === project.rootPath)?.id || project.roots[0]?.id
  const nameChanged = draftName.trim() !== project.name && draftName.trim().length > 0

  return (
    <div className="h-full overflow-y-auto bg-[var(--pear-bg)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-7 px-8 py-8">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">
              <Settings size={13} />
              Project settings
            </div>
            <h1 className="truncate text-2xl font-semibold text-[var(--pear-text)]">{project.name}</h1>
            <div className="mt-4 flex flex-wrap gap-2">
              <StatPill icon={Folder} label="Roots" value={project.roots.length} />
              <StatPill icon={Hash} label="Channels" value={project.channels.length} />
              <StatPill icon={Bot} label="Agents" value={agents.length} />
              <StatPill icon={Plug} label="Integrations" value={project.integrations.length} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => openDialog('add-project')}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
            >
              <Plus size={14} />
              Add project
            </button>
            <IconButton label="Close settings" onClick={closeActiveTab}>
              <X size={16} />
            </IconButton>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
            {error}
          </div>
        )}

        <Section title="General">
          <div className="grid max-w-2xl gap-4">
            <form
              className="flex items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void run(() => updateProject(project.id, { name: draftName.trim() }))
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="mb-1.5 block text-xs text-[var(--pear-text-faint)]">Name</span>
                <input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  className="h-10 w-full rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
                />
              </label>
              <button
                type="submit"
                disabled={!nameChanged}
                className="flex h-10 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
              >
                <Check size={14} />
                Save
              </button>
            </form>

            <label className="max-w-sm">
              <span className="mb-1.5 block text-xs text-[var(--pear-text-faint)]">Cloud agent workspace</span>
              <select
                value={cloudAgentWorkspaceMode(project)}
                onChange={(event) =>
                  void run(() =>
                    updateProject(project.id, {
                      cloudAgentWorkspaceMode: event.target.value as CloudAgentWorkspaceMode
                    })
                  )
                }
                className="h-10 w-full rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)]"
              >
                <option value="git-overlay">Git + live sync</option>
                <option value="git">Git - pull after run</option>
                <option value="relayfile">Relayfile - live sync</option>
              </select>
            </label>
          </div>
        </Section>

        <Section
          title="Roots"
          action={
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await addRoot()
                })
              }
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
            >
              <Plus size={13} />
              Add root
            </button>
          }
        >
          <div className="space-y-2">
            {project.roots.map((root) => (
              <RootRow
                key={root.id}
                root={root}
                selected={selectedRootId === root.id}
                removable={project.roots.length > 1}
                onSelect={() => setActiveRoot(root.id)}
                onRemove={() => {
                  if (!window.confirm("Remove this root from the project? This won't delete any files.")) return
                  void run(() => removeRoot(root.id))
                }}
              />
            ))}
          </div>
        </Section>

        <Section title="Channels">
          <form
            className="mb-3 flex max-w-lg items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const name = normalizeChannelName(channelName)
              if (!name) return
              void run(async () => {
                await addChannel(name)
                setActiveChannel(name)
                openTab({ kind: 'channel', projectId: project.id, channelName: name })
                setChannelName('')
              })
            }}
          >
            <input
              value={channelName}
              onChange={(event) => setChannelName(normalizeChannelName(event.target.value))}
              placeholder="channel-name"
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
            />
            <button
              type="submit"
              disabled={!channelName.trim()}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
            >
              <Plus size={13} />
              Add
            </button>
          </form>
          <div className="flex flex-wrap gap-2">
            {project.channels.map((channel) => (
              <div
                key={channel}
                className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm ${
                  activeChannelName === channel
                    ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                    : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] text-[var(--pear-text-dim)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveChannel(channel)
                    openTab({ kind: 'channel', projectId: project.id, channelName: channel })
                  }}
                  className="flex items-center gap-1.5"
                >
                  <Hash size={13} />
                  <span>{channel}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void run(() => removeChannel(channel))}
                  className="rounded-full p-0.5 text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-red)]"
                  title={`Remove channel ${channel}`}
                  aria-label={`Remove channel ${channel}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Agents"
          action={
            <button
              type="button"
              onClick={() => openDialog('spawn-agent')}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
            >
              <Plus size={13} />
              Add agent
            </button>
          }
        >
          <div className="space-y-2">
            {agents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-faint)]">
                No agents
              </div>
            ) : (
              agents.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      agent.status === 'running' ? 'bg-[var(--pear-accent-bright)]' : 'bg-[var(--pear-text-faint)]'
                    }`}
                  />
                  <AgentHarnessIcon
                    cli={agent.cli}
                    className="h-3.5 w-3.5 shrink-0 text-[var(--pear-text-faint)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--pear-text)]">{agent.name}</span>
                  <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-text-dim)]">
                    {agent.cli}
                  </span>
                </div>
              ))
            )}
          </div>
        </Section>

        <ProactiveAgentsSection projectId={project.id} />

        <Section title="Integrations">
          <form
            className="mb-3 flex max-w-lg items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const name = integrationName.trim()
              if (!name) return
              void run(async () => {
                await addIntegration(name)
                setIntegrationName('')
              })
            }}
          >
            <input
              value={integrationName}
              onChange={(event) => setIntegrationName(event.target.value)}
              placeholder="Integration name"
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
            />
            <button
              type="submit"
              disabled={!integrationName.trim()}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
            >
              <Plus size={13} />
              Add
            </button>
          </form>
          <div className="space-y-2">
            {project.integrations.map((integration) => (
              <div
                key={integration.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5"
              >
                <Plug size={15} className="text-[var(--pear-text-faint)]" />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--pear-text)]">{integration.name}</span>
                <span className="rounded-full bg-[var(--pear-bg-overlay)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--pear-text-dim)]">
                  {integration.type}
                </span>
                <IconButton
                  label={`Remove integration ${integration.name}`}
                  onClick={() => void run(() => removeIntegration(integration.id))}
                  variant="danger"
                >
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        </Section>

        <IntegrationVisibilitySection
          projectId={project.id}
          channels={project.channels}
          agentNames={agents.map((agent) => agent.name)}
        />

        <Section title="Danger">
          <button
            type="button"
            onClick={() => {
              if (!window.confirm(`Delete project "${project.name}"? This won't delete any files.`)) return
              void run(async () => {
                await removeProject(project.id)
                closeActiveTab()
              })
            }}
            className="flex items-center gap-2 rounded-lg border border-[var(--pear-red)]/30 px-4 py-2.5 text-sm text-[var(--pear-red)] hover:bg-[var(--pear-red)]/10"
          >
            <Trash2 size={14} />
            Delete project
          </button>
        </Section>
      </div>
    </div>
  )
}
