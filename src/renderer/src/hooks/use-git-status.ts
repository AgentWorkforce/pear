import { useEffect } from 'react'
import { useGitStore } from '@/stores/git-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export function useGitStatus(): void {
  const activeWorktreePath = useWorkspaceStore((s) => s.getActiveWorktree()?.path ?? null)
  const startPolling = useGitStore((s) => s.startPolling)
  const stopPolling = useGitStore((s) => s.stopPolling)

  useEffect(() => {
    if (activeWorktreePath) {
      startPolling(activeWorktreePath)
    } else {
      stopPolling()
    }
    return () => stopPolling()
  }, [activeWorktreePath, startPolling, stopPolling])
}
