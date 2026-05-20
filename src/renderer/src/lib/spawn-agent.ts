import { pear } from '@/lib/ipc'
import { getAgentKey, useAgentStore } from '@/stores/agent-store'
import { useProjectStore, type Project } from '@/stores/project-store'

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
        terminalMode: liveAgent.inboundDeliveryMode === 'manual_flush' ? 'drive' : 'passthrough'
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

  return name
}
