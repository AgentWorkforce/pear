export const MAX_FOLDER_HISTORY = 8
const MAX_SUGGESTIONS = 12

function trimFolder(folder: string): string {
  const value = folder.trim()
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

/** Folders used on one machine, newest first; older saves kept a single string. */
export function folderHistory(saved: unknown): string[] {
  const list = typeof saved === 'string' ? [saved] : Array.isArray(saved) ? saved : []
  return [...new Set(list.filter((value): value is string => typeof value === 'string')
    .map(trimFolder).filter((value) => value.startsWith('/')))]
}

/** Folders known for a machine: ones picked here first, then ones the machine reports. */
export function machineFolders(saved: unknown, reported: readonly string[] = []): string[] {
  return folderHistory([...folderHistory(saved), ...reported])
}

export function withFolder(history: string[], folder: string): string[] {
  const value = trimFolder(folder)
  if (!value.startsWith('/')) return history
  return [value, ...history.filter((entry) => entry !== value)].slice(0, MAX_FOLDER_HISTORY)
}

export function parentFolder(folder: string): string | null {
  const value = trimFolder(folder)
  const cut = value.lastIndexOf('/')
  return cut > 0 ? value.slice(0, cut) : null
}

/**
 * Folders to offer on a machine: ones used there before, then each
 * repository the machine is configured for, placed beside those folders
 * (the folder a person keeps one checkout in usually holds the others).
 */
export function folderSuggestions(history: string[], repositories: string[] = []): string[] {
  const parents = [...new Set(history.map(parentFolder).filter((value): value is string => !!value))]
  const repoNames = [...new Set(repositories.map((repo) => repo.split('/').pop()?.trim() ?? '').filter(Boolean))]
  const placed = new Set(history.map((folder) => folder.split('/').pop()))
  const siblings = parents.flatMap((parent) => repoNames.filter((repo) => !placed.has(repo)).map((repo) => `${parent}/${repo}`))
  return [...new Set([...history, ...siblings])].slice(0, MAX_SUGGESTIONS)
}

/** Range of the last path segment, so typing replaces only the project name. */
export function lastSegmentRange(folder: string): [number, number] {
  const end = folder.replace(/\/+$/, '').length
  return [folder.lastIndexOf('/', end - 1) + 1, end]
}
