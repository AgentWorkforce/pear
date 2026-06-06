const SLACK_WRITEBACK_COLLECTIONS = new Set(['channels', 'dms', 'users'])

function normalizeRemotePath(path: string): string | null {
  if (typeof path !== 'string') return null
  const segments = path
    .trim()
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return segments.length > 0 ? `/${segments.join('/')}` : '/'
}

export function isSlackProvider(provider: string): boolean {
  if (typeof provider !== 'string') return false
  const normalized = provider.trim().toLowerCase()
  return normalized === 'slack' || normalized.startsWith('slack-')
}

function normalizedProviderRoot(provider: string): string | null {
  if (!isSlackProvider(provider)) return null
  const normalized = normalizeRemotePath(provider)
  return normalized ? normalized.slice(1).toLowerCase() : null
}

export function slackWritebackCommandMountPathFor(provider: string, mountPath: string): string | null {
  const providerRoot = normalizedProviderRoot(provider)
  if (!providerRoot) return null
  const normalized = normalizeRemotePath(mountPath)
  if (!normalized) return null
  const segments = normalized.split('/').slice(1)
  if (segments[0]?.toLowerCase() !== providerRoot) return null

  const collection = segments[1]
  if (!SLACK_WRITEBACK_COLLECTIONS.has(collection)) return null

  if (segments.length === 3) {
    return `${normalized}/messages`
  }
  if (segments.length === 4 && segments[3] === 'messages') {
    return normalized
  }
  if (segments.length === 5 && segments[3] === 'threads') {
    return `${normalized}/replies`
  }
  if (segments.length === 6 && segments[3] === 'threads' && segments[5] === 'replies') {
    return normalized
  }
  return null
}

export function isSlackWritebackCommandRoot(remotePath: string): boolean {
  const normalized = normalizeRemotePath(remotePath)
  const provider = normalized?.split('/').filter(Boolean)[0]
  return normalized !== null &&
    typeof provider === 'string' &&
    slackWritebackCommandMountPathFor(provider, remotePath) === normalized
}
