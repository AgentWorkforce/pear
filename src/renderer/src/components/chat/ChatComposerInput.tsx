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
import { applyChatFormat, looksLikeUrl, type ChatFormatAction } from '@/lib/chat-formatting'
import type { Agent } from '@/stores/agent-store'

interface ComposerChromeButtonProps {
  label: string
  children: React.ReactNode
  className?: string
  active?: boolean
  disabled?: boolean
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMouseDown?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

function ComposerChromeButton({
  label,
  children,
  className = '',
  active = false,
  disabled = false,
  onClick,
  onMouseDown
}: ComposerChromeButtonProps): React.ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseDown={(event) => {
        if (!onMouseDown) return
        event.preventDefault()
        onMouseDown(event)
      }}
      className={`flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-[var(--pear-text-dim)] transition-colors ${
        active
          ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
          : disabled
            ? 'cursor-default opacity-55'
            : 'hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]'
      } ${className}`}
    >
      {children}
    </button>
  )
}

const FORMAT_CONTROLS: {
  label: string
  action: ChatFormatAction
  icon: React.ComponentType<{ size?: number }>
}[] = [
  { label: 'Bold', action: 'bold', icon: Bold },
  { label: 'Italic', action: 'italic', icon: Italic },
  { label: 'Underline', action: 'underline', icon: Underline },
  { label: 'Strikethrough', action: 'strikethrough', icon: Strikethrough },
  { label: 'Insert link', action: 'link', icon: Link2 },
  { label: 'Numbered list', action: 'numbered-list', icon: ListOrdered },
  { label: 'Bulleted list', action: 'bulleted-list', icon: List },
  { label: 'Code', action: 'code', icon: Code }
]

const ACTION_CONTROLS = [
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

interface ChatComposerInputProps {
  value: string
  placeholder: string
  sendLabel: string
  runningAgents: Array<Pick<Agent, 'name'> & Partial<Pick<Agent, 'cli' | 'status' | 'pendingDeliveryIds'>>>
  activeProjectId?: string | null
  disabled?: boolean
  canSend?: boolean
  footerLeadingControls?: React.ReactNode
  onChange: (value: string) => void
  onSubmit: () => void | Promise<void>
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

export function ChatComposerInput({
  value,
  placeholder,
  sendLabel,
  runningAgents,
  activeProjectId,
  disabled = false,
  canSend = Boolean(value.trim()) && !disabled,
  footerLeadingControls,
  onChange,
  onSubmit
}: ChatComposerInputProps): React.ReactNode {
  const [formattingVisible, setFormattingVisible] = useState(true)
  const [cursorPosition, setCursorPosition] = useState(0)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const [dismissedMentionToken, setDismissedMentionToken] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionMatch = getMentionMatch(value, cursorPosition)
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
    const minHeight = 56
    const maxHeight = 140
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${Math.max(nextHeight, minHeight)}px`
  }, [value])

  useEffect(() => {
    setSelectedMentionIndex(0)
  }, [mentionToken, activeProjectId])

  useEffect(() => {
    if (mentionToken !== dismissedMentionToken) return
    if (!mentionToken) {
      setDismissedMentionToken(null)
    }
  }, [dismissedMentionToken, mentionToken])

  const focusTextareaSelection = (nextSelectionStart: number, nextSelectionEnd = nextSelectionStart): void => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextSelectionStart, nextSelectionEnd)
      setCursorPosition(nextSelectionEnd)
    })
  }

  const focusTextareaAt = (nextCursorPosition: number): void => {
    focusTextareaSelection(nextCursorPosition)
  }

  const insertMention = (agentName: string): void => {
    if (!mentionMatch) return
    const nextText = `${value.slice(0, mentionMatch.start)}@${agentName} ${value.slice(mentionMatch.end)}`
    const nextCursorPosition = mentionMatch.start + agentName.length + 2
    onChange(nextText)
    setDismissedMentionToken(null)
    focusTextareaAt(nextCursorPosition)
  }

  const applyFormatToSelection = (action: ChatFormatAction): void => {
    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? value.length
    const selectionEnd = textarea?.selectionEnd ?? selectionStart
    const selectedText = value.slice(selectionStart, selectionEnd)
    const linkUrl = action === 'link'
      ? window.prompt('Enter link URL', looksLikeUrl(selectedText) ? selectedText.trim() : 'https://')
      : undefined

    if (action === 'link' && linkUrl === null) {
      focusTextareaSelection(selectionStart, selectionEnd)
      return
    }

    const result = applyChatFormat(value, selectionStart, selectionEnd, action, { linkUrl: linkUrl || undefined })

    onChange(result.text)
    setDismissedMentionToken(null)
    focusTextareaSelection(result.selectionStart, result.selectionEnd)
  }

  const submit = (): void => {
    if (!canSend || disabled) return
    setCursorPosition(0)
    setDismissedMentionToken(null)
    void onSubmit()
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    const modifierPressed = event.metaKey || event.ctrlKey
    if (modifierPressed && !event.altKey) {
      const key = event.key.toLowerCase()
      const shortcutAction: ChatFormatAction | null =
        key === 'b' && !event.shiftKey ? 'bold'
        : key === 'i' && !event.shiftKey ? 'italic'
        : key === 'u' && !event.shiftKey ? 'underline'
        : key === 'k' && !event.shiftKey ? 'link'
        : key === 'x' && event.shiftKey ? 'strikethrough'
        : key === '7' && event.shiftKey ? 'numbered-list'
        : key === '8' && event.shiftKey ? 'bulleted-list'
        : key === 'c' && event.shiftKey ? 'code'
        : null

      if (shortcutAction) {
        event.preventDefault()
        applyFormatToSelection(shortcutAction)
        return
      }
    }

    if (showMentionSuggestions) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedMentionIndex((currentIndex) =>
          currentIndex >= mentionSuggestions.length - 1 ? 0 : currentIndex + 1
        )
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedMentionIndex((currentIndex) =>
          currentIndex <= 0 ? mentionSuggestions.length - 1 : currentIndex - 1
        )
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertMention(mentionSuggestions[selectedMentionIndex].name)
        return
      }

      if (event.key === 'Escape' && mentionToken) {
        event.preventDefault()
        setDismissedMentionToken(mentionToken)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="rounded-lg border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-4 py-3 transition-colors focus-within:border-[var(--pear-border)]">
      {formattingVisible && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--pear-bg-overlay)] pb-2.5">
          {FORMAT_CONTROLS.map(({ label, action, icon: Icon }) => (
            <ComposerChromeButton
              key={label}
              label={label}
              onMouseDown={() => applyFormatToSelection(action)}
            >
              <Icon size={16} />
            </ComposerChromeButton>
          ))}
        </div>
      )}

      <div className={`relative ${formattingVisible ? 'mt-2.5' : ''}`}>
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
                        {(agent.pendingDeliveryIds?.length ?? 0) > 0 && (
                          <span className="text-[10px] text-[var(--pear-text-faint)]">thinking</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--pear-text-faint)]">
                        <AgentHarnessIcon
                          cli={agent.cli || 'unknown'}
                          className="h-3 w-3 shrink-0 text-[var(--pear-text-faint)]"
                        />
                        <span>{agent.cli || 'unknown'}</span>
                      </div>
                    </div>
                    <div
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        agent.status !== 'exited' ? 'bg-[var(--pear-accent)]' : 'bg-[var(--pear-text-faint)]'
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
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            setCursorPosition(event.target.selectionStart)
            setDismissedMentionToken(null)
          }}
          onKeyDown={handleKeyDown}
          onClick={(event) => {
            setCursorPosition(event.currentTarget.selectionStart)
          }}
          onKeyUp={(event) => {
            setCursorPosition(event.currentTarget.selectionStart)
          }}
          onSelect={(event) => {
            setCursorPosition(event.currentTarget.selectionStart)
          }}
          placeholder={placeholder}
          rows={2}
          disabled={disabled}
          data-focus-ring="none"
          className="block w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] disabled:opacity-50"
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-[var(--pear-bg-overlay)] pt-2.5">
        <div className="flex flex-wrap items-center gap-1">
          {footerLeadingControls}
          <ComposerChromeButton label="Add item" disabled>
            <Plus size={18} />
          </ComposerChromeButton>
          <div className="mx-1 h-5 w-px bg-[var(--pear-bg-overlay)]" />
          <ComposerChromeButton
            label="Formatting"
            active={formattingVisible}
            className="text-sm font-medium"
            onClick={() => setFormattingVisible((visible) => !visible)}
          >
            <span>Aa</span>
          </ComposerChromeButton>
          {ACTION_CONTROLS.map(({ label, icon: Icon }) => (
            <ComposerChromeButton key={label} label={label} disabled>
              <Icon size={17} />
            </ComposerChromeButton>
          ))}
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!canSend || disabled}
          aria-label={sendLabel}
          className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
            canSend && !disabled
              ? 'bg-[var(--pear-accent)] text-[var(--pear-bg)] hover:opacity-90'
              : 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)]'
          }`}
        >
          <Send size={15} className="translate-x-[1px]" />
        </button>
      </div>
    </div>
  )
}
