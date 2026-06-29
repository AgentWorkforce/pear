export const RELAYFILE_BASE_URL = 'https://file.agentrelay.com'
export const RELAYCAST_BASE_URL = 'https://cast.agentrelay.com'

const LEGACY_RELAYFILE_HOSTS = new Set([
  'api.relayfile.dev',
  'relayfile.dev'
])

const LEGACY_RELAYCAST_HOSTS = new Set([
  'api.relaycast.dev',
  'relaycast.dev'
])

export function normalizeRelayfileBaseUrl(value: string | null | undefined): string {
  return normalizeHostedServiceUrl(value, RELAYFILE_BASE_URL, LEGACY_RELAYFILE_HOSTS)
}

export function normalizeRelaycastBaseUrl(value: string | null | undefined): string {
  return normalizeHostedServiceUrl(value, RELAYCAST_BASE_URL, LEGACY_RELAYCAST_HOSTS)
}

export function normalizeRelayServiceEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    RELAYFILE_BASE_URL: normalizeRelayfileBaseUrl(env.RELAYFILE_BASE_URL),
    RELAYCAST_BASE_URL: normalizeRelaycastBaseUrl(env.RELAYCAST_BASE_URL || env.RELAY_BASE_URL),
    RELAY_BASE_URL: normalizeRelaycastBaseUrl(env.RELAY_BASE_URL || env.RELAYCAST_BASE_URL)
  }
}

export function normalizeRelayWorkspaceInfo<T extends {
  info?: {
    relayfileUrl?: string
    relaycastBaseUrl?: string
  }
}>(handle: T): T {
  if (handle.info) {
    handle.info.relayfileUrl = normalizeRelayfileBaseUrl(handle.info.relayfileUrl)
    handle.info.relaycastBaseUrl = normalizeRelaycastBaseUrl(handle.info.relaycastBaseUrl)
  }
  return handle
}

function normalizeHostedServiceUrl(
  value: string | null | undefined,
  canonical: string,
  legacyHosts: Set<string>
): string {
  const trimmed = value?.trim()
  if (!trimmed) return canonical

  try {
    const url = new URL(trimmed)
    if (url.hostname === new URL(canonical).hostname || legacyHosts.has(url.hostname)) {
      return canonical
    }
  } catch {
    return trimmed
  }

  return trimmed.replace(/\/+$/, '')
}
