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
