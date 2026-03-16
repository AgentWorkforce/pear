import type React from 'react'
import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { pear } from '@/lib/ipc'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useUIStore } from '@/stores/ui-store'

const inputClass =
  'w-full rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg)] px-4 py-2.5 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30'

export function AddWorktreeDialog(): React.ReactNode {
  const [branch, setBranch] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const workspace = useWorkspaceStore((s) => s.getActiveWorkspace())
  const refreshWorktrees = useWorkspaceStore((s) => s.refreshWorktrees)
  const closeDialog = useUIStore((s) => s.closeDialog)

  useEffect(() => {
    if (workspace) {
      pear.git.branches(workspace.rootPath).then(setBranches).catch(() => {})
    }
  }, [workspace])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!branch.trim() || !workspace) return
    await pear.git.addWorktree(workspace.rootPath, branch.trim(), baseBranch || undefined)
    await refreshWorktrees()
    closeDialog()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeDialog}>
      <div
        className="w-[400px] rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-6 py-4">
          <h2 className="text-base font-semibold">Add Worktree</h2>
          <button onClick={closeDialog} className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5">
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">Branch name</label>
              <input autoFocus value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/my-branch" className={inputClass} />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">Base branch</label>
              <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={inputClass}>
                <option value="">HEAD (default)</option>
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" onClick={closeDialog} className="rounded-lg px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!branch.trim()}
              className="rounded-lg bg-[var(--pear-accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
