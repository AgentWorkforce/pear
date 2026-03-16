import { useEffect } from 'react'
import { useGitStore } from '@/stores/git-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export function useGitStatus(): void {
  const activeWorktree = useWorkspaceStore((s) => s.getActiveWorktree())
  const startPolling = useGitStore((s) => s.startPolling)
  const stopPolling = useGitStore((s) => s.stopPolling)

  useEffect(() => {
    if (activeWorktree) {
      startPolling(activeWorktree.path)
    } else {
      stopPolling()
    }
    return () => stopPolling()
  }, [activeWorktree?.path, startPolling, stopPolling])
}
