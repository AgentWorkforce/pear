import type React from 'react'
import { useEffect, useRef } from 'react'
import { Hash } from 'lucide-react'
import { useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { ChatMessage } from './ChatMessage'
import { ComposeBar } from './ComposeBar'

export function ChatView(): React.ReactNode {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const allMessages = useAgentStore((s) => s.messages)
  const allAgents = useAgentStore((s) => s.agents)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = activeProjectId
    ? allMessages.filter((msg) => msg.projectId === activeProjectId)
    : allMessages
  const agents = activeProjectId
    ? allAgents.filter((agent) => agent.projectId === activeProjectId)
    : allAgents

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length])

  if (agents.length === 0 && !activeChannelName) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)]">
        <p className="text-xs text-[var(--pear-text-faint)]">Spawn an agent to start messaging</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg)]">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--pear-bg-surface)] bg-[var(--pear-bg-raised)] px-6 py-4">
        {activeChannelName ? (
          <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--pear-text-secondary)]">
            <Hash size={14} />
            {activeChannelName}
          </span>
        ) : (
          <span className="text-sm font-medium text-[var(--pear-text-secondary)]">Chat</span>
        )}
        <span className="ml-2 text-xs text-[var(--pear-text-faint)]">
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--pear-text-faint)]">
            {activeChannelName
              ? `No messages yet. Send the first message in #${activeChannelName}.`
              : 'No messages yet. Messages will appear here.'}
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
          </div>
        )}
      </div>

      {/* Compose */}
      <ComposeBar />
    </div>
  )
}
