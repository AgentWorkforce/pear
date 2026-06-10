import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

import type { DeployIO, DeployOptions, DeployResult } from '@agentworkforce/deploy'

export type ProactiveAgentDeployPhase = 'validate' | 'bundle' | 'upload' | 'warm' | 'register'
export type ProactiveAgentDeployStatus = 'active' | 'warming' | 'error'

export type ProactiveAgentDraft = {
  id: string
  name: string
  description?: string
  cloudAgentId: string
  harness: 'claude' | 'codex' | 'opencode'
  model: string
  systemPrompt: string
  integrations: Record<string, Record<string, unknown>>
  watch: Array<{
    paths: string[]
    events: Array<'created' | 'updated' | 'deleted'>
    debounceMs?: number
    match?: string
  }>
  handlerCode: string
  inputs?: Record<string, string>
  memory?: { enabled: boolean; scopes?: string[]; ttlDays?: number }
  harnessSettings?: { reasoning?: 'low' | 'medium' | 'high'; timeoutSeconds?: number }
  mount?: { enabled: boolean }
  useSubscription?: boolean
  runMode?: 'cloud' | 'local'
}

export type PersonaSpecJson = {
  id: string
  name: string
  description?: string
  cloud: true
  cloudAgentId: string
  harness: ProactiveAgentDraft['harness']
  model: string
  systemPrompt: string
  integrations: ProactiveAgentDraft['integrations']
  watch: ProactiveAgentDraft['watch']
  onEvent: string
  inputs?: Record<string, string>
  memory?: ProactiveAgentDraft['memory']
  harnessSettings?: ProactiveAgentDraft['harnessSettings']
  mount: { enabled: boolean }
  useSubscription?: boolean
  schedules?: unknown
}

export interface StageBundleInput {
  projectId: string
  draft: ProactiveAgentDraft
}

export interface StagedBundle {
  bundleDir: string
  personaPath: string
  handlerPath: string
}

export interface DeployBundleInput {
  projectId: string
  draft: ProactiveAgentDraft
  workspace: string
  cloudUrl?: string
  onLog?: (line: string) => void
  onPhase?: (phase: ProactiveAgentDeployPhase) => void
  io?: DeployIO
}

export interface DeployBundleResult {
  status: ProactiveAgentDeployStatus
  error?: string
  bundleDir: string
  deploymentId?: string
}

type DeployModule = {
  deploy(opts: DeployOptions): Promise<DeployResult>
}

type CloudRunHandleStatus = 'starting' | 'active' | 'failed' | 'cancelled'

type DeployResultWithHostedStatus = DeployResult & {
  status?: ProactiveAgentDeployStatus
  error?: string
  runHandle?: {
    status?: CloudRunHandleStatus | ProactiveAgentDeployStatus
    error?: unknown
    lastError?: unknown
  }
}

export function proactiveAgentBundleDir(projectId: string, personaId: string): string {
  return join(pearUserDataDir(), 'proactive-agents', projectId, personaId)
}

export function buildPersonaSpec(
  draft: ProactiveAgentDraft,
  opts: { handlerEntry?: string } = {}
): PersonaSpecJson {
  const schedules = (draft as ProactiveAgentDraft & { schedules?: unknown }).schedules
  const persona: PersonaSpecJson = {
    id: draft.id,
    name: draft.name,
    cloud: true,
    cloudAgentId: draft.cloudAgentId,
    harness: draft.harness,
    model: draft.model,
    systemPrompt: draft.systemPrompt,
    integrations: draft.integrations,
    watch: draft.watch,
    onEvent: opts.handlerEntry ?? './agent.ts',
    mount: { enabled: draft.mount?.enabled ?? false }
  }

  if (draft.description) persona.description = draft.description
  if (draft.inputs) persona.inputs = draft.inputs
  if (draft.memory) persona.memory = draft.memory
  if (draft.harnessSettings) persona.harnessSettings = draft.harnessSettings
  if (draft.useSubscription) persona.useSubscription = true

  // TODO(v2): cron triggers are UI-only until the cloud trigger router supports them.
  if (schedules !== undefined) persona.schedules = schedules

  return persona
}

export async function stageBundle(input: StageBundleInput): Promise<StagedBundle> {
  const bundleDir = proactiveAgentBundleDir(input.projectId, input.draft.id)
  const personaPath = join(bundleDir, 'persona.json')
  const handlerPath = join(bundleDir, 'agent.ts')

  await mkdir(bundleDir, { recursive: true })
  await writeFile(handlerPath, input.draft.handlerCode, 'utf8')
  await writeFile(
    personaPath,
    `${JSON.stringify(buildPersonaSpec(input.draft, { handlerEntry: './agent.ts' }), null, 2)}\n`,
    'utf8'
  )

  return { bundleDir, personaPath, handlerPath }
}

export async function deployBundle(input: DeployBundleInput): Promise<DeployBundleResult> {
  input.onPhase?.('validate')
  input.onPhase?.('bundle')
  const staged = await stageBundle({ projectId: input.projectId, draft: input.draft })

  const deployOptions: DeployOptions = {
    personaPath: staged.personaPath,
    mode: 'cloud',
    workspace: input.workspace,
    noPrompt: true,
    onExists: 'update',
    inputs: input.draft.inputs,
    onLog: input.onLog,
    io: input.io,
    ...(input.cloudUrl ? { cloudUrl: input.cloudUrl } : {})
  }

  try {
    input.onPhase?.('upload')
    const { deploy } = (await import('@agentworkforce/deploy')) as DeployModule
    const result = (await deploy(deployOptions)) as DeployResultWithHostedStatus
    input.onPhase?.('warm')
    input.onPhase?.('register')

    const error = deployResultError(result)
    return {
      status: mapDeployStatus(result),
      bundleDir: staged.bundleDir,
      deploymentId: result.deploymentId,
      ...(error ? { error } : {})
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    input.onLog?.(error)
    return {
      status: 'error',
      error,
      bundleDir: staged.bundleDir
    }
  }
}

function pearUserDataDir(): string {
  const override = process.env.PEAR_CONFIG_DIR?.trim()
  if (override) return override
  return app.getPath('userData')
}

export function mapDeployStatus(result: DeployResultWithHostedStatus): ProactiveAgentDeployStatus {
  const handleStatus = result.runHandle?.status
  if (handleStatus === 'starting' || handleStatus === 'warming') return 'warming'
  // `cancelled` is part of CloudRunHandleStatus; without this branch it falls
  // through to the default `'active'` below, which would silently report a
  // cancelled deployment as a successful one.
  if (handleStatus === 'failed' || handleStatus === 'cancelled' || handleStatus === 'error') return 'error'
  if (handleStatus === 'active') return 'active'

  if (result.status === 'warming' || result.status === 'error') return result.status
  return 'active'
}

function deployResultError(result: DeployResultWithHostedStatus): string | undefined {
  if (result.error) return result.error

  const handleError = result.runHandle?.error ?? result.runHandle?.lastError
  if (handleError instanceof Error) return handleError.message
  if (typeof handleError === 'string' && handleError.trim()) return handleError
  return undefined
}
