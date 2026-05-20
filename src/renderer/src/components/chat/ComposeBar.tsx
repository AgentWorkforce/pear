import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  AtSign,
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Mic,
  Plus,
  Send,
  Smile,
  Strikethrough,
  Underline,
  Video
} from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import {
  getDirectMessageRecipientTargets,
  getDirectMessageRoomTitle
} from '@/lib/direct-messages'
import { pear } from '@/lib/ipc'
import { useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'

interface ComposerChromeButtonProps {
  label: string
  children: React.ReactNode
  className?: string
}

function ComposerChromeButton({
  label,
  children,
  className = ''
}: ComposerChromeButtonProps): React.ReactNode {
  return (
    <button
      type="button"
      disabled
      aria-label={label}
      className={`flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-[var(--pear-text-dim)] disabled:cursor-default disabled:opacity-100 ${className}`}
    >
      {children}
    </button>
  )
}

const CHANNEL_FORMAT_CONTROLS = [
  { label: 'Bold', icon: Bold },
  { label: 'Italic', icon: Italic },
  { label: 'Underline', icon: Underline },
  { label: 'Strikethrough', icon: Strikethrough },
  { label: 'Insert link', icon: Link2 },
  { label: 'Numbered list', icon: ListOrdered },
  { label: 'Bulleted list', icon: List },
  { label: 'Code', icon: Code }
]

const CHANNEL_ACTION_CONTROLS = [
  { label: 'Emoji', icon: Smile },
  { label: 'Mention', icon: AtSign },
  { label: 'Video clip', icon: Video },
  { label: 'Voice clip', icon: Mic }
]

interface MentionMatch {
  start: number
  end: number
  query: string
}

interface ComposeBarProps {
  directMessageParticipants?: string[]
}

function getMentionMatch(value: string, cursorPosition: number): MentionMatch | null {
  const clampedCursor = Math.max(0, Math.min(cursorPosition, value.length))
  const beforeCursor = value.slice(0, clampedCursor)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
  if (!match) return null

  return {
    start: clampedCursor - match[2].length - 1,
    end: clampedCursor,
    query: match[2]
  }
}

function getMentionScore(agentName: string, query: string): number {
  if (!query) return 0
  const lowerName = agentName.toLowerCase()
  const lowerQuery = query.toLowerCase()

  if (lowerName.startsWith(lowerQuery)) return 0

  const includesIndex = lowerName.indexOf(lowerQuery)
  return includesIndex === -1 ? Number.POSITIVE_INFINITY : includesIndex + 10
}

function getMentionInitials(name: string): string {
  return name
    .split(/[\s-_]+/)
    .map((part) => part[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function ComposeBar({ directMessageParticipants }: ComposeBarProps = {}): React.ReactNode {
  const [text, setText] = useState('')
  const [recipient, setRecipient] = useState('broadcast')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [cursorPosition, setCursorPosition] = useState(0)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const [dismissedMentionToken, setDismissedMentionToken] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
    (a) => a.status === 'running' && (!activeProjectId || a.projectId === activeProjectId)
  )
  const isDirectMessageComposer = directMessageTargets.length > 0
  const isChannelComposer = Boolean(!isDirectMessageComposer && activeChannelName && activeChannelNameTarget)
  const mentionMatch = getMentionMatch(text, cursorPosition)
  const mentionToken = mentionMatch ? `${mentionMatch.start}:${mentionMatch.query}` : null
  const mentionSuggestions = mentionMatch
    ? [...runningAgents]
        .filter((agent) => getMentionScore(agent.name, mentionMatch.query) !== Number.POSITIVE_INFINITY)
        .sort((left, right) => {
          const scoreDelta = getMentionScore(left.name, mentionMatch.query) - getMentionScore(right.name, mentionMatch.query)
          if (scoreDelta !== 0) return scoreDelta
          return left.name.localeCompare(right.name)
        })
        .slice(0, 6)
    : []
  const showMentionSuggestions =
    Boolean(mentionMatch) &&
    mentionSuggestions.length > 0 &&
    mentionToken !== dismissedMentionToken

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = '0px'
    const minHeight = 120
    const maxHeight = 260
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${Math.max(nextHeight, minHeight)}px`
  }, [text])

  useEffect(() => {
    if (isChannelComposer || isDirectMessageComposer) return
    if (recipient !== 'broadcast' && !runningAgents.some((agent) => agent.name === recipient)) {
      setRecipient('broadcast')
    }
  }, [isChannelComposer, isDirectMessageComposer, recipient, runningAgents])

  useEffect(() => {
    setSelectedMentionIndex(0)
  }, [mentionToken, activeProjectId])

  useEffect(() => {
    if (mentionToken !== dismissedMentionToken) return
    if (!mentionToken) {
      setDismissedMentionToken(null)
    }
  }, [dismissedMentionToken, mentionToken])

  const focusTextareaAt = (nextCursorPosition: number): void => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextCursorPosition, nextCursorPosition)
      setCursorPosition(nextCursorPosition)
    })
  }

  const insertMention = (agentName: string): void => {
    if (!mentionMatch) return
    const nextText = `${text.slice(0, mentionMatch.start)}@${agentName} ${text.slice(mentionMatch.end)}`
    const nextCursorPosition = mentionMatch.start + agentName.length + 2
    setText(nextText)
    setDismissedMentionToken(null)
    focusTextareaAt(nextCursorPosition)
  }

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
        await Promise.all(
          directMessageTargets.map((target) =>
            pear.broker.sendMessage(activeProjectId, { to: target, text: body, from: 'human' })
          )
        )
        addHumanMessage(directMessageTargets.join(', '), body, activeProjectId || undefined)
      } else if (isChannelComposer && activeChannelNameTarget) {
        await pear.broker.sendMessage(activeProjectId, {
          to: `#${activeChannelNameTarget}`,
          text: body,
          from: 'human'
        })
        addHumanMessage(`#${activeChannelNameTarget}`, body, activeProjectId || undefined)
      } else if (recipient === 'broadcast') {
        const targets = runningAgents.map((agent) => agent.name)
        if (targets.length === 0) {
          throw new Error('No running agents available')
        }
        await Promise.all(
          targets.map((target) =>
            pear.broker.sendMessage(activeProjectId, { to: target, text: body, from: 'human' })
          )
        )
        addHumanMessage('*', body, activeProjectId || undefined)
      } else {
        await pear.broker.sendMessage(activeProjectId, { to: recipient, text: body, from: 'human' })
        addHumanMessage(recipient, body, activeProjectId || undefined)
      }
      setText('')
      setCursorPosition(0)
      setDismissedMentionToken(null)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (showMentionSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedMentionIndex((currentIndex) =>
          currentIndex >= mentionSuggestions.length - 1 ? 0 : currentIndex + 1
        )
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedMentionIndex((currentIndex) =>
          currentIndex <= 0 ? mentionSuggestions.length - 1 : currentIndex - 1
        )
        return
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(mentionSuggestions[selectedMentionIndex].name)
        return
      }

      if (e.key === 'Escape' && mentionToken) {
        e.preventDefault()
        setDismissedMentionToken(mentionToken)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = Boolean(text.trim()) && !sending
  const placeholder = isChannelComposer
    ? `Message #${activeChannelName}`
    : directMessageTitle
      ? `Message ${directMessageTitle}`
    : recipient === 'broadcast'
      ? 'Send a message...'
      : `Message @${recipient}`

  return (
    <div className="shrink-0 border-t border-[var(--pear-bg-surface)] bg-[var(--pear-bg-raised)] p-5">
      {sendError && (
        <div className="mb-3 rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-4 py-2 text-xs text-[var(--pear-red)]">
          {sendError}
        </div>
      )}
      <div className="rounded-lg border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--pear-bg-overlay)] pb-2">
          {CHANNEL_FORMAT_CONTROLS.map(({ label, icon: Icon }) => (
            <ComposerChromeButton key={label} label={label}>
              <Icon size={16} />
            </ComposerChromeButton>
          ))}
        </div>

        <div className="relative mt-3">
          {showMentionSuggestions && (
            <div className="absolute bottom-full left-0 z-20 mb-3 w-full max-w-[420px] overflow-hidden rounded-lg border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-raised)] shadow-2xl">
              <div className="border-b border-[var(--pear-bg-overlay)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--pear-text-faint)]">
                Mention An Agent
              </div>
              <div className="py-1.5">
                {mentionSuggestions.map((agent, index) => {
                  const isSelected = index === selectedMentionIndex
                  return (
                    <button
                      key={agent.name}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault()
                        insertMention(agent.name)
                      }}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                        isSelected
                          ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                          : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)]'
                      }`}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--pear-bg-overlay)] text-[11px] font-semibold text-[var(--pear-text)]">
                        {getMentionInitials(agent.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-[inherit]">{agent.name}</span>
                          {agent.pendingDeliveryIds.length > 0 && (
                            <span className="text-[10px] text-[var(--pear-text-faint)]">thinking</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--pear-text-faint)]">
                          <AgentHarnessIcon
                            cli={agent.cli}
                            className="h-3 w-3 shrink-0 text-[var(--pear-text-faint)]"
                          />
                          <span>{agent.cli}</span>
                        </div>
                      </div>
                      <div
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          agent.status === 'running' ? 'bg-[var(--pear-accent)]' : 'bg-[var(--pear-text-faint)]'
                        }`}
                      />
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCursorPosition(e.target.selectionStart)
              setDismissedMentionToken(null)
            }}
            onKeyDown={handleKeyDown}
            onClick={(e) => {
              setCursorPosition(e.currentTarget.selectionStart)
            }}
            onKeyUp={(e) => {
              setCursorPosition(e.currentTarget.selectionStart)
            }}
            onSelect={(e) => {
              setCursorPosition(e.currentTarget.selectionStart)
            }}
            placeholder={placeholder}
            rows={4}
            disabled={sending}
            className="block w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-6 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] disabled:opacity-50"
          />
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-[var(--pear-bg-overlay)] pt-3">
          <div className="flex flex-wrap items-center gap-1">
            {!isChannelComposer && !isDirectMessageComposer && (
              <>
                <select
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  disabled={sending}
                  className="h-8 rounded-md border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg)] px-3 text-xs text-[var(--pear-text)] outline-none disabled:opacity-50"
                >
                  <option value="broadcast">Broadcast</option>
                  {runningAgents.map((a) => (
                    <option key={a.name} value={a.name}>
                      @{a.name}
                    </option>
                  ))}
                </select>
                <div className="mx-1 h-5 w-px bg-[var(--pear-bg-overlay)]" />
              </>
            )}
            <ComposerChromeButton label="Add item">
              <Plus size={18} />
            </ComposerChromeButton>
            <div className="mx-1 h-5 w-px bg-[var(--pear-bg-overlay)]" />
            <ComposerChromeButton label="Formatting" className="text-sm font-medium">
              <span>Aa</span>
            </ComposerChromeButton>
            {CHANNEL_ACTION_CONTROLS.map(({ label, icon: Icon }) => (
              <ComposerChromeButton key={label} label={label}>
                <Icon size={17} />
              </ComposerChromeButton>
            ))}
          </div>

          <button
            onClick={handleSend}
            disabled={!canSend}
            aria-label={isChannelComposer
              ? `Send message to #${activeChannelName}`
              : directMessageTitle
                ? `Send message to ${directMessageTitle}`
                : 'Send message'}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
              canSend
                ? 'bg-[var(--pear-accent)] text-[var(--pear-bg)] hover:opacity-90'
                : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)]'
            }`}
          >
            <Send size={15} className="translate-x-[1px]" />
          </button>
        </div>
      </div>
    </div>
  )
}
