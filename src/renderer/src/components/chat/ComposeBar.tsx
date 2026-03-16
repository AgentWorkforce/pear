import type React from 'react'
import { useState } from 'react'
import { Send } from 'lucide-react'
import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export function ComposeBar(): React.ReactNode {
  const [text, setText] = useState('')
  const [recipient, setRecipient] = useState('broadcast')
  const agents = useAgentStore((s) => s.agents)
  const addHumanMessage = useAgentStore((s) => s.addHumanMessage)
  const activeChannelPrefixed = useWorkspaceStore((s) => s.getActiveChannelPrefixed())
  const activeWorktree = useWorkspaceStore((s) => s.getActiveWorktree())
  const runningAgents = agents.filter((a) =>
    a.status === 'running' && (!a.worktreeId || a.worktreeId === activeWorktree?.id)
  )

  const handleSend = async (): Promise<void> => {
    if (!text.trim()) return
    const to = recipient === 'broadcast' ? '*' : recipient
    await pear.broker.sendMessage({ to, text: text.trim(), from: 'human' })
    addHumanMessage(to, text.trim(), activeChannelPrefixed || undefined)
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="shrink-0 border-t border-[var(--pear-bg-surface)] bg-[var(--pear-bg-raised)] p-4">
      <div className="flex items-end gap-2">
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className="shrink-0 rounded border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-2 py-1 text-xs text-[var(--pear-text)] outline-none"
        >
          <option value="broadcast">Broadcast</option>
          {runningAgents.map((a) => (
            <option key={a.name} value={a.name}>
              @{a.name}
            </option>
          ))}
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          rows={1}
          className="min-h-[36px] flex-1 resize-none rounded border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-3 py-2 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent)]"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="rounded bg-[var(--pear-accent)] p-1.5 text-[var(--pear-bg)] hover:opacity-90 disabled:opacity-50"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
