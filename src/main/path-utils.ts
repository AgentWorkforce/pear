import { statSync } from 'fs'

function getStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

export function isDirectory(path: string): boolean {
  return getStat(path)?.isDirectory() ?? false
}

export function assertDirectory(path: string, label = 'Path'): void {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`${label} no longer exists: ${path}`)
    }
    throw new Error(`${label} cannot be accessed: ${path}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`)
  }
}
