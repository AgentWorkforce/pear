import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Project } from '@/stores/project-store'
import { useProjectStore } from '@/stores/project-store'
import { spawnTeamForIssue } from './spawn-agent'

const mockPear = vi.hoisted(() => ({
  cloudAgent: {
    status: vi.fn(async () => null),
    detach: vi.fn(async () => undefined)
  },
  broker: {
    start: vi.fn(async () => true),
    listAgents: vi.fn(async () => []),
    spawnAgent: vi.fn(async (_projectId: string, input: { name: string; cli: string }) => ({
      name: input.name,
      runtime: 'local',
      cli: input.cli
    })),
    attachTerminal: vi.fn(async () => ({ name: 'agent', mode: 'auto_inject', pending: 0, snapshot: null })),
    sendMessage: vi.fn(async () => undefined),
    releaseAgent: vi.fn(async () => undefined)
  },
  project: {
    setActive: vi.fn(async () => undefined)
  }
}))

vi.mock('@/lib/ipc', () => ({ pear: mockPear }))
vi.mock('@/stores/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      openTab: vi.fn()
    })
  }
}))

const project: Project = {
  id: 'project-1',
  name: 'Project 1',
  rootPath: '/tmp/project',
  rootPathExists: true,
  roots: [{ id: 'root-1', name: 'Root', path: '/tmp/project', pathExists: true }],
  channels: ['general'],
  channelPeople: {},
  integrations: []
}

describe('spawnTeamForIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectStore.setState({
      projects: [project],
      activeProjectId: project.id,
      activeRootId: 'root-1',
      activeChannelName: null,
      brokerStarted: false,
      brokerProjectId: null
    })
  })

  test('reuses an existing deterministic issue team without respawning or resending prompts', async () => {
    mockPear.broker.listAgents.mockResolvedValue([
      { name: 'PEAR-123-impl', projectId: project.id, cli: 'codex', current_state: 'idle' },
      { name: 'PEAR-123-review', projectId: project.id, cli: 'claude', current_state: 'idle' }
    ])

    await expect(spawnTeamForIssue(project, {
      issueId: 'lin-123',
      issueIdentifier: 'PEAR-123',
      issueTitle: 'Reuse existing pair',
      issueDescription: 'The team already exists.'
    })).resolves.toEqual({ implName: 'PEAR-123-impl', reviewName: 'PEAR-123-review' })

    expect(mockPear.broker.spawnAgent).not.toHaveBeenCalled()
    expect(mockPear.broker.sendMessage).not.toHaveBeenCalled()
  })

  test('releases newly created team agents when prompt delivery fails', async () => {
    mockPear.broker.listAgents.mockResolvedValue([])
    mockPear.broker.sendMessage.mockRejectedValueOnce(new Error('delivery failed'))

    await expect(spawnTeamForIssue(project, {
      issueId: 'lin-124',
      issueIdentifier: 'PEAR-124',
      issueTitle: 'Rollback failed prompt',
      issueDescription: 'Prompt delivery should clean up created agents.'
    })).rejects.toThrow('delivery failed')

    expect(mockPear.broker.releaseAgent).toHaveBeenCalledWith(project.id, 'PEAR-124-impl')
    expect(mockPear.broker.releaseAgent).toHaveBeenCalledWith(project.id, 'PEAR-124-review')
  })
})
