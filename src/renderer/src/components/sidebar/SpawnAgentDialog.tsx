import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ClaudeIcon, CodexIcon } from '@/components/common/AgentIcons'
import { spawnProjectAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

const AGENT_OPTIONS: Array<{ cli: SpawnAgentCli; label: string; Icon: typeof ClaudeIcon }> = [
  { cli: 'claude', label: 'Claude', Icon: ClaudeIcon },
  { cli: 'codex', label: 'Codex', Icon: CodexIcon }
]

export function SpawnAgentDialog(): React.ReactNode {
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [error, setError] = useState<string | null>(null)
  const project = useProjectStore((s) => s.getActiveProject())
  const root = useProjectStore((s) => s.getActiveRoot())
  const closeDialog = useUIStore((s) => s.closeDialog)
  const openDialog = useUIStore((s) => s.openDialog)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeDialog])

  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  const handleSpawn = async (cli: SpawnAgentCli): Promise<void> => {
    if (!project) {
      closeDialog()
      openDialog('add-project')
      return
    }

    setError(null)
    setSpawningCli(cli)
    try {
      await spawnProjectAgent(project, cli)
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpawningCli(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeDialog}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Spawn Agent"
        className="w-[360px] rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-5 py-4">
          <h2 className="text-base font-semibold">Spawn Agent</h2>
          <button onClick={closeDialog} aria-label="Close dialog" className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]">
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5">
          {project ? (
            <div className="space-y-3">
              <div className="truncate text-xs text-[var(--pear-text-faint)]">{root?.path || project.rootPath}</div>
              <div className="grid grid-cols-2 gap-3">
                {AGENT_OPTIONS.map(({ cli, label, Icon }) => (
                  <button
                    key={cli}
                    type="button"
                    autoFocus={cli === 'claude'}
                    onClick={() => handleSpawn(cli)}
                    disabled={!root?.pathExists || spawningCli !== null}
                    className="flex min-h-[92px] flex-col items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
                    title={root?.pathExists ? `Spawn ${label}` : `Path not found: ${root?.path || project.rootPath}`}
                  >
                    <Icon className="h-6 w-6" />
                    <span>{spawningCli === cli ? 'Starting' : label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <button
              type="button"
              autoFocus
              onClick={() => {
                closeDialog()
                openDialog('add-project')
              }}
              className="w-full rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-6 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
            >
              Add project
            </button>
          )}

          {error && (
            <p className="mt-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
