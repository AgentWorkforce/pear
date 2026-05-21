import type React from 'react'
import { useMemo, useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Position
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { getAgentKey, getAgentKeyForAgent, type Agent, useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { AgentNode } from './AgentNode'
import { HierarchyEdge } from './HierarchyEdge'
import { MessageEdge } from './MessageEdge'
import { Network } from 'lucide-react'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { hierarchy: HierarchyEdge, message: MessageEdge }

const NODE_X_GAP = 320
const NODE_Y_GAP = 245
const NODE_START_X = 72
const NODE_START_Y = 56

interface GraphLayout {
  positions: Map<string, { x: number; y: number }>
  signature: string
}

function normalizeAgentTarget(target: string): string | null {
  const trimmed = target.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  return trimmed.replace(/^@/, '')
}

function compareAgents(left: Agent, right: Agent): number {
  return getAgentKeyForAgent(left).localeCompare(getAgentKeyForAgent(right))
}

function buildHierarchyLayout(agents: Agent[]): GraphLayout {
  const sortedAgents = [...agents].sort(compareAgents)
  const agentsByKey = new Map(sortedAgents.map((agent) => [getAgentKeyForAgent(agent), agent]))
  const childrenByParentKey = new Map<string | null, string[]>()
  const parentKeyByAgentKey = new Map<string, string | null>()

  for (const agent of sortedAgents) {
    const agentKey = getAgentKeyForAgent(agent)
    const parentKey = agent.parent ? getAgentKey(agent.projectId, agent.parent) : null
    const validParentKey = parentKey && agentsByKey.has(parentKey) ? parentKey : null
    parentKeyByAgentKey.set(agentKey, validParentKey)

    const siblingKeys = childrenByParentKey.get(validParentKey) || []
    siblingKeys.push(agentKey)
    childrenByParentKey.set(validParentKey, siblingKeys)
  }

  const levelKeys: string[][] = []
  const visitedKeys = new Set<string>()
  const visit = (agentKey: string, depth: number): void => {
    if (visitedKeys.has(agentKey)) return
    visitedKeys.add(agentKey)

    const keysAtLevel = levelKeys[depth] || []
    keysAtLevel.push(agentKey)
    levelKeys[depth] = keysAtLevel

    for (const childKey of childrenByParentKey.get(agentKey) || []) {
      visit(childKey, depth + 1)
    }
  }

  for (const rootKey of childrenByParentKey.get(null) || []) {
    visit(rootKey, 0)
  }

  for (const agent of sortedAgents) {
    visit(getAgentKeyForAgent(agent), 0)
  }

  const positions = new Map<string, { x: number; y: number }>()
  levelKeys.forEach((keys, depth) => {
    keys.forEach((agentKey, index) => {
      positions.set(agentKey, {
        x: NODE_START_X + index * NODE_X_GAP,
        y: NODE_START_Y + depth * NODE_Y_GAP
      })
    })
  })

  return {
    positions,
    signature: sortedAgents
      .map((agent) => {
        const agentKey = getAgentKeyForAgent(agent)
        return `${agentKey}<-${parentKeyByAgentKey.get(agentKey) || 'root'}`
      })
      .join('|')
  }
}

export function GraphView(): React.ReactNode {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const allAgents = useAgentStore((s) => s.agents)
  const allRelayMessages = useAgentStore((s) => s.relayMessages)
  const agents = useMemo(
    () => activeProjectId
      ? allAgents.filter((agent) => agent.projectId === activeProjectId)
      : allAgents,
    [activeProjectId, allAgents]
  )
  const relayMessages = useMemo(
    () => activeProjectId
      ? allRelayMessages.filter((message) => message.projectId === activeProjectId)
      : allRelayMessages,
    [activeProjectId, allRelayMessages]
  )
  const activeAgentKey = useAgentStore((s) => s.activeAgentKey)
  const layout = useMemo(() => buildHierarchyLayout(agents), [agents])

  const initialNodes: Node[] = useMemo(() => {
    return agents.map((agent, i) => ({
      id: getAgentKeyForAgent(agent),
      type: 'agent',
      position: layout.positions.get(getAgentKeyForAgent(agent)) || {
        x: NODE_START_X + i * NODE_X_GAP,
        y: NODE_START_Y
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: { agent, active: getAgentKeyForAgent(agent) === activeAgentKey }
    }))
  }, [activeAgentKey, agents, layout])

  const initialEdges: Edge[] = useMemo(() => {
    const agentKeys = new Set(agents.map(getAgentKeyForAgent))
    const hierarchyEdges: Edge[] = agents
      .map((agent) => {
        if (!agent.parent) return null

        const source = getAgentKey(agent.projectId, agent.parent)
        const target = getAgentKeyForAgent(agent)
        if (!agentKeys.has(source)) return null

        return {
          id: `hierarchy:${source}->${target}`,
          source,
          target,
          type: 'hierarchy',
          selectable: false,
          focusable: false,
          zIndex: 0
        } satisfies Edge
      })
      .filter((edge): edge is Edge => edge !== null)

    const edgeMap = new Map<string, { count: number; lastBody: string; lastTimestamp: number }>()
    for (const msg of relayMessages) {
      const source = getAgentKey(msg.projectId || activeProjectId || undefined, msg.from)
      const targetName = normalizeAgentTarget(msg.target)
      if (!targetName) continue

      const target = getAgentKey(msg.projectId || activeProjectId || undefined, targetName)
      if (source === target || !agentKeys.has(source) || !agentKeys.has(target)) continue

      const key = `message:${source}->${target}`
      const existing = edgeMap.get(key)
      edgeMap.set(key, {
        count: (existing?.count || 0) + 1,
        lastBody: msg.body,
        lastTimestamp: msg.timestamp
      })
    }
    const messageEdges = Array.from(edgeMap.entries()).map(([key, val]) => {
      const [source, target] = key.replace(/^message:/, '').split('->')
      return {
        id: key,
        source,
        target,
        type: 'message',
        data: { count: val.count, lastBody: val.lastBody, lastTimestamp: val.lastTimestamp },
        zIndex: 1
      } satisfies Edge
    })

    return [...hierarchyEdges, ...messageEdges]
  }, [activeProjectId, agents, relayMessages])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const layoutSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    setNodes((currentNodes) => {
      const layoutChanged = layoutSignatureRef.current !== layout.signature
      layoutSignatureRef.current = layout.signature
      const currentById = new Map(currentNodes.map((node) => [node.id, node]))

      return initialNodes.map((node) => {
        const currentNode = currentById.get(node.id)
        if (!currentNode || layoutChanged) return node
        return {
          ...currentNode,
          ...node,
          position: currentNode.position,
          selected: currentNode.selected
        }
      })
    })
  }, [initialNodes, layout.signature, setNodes])

  useEffect(() => {
    setEdges(initialEdges)
  }, [initialEdges, setEdges])

  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setActiveAgentKey(node.id)
    },
    [setActiveAgentKey]
  )

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-[var(--pear-bg)] text-[var(--pear-text-faint)]">
        <Network size={40} />
        <p className="text-sm">No agents to visualize</p>
      </div>
    )
  }

  return (
    <div className="h-full w-full bg-[var(--pear-bg)]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="var(--pear-bg-overlay)" gap={20} size={1} />
        <Controls
          style={{
            backgroundColor: 'var(--pear-bg-surface)',
            borderColor: 'var(--pear-bg-overlay)',
            color: 'var(--pear-text)'
          }}
        />
      </ReactFlow>
    </div>
  )
}
