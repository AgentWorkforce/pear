// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProactiveAgentEditor } from './ProactiveAgentEditor'
import { useProjectStore } from '@/stores/project-store'

const mocks = vi.hoisted(() => ({
  createMock: vi.fn(),
  deployMock: vi.fn(),
  refreshCloudAgentsMock: vi.fn()
}))

vi.mock('@/lib/ipc', () => ({
  pear: {
    integrations: {
      list: vi.fn(async () => [])
    },
    proactiveAgent: {
      create: mocks.createMock,
      update: vi.fn(),
      deploy: mocks.deployMock,
      onEvent: vi.fn(() => () => undefined)
    }
  }
}))

vi.mock('@/hooks/use-cloud-agent', () => ({
  useCloudAgentCatalog: () => ({
    catalog: [{
      id: 'cloud-agent-1',
      name: 'Claude agent',
      harness: 'claude',
      defaultModel: 'claude-opus-4-7',
      status: 'ready',
      lastAuthenticatedAt: null
    }],
    status: 'ready',
    error: undefined,
    refresh: mocks.refreshCloudAgentsMock,
    create: vi.fn(),
    remove: vi.fn()
  })
}))

vi.mock('@/hooks/use-proactive-agent', () => ({
  useProactiveAgents: () => ({
    bindings: [],
    status: 'ready',
    error: null,
    pause: vi.fn(),
    resume: vi.fn(),
    undeploy: vi.fn()
  })
}))

function textareaUnderLabel(label: string): HTMLTextAreaElement {
  const labelElement = screen.getByText(label).closest('label')
  const textarea = labelElement?.querySelector('textarea')
  if (!textarea) throw new Error(`Missing textarea for ${label}`)
  return textarea
}

function checkboxUnderLabel(label: string): HTMLInputElement {
  const labelElement = screen.getByText(label).closest('label')
  const checkbox = labelElement?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!checkbox) throw new Error(`Missing checkbox for ${label}`)
  return checkbox
}

describe('ProactiveAgentEditor subscription deploy guard', () => {
  beforeEach(() => {
    mocks.createMock.mockReset()
    mocks.deployMock.mockReset()
    mocks.refreshCloudAgentsMock.mockResolvedValue([])
    mocks.createMock.mockResolvedValue({
      projectId: 'project-1',
      personaId: 'release-bot',
      cloudAgentId: 'cloud-agent-1',
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      draft: {}
    })
    mocks.deployMock.mockResolvedValue({ status: 'active' })
    useProjectStore.setState({
      projects: [{
        id: 'project-1',
        name: 'Project 1',
        relayWorkspaceId: 'project-1',
        rootPath: '/tmp/project-1',
        rootPathExists: true,
        roots: [{ id: 'root-1', name: 'Project 1', path: '/tmp/project-1', pathExists: true }],
        channels: ['general'],
        channelPeople: {},
        integrations: []
      }],
      activeProjectId: 'project-1',
      activeRootId: 'root-1'
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('blocks deploy and shows the provider connect command when subscription credentials are missing', async () => {
    render(React.createElement(ProactiveAgentEditor, {
      projectId: 'project-1',
      onClose: vi.fn()
    }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Release Bot' } })
    fireEvent.blur(screen.getByLabelText('Name'))
    fireEvent.change(screen.getByLabelText('Cloud agent'), { target: { value: 'cloud-agent-1' } })
    fireEvent.change(textareaUnderLabel('System prompt'), { target: { value: 'Handle releases.' } })
    fireEvent.change(textareaUnderLabel('Paths'), { target: { value: '/releases/**' } })
    fireEvent.click(checkboxUnderLabel('Use my subscription'))

    expect(screen.getAllByText(/agent-relay cloud connect anthropic/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /deploy/i }))

    await waitFor(() => {
      expect(screen.getByText(/Subscription deploys require connected LLM provider credentials/)).toBeTruthy()
    })
    expect(screen.getAllByText(/agent-relay cloud connect anthropic/).length).toBeGreaterThan(0)
    expect(mocks.createMock).not.toHaveBeenCalled()
    expect(mocks.deployMock).not.toHaveBeenCalled()
  })
})
