import { pear, type WorkforcePersona } from '@/lib/ipc'
import { getAgentKey, useAgentStore } from '@/stores/agent-store'
import { useProjectStore, type Project } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

export type SpawnAgentCli = 'claude' | 'codex'

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

export async function spawnProjectAgent(project: Project, cli: SpawnAgentCli): Promise<string> {
  const projectStore = useProjectStore.getState()
  if (projectStore.activeProjectId !== project.id) {
    await projectStore.setActiveProject(project.id)
  } else {
    await projectStore.ensureBroker()
  }

  const root = useProjectStore.getState().getActiveRoot()
  if (!root?.pathExists) {
    throw new Error(`Project root not found: ${root?.path || project.rootPath}`)
  }

  const liveAgents = await pear.broker.listAgents(project.id)
  const agentStore = useAgentStore.getState()
  for (const liveAgent of liveAgents) {
    agentStore.trackSpawnedAgent(
      liveAgent.name,
      project.id,
      root.id,
      liveAgent.cli || cli,
      root.path,
      {
        currentState: liveAgent.current_state,
        terminalMode: liveAgent.inboundDeliveryMode === 'manual_flush' ? 'drive' : 'passthrough',
        lastActivityAt: liveAgent.last_activity_at,
        lastActivityMs: liveAgent.last_activity_ms,
        channels: liveAgent.channels
      }
    )
  }

  const requestedName = nextAgentName(cli, project.id, liveAgents.map((agent) => agent.name))
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

export async function listProjectPersonas(project: Project): Promise<WorkforcePersona[]> {
  const projectStore = useProjectStore.getState()
  if (projectStore.activeProjectId !== project.id) {
    await projectStore.setActiveProject(project.id)
  } else {
    await projectStore.ensureBroker()
  }

  const root = useProjectStore.getState().getActiveRoot()
  if (!root?.pathExists) {
    return []
  }

  return pear.broker.listPersonas(project.id)
}

export async function spawnProjectPersona(project: Project, personaId: string): Promise<string> {
  const projectStore = useProjectStore.getState()
  if (projectStore.activeProjectId !== project.id) {
    await projectStore.setActiveProject(project.id)
  } else {
    await projectStore.ensureBroker()
  }

  const root = useProjectStore.getState().getActiveRoot()
  if (!root?.pathExists) {
    throw new Error(`Project root not found: ${root?.path || project.rootPath}`)
  }

  const liveAgents = await pear.broker.listAgents(project.id)
  const agentStore = useAgentStore.getState()
  for (const liveAgent of liveAgents) {
    agentStore.trackSpawnedAgent(
      liveAgent.name,
      project.id,
      root.id,
      liveAgent.cli || personaId,
      root.path,
      {
        currentState: liveAgent.current_state,
        terminalMode: liveAgent.inboundDeliveryMode === 'manual_flush' ? 'drive' : 'passthrough',
        lastActivityAt: liveAgent.last_activity_at,
        lastActivityMs: liveAgent.last_activity_ms,
        channels: liveAgent.channels
      }
    )
  }

  const personas = await pear.broker.listPersonas(project.id).catch((): WorkforcePersona[] => [])
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
