import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore, type Workspace } from '@/stores/workspace-store'

export type SpawnAgentCli = 'claude' | 'codex'

function nextAgentName(cli: SpawnAgentCli): string {
  const existingNames = new Set(useAgentStore.getState().agents.map((agent) => agent.name))
  let index = 1

  while (existingNames.has(`${cli}-${index}`)) {
    index += 1
  }

  return `${cli}-${index}`
}

export async function spawnWorkspaceAgent(workspace: Workspace, cli: SpawnAgentCli): Promise<string> {
  if (!workspace.rootPathExists) {
    throw new Error(`Workspace path not found: ${workspace.rootPath}`)
  }

  const workspaceStore = useWorkspaceStore.getState()
  if (workspaceStore.activeWorkspaceId !== workspace.id) {
    await workspaceStore.setActiveWorkspace(workspace.id)
  } else {
    await workspaceStore.ensureBroker()
  }

  const requestedName = nextAgentName(cli)
  const spawned = await pear.broker.spawnAgent({
    name: requestedName,
    cli,
    cwd: workspace.rootPath
  })
  const name = spawned.name || requestedName

  await pear.broker.attachTerminal({
    name,
    mode: 'passthrough'
  })

  const agentStore = useAgentStore.getState()
  agentStore.trackSpawnedAgent(name, workspace.id, undefined, cli)
  agentStore.setActiveAgent(name)

  return name
}
