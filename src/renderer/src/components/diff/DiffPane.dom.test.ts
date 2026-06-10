// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DiffPane } from './DiffPane'
import type { FileStatus } from '@/stores/git-store'
import { useGitStore } from '@/stores/git-store'
import type { Project } from '@/stores/project-store'
import { useProjectStore } from '@/stores/project-store'
import { useAgentStore } from '@/stores/agent-store'

const commitSelection = vi.fn(async () => ({ hash: 'abc1234def5678' }))

vi.mock('@/lib/ipc', () => ({
  pear: {
    auth: {
      status: vi.fn(async () => ({ loggedIn: false, user: null }))
    },
    git: {
      summary: vi.fn(async () => ({ branch: 'main', additions: 0, deletions: 0 })),
      status: vi.fn(async () => []),
      diff: vi.fn(async () => ''),
      history: vi.fn(async () => []),
      show: vi.fn(async () => ''),
      branchSyncStatus: vi.fn(async () => ({
        branch: 'main',
        remote: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false
      })),
      branchDetails: vi.fn(async () => []),
      commitSelection: (...args: unknown[]) => commitSelection(...args),
      generateCommitMessage: vi.fn(async () => ({ title: '', body: '' }))
    },
    fs: {
      readPreview: vi.fn(async () => ({ kind: 'file', size: 100 }))
    }
  }
}))

const ROOT_PATH = '/tmp/project-1'

function makeFiles(): FileStatus[] {
  return [
    { path: 'src/alpha.ts', status: 'modified', staged: false },
    { path: 'src/beta.ts', status: 'modified', staged: false }
  ]
}

function seedDiffPane(files: FileStatus[]): void {
  const project: Project = {
    id: 'project-1',
    name: 'Project 1',
    relayWorkspaceId: 'project-1',
    rootPath: ROOT_PATH,
    rootPathExists: true,
    roots: [{ id: 'root-1', name: 'Project 1', path: ROOT_PATH, pathExists: true }],
    channels: ['general'],
    channelPeople: {},
    integrations: []
  }

  useProjectStore.setState({
    projects: [project],
    activeProjectId: project.id,
    activeRootId: 'root-1',
    activeChannelName: 'general',
    brokerStarted: true,
    brokerProjectId: project.id,
    loading: false,
    pendingRootConflict: null
  })
  useAgentStore.setState({ agents: [] })
  useGitStore.setState({
    files,
    selectedFile: files[0]?.path || null,
    diff: '',
    summary: { rootPath: ROOT_PATH, branch: 'main', additions: 0, deletions: 0 },
    history: [],
    selectedCommit: null,
    selectedCommitFile: null,
    commitDiff: '',
    loading: false,
    historyLoading: false,
    actionLoading: false,
    commitDraftByRoot: {},
    commitDraftStatusByRoot: {},
    commitDraftErrorByRoot: {}
  })
}

function findCommitButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((element) =>
    element.textContent?.startsWith('Commit ')
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error('Commit button not found')
  return button
}

beforeEach(() => {
  seedDiffPane(makeFiles())
})

afterEach(() => {
  cleanup()
  commitSelection.mockClear()
  document.body.innerHTML = ''
})

describe('DiffPane file selection', () => {
  it('toggles a file out of and back into the selection', async () => {
    render(React.createElement(DiffPane))

    // The root probes git asynchronously; the file list appears once it resolves.
    const checkbox = await waitFor(() => {
      const element = document.querySelector('[aria-label="Unselect src/alpha.ts"]')
      if (!(element instanceof HTMLButtonElement)) throw new Error('alpha checkbox not selected yet')
      return element
    })

    // Files start fully selected (auto-initialized on first load).
    expect(checkbox.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      fireEvent.click(checkbox)
    })

    await waitFor(() => {
      const deselected = document.querySelector('[aria-label="Select entire src/alpha.ts"]')
      expect(deselected).not.toBeNull()
      expect(deselected?.getAttribute('aria-checked')).toBe('false')
    })

    // The other file remains selected and unaffected.
    expect(document.querySelector('[aria-label="Unselect src/beta.ts"]')).not.toBeNull()

    // Toggling again re-selects it.
    const reselect = document.querySelector('[aria-label="Select entire src/alpha.ts"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(reselect)
    })

    await waitFor(() => {
      expect(document.querySelector('[aria-label="Unselect src/alpha.ts"]')).not.toBeNull()
    })
  })
})

describe('DiffPane commit form', () => {
  it('enables the commit button only with a summary and submits the selection', async () => {
    render(React.createElement(DiffPane))

    const titleInput = await waitFor(() => {
      const element = document.querySelector('input[placeholder="Summary (required)"]')
      if (!(element instanceof HTMLInputElement)) throw new Error('commit title input not found yet')
      return element
    })

    // Files are selected by default, but with no summary the commit button is disabled.
    const commitButton = findCommitButton()
    expect(commitButton.disabled).toBe(true)

    await act(async () => {
      fireEvent.change(titleInput, { target: { value: 'Refactor diff pane' } })
    })

    await waitFor(() => {
      expect(findCommitButton().disabled).toBe(false)
    })

    await act(async () => {
      fireEvent.click(findCommitButton())
    })

    await waitFor(() => {
      expect(commitSelection).toHaveBeenCalledTimes(1)
    })

    const [rootPath, input] = commitSelection.mock.calls[0] as [string, { title: string; wholeFiles: string[] }]
    expect(rootPath).toBe(ROOT_PATH)
    expect(input.title).toBe('Refactor diff pane')
    expect(input.wholeFiles).toEqual(expect.arrayContaining(['src/alpha.ts', 'src/beta.ts']))
  })
})
