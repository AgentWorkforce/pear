import type React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot } from 'lucide-react'
import type { Agent } from '@/stores/agent-store'

interface AgentNodeData {
  agent: Agent
  [key: string]: unknown
}

const cliIcons: Record<string, string> = {
  claude: 'C',
  codex: 'X',
  gemini: 'G',
  opencode: 'O'
}

export function AgentNode({ data }: NodeProps): React.ReactNode {
  const { agent } = data as AgentNodeData
  const statusColor =
    agent.status === 'running' ? 'var(--pear-accent-bright)' : 'var(--pear-text-faint)'

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--pear-border)' }} />
      <div className="rounded-lg border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-4 py-3 shadow-lg">
        <div className="flex items-center gap-1.5">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-[var(--pear-bg)]">
            {cliIcons[agent.cli] ? (
              <span className="text-sm font-bold text-[var(--pear-accent)]">
                {cliIcons[agent.cli]}
              </span>
            ) : (
              <Bot size={16} className="text-[var(--pear-accent)]" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-[var(--pear-text)]">{agent.name}</span>
              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: statusColor }} />
            </div>
            <div className="text-xs text-[var(--pear-text-faint)]">
              {agent.cli}
              {agent.model && ` / ${agent.model}`}
            </div>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--pear-border)' }} />
    </>
  )
}
