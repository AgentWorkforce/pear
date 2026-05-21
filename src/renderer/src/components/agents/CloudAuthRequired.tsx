import type React from 'react'
import { useState } from 'react'
import { AlertCircle, Cloud, LogIn } from 'lucide-react'
import { pear } from '@/lib/ipc'

export interface CloudAuthRequiredProps {
  apiUrl?: string
  onAuthenticated: () => void
  onCancel?: () => void
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function CloudAuthRequired({
  apiUrl,
  onAuthenticated,
  onCancel
}: CloudAuthRequiredProps): React.ReactNode {
  const [status, setStatus] = useState<'idle' | 'pending'>('idle')
  const [error, setError] = useState<string | null>(null)
  const isPending = status === 'pending'

  const handleSignIn = async (): Promise<void> => {
    setStatus('pending')
    setError(null)

    try {
      await pear.auth.login(apiUrl ? { apiUrl } : undefined)
      onAuthenticated()
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('idle')
    }
  }

  return (
    <section className="rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-accent)]">
          <Cloud size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-[var(--pear-text)]">Sign in to Agent Relay Cloud</h2>
          <p className="mt-1 text-sm leading-5 text-[var(--pear-text-faint)]">
            Pear needs your Agent Relay account to list and attach cloud agents.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2.5 text-sm text-[var(--pear-red)]"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSignIn}
          disabled={isPending}
          className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-[var(--pear-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <LogIn size={15} />
          <span>{isPending ? 'Signing in...' : 'Sign in to Agent Relay Cloud'}</span>
        </button>
      </div>
    </section>
  )
}
