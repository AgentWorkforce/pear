import { useEffect, useRef } from 'react'
import { pear } from '@/lib/ipc'

export interface BurnFingerprintScope { sessionId?: string }

/**
 * Polls pear.burn.fingerprint(scope) every intervalMs. Calls onChanged() only
 * when the fingerprint differs from the last seen value (and skips the very
 * first poll if `skipInitial`, since callers do their own initial load).
 * Pass an empty scope ({}) for the global ledger fingerprint.
 */
export function useBurnFingerprintRefresh(
  scope: BurnFingerprintScope,
  intervalMs: number,
  onChanged: () => void
): void {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const lastFingerprintRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)

  useEffect(() => {
    const timerId = window.setInterval(async () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        const { fingerprint } = await pear.burn.fingerprint(
          scope.sessionId ? { sessionId: scope.sessionId } : {}
        )
        if (!fingerprint) return
        if (lastFingerprintRef.current === null) {
          // First observed fingerprint — treat as baseline, do not fire onChanged
          lastFingerprintRef.current = fingerprint
        } else if (fingerprint !== lastFingerprintRef.current) {
          lastFingerprintRef.current = fingerprint
          onChangedRef.current()
        }
      } catch {
        // Swallow errors — burn polling is informational
      } finally {
        inFlightRef.current = false
      }
    }, intervalMs)

    return () => window.clearInterval(timerId)
  }, [scope.sessionId, intervalMs])
}
