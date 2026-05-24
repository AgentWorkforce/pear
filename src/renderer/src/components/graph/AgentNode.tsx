import type React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot, GitBranch } from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import { usePtyTail } from '@/hooks/use-pty-tail'
import type { Agent } from '@/stores/agent-store'

interface AgentNodeData {
  agent: Agent
  active?: boolean
  [key: string]: unknown
}

const ANSI_ESCAPE_PATTERN =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

function cleanTerminalText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n\t]+$/gm, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

function getTerminalPreviewLines(rawText: string): string[] {
  const text = cleanTerminalText(rawText)
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line, index, allLines) => line.trim().length > 0 || index > allLines.length - 8)
    .slice(-8)

  return lines.length > 0 ? lines : ['No terminal output yet']
}

export function AgentNode({ data }: NodeProps): React.ReactNode {
  const { agent, active } = data as AgentNodeData
  const statusColor =
    agent.status === 'running' ? 'var(--pear-accent-bright)' : 'var(--pear-text-faint)'
  const terminalTail = usePtyTail(agent.projectId, agent.name)
  const previewLines = getTerminalPreviewLines(terminalTail)

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--pear-border)' }} />
      <div
        className={`w-[260px] rounded-lg border bg-[var(--pear-bg-surface)] px-3 py-3 shadow-lg ${
          active
            ? 'border-[var(--pear-accent-dim)] ring-1 ring-[var(--pear-accent-dim)]/50'
            : 'border-[var(--pear-bg-overlay)]'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[var(--pear-bg)]">
            {agent.cli ? (
              <AgentHarnessIcon cli={agent.cli} className="h-4 w-4 text-[var(--pear-accent)]" />
            ) : (
              <Bot size={16} className="text-[var(--pear-accent)]" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-sm font-medium text-[var(--pear-text)]">{agent.name}</span>
              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: statusColor }} />
            </div>
            <div className="truncate text-xs text-[var(--pear-text-faint)]">
              {agent.cli}
              {agent.model && ` / ${agent.model}`}
            </div>
          </div>
          {agent.parent && (
            <div
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--pear-bg)] text-[var(--pear-text-faint)]"
              title={`Child of ${agent.parent}`}
              aria-label={`Child of ${agent.parent}`}
            >
              <GitBranch size={13} />
            </div>
          )}
        </div>
        <div className="mt-3 h-[92px] overflow-hidden rounded-md border border-[var(--pear-border-subtle)] bg-[#050a0f] px-2 py-1.5 text-[10px] leading-[1.25] text-[#a8f0c6] shadow-inner">
          <pre className="h-full overflow-hidden whitespace-pre-wrap break-words font-mono">{previewLines.join('\n')}</pre>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--pear-border)' }} />
    </>
  )
}
