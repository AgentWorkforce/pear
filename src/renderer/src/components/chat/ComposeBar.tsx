import type React from 'react'
import { useEffect, useState } from 'react'
import {
  getDirectMessageRecipientTargets,
  getDirectMessageRoomTitle
} from '@/lib/direct-messages'
import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { ChatComposerInput } from './ChatComposerInput'

interface ComposeBarProps {
  directMessageParticipants?: string[]
}

export function ComposeBar({ directMessageParticipants }: ComposeBarProps = {}): React.ReactNode {
  const [text, setText] = useState('')
  const [recipient, setRecipient] = useState('broadcast')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const agents = useAgentStore((s) => s.agents)
  const addHumanMessage = useAgentStore((s) => s.addHumanMessage)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const activeChannelNameTarget = useProjectStore((s) => s.getActiveChannelName())
  const directMessageTargets = directMessageParticipants
    ? getDirectMessageRecipientTargets(directMessageParticipants)
    : []
  const directMessageTitle = directMessageParticipants
    ? getDirectMessageRoomTitle(directMessageParticipants)
    : null
  const runningAgents = agents.filter(
    (agent) => agent.status === 'running' && (!activeProjectId || agent.projectId === activeProjectId)
  )
  const isDirectMessageComposer = directMessageTargets.length > 0
  const isChannelComposer = Boolean(!isDirectMessageComposer && activeChannelName && activeChannelNameTarget)

  useEffect(() => {
    if (isChannelComposer || isDirectMessageComposer) return
    if (recipient !== 'broadcast' && !runningAgents.some((agent) => agent.name === recipient)) {
      setRecipient('broadcast')
    }
  }, [isChannelComposer, isDirectMessageComposer, recipient, runningAgents])

  const handleSend = async (): Promise<void> => {
    if (!text.trim() || sending) return
    const body = text.trim()
    setSending(true)
    setSendError(null)
    try {
      if (!activeProjectId) {
        throw new Error('No project selected')
      }
      if (isDirectMessageComposer) {
        const results = await Promise.all(
          directMessageTargets.map((target) =>
            pear.broker.sendMessage(activeProjectId, { to: target, text: body, from: 'human' })
          )
        )
        // Only a single-target DM has one canonical echo to adopt; a fan-out to
        // several participants produces one echo each, none of which maps to the
        // single combined optimistic record, so it stays on the heuristic path.
        const canonicalId = directMessageTargets.length === 1 ? results[0]?.eventId : undefined
        addHumanMessage(directMessageTargets.join(', '), body, activeProjectId || undefined, canonicalId)
      } else if (isChannelComposer && activeChannelNameTarget) {
        const { eventId } = await pear.broker.sendMessage(activeProjectId, {
          to: `#${activeChannelNameTarget}`,
          text: body,
          from: 'human'
        })
        addHumanMessage(`#${activeChannelNameTarget}`, body, activeProjectId || undefined, eventId)
      } else if (recipient === 'broadcast') {
        const targets = runningAgents.map((agent) => agent.name)
        if (targets.length === 0) {
          throw new Error('No running agents available')
        }
        // Broadcast fans out to N agents (N canonical echoes) but shows one '*'
        // optimistic record, so there's no single id to adopt — heuristic path.
        await Promise.all(
          targets.map((target) =>
            pear.broker.sendMessage(activeProjectId, { to: target, text: body, from: 'human' })
          )
        )
        addHumanMessage('*', body, activeProjectId || undefined)
      } else {
        const { eventId } = await pear.broker.sendMessage(activeProjectId, { to: recipient, text: body, from: 'human' })
        addHumanMessage(recipient, body, activeProjectId || undefined, eventId)
      }
      setText('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const placeholder = isChannelComposer
    ? `Message #${activeChannelName}`
    : directMessageTitle
      ? `Message ${directMessageTitle}`
    : recipient === 'broadcast'
      ? 'Send a message...'
      : `Message @${recipient}`
  const sendLabel = isChannelComposer
    ? `Send message to #${activeChannelName}`
    : directMessageTitle
      ? `Send message to ${directMessageTitle}`
      : 'Send message'
  const footerLeadingControls = !isChannelComposer && !isDirectMessageComposer ? (
    <>
      <select
        value={recipient}
        onChange={(event) => setRecipient(event.target.value)}
        disabled={sending}
        className="h-8 rounded-md border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg)] px-3 text-xs text-[var(--pear-text)] outline-none disabled:opacity-50"
      >
        <option value="broadcast">Broadcast</option>
        {runningAgents.map((agent) => (
          <option key={agent.name} value={agent.name}>
            @{agent.name}
          </option>
        ))}
      </select>
      <div className="mx-1 h-5 w-px bg-[var(--pear-bg-overlay)]" />
    </>
  ) : null

  return (
    <div className="shrink-0 border-t border-[var(--pear-bg-surface)] bg-[var(--pear-bg-raised)] p-4">
      {sendError && (
        <div className="mb-3 rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-4 py-2 text-xs text-[var(--pear-red)]">
          {sendError}
        </div>
      )}
      <ChatComposerInput
        value={text}
        placeholder={placeholder}
        sendLabel={sendLabel}
        runningAgents={runningAgents}
        activeProjectId={activeProjectId}
        disabled={sending}
        canSend={Boolean(text.trim()) && !sending}
        footerLeadingControls={footerLeadingControls}
        onChange={setText}
        onSubmit={handleSend}
      />
    </div>
  )
}
