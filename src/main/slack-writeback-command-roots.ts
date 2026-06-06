const SLACK_WRITEBACK_COLLECTIONS = new Set(['channels', 'dms', 'users'])

function normalizeRemotePath(path: string): string {
  const segments = path
    .trim()
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  return segments.length > 0 ? `/${segments.join('/')}` : '/'
}

function isSlackProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase()
  return normalized === 'slack' || normalized.startsWith('slack-')
}

export function slackWritebackCommandMountPathFor(provider: string, mountPath: string): string | null {
  if (!isSlackProvider(provider)) return null
  const normalized = normalizeRemotePath(mountPath)
  const segments = normalized.split('/').filter(Boolean)
  if (segments[0] !== 'slack') return null

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
  return slackWritebackCommandMountPathFor('slack', remotePath) === normalizeRemotePath(remotePath)
}
