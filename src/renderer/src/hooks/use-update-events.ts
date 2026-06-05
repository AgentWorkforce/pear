import { useEffect } from 'react'
import { pear } from '@/lib/ipc'
import { useUpdateStore } from '@/stores/update-store'

/**
 * Subscribe to the main process's auto-update events and mirror them into the
 * update store. Mount once near the app root.
 */
export function useUpdateEvents(): void {
  useEffect(() => {
    const store = useUpdateStore.getState
    const unsubs = [
      pear.update.onAvailable(({ version }) => store().markAvailable(version)),
      pear.update.onProgress(({ percent }) => store().markDownloading(percent)),
      pear.update.onDownloaded(({ version }) => store().markDownloaded(version)),
      pear.update.onError(({ message }) => store().markError(message))
    ]

    // Replay any state the main process broadcast before we subscribed (e.g. an
    // update found during startup, before this effect mounted). Subscribing
    // first makes this idempotent with a concurrently-arriving event.
    void pear.update.getState().then((state) => {
      if (!state) return
      const s = store()
      if (state.kind === 'available') s.markAvailable(state.version)
      else if (state.kind === 'downloading') s.markDownloading(state.percent)
      else if (state.kind === 'downloaded') s.markDownloaded(state.version)
      else s.markError(state.message)
    })

    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [])
}
