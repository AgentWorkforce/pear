import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, Moon, Plug, RefreshCcw, Settings, Sun, Trash2, X } from 'lucide-react'
import { pear, type ConnectedIntegration, type IntegrationAdapter, type IntegrationConnectSession } from '@/lib/ipc'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

// Renders the provider's Nango logo on a light tile (logos are mostly dark/
// monochrome SVGs, so they need a light backing to stay legible). Falls back to
// a generic plug icon when no logo URL is set or the image fails to load — e.g.
// storage/db backends that have no Nango template logo.
function IntegrationLogo({ iconUrl, label }: { iconUrl?: string; label: string }): React.ReactNode {
  const [failed, setFailed] = useState(false)

  if (!iconUrl || failed) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--pear-bg-overlay)] text-[var(--pear-accent-bright)]">
        <Plug size={16} />
      </div>
    )
  }

  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/95 p-1.5">
      <img
        src={iconUrl}
        alt={`${label} logo`}
        className="h-full w-full object-contain"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

// Relaycast/Nango return connections under auth-template keys
// ("github-app-oauth", "slack-bot", "linear-oauth"), but the catalog uses the
// product slug ("github", "slack", "linear"). Strip the auth suffix so the two
// align. Also map gmail → google-mail to mirror toRelayfileProvider in the
// main process (integrations.ts) — the static catalog uses "gmail" while the
// live cloud catalog uses "google-mail", and the tile lookup needs both to
// collapse to the same key.
function canonicalProviderKey(provider: string): string {
  const normalized = provider.trim().toLowerCase().replace(/-(app-oauth|app|oauth|bot-oauth|bot|api-key|apikey)$/, '')
  return normalized === 'gmail' ? 'google-mail' : normalized
}

function capabilityLabel(adapter: IntegrationAdapter): string {
  const capabilities = [
    adapter.capabilities.webhook ? 'Webhook' : null,
    adapter.capabilities.poll ? 'Polling' : null,
    adapter.capabilities.writeback ? 'Writeback' : null
  ].filter(Boolean)
  return capabilities.join(' / ') || 'Read only'
}

function defaultScope(adapter: IntegrationAdapter): Record<string, unknown> {
  return {
    provider: adapter.provider,
    scopes: adapter.requiredScopes || []
  }
}

type PendingConnect = {
  projectId: string
  provider: string
  sessionId: string
  scope: Record<string, unknown>
  mountPaths: string[]
}

export function AccountSettings(): React.ReactNode {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const closeActiveTab = useUIStore((s) => s.closeActiveTab)
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  const [catalog, setCatalog] = useState<IntegrationAdapter[]>([])
  const [connected, setConnected] = useState<ConnectedIntegration[]>([])
  const [session, setSession] = useState<IntegrationConnectSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pendingConnectRef = useRef<PendingConnect | null>(null)
  const completedConnectSessionsRef = useRef<Set<string>>(new Set())

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [activeProjectId, projects]
  )

  // Connected integrations only carry a provider id; look up the catalog adapter
  // to reuse its logo (and display name) in the connected list.
  const adapterByProvider = useMemo(
    () => new Map(catalog.map((adapter) => [canonicalProviderKey(adapter.provider), adapter])),
    [catalog]
  )

  const connectedProviders = useMemo(
    () => new Set(connected.map((integration) => canonicalProviderKey(integration.provider))),
    [connected]
  )

  const loadConnected = useCallback(async () => {
    if (!activeProjectId) {
      setConnected([])
      return
    }
    setConnected(await pear.integrations.list(activeProjectId))
  }, [activeProjectId])

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const [nextCatalog] = await Promise.all([
        pear.integrations.catalog(),
        loadConnected()
      ])
      setCatalog(nextCatalog)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [loadConnected])

  useEffect(() => {
    void load()
  }, [load])

  const completeSession = useCallback(async (
    completedSession: IntegrationConnectSession,
    pendingConnect: PendingConnect
  ) => {
    if (completedConnectSessionsRef.current.has(completedSession.sessionId)) return

    completedConnectSessionsRef.current.add(completedSession.sessionId)
    setBusyProvider(pendingConnect.provider)
    try {
      await pear.integrations.completeConnect(
        pendingConnect.projectId,
        completedSession.sessionId,
        pendingConnect.scope,
        pendingConnect.mountPaths,
        true
      )
      pendingConnectRef.current = null
      await loadConnected()
    } catch (err) {
      completedConnectSessionsRef.current.delete(completedSession.sessionId)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyProvider(null)
    }
  }, [loadConnected])

  useEffect(() => {
    return pear.integrations.onEvent((event) => {
      if (event.type === 'session-update') {
        const pendingConnect = pendingConnectRef.current
        if (!pendingConnect || pendingConnect.sessionId !== event.sessionId) return

        setSession(event.session)
        if (event.session.status === 'completed' && event.session.integrationId) {
          void completeSession(event.session, pendingConnect)
          return
        }
        if (event.session.status === 'error' || event.session.status === 'expired') {
          pendingConnectRef.current = null
          setBusyProvider(null)
          setError(event.session.error || `Integration connect session is ${event.session.status}`)
        }
        return
      }

      if (event.projectId === activeProjectId) {
        void loadConnected()
      }
    })
  }, [activeProjectId, completeSession, loadConnected])

  const startConnect = useCallback(async (adapter: IntegrationAdapter) => {
    if (!activeProjectId) {
      setError('Select a project before connecting an integration.')
      return
    }

    setError(null)
    setBusyProvider(adapter.provider)
    try {
      const nextSession = await pear.integrations.startConnect(activeProjectId, adapter.provider)
      pendingConnectRef.current = {
        projectId: activeProjectId,
        provider: adapter.provider,
        sessionId: nextSession.sessionId,
        scope: defaultScope(adapter),
        mountPaths: adapter.defaultMountPaths
      }
      setSession(nextSession)
      if (nextSession.status === 'completed' && nextSession.integrationId) {
        await completeSession(nextSession, pendingConnectRef.current)
      }
    } catch (err) {
      pendingConnectRef.current = null
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      const pendingConnect = pendingConnectRef.current
      if (!pendingConnect || pendingConnect.provider !== adapter.provider) {
        setBusyProvider(null)
      }
    }
  }, [activeProjectId, completeSession])

  const disconnect = useCallback(async (integration: ConnectedIntegration) => {
    if (!activeProjectId) return

    setError(null)
    setBusyProvider(integration.provider)
    try {
      await pear.integrations.disconnect(activeProjectId, integration.integrationId)
      await loadConnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyProvider(null)
    }
  }, [activeProjectId, loadConnected])

  return (
    <div className="h-full overflow-y-auto bg-[var(--pear-bg)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-7 px-8 py-8">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">
              <Settings size={13} />
              Account settings
            </div>
            <h1 className="text-2xl font-semibold text-[var(--pear-text)]">Integrations</h1>
            <div className="mt-2 text-sm text-[var(--pear-text-dim)]">
              {activeProject ? activeProject.name : 'No project selected'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
            >
              <RefreshCcw size={14} />
              Refresh
            </button>
            <button
              type="button"
              onClick={closeActiveTab}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--pear-border)] text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
              title="Close account settings"
              aria-label="Close account settings"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
            {error}
          </div>
        )}

        {session && (
          <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2 text-sm text-[var(--pear-text-dim)]">
            {session.provider}: {session.status}
          </div>
        )}

        <section className="border-t border-[var(--pear-border-subtle)] pt-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">Appearance</h2>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm text-[var(--pear-text)]">Theme</div>
              <div className="text-xs text-[var(--pear-text-faint)]">Switch between dark and light mode</div>
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--pear-border-subtle)] p-0.5">
              {(['dark', 'light'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={theme === mode}
                  onClick={() => setTheme(mode)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm capitalize transition-colors ${
                    theme === mode
                      ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                      : 'text-[var(--pear-text-faint)] hover:text-[var(--pear-text-dim)]'
                  }`}
                >
                  {mode === 'dark' ? <Moon size={13} /> : <Sun size={13} />}
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--pear-border-subtle)] pt-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">Connected</h2>
            <span className="text-xs text-[var(--pear-text-faint)]">{connected.length}</span>
          </div>
          <div className="space-y-2">
            {connected.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-faint)]">
                No integrations connected
              </div>
            ) : (
              connected.map((integration) => {
                const adapter = adapterByProvider.get(canonicalProviderKey(integration.provider))
                return (
                <div
                  key={integration.integrationId}
                  className="flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5"
                >
                  <IntegrationLogo iconUrl={adapter?.iconUrl} label={adapter?.displayName || integration.provider} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-[var(--pear-text)]">{adapter?.displayName || integration.provider}</span>
                      <CheckCircle2 size={13} className="shrink-0 text-[var(--pear-accent-bright)]" />
                    </div>
                    <div className="truncate text-xs text-[var(--pear-text-faint)]">
                      {integration.mountPaths.join(', ') || 'No mount paths'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busyProvider === integration.provider}
                    onClick={() => void disconnect(integration)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--pear-red)] hover:bg-[var(--pear-red)]/10 disabled:opacity-40"
                    title={`Disconnect ${integration.provider}`}
                    aria-label={`Disconnect ${integration.provider}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                )
              })
            )}
          </div>
        </section>

        <section className="border-t border-[var(--pear-border-subtle)] pt-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">Catalog</h2>
            <span className="text-xs text-[var(--pear-text-faint)]">{loading ? 'Loading' : catalog.length}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {catalog.map((adapter) => {
              const isConnected = connectedProviders.has(canonicalProviderKey(adapter.provider))
              return (
                <div
                  key={adapter.provider}
                  className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-4"
                >
                  <div className="flex items-start gap-3">
                    <IntegrationLogo iconUrl={adapter.iconUrl} label={adapter.displayName} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-[var(--pear-text)]">{adapter.displayName}</span>
                        {isConnected && (
                          <CheckCircle2 size={13} className="shrink-0 text-[var(--pear-accent-bright)]" />
                        )}
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--pear-text-dim)]">
                        {adapter.description}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="truncate text-xs text-[var(--pear-text-faint)]">{capabilityLabel(adapter)}</span>
                    {isConnected ? (
                      <span className="flex h-8 items-center gap-2 rounded-md border border-[var(--pear-accent-dim)]/40 bg-[var(--pear-accent-bright)]/10 px-3 text-xs text-[var(--pear-accent-bright)]">
                        <CheckCircle2 size={13} />
                        Connected
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!activeProjectId || busyProvider === adapter.provider}
                        onClick={() => void startConnect(adapter)}
                        className="flex h-8 items-center gap-2 rounded-md border border-[var(--pear-border)] px-3 text-xs text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
                      >
                        <ExternalLink size={13} />
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
