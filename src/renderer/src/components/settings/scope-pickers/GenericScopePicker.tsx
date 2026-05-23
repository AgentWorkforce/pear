import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type IntegrationAccessibleResource = {
  id?: string
  name?: string
  displayName?: string
  title?: string
  key?: string
  slug?: string
  path?: string
  type?: string
  kind?: string
  metadata?: Record<string, unknown>
}

export type ScopePickerValue = {
  scope: Record<string, unknown>
  mountPaths: string[]
}

export type ScopePickerProps = {
  provider: string
  listAccessibleResources: () => Promise<IntegrationAccessibleResource[]>
  initialSelectedIds?: string[]
  disabled?: boolean
  onChange: (value: ScopePickerValue) => void
}

type GenericScopePickerProps = ScopePickerProps & {
  title?: string
  resourceNoun?: string
  baseMountPath?: string
  scopeKey?: string
  getResourceLabel?: (resource: IntegrationAccessibleResource) => string
  getResourceDescription?: (resource: IntegrationAccessibleResource) => string
  getResourceMountSegment?: (resource: IntegrationAccessibleResource) => string
  getResourceScopeId?: (resource: IntegrationAccessibleResource) => string
}

export function resourceText(
  resource: IntegrationAccessibleResource,
  ...keys: Array<keyof IntegrationAccessibleResource>
): string {
  for (const key of keys) {
    const value = resource[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function metadataText(resource: IntegrationAccessibleResource, ...keys: string[]): string {
  for (const key of keys) {
    const value = resource.metadata?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function resourceId(resource: IntegrationAccessibleResource, index: number): string {
  return resourceText(resource, 'id', 'slug', 'key', 'path', 'name', 'displayName', 'title') || `resource-${index}`
}

function normalizeMountSegment(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function buildResourceSummary(resource: IntegrationAccessibleResource, index: number): Record<string, string> {
  return {
    id: resourceId(resource, index),
    label: resourceText(resource, 'displayName', 'title', 'name', 'slug', 'key', 'path', 'id'),
    type: resourceText(resource, 'type', 'kind')
  }
}

export function GenericScopePicker({
  provider,
  listAccessibleResources,
  initialSelectedIds,
  disabled = false,
  onChange,
  title,
  resourceNoun = 'resources',
  baseMountPath = `/integrations/${provider}`,
  scopeKey = 'resources',
  getResourceLabel = (resource) => resourceText(resource, 'displayName', 'title', 'name', 'slug', 'key', 'path', 'id'),
  getResourceDescription = (resource) => resourceText(resource, 'path', 'type', 'kind'),
  getResourceMountSegment = (resource) => resourceText(resource, 'path', 'slug', 'key', 'name', 'id'),
  getResourceScopeId = (resource) => resourceText(resource, 'id', 'slug', 'key', 'path', 'name')
}: GenericScopePickerProps): React.ReactNode {
  const [resources, setResources] = useState<IntegrationAccessibleResource[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialSelectedIds || []))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const onChangeRef = useRef(onChange)
  const getResourceMountSegmentRef = useRef(getResourceMountSegment)
  const getResourceScopeIdRef = useRef(getResourceScopeId)

  onChangeRef.current = onChange
  getResourceMountSegmentRef.current = getResourceMountSegment
  getResourceScopeIdRef.current = getResourceScopeId

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)
    void listAccessibleResources()
      .then((nextResources) => {
        if (cancelled) return
        setResources(nextResources)
        setSelectedIds(
          new Set(
            initialSelectedIds && initialSelectedIds.length > 0
              ? initialSelectedIds
              : nextResources.map(resourceId)
          )
        )
      })
      .catch((err) => {
        if (cancelled) return
        setResources([])
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [initialSelectedIds, listAccessibleResources])

  const selectedResourceEntries = useMemo(
    () =>
      resources
        .map((resource, index) => ({ resource, index }))
        .filter(({ resource, index }) => selectedIds.has(resourceId(resource, index))),
    [resources, selectedIds]
  )

  useEffect(() => {
    if (loading) return

    if (resources.length === 0) {
      onChangeRef.current({
        scope: { provider, selection: 'all', [scopeKey]: [] },
        mountPaths: [baseMountPath]
      })
      return
    }

    onChangeRef.current({
      scope: {
        provider,
        selection: 'selected',
        [scopeKey]: selectedResourceEntries
          .map(({ resource }) => getResourceScopeIdRef.current(resource))
          .filter(Boolean),
        resources: selectedResourceEntries.map(({ resource, index }) =>
          buildResourceSummary(resource, index)
        )
      },
      mountPaths: selectedResourceEntries
        .map(({ resource }) => getResourceMountSegmentRef.current(resource))
        .filter(Boolean)
        .map((segment) => `${baseMountPath}/${normalizeMountSegment(segment)}`)
    })
  }, [
    baseMountPath,
    loading,
    provider,
    resources.length,
    scopeKey,
    selectedResourceEntries
  ])

  const toggleResource = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const allSelected = resources.length > 0 && selectedResourceEntries.length === resources.length

  return (
    <div className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[var(--pear-text)]">{title || `Choose ${resourceNoun}`}</div>
          <div className="mt-0.5 text-xs text-[var(--pear-text-faint)]">
            {loading ? 'Loading' : resources.length === 0 ? 'All selected' : `${selectedResourceEntries.length} selected`}
          </div>
        </div>
        <button
          type="button"
          disabled={disabled || loading || resources.length === 0}
          onClick={() =>
            setSelectedIds(allSelected ? new Set() : new Set(resources.map(resourceId)))
          }
          className="rounded-md px-2.5 py-1.5 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)] disabled:opacity-40"
        >
          {allSelected ? 'Clear' : 'All'}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
          {error}
        </div>
      )}

      <div className="max-h-64 space-y-2 overflow-y-auto">
        {resources.length === 0 && !loading ? (
          <div className="rounded-md border border-dashed border-[var(--pear-border)] px-3 py-2 text-sm text-[var(--pear-text-faint)]">
            All {provider} {resourceNoun}
          </div>
        ) : (
          resources.map((resource, index) => {
            const id = resourceId(resource, index)
            const label = getResourceLabel(resource) || id
            const description = getResourceDescription(resource)

            return (
              <label
                key={id}
                className="flex items-center gap-3 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(id)}
                  disabled={disabled || loading}
                  onChange={() => toggleResource(id)}
                  className="h-4 w-4 accent-[var(--pear-accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--pear-text)]">{label}</span>
                  {description && (
                    <span className="block truncate text-xs text-[var(--pear-text-faint)]">{description}</span>
                  )}
                </span>
              </label>
            )
          })
        )}
      </div>
    </div>
  )
}
