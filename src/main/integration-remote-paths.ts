export function normalizeRemoteDirectoryPath(remotePath: string): string | null {
  const segments = remotePath.split('/').map((segment) => segment.trim()).filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return `/${segments.join('/')}`
}

export function remotePathName(remotePath: string): string {
  const segments = remotePath.split('/').filter(Boolean)
  return segments[segments.length - 1] || remotePath
}

export function isRelayfilePathWithinRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = rootPath.trim().replace(/\/+$/, '') || '/'
  const normalizedTarget = targetPath.trim().replace(/\/+$/, '') || '/'
  if (normalizedRoot === '/') return normalizedTarget === '/' || normalizedTarget.startsWith('/')
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

function isImmediateNonDiscoveryParent(parentPath: string, childPath: string): boolean {
  const normalizedParent = parentPath.trim().replace(/\/+$/, '') || '/'
  const normalizedChild = childPath.trim().replace(/\/+$/, '') || '/'
  if (normalizedChild.startsWith('/discovery/')) return false
  if (normalizedParent === '/' || normalizedParent === normalizedChild) return false
  if (!normalizedChild.startsWith(`${normalizedParent}/`)) return false
  return normalizedChild.slice(normalizedParent.length + 1).split('/').length === 1
}

export function canListRemoteDirectoryForMountPaths(remotePath: string, mountPaths: string[]): boolean {
  return mountPaths.some((mountPath) =>
    isRelayfilePathWithinRoot(mountPath, remotePath) ||
    isImmediateNonDiscoveryParent(remotePath, mountPath)
  )
}

export function canShowRemoteDirectoryEntryForMountPaths(entryPath: string, mountPaths: string[]): boolean {
  return mountPaths.some((mountPath) =>
    isRelayfilePathWithinRoot(mountPath, entryPath) ||
    isRelayfilePathWithinRoot(entryPath, mountPath)
  )
}

// Slack direct-message and per-user message paths are delivered as events when
// DM listening is enabled (SLACK_DM_EVENT_GLOBS: /slack/users/*/messages/** and
// /slack/channels/D*/**), but they are not part of the canonical channel mount
// paths, so the mount-path scope checks above reject them. This predicate
// recognizes exactly those event-subscribed DM roots so list/read can be
// allowed when (and only when) DM listening is on, without widening scope to
// non-DM channels. The "D" prefix on a channel segment is Slack's DM channel
// convention, which a plain root path cannot express.
export function isSlackDmListablePath(remotePath: string): boolean {
  const segments = (remotePath || '').trim().replace(/\/+$/, '').split('/').filter(Boolean)
  if (segments[0] !== 'slack') return false
  if (segments[1] === 'users') return true
  if (segments[1] === 'channels' && /^D/u.test(segments[2] ?? '')) return true
  return false
}
