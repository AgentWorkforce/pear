import { getAgentKey, getAgentKeyForAgent, useAgentStore, type Agent } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import type { IssueViewModel } from '@/stores/issues-store'

// Web-first boundary: in the browser build there are no real projects/agents to
// route into, so a forward jump that would need real shell nav is STUBBED — we
// resolve the (project, agent) target and surface it as a toast. The identical
// call performs real shell nav in Electron. Mirrors lib/ipc.ts's mock gate.
const isWebMock = import.meta.env.VITE_PEAR_MOCK_IPC === 'true'

export type IssueJumpResult =
  // Landed on the live agent workspace (Electron, agent already running).
  | { kind: 'jumped'; message: string; projectId: string; agentKey: string }
  // Browser stub: resolved the target but didn't navigate (no real shell).
  | { kind: 'stub'; message: string; projectId?: string; agentName?: string }
  // Assigned to an agent that isn't spawned yet — opened the spawn flow.
  | { kind: 'spawn'; message: string; agentName: string }
  // No assignee — opened the assign & spawn flow.
  | { kind: 'unassigned'; message: string }

function resolvedAgentName(issue: IssueViewModel): string | undefined {
  return issue.assignedAgentName || issue.assigneeName
}

// Match a tracked agent to the issue by name (case-insensitive), preferring a
// running session so active work wins over an exited one of the same name.
function findTrackedAgent(issue: IssueViewModel, agents: Agent[]): Agent | undefined {
  const name = resolvedAgentName(issue)?.toLowerCase()
  if (!name) return undefined
  const matches = agents.filter((agent) => agent.name.toLowerCase() === name)
  return matches.find((agent) => agent.status === 'running') || matches[0]
}

/**
 * L3 forward jump: from an Inbox card into the live Pear workspace doing the
 * work. Resolves `issue.assignee → agentName → (projectId, agentKey)` and:
 *  - agent running        → switch project + open the agents tab on that agent,
 *                           leaving a `↩ PEAR-X` breadcrumb (Electron).
 *  - assigned, not spawned→ open the existing spawn flow ("Spawn on PEAR-X").
 *  - unassigned           → open the spawn flow ("Assign & spawn").
 * Always records the focused card (`selectedIssueId`) so a later return restores
 * your place, and never closes the inbox (openTab only adds/activates a tab).
 * In the browser build every real-project jump is stubbed to a resolved-target
 * toast; the returned `message` is suitable for surfacing to the user.
 */
export async function jumpToIssueWork(issue: IssueViewModel): Promise<IssueJumpResult> {
  const ui = useUIStore.getState()
  // Remember which card we acted on regardless of outcome, so returning to the
  // inbox (back / re-clicking Issues) restores focus to it.
  ui.setSelectedIssueId(issue.id)

  const agentName = resolvedAgentName(issue)
  const agents = useAgentStore.getState().agents
  const targetAgent = findTrackedAgent(issue, agents)

  if (!agentName) {
    if (!isWebMock) ui.openDialog('spawn-agent')
    return { kind: 'unassigned', message: `Assign & spawn an agent for ${issue.identifier}` }
  }

  // Web build: resolve the target but don't navigate — no real shell.
  if (isWebMock) {
    const targetProjectId = targetAgent?.projectId
    const where = targetProjectId ? ` in ${targetProjectId}` : ''
    return {
      kind: 'stub',
      message: `Open ${agentName}${where} for ${issue.identifier}`,
      projectId: targetProjectId,
      agentName
    }
  }

  // Electron, agent is live → jump onto it.
  if (targetAgent && targetAgent.status === 'running') {
    const projectStore = useProjectStore.getState()
    const targetProjectId = targetAgent.projectId
    const agentKey = getAgentKeyForAgent(targetAgent)

    if (targetProjectId && projectStore.projects.some((project) => project.id === targetProjectId)) {
      if (projectStore.activeProjectId !== targetProjectId) {
        await projectStore.setActiveProject(targetProjectId)
      }
      useUIStore.getState().openTab({ kind: 'agents', projectId: targetProjectId })
    } else {
      useUIStore.getState().openTab({ kind: 'agents' })
    }

    useAgentStore.getState().setActiveAgentKey(agentKey)
    // openTab clears the breadcrumb; set it after so the agent header shows
    // `↩ PEAR-X` for the card we came from.
    useUIStore.getState().setAgentJumpIssueId(issue.id)

    return {
      kind: 'jumped',
      message: `Opened ${agentName} for ${issue.identifier}`,
      projectId: targetProjectId || getAgentKey(undefined, agentName),
      agentKey
    }
  }

  // Assigned but not spawned → reuse the existing spawn flow.
  ui.openDialog('spawn-agent')
  return { kind: 'spawn', message: `Spawn ${agentName} on ${issue.identifier}`, agentName }
}
