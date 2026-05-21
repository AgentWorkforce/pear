import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Cloud, FolderPlus, Loader2, X } from 'lucide-react'
import CloudAgentPicker from '@/components/agents/CloudAgentPicker'
import { CloudAuthRequired } from '@/components/agents/CloudAuthRequired'
import { pear } from '@/lib/ipc'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

type CloudAgentDialogState = 'checking-auth' | 'auth-required' | 'picker'

export function CloudAgentDialog(): React.ReactNode {
  const closeDialog = useUIStore((s) => s.closeDialog)
  const openDialog = useUIStore((s) => s.openDialog)
  const openTab = useUIStore((s) => s.openTab)
  const project = useProjectStore((s) => s.getActiveProject())
  const [state, setState] = useState<CloudAgentDialogState>('checking-auth')

  const checkAuth = useCallback(async (): Promise<void> => {
    setState('checking-auth')
    try {
      const status = await pear.auth.status()
      setState(status.loggedIn ? 'picker' : 'auth-required')
    } catch {
      setState('auth-required')
    }
  }, [])

  useEffect(() => {
    void checkAuth()
  }, [checkAuth])

  const handleAttached = async (): Promise<void> => {
    if (project) {
      openTab({ kind: 'agents', projectId: project.id })
    }
    closeDialog()
  }

  // Stable identities for the props CloudAgentPicker / CloudAuthRequired use in
  // useEffect dependency arrays — inline arrow functions here would create a
  // new reference on every render and refire those effects (e.g. re-fetching
  // the agent list on every parent store change).
  const handleAuthenticated = useCallback(() => setState('picker'), [])
  const handleAuthRequired = useCallback(() => setState('auth-required'), [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeDialog}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-agent-dialog-title"
        className="flex max-h-[86vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Cloud size={16} className="shrink-0 text-[var(--pear-accent)]" />
            <h2 id="cloud-agent-dialog-title" className="truncate text-base font-semibold text-[var(--pear-text)]">
              Add cloud agent
            </h2>
          </div>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!project ? (
            <div className="rounded-lg border border-dashed border-[var(--pear-border)] p-6 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] text-[var(--pear-text-dim)]">
                <FolderPlus size={18} />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-[var(--pear-text)]">Add a project first</h3>
              <p className="mx-auto mt-1 max-w-[360px] text-sm leading-5 text-[var(--pear-text-faint)]">
                Cloud agents attach to a project so Pear can sync files into the sandbox.
              </p>
              <button
                type="button"
                autoFocus
                onClick={() => openDialog('add-project')}
                className="mt-5 rounded-md bg-[var(--pear-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)]"
              >
                Add project
              </button>
            </div>
          ) : state === 'checking-auth' ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-[var(--pear-text-faint)]">
              <Loader2 size={15} className="animate-spin" />
              Checking cloud sign-in
            </div>
          ) : state === 'auth-required' ? (
            <CloudAuthRequired
              onAuthenticated={handleAuthenticated}
              onCancel={closeDialog}
            />
          ) : (
            <CloudAgentPicker
              projectId={project.id}
              onAttach={handleAttached}
              onCancel={closeDialog}
              onAuthRequired={handleAuthRequired}
            />
          )}
        </div>
      </div>
    </div>
  )
}
