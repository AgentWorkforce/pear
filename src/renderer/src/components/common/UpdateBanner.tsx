import type React from 'react'
import { useState } from 'react'
import { AlertTriangle, Download, RefreshCw, X } from 'lucide-react'
import { pear } from '@/lib/ipc'
import { useUpdateStore } from '@/stores/update-store'

/**
 * Slim full-width banner shown under the top bar when an update is available,
 * downloading, ready, or errored. Drives the click-to-download → restart flow.
 */
export function UpdateBanner(): React.ReactNode {
  const status = useUpdateStore((s) => s.status)
  const version = useUpdateStore((s) => s.version)
  const percent = useUpdateStore((s) => s.percent)
  const error = useUpdateStore((s) => s.error)
  const dismissed = useUpdateStore((s) => s.dismissed)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const [starting, setStarting] = useState(false)

  if (dismissed || status === 'idle') return null

  const startDownload = async (): Promise<void> => {
    setStarting(true)
    try {
      await pear.update.download()
    } finally {
      setStarting(false)
    }
  }

  const isError = status === 'error'
  const accent = isError
    ? 'border-[var(--pear-red)]/30 bg-[var(--pear-red)]/10'
    : 'border-[var(--pear-accent)]/30 bg-[var(--pear-accent)]/10'

  return (
    <div
      className={`flex items-center gap-3 border-b px-4 py-1.5 text-[13px] text-[var(--pear-text)] ${accent}`}
    >
      {isError ? (
        <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--pear-red)]" />
      ) : status === 'downloaded' ? (
        <RefreshCw className="h-4 w-4 shrink-0 text-[var(--pear-accent-bright)]" />
      ) : (
        <Download className="h-4 w-4 shrink-0 text-[var(--pear-accent-bright)]" />
      )}

      <div className="min-w-0 flex-1">
        {status === 'available' && (
          <span>
            Pear <span className="font-medium">{version}</span> is available.
          </span>
        )}
        {status === 'downloading' && <span>Downloading update… {Math.round(percent)}%</span>}
        {status === 'downloaded' && (
          <span>
            Pear <span className="font-medium">{version}</span> is ready to install.
          </span>
        )}
        {status === 'error' && <span>Update failed: {error}</span>}

        {status === 'downloading' && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--pear-bg-surface)]">
            <div
              className="h-full rounded-full bg-[var(--pear-accent)] transition-[width] duration-200"
              style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
            />
          </div>
        )}
      </div>

      {status === 'available' && (
        <button
          type="button"
          onClick={() => void startDownload()}
          disabled={starting}
          className="shrink-0 rounded-full bg-[var(--pear-accent)] px-3 py-1 text-[12px] font-medium text-[var(--pear-bg)] transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {starting ? 'Starting…' : 'Update now'}
        </button>
      )}
      {status === 'downloaded' && (
        <button
          type="button"
          onClick={() => void pear.update.install()}
          className="shrink-0 rounded-full bg-[var(--pear-accent)] px-3 py-1 text-[12px] font-medium text-[var(--pear-bg)] transition-opacity hover:opacity-90"
        >
          Restart now
        </button>
      )}

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-[var(--pear-text-dim)] transition-colors hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
