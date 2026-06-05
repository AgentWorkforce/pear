export function normalizeRemoteDirectoryPath(remotePath: string): string | null {
  const segments = remotePath.split('/').map((segment) => segment.trim()).filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return `/${segments.join('/')}`
}

export function remotePathName(remotePath: string): string {
  return remotePath.split('/').filter(Boolean).at(-1) || remotePath
}

export function isRelayfilePathWithinRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = rootPath.trim().replace(/\/+$/u, '') || '/'
  const normalizedTarget = targetPath.trim().replace(/\/+$/u, '') || '/'
  if (normalizedRoot === '/') return normalizedTarget === '/' || normalizedTarget.startsWith('/')
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

export function canListRemoteDirectoryForMountPaths(remotePath: string, mountPaths: string[]): boolean {
  return mountPaths.some((mountPath) => isRelayfilePathWithinRoot(mountPath, remotePath))
}
