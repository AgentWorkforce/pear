import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

const inputClass =
  'w-full rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg)] px-4 py-2.5 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30'

export function AddProjectDialog(): React.ReactNode {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const addProject = useProjectStore((s) => s.addProject)
  const closeDialog = useUIStore((s) => s.closeDialog)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeDialog])

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

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) return
    setError(null)
    setSubmitting(true)
    try {
      const project = await addProject(name.trim())
      if (project) {
        closeDialog()
      } else {
        setSubmitting(false)
      }
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
        aria-label="Add Project"
        className="w-[400px] rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-6 py-4">
          <h2 className="text-base font-semibold">Add Project</h2>
          <button onClick={closeDialog} aria-label="Close dialog" className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5">
          <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">Project name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" className={inputClass} />
          <p className="mt-3 text-xs text-[var(--pear-text-faint)]">
            You&apos;ll be prompted to select the root directory.
          </p>
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
              disabled={!name.trim() || submitting}
              className="rounded-lg bg-[var(--pear-accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:opacity-40"
            >
              {submitting ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
