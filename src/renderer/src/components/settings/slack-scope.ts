import type { IntegrationAccessibleResource } from './scope-pickers/GenericScopePicker'

// Pure helpers for Slack scope/mount-path handling, kept free of React so they
// can be unit-tested directly. Two Slack source surfaces share one mountPaths
// array on the integration: channels (`/slack/channels/<C…>`) and 1:1 DM
// recipients (`/slack/users/<U…>/messages`). The DM model is user-recipient
// based — we never emit raw `/slack/channels/D…` or `/slack/dms/<D…>` product
// mounts, and never suffixed `/slack/users/<U…>__<slug>` segments, because the
// relayfile adapter writeback extraction and Cloud scope aliasing only bridge
// channel suffixes today, not user suffixes.

function resourceField(resource: IntegrationAccessibleResource, ...keys: Array<keyof IntegrationAccessibleResource>): string {
  for (const key of keys) {
    const value = resource[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function resourceMeta(resource: IntegrationAccessibleResource, ...keys: string[]): string {
  for (const key of keys) {
    const value = resource.metadata?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Bare Slack user id (`U…`) for a DM-recipient resource. Cloud `users` options
 *  already normalize to bare ids; we never emit a suffixed `U…__slug`. */
export function slackDmUserId(resource: IntegrationAccessibleResource): string {
  return resourceMeta(resource, 'userId') || resourceField(resource, 'id', 'slug', 'key', 'name')
}

/** Mount segment appended to `/slack/users` → `<U…>/messages`, yielding the
 *  canonical 1:1 DM path `/slack/users/<U…>/messages`. Empty when no id. */
export function slackDmMountSegment(resource: IntegrationAccessibleResource): string {
  const id = slackDmUserId(resource)
  return id ? `${id}/messages` : ''
}

/** Map a Cloud `users` option into a scope-picker resource (bare `U…` id). */
export function slackUserResourceFromOption(option: {
  value: string
  label: string
  hint?: string
}): IntegrationAccessibleResource {
  const id = option.value.trim()
  const name = option.label.replace(/^@/u, '').trim() || id
  return {
    id,
    displayName: option.label,
    name,
    metadata: {
      userId: id,
      ...(option.hint ? { hint: option.hint } : {})
    }
  }
}

export function isSlackChannelMountPath(path: string): boolean {
  return /^\/slack\/channels(?:\/|$)/u.test(path.trim())
}

export function isSlackUserMessagesMountPath(path: string): boolean {
  return /^\/slack\/users\/[^/]+\/messages(?:\/|$)/u.test(path.trim())
}

/**
 * Merge the channel and DM-recipient halves of a Slack integration's mountPaths.
 * Each picker emits the full set of paths for its own surface, so a `null` half
 * means "unchanged — keep what's already on the integration." Non-Slack and
 * non-channel/non-user paths (e.g. `/discovery/slack`) are always preserved.
 * Result is order-stable and de-duplicated.
 */
export function mergeSlackScopeMountPaths(args: {
  existing: string[]
  channelPaths: string[] | null
  dmPaths: string[] | null
}): string[] {
  const { existing, channelPaths, dmPaths } = args
  const resolvedChannelPaths = channelPaths ?? existing.filter(isSlackChannelMountPath)
  const resolvedDmPaths = dmPaths ?? existing.filter(isSlackUserMessagesMountPath)
  const preserved = existing.filter(
    (path) => !isSlackChannelMountPath(path) && !isSlackUserMessagesMountPath(path)
  )

  const merged: string[] = []
  const seen = new Set<string>()
  for (const path of [...preserved, ...resolvedChannelPaths, ...resolvedDmPaths]) {
    const trimmed = path?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    merged.push(trimmed)
  }
  return merged
}
