import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeProactiveTrigger } from '../../cloud/packages/core/src/runtime/proactive-trigger-router'
import { runProactivePersona } from '../../cloud/packages/core/src/runtime/proactive-runner'
import type { ProactiveAgentDraft } from '../src/main/proactive-agent.types'

const mocks = vi.hoisted(() => ({
  deployMock: vi.fn()
}))

const deployMock = mocks.deployMock

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => process.env.PEAR_CONFIG_DIR || tmpdir())
  }
}))

vi.mock('../src/main/auth', () => ({
  resolveCloudAuth: vi.fn(async () => ({
    accessToken: 'test-token',
    apiUrl: 'https://cloud.test'
  }))
}))

vi.mock('@agentworkforce/deploy', () => ({
  deploy: deployMock
}))

type PersonaRegistration = {
  workspaceId: string
  personaId: string
  status: 'active'
  watch: Array<{
    paths: string[]
    events: Array<'created' | 'updated' | 'deleted'>
  }>
}

type RunRow = {
  runId: string
  workspaceId: string
  projectId: string
  personaId: string
  status: string
  trigger: {
    type: 'relayfile.changed'
    path: string
    event: string
  }
  startedAt: string
  completedAt?: string
}

describe('proactive agent smoke', () => {
  let tempDir: string
  let personas: PersonaRegistration[]
  let runs: RunRow[]
  let runRow: { status: string }
  let postHandler: ReturnType<typeof vi.fn>
  let getHandler: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pear-proactive-smoke-'))
    process.env.PEAR_CONFIG_DIR = tempDir
    personas = []
    runs = []
    runRow = { status: 'running' }

    const NativeFunction = globalThis.Function
    vi.stubGlobal('Function', function (...args: string[]) {
      if (args.at(-1) === 'return import(specifier)') {
        return async () => null
      }
      return NativeFunction(...args)
    } as FunctionConstructor)

    postHandler = vi.fn(async (request: Request) => {
      const body = await request.json() as {
        persona: { id: string; watch?: PersonaRegistration['watch'] }
        projectId?: string
      }
      const workspaceId = workspaceFromUrl(request.url)
      const registration: PersonaRegistration = {
        workspaceId,
        personaId: body.persona.id,
        status: 'active',
        watch: body.persona.watch || []
      }
      personas = personas.filter((persona) => persona.personaId !== registration.personaId)
      personas.push(registration)

      return jsonResponse({
        agentId: registration.personaId,
        workspaceId,
        status: 'active',
        deploymentId: 'dep_123',
        persona: registration
      }, 201)
    })

    getHandler = vi.fn(async () => jsonResponse({ runs }))

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method || 'GET'
      if (method === 'POST' && url.includes('/proactive-personas/release-notes')) {
        return postHandler(new Request(url, {
          method,
          body: init?.body as BodyInit,
          headers: init?.headers
        }))
      }
      if (method === 'GET' && url.includes('/proactive-personas/release-notes/runs')) {
        return getHandler(new Request(url, { method, headers: init?.headers }))
      }
      return jsonResponse({ personas })
    }))

    deployMock.mockReset()
    deployMock.mockImplementation(async (options: {
      personaPath: string
      workspace: string
      cloudUrl?: string
    }) => {
      const persona = JSON.parse(await readFile(options.personaPath, 'utf8')) as Record<string, unknown>
      const cloudUrl = options.cloudUrl || 'https://cloud.test'
      await fetch(`${cloudUrl}/api/v1/workspaces/${encodeURIComponent(options.workspace)}/proactive-personas/${encodeURIComponent(String(persona.id))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          persona,
          projectId: 'project-1',
          bundle: { runner: 'runner', agent: 'agent', packageJson: { type: 'module' } },
          watch: persona.watch
        })
      })

      return {
        deploymentId: 'dep_123',
        mode: 'cloud',
        workspace: options.workspace,
        bundleDir: join(tempDir, 'bundle'),
        connectedIntegrations: [],
        schedules: [],
        runHandle: { status: 'active' }
      }
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    delete process.env.PEAR_CONFIG_DIR
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates, deploys, observes a change, and reads a succeeded run', async () => {
    const { saveStore } = await import('../src/main/store')
    const { ProactiveAgentManager } = await import('../src/main/proactive-agent')
    const manager = new ProactiveAgentManager()

    saveStore({
      activeProjectId: 'project-1',
      projects: [{
        id: 'project-1',
        name: 'Project',
        relayWorkspaceId: 'workspace-1',
        rootPath: tempDir,
        roots: [{ id: 'root-1', name: 'Project', path: tempDir }],
        channels: ['general'],
        channelPeople: {},
        integrations: []
      }]
    })

    const draft: ProactiveAgentDraft = {
      id: 'release-notes',
      name: 'Release Notes',
      cloudAgentId: 'cloud-agent-1',
      harness: 'claude',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'Write release notes when changelog files change.',
      integrations: {},
      watch: [{
        paths: ['/integrations/github/repos/acme/web/issues/**/*.json'],
        events: ['created', 'updated']
      }],
      handlerCode: [
        "import { handler } from '@agentworkforce/runtime';",
        'export default handler(async (ctx, event) => {',
        "  ctx.log('info', event.type);",
        '});'
      ].join('\n'),
      runMode: 'cloud'
    }

    const created = await manager.create('project-1', draft)
    expect(created.personaId).toBe('release-notes')

    const deployResult = await manager.deploy('project-1', 'release-notes')
    expect(deployResult.status).toBe('active')
    expect(deployMock).toHaveBeenCalledTimes(1)
    expect(deployMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'cloud',
      workspace: 'workspace-1',
      noPrompt: true,
      onExists: 'update'
    }))
    expect(postHandler).toHaveBeenCalled()

    const matches = routeProactiveTrigger(personas, {
      workspaceId: 'workspace-1',
      path: '/integrations/github/repos/acme/web/issues/open/1.json',
      event: 'updated'
    })
    expect(matches).toHaveLength(1)

    await runProactivePersona(matches[0], {
      randomUUID: () => 'run-1',
      now: () => new Date('2026-05-21T12:00:00.000Z'),
      run: async () => undefined,
      persistRun: async (row) => {
        runRow = row
        const next: RunRow = {
          runId: row.runId,
          workspaceId: row.workspaceId,
          projectId: 'project-1',
          personaId: row.personaId,
          status: row.status,
          trigger: row.trigger,
          startedAt: row.startedAt,
          ...(row.completedAt ? { completedAt: row.completedAt } : {})
        }
        const index = runs.findIndex((candidate) => candidate.runId === next.runId)
        if (index === -1) runs.push(next)
        else runs[index] = next
      }
    })
    expect(runRow.status).toBe('succeeded')

    const page = await manager.runs('project-1', 'release-notes')
    expect(getHandler).toHaveBeenCalled()
    expect(page.runs).toHaveLength(1)
    expect(page.runs[0].status).toBe('succeeded')
  })
})

function workspaceFromUrl(url: string): string {
  const match = /\/workspaces\/([^/]+)\//.exec(url)
  return match ? decodeURIComponent(match[1]) : 'workspace-1'
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? 'Created' : 'OK',
    json: async () => body
  } as Response
}
