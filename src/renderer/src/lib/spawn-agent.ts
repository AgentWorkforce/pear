import { pear, type WorkforcePersona } from '@/lib/ipc'
import { getAgentKey, useAgentStore } from '@/stores/agent-store'
import { useProjectStore, type Project, type ProjectRoot } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

export type SpawnAgentCli = 'claude' | 'codex' | 'grok'

function nextAgentName(cli: SpawnAgentCli, projectId: string, liveNames: string[]): string {
  const existingNames = new Set([
    ...liveNames,
    ...useAgentStore.getState().agents
      .filter((agent) => agent.projectId === projectId)
      .map((agent) => agent.name)
  ])
  let index = 1

  while (existingNames.has(`${cli}-${index}`)) {
    index += 1
  }

  return `${cli}-${index}`
}

async function ensureLocalBroker(
  project: Project,
  rootOverride?: ProjectRoot,
  options: { detachCloud?: boolean } = {}
): Promise<void> {
  const detachCloud = options.detachCloud ?? true
  const projectStore = useProjectStore.getState()
  if (projectStore.activeProjectId !== project.id) {
    await projectStore.setActiveProject(project.id)
  }
  if (rootOverride) {
    useProjectStore.getState().setActiveRoot(rootOverride.id)
  }

  if (detachCloud) {
    const cloudStatus = await pear.cloudAgent.status(project.id).catch(() => null)
    if (cloudStatus) {
      await pear.cloudAgent.detach(project.id)
    }
  }

  await useProjectStore.getState().ensureBroker()
}

export async function spawnProjectAgent(
  project: Project,
  cli: SpawnAgentCli,
  customName?: string,
  rootOverride?: ProjectRoot
): Promise<string> {
  if (rootOverride && !rootOverride.pathExists) {
    throw new Error(`Project root not found: ${rootOverride.path || project.rootPath}`)
  }
  await ensureLocalBroker(project, rootOverride)

  const root = rootOverride ?? useProjectStore.getState().getActiveRoot()
  if (!root?.pathExists) {
    throw new Error(`Project root not found: ${root?.path || project.rootPath}`)
  }

  const liveAgents = await pear.broker.listAgents(project.id)
  const agentStore = useAgentStore.getState()
  for (const liveAgent of liveAgents) {
    const trackedAgent = agentStore.agents.find((agent) => agent.projectId === project.id && agent.name === liveAgent.name)
    agentStore.trackSpawnedAgent(
      liveAgent.name,
      project.id,
      trackedAgent?.rootId ?? root.id,
      liveAgent.cli || cli,
      trackedAgent?.rootPath ?? root.path,
      {
        currentState: liveAgent.current_state,
        terminalMode: liveAgent.inboundDeliveryMode === 'manual_flush' ? 'drive' : 'passthrough',
        lastActivityAt: liveAgent.last_activity_at,
        lastActivityMs: liveAgent.last_activity_ms,
        channels: liveAgent.channels
      }
    )
  }

  const trimmedCustom = customName?.trim() || undefined
  // When the user provides a custom name use it verbatim; the broker's
  // getAvailableAgentName will append -2/-3/... on conflict. When empty we
  // fall back to the per-cli auto-numbered default.
  const requestedName = trimmedCustom ?? nextAgentName(cli, project.id, liveAgents.map((agent) => agent.name))
  const spawned = await pear.broker.spawnAgent(project.id, {
    name: requestedName,
    cli,
    cwd: root.path
  })
  const name = spawned.name || requestedName

  await pear.broker.attachTerminal({
    projectId: project.id,
    name,
    mode: 'passthrough'
  })

  agentStore.trackSpawnedAgent(name, project.id, root.id, cli, root.path)
  agentStore.setActiveAgentKey(getAgentKey(project.id, name))
  useUIStore.getState().openTab({ kind: 'agents', projectId: project.id })

  return name
}

export async function listProjectPersonas(project: Project, rootOverride?: ProjectRoot): Promise<WorkforcePersona[]> {
  if (rootOverride && !rootOverride.pathExists) {
    return []
  }

  const root = rootOverride ?? useProjectStore.getState().getActiveRoot()
  if (!root?.pathExists) {
    return []
  }

  return pear.broker.listPersonas(project.id, root.path)
}

export type TeamComposition = {
  issueId: string
  issueIdentifier: string
  issueTitle: string
  issueDescription: string
  repo?: string
}

type TeamAgentResult = {
  name: string
  created: boolean
}

const teamSpawnPromises = new Map<string, Promise<{ implName: string; reviewName: string }>>()

async function getOrSpawnTeamAgent(
  project: Project,
  cli: SpawnAgentCli,
  name: string,
  rootOverride?: ProjectRoot
): Promise<TeamAgentResult> {
  await ensureLocalBroker(project, rootOverride)

  const root = rootOverride ?? useProjectStore.getState().getActiveRoot()
  if (!root?.pathExists) {
    throw new Error(`Project root not found: ${root?.path || project.rootPath}`)
  }

  const existing = (await pear.broker.listAgents(project.id)).find((agent) => agent.name === name)
  if (existing) {
    useAgentStore.getState().trackSpawnedAgent(
      existing.name,
      project.id,
      root.id,
      existing.cli || cli,
      root.path,
      {
        currentState: existing.current_state,
        terminalMode: existing.inboundDeliveryMode === 'manual_flush' ? 'drive' : 'passthrough',
        lastActivityAt: existing.last_activity_at,
        lastActivityMs: existing.last_activity_ms,
        channels: existing.channels
      }
    )
    useAgentStore.getState().setActiveAgentKey(getAgentKey(project.id, existing.name))
    useUIStore.getState().openTab({ kind: 'agents', projectId: project.id })
    return { name: existing.name, created: false }
  }

  return { name: await spawnProjectAgent(project, cli, name, rootOverride), created: true }
}

async function releaseCreatedTeamAgents(projectId: string, agents: TeamAgentResult[]): Promise<void> {
  await Promise.all(
    agents
      .filter((agent) => agent.created)
      .map((agent) => pear.broker.releaseAgent(projectId, agent.name).catch(() => undefined))
  )
}

export async function spawnTeamForIssue(
  project: Project,
  composition: TeamComposition,
  rootOverride?: ProjectRoot
): Promise<{ implName: string; reviewName: string }> {
  const implRequestedName = `${composition.issueIdentifier}-impl`
  const reviewRequestedName = `${composition.issueIdentifier}-review`
  const promiseKey = `${project.id}\0${implRequestedName}\0${reviewRequestedName}`
  const current = teamSpawnPromises.get(promiseKey)
  if (current) return current

  const pending = (async (): Promise<{ implName: string; reviewName: string }> => {
    const spawnedAgents: TeamAgentResult[] = []
    try {
      const impl = await getOrSpawnTeamAgent(project, 'codex', implRequestedName, rootOverride)
      spawnedAgents.push(impl)
      const review = await getOrSpawnTeamAgent(project, 'claude', reviewRequestedName, rootOverride)
      spawnedAgents.push(review)

      const implPrompt = [
        'Implement this issue and open a PR when done.',
        '',
        `Issue: ${composition.issueIdentifier} — ${composition.issueTitle}`,
        composition.issueDescription,
        composition.repo ? `Repository: ${composition.repo}` : ''
      ].filter(Boolean).join('\n')

      const reviewPrompt = [
        `Review the implementation by ${impl.name} for this issue. Watch for correctness, security, and test coverage.`,
        '',
        `Issue: ${composition.issueIdentifier} — ${composition.issueTitle}`,
        composition.issueDescription
      ].join('\n')

      if (impl.created) await pear.broker.sendMessage(project.id, { to: impl.name, text: implPrompt })
      if (review.created) await pear.broker.sendMessage(project.id, { to: review.name, text: reviewPrompt })

      return { implName: impl.name, reviewName: review.name }
    } catch (error) {
      await releaseCreatedTeamAgents(project.id, spawnedAgents)
      throw error
    }
  })()

  teamSpawnPromises.set(promiseKey, pending)
  try {
    return await pending
  } finally {
    if (teamSpawnPromises.get(promiseKey) === pending) {
      teamSpawnPromises.delete(promiseKey)
    }
  }
}

export async function spawnProjectPersona(project: Project, personaId: string, rootOverride?: ProjectRoot): Promise<string> {
  if (rootOverride && !rootOverride.pathExists) {
    throw new Error(`Project root not found: ${rootOverride.path || project.rootPath}`)
  }
  await ensureLocalBroker(project, rootOverride)

  const root = rootOverride ?? useProjectStore.getState().getActiveRoot()
  if (!root?.pathExists) {
    throw new Error(`Project root not found: ${root?.path || project.rootPath}`)
  }

  const liveAgents = await pear.broker.listAgents(project.id)
  const agentStore = useAgentStore.getState()
  for (const liveAgent of liveAgents) {
    const trackedAgent = agentStore.agents.find((agent) => agent.projectId === project.id && agent.name === liveAgent.name)
    agentStore.trackSpawnedAgent(
      liveAgent.name,
      project.id,
      trackedAgent?.rootId ?? root.id,
      liveAgent.cli || personaId,
      trackedAgent?.rootPath ?? root.path,
      {
        currentState: liveAgent.current_state,
        terminalMode: liveAgent.inboundDeliveryMode === 'manual_flush' ? 'drive' : 'passthrough',
        lastActivityAt: liveAgent.last_activity_at,
        lastActivityMs: liveAgent.last_activity_ms,
        channels: liveAgent.channels
      }
    )
  }

  const personas = await pear.broker.listPersonas(project.id, root.path).catch((): WorkforcePersona[] => [])
  const persona = personas.find((candidate) => candidate.id === personaId)
  const spawned = await pear.broker.spawnPersona(project.id, personaId)
  const name = spawned.name || personaId

  await pear.broker.attachTerminal({
    projectId: project.id,
    name,
    mode: 'passthrough'
  })

  agentStore.trackSpawnedAgent(name, project.id, root.id, spawned.cli || persona?.harness || personaId, root.path)
  agentStore.setActiveAgentKey(getAgentKey(project.id, name))
  useUIStore.getState().openTab({ kind: 'agents', projectId: project.id })

  return name
}
