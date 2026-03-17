import type React from 'react'
import { useState } from 'react'
import { Send } from 'lucide-react'
import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export function ComposeBar(): React.ReactNode {
  const [text, setText] = useState('')
  const [recipient, setRecipient] = useState('broadcast')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const agents = useAgentStore((s) => s.agents)
  const addHumanMessage = useAgentStore((s) => s.addHumanMessage)
  const activeChannelPrefixed = useWorkspaceStore((s) => s.getActiveChannelPrefixed())
  const activeWorktree = useWorkspaceStore((s) => s.getActiveWorktree())
  const runningAgents = agents.filter((a) =>
    a.status === 'running' && (!a.worktreeId || a.worktreeId === activeWorktree?.id)
  )

  const handleSend = async (): Promise<void> => {
    if (!text.trim() || sending) return
    const to = recipient === 'broadcast' ? '*' : recipient
    const body = text.trim()
    setSending(true)
    setSendError(null)
    try {
      await pear.broker.sendMessage({ to, text: body, from: 'human' })
      addHumanMessage(to, body, activeChannelPrefixed || undefined)
      setText('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="shrink-0 border-t border-[var(--pear-bg-surface)] bg-[var(--pear-bg-raised)] p-4">
      {sendError && (
        <div className="mb-2 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-1.5 text-xs text-[var(--pear-red)]">
          {sendError}
        </div>
      )}
      <div className="flex items-end gap-2">
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={sending}
          className="shrink-0 rounded border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-2 py-1 text-xs text-[var(--pear-text)] outline-none disabled:opacity-50"
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
          disabled={sending}
          className="min-h-[36px] flex-1 resize-none rounded border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-3 py-2 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent)] disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || sending}
          aria-label="Send message"
          className="rounded bg-[var(--pear-accent)] p-1.5 text-[var(--pear-bg)] hover:opacity-90 disabled:opacity-50"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
