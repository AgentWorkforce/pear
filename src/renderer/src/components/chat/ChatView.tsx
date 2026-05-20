import type React from 'react'
import { Fragment, useEffect, useMemo, useRef } from 'react'
import { Hash } from 'lucide-react'
import { useAgentStore, type ChatMessage as ChatMessageType } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { ChatMessage } from './ChatMessage'
import { ComposeBar } from './ComposeBar'

function normalizeMessageChannel(target: string): string {
  return target.trim().replace(/^#/, '')
}

function isChannelMessage(message: ChatMessageType, channelName: string): boolean {
  return normalizeMessageChannel(message.to) === channelName
}

function isHumanMessage(message: ChatMessageType): boolean {
  return message.isHuman || message.from.trim().toLowerCase() === 'human'
}

function areDuplicateHumanMessages(left: ChatMessageType, right: ChatMessageType): boolean {
  return isHumanMessage(left) &&
    isHumanMessage(right) &&
    left.body === right.body &&
    (!left.projectId || !right.projectId || left.projectId === right.projectId) &&
    normalizeMessageChannel(left.to) === normalizeMessageChannel(right.to) &&
    Math.abs(left.timestamp - right.timestamp) < 10_000
}

function dedupeHumanMessages(messages: ChatMessageType[]): ChatMessageType[] {
  const deduped: ChatMessageType[] = []

  for (const message of messages) {
    const duplicateIndex = deduped.findIndex((candidate) => areDuplicateHumanMessages(candidate, message))
    if (duplicateIndex === -1) {
      deduped.push(message)
      continue
    }

    if (message.isHuman && !deduped[duplicateIndex].isHuman) {
      deduped[duplicateIndex] = message
    }
  }

  return deduped
}

function isSameDay(left: number, right: number): boolean {
  const leftDate = new Date(left)
  const rightDate = new Date(right)

  return leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
}

function getStartOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function formatDateDivider(timestamp: number): string {
  const date = new Date(timestamp)
  const today = getStartOfDay(new Date())
  const messageDay = getStartOfDay(date)
  const dayDelta = Math.round((today - messageDay) / 86_400_000)

  if (dayDelta === 0) return 'Today'
  if (dayDelta === 1) return 'Yesterday'

  const currentYear = new Date().getFullYear()
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === currentYear ? {} : { year: 'numeric' })
  })
}

function DateDivider({ timestamp }: { timestamp: number }): React.ReactNode {
  return (
    <div className="relative my-4 flex items-center justify-center">
      <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--pear-border-subtle)]" />
      <span className="relative rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-1 text-xs font-medium text-[var(--pear-text-secondary)]">
        {formatDateDivider(timestamp)}
      </span>
    </div>
  )
}

export function ChatView(): React.ReactNode {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const allMessages = useAgentStore((s) => s.messages)
  const allAgents = useAgentStore((s) => s.agents)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const scrollRef = useRef<HTMLDivElement>(null)

  const projectMessages = useMemo(
    () => activeProjectId
      ? allMessages.filter((message) => message.projectId === activeProjectId)
      : allMessages,
    [activeProjectId, allMessages]
  )
  const messages = useMemo(
    () => {
      const scopedMessages = activeChannelName
        ? projectMessages.filter((message) => isChannelMessage(message, activeChannelName))
        : projectMessages
      return dedupeHumanMessages(scopedMessages)
    },
    [activeChannelName, projectMessages]
  )
  const agents = useMemo(
    () => activeProjectId
      ? allAgents.filter((agent) => agent.projectId === activeProjectId)
      : allAgents,
    [activeProjectId, allAgents]
  )

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [activeChannelName, messages.length])

  if (agents.length === 0 && !activeChannelName) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--pear-bg)]">
        <p className="text-xs text-[var(--pear-text-faint)]">Spawn an agent to start messaging</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg)]">
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-5">
        <div className="min-w-0">
          {activeChannelName ? (
            <div className="flex min-w-0 items-center gap-2">
              <Hash size={16} className="shrink-0 text-[var(--pear-text-faint)]" />
              <span className="min-w-0 truncate text-base font-semibold text-[var(--pear-text)]">
                {activeChannelName}
              </span>
            </div>
          ) : (
            <span className="text-base font-semibold text-[var(--pear-text)]">Messages</span>
          )}
        </div>
        <span className="shrink-0 text-xs text-[var(--pear-text-faint)]">
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--pear-text-faint)]">
            {activeChannelName
              ? `No messages in #${activeChannelName} yet.`
              : 'No messages yet.'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {messages.map((message, index) => {
              const previousMessage = messages[index - 1]
              const showDateDivider = !previousMessage || !isSameDay(previousMessage.timestamp, message.timestamp)

              return (
                <Fragment key={message.id}>
                  {showDateDivider && <DateDivider timestamp={message.timestamp} />}
                  <ChatMessage message={message} showRoute={!activeChannelName} />
                </Fragment>
              )
            })}
          </div>
        )}
      </div>

      <ComposeBar />
    </div>
  )
}
