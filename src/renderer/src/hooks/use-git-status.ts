import { useEffect } from 'react'
import { useGitStore } from '@/stores/git-store'
import { useProjectStore } from '@/stores/project-store'

export function useGitStatus(): void {
  const activeRootPath = useProjectStore((s) => {
    const root = s.getActiveRoot()
    return root?.pathExists ? root.path : null
  })
  const projectRootPathKey = useProjectStore((s) => {
    const project = s.getActiveProject()
    return project?.roots
      .filter((root) => root.pathExists)
      .map((root) => root.path)
      .join('\0') || ''
  })
  const startPolling = useGitStore((s) => s.startPolling)
  const stopPolling = useGitStore((s) => s.stopPolling)

  useEffect(() => {
    const projectRootPaths = projectRootPathKey ? projectRootPathKey.split('\0') : []
    startPolling(activeRootPath, projectRootPaths)
    return () => stopPolling()
  }, [activeRootPath, projectRootPathKey, startPolling, stopPolling])
}
