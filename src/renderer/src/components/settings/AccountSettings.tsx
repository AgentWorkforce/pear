import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FolderOpen,
  Loader2,
  Moon,
  Plug,
  RefreshCcw,
  Settings,
  Sun,
  Trash2,
  X
} from 'lucide-react'
import {
  pear,
  type ConnectedIntegration,
  type FsDirEntry,
  type FsReadPreviewResult,
  type IntegrationAdapter,
  type IntegrationConnectSession
} from '@/lib/ipc'
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

type IntegrationMountBrowserApi = {
  listMountDir?: (projectId: string, integrationId: string, dirPath: string) => Promise<FsDirEntry[]>
  readMountPreview?: (projectId: string, integrationId: string, filePath: string) => Promise<FsReadPreviewResult>
}

const PRELOAD_RESTART_MESSAGE = 'Restart Pear to load the Relayfile browser bridge.'

function integrationMountBrowserApi(): IntegrationMountBrowserApi {
  return pear.integrations as unknown as IntegrationMountBrowserApi
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function pathName(path: string): string {
  const parts = normalizeFsPath(path).split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

function rootLabel(path: string): string {
  const parts = normalizeFsPath(path).split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  const parent = parts[parts.length - 2]
  if (parent === 'discovery' && last) return `discovery/${last}`
  return last || path
}

function pathParent(path: string): string | null {
  const normalized = normalizeFsPath(path).replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return null
  return path.slice(0, index)
}

function pathWithinRoot(root: string, path: string): boolean {
  const normalizedRoot = normalizeFsPath(root).replace(/\/+$/, '')
  const normalizedPath = normalizeFsPath(path)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function rootForPath(roots: string[], path: string | null): string | null {
  if (!path) return roots[0] || null
  return roots.find((root) => pathWithinRoot(root, path)) || roots[0] || null
}

function relativeMountPath(root: string | null, path: string | null): string {
  if (!root || !path) return ''
  const normalizedRoot = normalizeFsPath(root).replace(/\/+$/, '')
  const normalizedPath = normalizeFsPath(path)
  if (normalizedPath === normalizedRoot) return '/'
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? `/${normalizedPath.slice(normalizedRoot.length + 1)}`
    : normalizedPath
}

function canBrowseSyncedData(integration: ConnectedIntegration): boolean {
  return integration.downloadHistoricalData === true
}

function localPathSegments(path: string): string[] {
  return path.split(/[\\/]+/u).filter(Boolean)
}

function historicalLocalMountPaths(integration: ConnectedIntegration): string[] {
  return (integration.localMountPaths || [])
    .filter((root) => !localPathSegments(root).includes('discovery'))
}

function IntegrationRelayfileBrowser({
  roots,
  currentPath,
  entries,
  preview,
  loading,
  error,
  onOpenDirectory,
  onOpenFile,
  onRefresh
}: {
  roots: string[]
  currentPath: string | null
  entries: FsDirEntry[]
  preview: { path: string; result: FsReadPreviewResult } | null
  loading: boolean
  error: string | null
  onOpenDirectory: (path: string) => void
  onOpenFile: (path: string) => void
  onRefresh: () => void
}): React.ReactNode {
  const currentRoot = rootForPath(roots, currentPath)
  const parent = currentPath ? pathParent(currentPath) : null
  const canGoUp = !!parent && !!currentRoot && pathWithinRoot(currentRoot, parent)

  return (
    <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--pear-border-subtle)] px-3 py-2">
        <FolderOpen size={14} className="text-[var(--pear-accent-bright)]" />
        <div className="min-w-0 flex-1 truncate text-xs text-[var(--pear-text-dim)]">
          {relativeMountPath(currentRoot, currentPath) || 'Relayfile mount'}
        </div>
        {roots.length > 1 && (
          <div className="flex max-w-full gap-1 overflow-x-auto">
            {roots.map((root) => (
              <button
                key={root}
                type="button"
                onClick={() => onOpenDirectory(root)}
                className={`h-7 shrink-0 rounded-md border px-2 text-xs ${
                  currentRoot === root
                    ? 'border-[var(--pear-accent-dim)] text-[var(--pear-accent-bright)]'
                    : 'border-[var(--pear-border)] text-[var(--pear-text-faint)] hover:text-[var(--pear-text)]'
                }`}
                title={root}
              >
                {rootLabel(root)}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onRefresh}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
          title="Refresh"
          aria-label="Refresh"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />}
        </button>
      </div>

      {error ? (
        <div className="px-3 py-3 text-sm text-[var(--pear-red)]">{error}</div>
      ) : roots.length === 0 ? (
        <div className="px-3 py-3 text-sm text-[var(--pear-text-faint)]">Relayfile mount is not available.</div>
      ) : (
        <div className="grid min-h-[280px] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="border-b border-[var(--pear-border-subtle)] md:border-b-0 md:border-r">
            <div className="max-h-80 overflow-auto p-2">
              {canGoUp && parent && (
                <button
                  type="button"
                  onClick={() => onOpenDirectory(parent)}
                  className="mb-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
                >
                  <ChevronRight size={13} className="-rotate-90" />
                  ..
                </button>
              )}
              {entries.length === 0 && !loading ? (
                <div className="px-2 py-6 text-center text-xs text-[var(--pear-text-faint)]">Empty directory</div>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => entry.type === 'directory' ? onOpenDirectory(entry.path) : onOpenFile(entry.path)}
                    className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
                    title={entry.path}
                  >
                    {entry.type === 'directory'
                      ? <FolderOpen size={13} className="shrink-0 text-[var(--pear-accent-bright)]" />
                      : <File size={13} className="shrink-0 text-[var(--pear-text-faint)]" />}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="min-w-0 p-3">
            {!preview ? (
              <div className="flex h-full min-h-40 items-center justify-center text-xs text-[var(--pear-text-faint)]">
                Select a file
              </div>
            ) : preview.result.kind === 'text' ? (
              <div className="min-w-0">
                <div className="mb-2 truncate text-xs text-[var(--pear-text-faint)]" title={preview.path}>
                  {pathName(preview.path)} · {preview.result.size} bytes
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--pear-bg)] p-3 text-xs leading-5 text-[var(--pear-text-dim)]">
                  {preview.result.content}
                </pre>
              </div>
            ) : (
              <div className="rounded-md border border-[var(--pear-border-subtle)] px-3 py-2 text-xs text-[var(--pear-text-faint)]">
                {preview.result.kind === 'too-large'
                  ? `File is too large to preview (${preview.result.size} bytes).`
                  : preview.result.kind === 'binary'
                    ? `Binary file (${preview.result.size} bytes).`
                    : preview.result.content}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
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
  const [expandedIntegrationId, setExpandedIntegrationId] = useState<string | null>(null)
  const [browserPath, setBrowserPath] = useState<string | null>(null)
  const [browserEntries, setBrowserEntries] = useState<FsDirEntry[]>([])
  const [browserPreview, setBrowserPreview] = useState<{ path: string; result: FsReadPreviewResult } | null>(null)
  const [browserLoading, setBrowserLoading] = useState(false)
  const [browserError, setBrowserError] = useState<string | null>(null)
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

  useEffect(() => {
    if (!expandedIntegrationId) return
    const expanded = connected.find((integration) => integration.integrationId === expandedIntegrationId)
    if (expanded && canBrowseSyncedData(expanded)) return

    setExpandedIntegrationId(null)
    setBrowserPath(null)
    setBrowserEntries([])
    setBrowserPreview(null)
    setBrowserError(null)
  }, [connected, expandedIntegrationId])

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

  const openMountDirectory = useCallback(async (integration: ConnectedIntegration, dirPath: string) => {
    if (!activeProjectId) {
      setBrowserError('Select a project before browsing an integration.')
      return
    }

    const mountApi = integrationMountBrowserApi()
    if (typeof mountApi.listMountDir !== 'function') {
      setBrowserEntries([])
      setBrowserPreview(null)
      setBrowserLoading(false)
      setBrowserError(PRELOAD_RESTART_MESSAGE)
      return
    }

    setBrowserLoading(true)
    setBrowserError(null)
    setBrowserPreview(null)
    try {
      const entries = await mountApi.listMountDir(activeProjectId, integration.integrationId, dirPath)
      setExpandedIntegrationId(integration.integrationId)
      setBrowserPath(dirPath)
      setBrowserEntries(entries)
    } catch (err) {
      setBrowserEntries([])
      setBrowserError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrowserLoading(false)
    }
  }, [activeProjectId])

  const openMountPreview = useCallback(async (integration: ConnectedIntegration, filePath: string) => {
    if (!activeProjectId) {
      setBrowserError('Select a project before browsing an integration.')
      return
    }

    const mountApi = integrationMountBrowserApi()
    if (typeof mountApi.readMountPreview !== 'function') {
      setBrowserPreview(null)
      setBrowserLoading(false)
      setBrowserError(PRELOAD_RESTART_MESSAGE)
      return
    }

    setBrowserLoading(true)
    setBrowserError(null)
    try {
      const result = await mountApi.readMountPreview(activeProjectId, integration.integrationId, filePath)
      setBrowserPreview({ path: filePath, result })
    } catch (err) {
      setBrowserPreview(null)
      setBrowserError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrowserLoading(false)
    }
  }, [activeProjectId])

  const toggleMountBrowser = useCallback((integration: ConnectedIntegration) => {
    if (!canBrowseSyncedData(integration)) return

    const roots = historicalLocalMountPaths(integration)
    if (expandedIntegrationId === integration.integrationId) {
      setExpandedIntegrationId(null)
      setBrowserPath(null)
      setBrowserEntries([])
      setBrowserPreview(null)
      setBrowserError(null)
      return
    }

    const root = roots[0]
    setExpandedIntegrationId(integration.integrationId)
    setBrowserPath(root || null)
    setBrowserEntries([])
    setBrowserPreview(null)
    setBrowserError(root ? null : 'Relayfile mount is not available for this integration.')
    if (root) void openMountDirectory(integration, root)
  }, [expandedIntegrationId, openMountDirectory])

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
            <span className="text-xs text-[var(--pear-text-faint)]">{loading ? 'Loading' : connected.length}</span>
          </div>
          <div className="space-y-2">
            {loading && connected.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-faint)]">
                <Loader2 size={13} className="animate-spin" />
                Loading integrations
              </div>
            ) : connected.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-3 text-sm text-[var(--pear-text-faint)]">
                No integrations connected
              </div>
            ) : (
              connected.map((integration) => {
                const adapter = adapterByProvider.get(canonicalProviderKey(integration.provider))
                const expanded = expandedIntegrationId === integration.integrationId
                const browsable = canBrowseSyncedData(integration)
                const browserRoots = historicalLocalMountPaths(integration)
                return (
                  <div key={integration.integrationId} className="space-y-2">
                    <div className="flex items-center gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5">
                      {browsable ? (
                        <button
                          type="button"
                          onClick={() => toggleMountBrowser(integration)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          aria-expanded={expanded}
                        >
                          {expanded
                            ? <ChevronDown size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
                            : <ChevronRight size={14} className="shrink-0 text-[var(--pear-text-faint)]" />}
                          <IntegrationLogo iconUrl={adapter?.iconUrl} label={adapter?.displayName || integration.provider} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm text-[var(--pear-text)]">{adapter?.displayName || integration.provider}</span>
                              <CheckCircle2 size={13} className="shrink-0 text-[var(--pear-accent-bright)]" />
                            </div>
                            {integration.mountPaths.length > 0 && (
                              <div className="truncate text-xs text-[var(--pear-text-faint)]">
                                {integration.mountPaths.join(', ')}
                              </div>
                            )}
                            {integration.localMountPaths && integration.localMountPaths.length > 0 && (
                              <div className="truncate text-[11px] text-[var(--pear-text-faint)]">
                                {integration.localMountPaths.join(', ')}
                              </div>
                            )}
                          </div>
                        </button>
                      ) : (
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <IntegrationLogo iconUrl={adapter?.iconUrl} label={adapter?.displayName || integration.provider} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm text-[var(--pear-text)]">{adapter?.displayName || integration.provider}</span>
                              <CheckCircle2 size={13} className="shrink-0 text-[var(--pear-accent-bright)]" />
                            </div>
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        disabled={busyProvider === integration.provider}
                        onClick={() => void disconnect(integration)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--pear-red)] hover:bg-[var(--pear-red)]/10 disabled:opacity-40"
                        title={`Disconnect ${integration.provider}`}
                        aria-label={`Disconnect ${integration.provider}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {expanded && browsable && (
                      <IntegrationRelayfileBrowser
                        roots={browserRoots}
                        currentPath={browserPath}
                        entries={browserEntries}
                        preview={browserPreview}
                        loading={browserLoading}
                        error={browserError}
                        onOpenDirectory={(path) => void openMountDirectory(integration, path)}
                        onOpenFile={(path) => void openMountPreview(integration, path)}
                        onRefresh={() => {
                          const root = browserRoots[0] || null
                          if (browserPath) {
                            void openMountDirectory(integration, browserPath)
                          } else if (root) {
                            void openMountDirectory(integration, root)
                          }
                        }}
                      />
                    )}
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
