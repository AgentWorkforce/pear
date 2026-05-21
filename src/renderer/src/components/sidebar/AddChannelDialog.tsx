import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Hash, X } from 'lucide-react'
import { normalizeChannelName, useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

const inputClass =
  'w-full rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg)] px-4 py-2.5 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30'

export function AddChannelDialog(): React.ReactNode {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const project = useProjectStore((s) => s.getActiveProject())
  const addChannel = useProjectStore((s) => s.addChannel)
  const setActiveChannel = useProjectStore((s) => s.setActiveChannel)
  const closeDialog = useUIStore((s) => s.closeDialog)
  const openDialog = useUIStore((s) => s.openDialog)
  const openTab = useUIStore((s) => s.openTab)
  const dialogRef = useRef<HTMLDivElement>(null)

  const channelName = normalizeChannelName(name)
  const alreadyExists = !!project?.channels.includes(channelName)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeDialog])

  const handleDialogKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!project) {
      closeDialog()
      openDialog('add-project')
      return
    }
    if (!channelName) return

    setError(null)
    setSubmitting(true)
    try {
      if (!alreadyExists) {
        await addChannel(channelName)
      }
      setActiveChannel(channelName)
      openTab({ kind: 'channel', projectId: project.id, channelName })
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeDialog}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add Channel"
        className="w-[400px] rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-6 py-4">
          <h2 className="text-base font-semibold">Add Channel</h2>
          <button onClick={closeDialog} aria-label="Close dialog" className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]">
            <X size={16} />
          </button>
        </div>

        {project ? (
          <form onSubmit={handleSubmit} className="px-6 py-5">
            <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">
              Channel name
            </label>
            <div className="relative">
              <Hash size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pear-text-faint)]" />
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="channel-name"
                className={`${inputClass} pl-9`}
              />
            </div>
            <p className="mt-3 text-xs text-[var(--pear-text-faint)]">
              {channelName ? `Will create #${channelName}` : 'Use letters, numbers, spaces, or dashes.'}
            </p>
            {alreadyExists && (
              <p className="mt-3 rounded-lg border border-[var(--pear-yellow)]/20 bg-[var(--pear-yellow)]/10 px-4 py-2.5 text-xs text-[var(--pear-yellow)]">
                That channel already exists. Submitting will open it.
              </p>
            )}
            {error && (
              <p className="mt-3 rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-4 py-2.5 text-xs text-[var(--pear-red)]">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={closeDialog} className="rounded-lg px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!channelName || submitting}
                className="rounded-lg bg-[var(--pear-accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:opacity-40"
              >
                {submitting ? 'Adding...' : alreadyExists ? 'Open' : 'Add'}
              </button>
            </div>
          </form>
        ) : (
          <div className="px-6 py-5">
            <button
              type="button"
              autoFocus
              onClick={() => {
                closeDialog()
                openDialog('add-project')
              }}
              className="w-full rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-6 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
            >
              Add project
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
