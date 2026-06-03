import { basename, isAbsolute, relative, resolve } from 'path'
import type { Project } from './store'

/**
 * Parse a `pear open <path>` invocation out of a process argv array.
 *
 * Electron argv shape varies by launch mode (packaged: `[exe, ...args]`; dev:
 * `[electron, '.', ...args]`), so rather than relying on fixed positions we scan
 * for the `open` verb and return the next non-flag argument as the target path.
 *
 * A `--` token ends option parsing, so the argument after it is always treated
 * as the path — letting `pear open -- -repo` target a directory named `-repo`.
 */
export function parseOpenCommand(argv: readonly string[]): string | null {
  const openIndex = argv.findIndex((arg) => arg === 'open')
  if (openIndex === -1) return null
  for (let i = openIndex + 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') return argv[i + 1] ?? null
    if (arg.startsWith('-')) continue
    return arg
  }
  return null
}

/**
 * Find the first project that already contains `targetPath` — either as an exact
 * root or nested under one of its roots. Paths are resolved to absolute form so
 * relative inputs (`./my-directory`) match against stored absolute roots.
 */
export function findProjectForPath(projects: readonly Project[], targetPath: string): Project | null {
  const resolved = resolve(targetPath)
  return (
    projects.find((project) =>
      project.roots.some((root) => {
        const rootPath = resolve(root.path)
        const pathFromRoot = relative(rootPath, resolved)
        return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
      })
    ) ?? null
  )
}

export interface OpenPathResult {
  projectId: string
  projectName: string
  rootPath: string
  created: boolean
}

/**
 * Dependencies for {@link openProjectForPath}. Injected so the find-or-create
 * logic can be unit tested without touching disk or the Electron `app`
 * singleton; wired to the real store / filesystem helpers in `index.ts`.
 */
export interface OpenPathDeps {
  loadStore: () => { projects: Project[] }
  addProject: (name: string, rootPath: string) => Project
  setActiveProject: (id: string | null) => void
  isDirectory: (path: string) => boolean
}

/**
 * Resolve a directory to a project and make it the active project: reuse the
 * first project that already contains the directory, otherwise create a new
 * project whose only root is that directory.
 */
export function openProjectForPath(targetPath: string, deps: OpenPathDeps): OpenPathResult {
  const resolved = resolve(targetPath)
  const { projects } = deps.loadStore()

  const existing = findProjectForPath(projects, resolved)
  if (existing) {
    deps.setActiveProject(existing.id)
    return {
      projectId: existing.id,
      projectName: existing.name,
      rootPath: existing.rootPath,
      created: false
    }
  }

  if (!deps.isDirectory(resolved)) {
    throw new Error(`Cannot open: not a directory: ${resolved}`)
  }

  const project = deps.addProject(basename(resolved) || resolved, resolved)
  deps.setActiveProject(project.id)
  return {
    projectId: project.id,
    projectName: project.name,
    rootPath: project.rootPath,
    created: true
  }
}
