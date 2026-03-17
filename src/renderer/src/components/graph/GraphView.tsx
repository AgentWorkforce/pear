import type React from 'react'
import { useMemo, useCallback, useEffect } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  BackgroundVariant
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useAgentStore } from '@/stores/agent-store'
import { AgentNode } from './AgentNode'
import { MessageEdge } from './MessageEdge'
import { Network } from 'lucide-react'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { message: MessageEdge }

export function GraphView(): React.ReactNode {
  const agents = useAgentStore((s) => s.agents)
  const relayMessages = useAgentStore((s) => s.relayMessages)

  const initialNodes: Node[] = useMemo(() => {
    const cols = Math.ceil(Math.sqrt(agents.length))
    return agents.map((agent, i) => ({
      id: agent.name,
      type: 'agent',
      position: { x: (i % cols) * 220 + 50, y: Math.floor(i / cols) * 160 + 50 },
      data: { agent }
    }))
  }, [agents])

  const initialEdges: Edge[] = useMemo(() => {
    const edgeMap = new Map<string, { count: number; lastBody: string }>()
    for (const msg of relayMessages) {
      const key = `${msg.from}->${msg.target}`
      const existing = edgeMap.get(key)
      edgeMap.set(key, {
        count: (existing?.count || 0) + 1,
        lastBody: msg.body
      })
    }
    return Array.from(edgeMap.entries()).map(([key, val]) => ({
      id: key,
      source: key.split('->')[0],
      target: key.split('->')[1],
      type: 'message',
      data: { count: val.count, lastBody: val.lastBody },
      animated: true
    }))
  }, [relayMessages])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    setNodes(initialNodes)
  }, [initialNodes, setNodes])

  useEffect(() => {
    setEdges(initialEdges)
  }, [initialEdges, setEdges])

  const setActiveAgent = useAgentStore((s) => s.setActiveAgent)
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setActiveAgent(node.id)
    },
    [setActiveAgent]
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
