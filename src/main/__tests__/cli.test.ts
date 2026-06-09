/**
 * Tests for the `pear open <dir>` CLI logic.
 *
 * Uses `node:test` + `node:assert` (zero deps), matching the rest of the
 * suite. `openProjectForPath` takes injectable deps so the find-or-create
 * behaviour is exercised without touching disk or the Electron `app` singleton.
 *
 * Run with: `node --import tsx --test src/main/__tests__/cli.test.ts`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findProjectForPath, openProjectForPath, parseOpenCommand, projectContainsPath, type OpenPathDeps } from '../cli.ts'
import type { Project } from '../store.ts'

function makeProject(overrides: Partial<Project> & { roots: Project['roots'] }): Project {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Project',
    rootPath: overrides.rootPath ?? overrides.roots[0].path,
    roots: overrides.roots,
    channels: overrides.channels ?? ['general'],
    channelPeople: overrides.channelPeople ?? {},
    integrations: overrides.integrations ?? []
  } as Project
}

function makeRoot(path: string): Project['roots'][number] {
  return { id: `root-${path}`, name: path, path }
}

test('parseOpenCommand extracts the path after the open verb', () => {
  assert.equal(parseOpenCommand(['electron', '.', 'open', '/tmp/foo']), '/tmp/foo')
  assert.equal(parseOpenCommand(['/Applications/Pear', 'open', './rel']), './rel')
})

test('parseOpenCommand skips flags between open and the path', () => {
  assert.equal(parseOpenCommand(['pear', 'open', '--verbose', '/tmp/foo']), '/tmp/foo')
})

test('parseOpenCommand treats -- as end-of-options for dash-named directories', () => {
  assert.equal(parseOpenCommand(['pear', 'open', '--', '-repo']), '-repo')
  assert.equal(parseOpenCommand(['pear', 'open', '--']), null)
})

test('parseOpenCommand returns null without an open verb or path', () => {
  assert.equal(parseOpenCommand(['electron', '.']), null)
  assert.equal(parseOpenCommand(['pear', 'open']), null)
  assert.equal(parseOpenCommand(['pear', 'open', '--flag-only']), null)
})

test('findProjectForPath matches an exact root', () => {
  const projects = [makeProject({ id: 'a', roots: [makeRoot('/work/alpha')] })]
  assert.equal(findProjectForPath(projects, '/work/alpha')?.id, 'a')
})

test('projectContainsPath matches an exact root', () => {
  const project = makeProject({ id: 'a', roots: [makeRoot('/work/alpha')] })
  assert.equal(projectContainsPath(project, '/work/alpha'), true)
})

test('findProjectForPath matches a nested directory under a root', () => {
  const projects = [makeProject({ id: 'a', roots: [makeRoot('/work/alpha')] })]
  assert.equal(findProjectForPath(projects, '/work/alpha/src/lib')?.id, 'a')
})

test('projectContainsPath matches a nested directory under a root', () => {
  const project = makeProject({ id: 'a', roots: [makeRoot('/work/alpha')] })
  assert.equal(projectContainsPath(project, '/work/alpha/src/lib'), true)
})

test('findProjectForPath does not match a sibling that only shares a prefix', () => {
  const projects = [makeProject({ id: 'a', roots: [makeRoot('/work/alpha')] })]
  assert.equal(findProjectForPath(projects, '/work/alpha-beta'), null)
})

test('projectContainsPath does not match a sibling that only shares a prefix', () => {
  const project = makeProject({ id: 'a', roots: [makeRoot('/work/alpha')] })
  assert.equal(projectContainsPath(project, '/work/alpha-beta'), false)
})

test('findProjectForPath returns the first matching project', () => {
  const projects = [
    makeProject({ id: 'first', roots: [makeRoot('/work/alpha')] }),
    makeProject({ id: 'second', roots: [makeRoot('/work/alpha')] })
  ]
  assert.equal(findProjectForPath(projects, '/work/alpha')?.id, 'first')
})

interface Harness {
  deps: OpenPathDeps
  added: Array<{ name: string; rootPath: string }>
  activeId: string | null
}

function makeHarness(projects: Project[], dirsThatExist = new Set<string>()): Harness {
  const harness: Harness = {
    added: [],
    activeId: null,
    deps: {
      loadStore: () => ({ projects, activeProjectId: null }) as ReturnType<OpenPathDeps['loadStore']>,
      addProject: (name: string, rootPath: string) => {
        const project = makeProject({ id: 'created', name, roots: [makeRoot(rootPath)] })
        harness.added.push({ name, rootPath })
        projects.push(project)
        return project
      },
      setActiveProject: (id: string | null) => {
        harness.activeId = id
      },
      isDirectory: (path: string) => dirsThatExist.has(path)
    }
  }
  return harness
}

test('openProjectForPath reuses an existing project and activates it', () => {
  const projects = [makeProject({ id: 'existing', roots: [makeRoot('/work/alpha')] })]
  const harness = makeHarness(projects)

  const result = openProjectForPath('/work/alpha/nested', harness.deps)

  assert.equal(result.created, false)
  assert.equal(result.projectId, 'existing')
  assert.equal(harness.activeId, 'existing')
  assert.equal(harness.added.length, 0)
})

test('openProjectForPath creates a new project when no root contains the path', () => {
  const projects: Project[] = []
  const harness = makeHarness(projects, new Set(['/work/brand-new']))

  const result = openProjectForPath('/work/brand-new', harness.deps)

  assert.equal(result.created, true)
  assert.equal(result.projectId, 'created')
  assert.equal(result.rootPath, '/work/brand-new')
  assert.equal(harness.activeId, 'created')
  assert.deepEqual(harness.added, [{ name: 'brand-new', rootPath: '/work/brand-new' }])
})

test('openProjectForPath refuses to create a project for a non-directory', () => {
  const harness = makeHarness([], new Set())
  assert.throws(() => openProjectForPath('/work/missing', harness.deps), /not a directory/)
  assert.equal(harness.added.length, 0)
  assert.equal(harness.activeId, null)
})
