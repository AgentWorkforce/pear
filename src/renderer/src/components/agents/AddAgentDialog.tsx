import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { Cloud, Monitor, X } from 'lucide-react'

type AddAgentChoice = 'local' | 'cloud'

export interface AddAgentDialogProps {
  open: boolean
  onClose: () => void
  onSelectLocal: () => void
  onSelectCloud: () => void
}

interface AgentChoiceOption {
  choice: AddAgentChoice
  title: string
  description: string
  action: string
  ariaLabel: string
  Icon: typeof Monitor
}

const AGENT_OPTIONS: AgentChoiceOption[] = [
  {
    choice: 'local',
    title: 'Local agent',
    description: 'Runs on this machine via the bundled broker.',
    action: 'Add local agent',
    ariaLabel: 'Add local agent',
    Icon: Monitor
  },
  {
    choice: 'cloud',
    title: 'Cloud agent',
    description: 'Runs in a Daytona sandbox synced with your project files.',
    action: 'Continue',
    ariaLabel: 'Continue with cloud agent',
    Icon: Cloud
  }
]

export function AddAgentDialog({
  open,
  onClose,
  onSelectLocal,
  onSelectCloud
}: AddAgentDialogProps): React.ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return

    const dialog = dialogRef.current
    if (!dialog) return

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  const handleChoice = (choice: AddAgentChoice): void => {
    if (choice === 'local') {
      onSelectLocal()
      return
    }

    onSelectCloud()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-agent-dialog-title"
        className="w-full max-w-[540px] rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-5 py-4">
          <h2 id="add-agent-dialog-title" className="text-base font-semibold text-[var(--pear-text)]">
            Add agent
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {AGENT_OPTIONS.map(({ choice, title, description, action, ariaLabel, Icon }) => (
              <button
                key={choice}
                type="button"
                autoFocus={choice === 'local'}
                aria-label={ariaLabel}
                onClick={() => handleChoice(choice)}
                className="group flex min-h-[180px] flex-col items-start justify-between rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] p-4 text-left hover:border-[var(--pear-accent-dim)] hover:bg-[var(--pear-bg-surface-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--pear-accent-dim)]"
              >
                <span className="flex flex-col gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] text-[var(--pear-text-dim)] group-hover:text-[var(--pear-text)]">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-[var(--pear-text)]">{title}</span>
                    <span className="text-xs leading-5 text-[var(--pear-text-faint)]">{description}</span>
                  </span>
                </span>
                <span className="mt-4 inline-flex h-8 items-center rounded-md border border-[var(--pear-border)] px-3 text-xs font-medium text-[var(--pear-text-dim)] group-hover:border-[var(--pear-accent-dim)] group-hover:text-[var(--pear-text)]">
                  {action}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-2 text-xs font-medium text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
