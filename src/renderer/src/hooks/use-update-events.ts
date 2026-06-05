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
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [])
}
