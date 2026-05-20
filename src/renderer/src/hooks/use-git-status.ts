import { useEffect } from 'react'
import { useGitStore } from '@/stores/git-store'
import { useProjectStore } from '@/stores/project-store'

export function useGitStatus(): void {
  const activeRootPath = useProjectStore((s) => s.getActiveRoot()?.path ?? null)
  const startPolling = useGitStore((s) => s.startPolling)
  const stopPolling = useGitStore((s) => s.stopPolling)

  useEffect(() => {
    if (activeRootPath) {
      startPolling(activeRootPath)
    } else {
      stopPolling()
    }
    return () => stopPolling()
  }, [activeRootPath, startPolling, stopPolling])
}
