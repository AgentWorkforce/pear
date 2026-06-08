import type { IntegrationAccessibleResource } from './scope-pickers/GenericScopePicker'

// Pure helpers for Slack scope/mount-path handling, kept free of React so they
// can be unit-tested directly. Two Slack source surfaces share one mountPaths
// array on the integration: channels (`/slack/channels/<C…>`) and 1:1 DM
// recipients (`/slack/users/<U…>/messages`). The DM model is user-recipient
// based — we never emit raw `/slack/channels/D…` or `/slack/dms/<D…>` product
// mounts, and never suffixed `/slack/users/<U…>__<slug>` segments, because the
// relayfile adapter writeback extraction and Cloud scope aliasing only bridge
// channel suffixes today, not user suffixes.

function resourceField(
  resource: IntegrationAccessibleResource | null | undefined,
  ...keys: Array<keyof IntegrationAccessibleResource>
): string {
  if (!resource) return ''
  for (const key of keys) {
    const value = resource[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function resourceMeta(resource: IntegrationAccessibleResource | null | undefined, ...keys: string[]): string {
  if (!resource) return ''
  for (const key of keys) {
    const value = resource.metadata?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Bare Slack user id (`U…`) for a DM-recipient resource. Cloud `users` options
 *  already normalize to bare ids; we never emit a suffixed `U…__slug`. */
export function slackDmUserId(resource: IntegrationAccessibleResource | null | undefined): string {
  return resourceMeta(resource, 'userId') || resourceField(resource, 'id', 'slug', 'key')
}

/** Mount segment appended to `/slack/users` → `<U…>/messages`, yielding the
 *  canonical 1:1 DM path `/slack/users/<U…>/messages`. Empty when no id. */
export function slackDmMountSegment(resource: IntegrationAccessibleResource | null | undefined): string {
  const id = slackDmUserId(resource)
  return id ? `${id}/messages` : ''
}

/** Map a Cloud `users` option into a scope-picker resource (bare `U…` id). */
export function slackUserResourceFromOption(option: {
  value: string
  label: string
  hint?: string
} | null | undefined): IntegrationAccessibleResource {
  const id = option?.value?.trim() ?? ''
  const label = option?.label ?? ''
  const name = label.replace(/^@/u, '').trim() || id
  return {
    id,
    displayName: label,
    name,
    metadata: {
      userId: id,
      ...(option?.hint ? { hint: option.hint } : {})
    }
  }
}

export function isSlackChannelMountPath(path: unknown): path is string {
  return typeof path === 'string' && /^\/slack\/channels(?:\/|$)/u.test(path.trim())
}

export function isSlackUserMessagesMountPath(path: unknown): path is string {
  return typeof path === 'string' && /^\/slack\/users\/[^/]+\/messages(?:\/|$)/u.test(path.trim())
}

/**
 * Merge the channel and DM-recipient halves of a Slack integration's mountPaths.
 * Each picker emits the full set of paths for its own surface, so a `null` half
 * means "unchanged — keep what's already on the integration." Non-Slack and
 * non-channel/non-user paths (e.g. `/discovery/slack`) are always preserved.
 * Result is order-stable and de-duplicated.
 */
export function mergeSlackScopeMountPaths(args: {
  existing: unknown[] | null | undefined
  channelPaths: unknown[] | null
  dmPaths: unknown[] | null
}): string[] {
  const { existing, channelPaths, dmPaths } = args
  const existingPaths = Array.isArray(existing) ? existing : []
  const resolvedChannelPaths = channelPaths ?? existingPaths.filter(isSlackChannelMountPath)
  const resolvedDmPaths = dmPaths ?? existingPaths.filter(isSlackUserMessagesMountPath)
  const preserved = existingPaths.filter(
    (path) => !isSlackChannelMountPath(path) && !isSlackUserMessagesMountPath(path)
  )

  const merged: string[] = []
  const seen = new Set<string>()
  for (const path of [...preserved, ...resolvedChannelPaths, ...resolvedDmPaths]) {
    const trimmed = typeof path === 'string' ? path.trim() : ''
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    merged.push(trimmed)
  }
  return merged
}
