import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { ClaudeIcon, CodexIcon } from '@/components/common/AgentIcons'
import { listProjectPersonas, spawnProjectAgent, spawnProjectPersona, type SpawnAgentCli } from '@/lib/spawn-agent'
import type { WorkforcePersona } from '@/lib/ipc'
import { useProjectStore, type ProjectRoot } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

const AGENT_OPTIONS: Array<{ cli: SpawnAgentCli; label: string; Icon: typeof ClaudeIcon }> = [
  { cli: 'claude', label: 'Claude', Icon: ClaudeIcon },
  { cli: 'codex', label: 'Codex', Icon: CodexIcon }
]

export function SpawnAgentDialog(): React.ReactNode {
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [spawningPersona, setSpawningPersona] = useState(false)
  const [personas, setPersonas] = useState<WorkforcePersona[]>([])
  const [loadingPersonas, setLoadingPersonas] = useState(false)
  const [selectedPersonaId, setSelectedPersonaId] = useState('')
  const [customName, setCustomName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null)
  const project = useProjectStore((s) => s.getActiveProject())
  const defaultRoot = useProjectStore((s) => s.getActiveRoot())
  const root: ProjectRoot | undefined = project?.roots.find((r) => r.id === selectedRootId) ?? defaultRoot
  const closeDialog = useUIStore((s) => s.closeDialog)
  const openDialog = useUIStore((s) => s.openDialog)
  const dialogRef = useRef<HTMLDivElement>(null)
  const spawnRequestRef = useRef(false)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeDialog])

  useEffect(() => {
    let cancelled = false

    async function loadPersonas(): Promise<void> {
      if (!project) {
        setPersonas([])
        setSelectedPersonaId('')
        setLoadingPersonas(false)
        return
      }

      setLoadingPersonas(true)
      try {
        const discovered = await listProjectPersonas(project)
        if (cancelled) return
        setError(null)
        setPersonas(discovered)
        setSelectedPersonaId((current) => {
          if (current && discovered.some((persona) => persona.id === current)) return current
          return discovered[0]?.id || ''
        })
      } catch (err) {
        if (cancelled) return
        setPersonas([])
        setSelectedPersonaId('')
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingPersonas(false)
      }
    }

    void loadPersonas()

    return () => {
      cancelled = true
    }
  }, [project, root?.id])

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
    if (spawnRequestRef.current) return
    if (!project) {
      closeDialog()
      openDialog('add-project')
      return
    }

    spawnRequestRef.current = true
    setError(null)
    setSpawningCli(cli)
    try {
      await spawnProjectAgent(project, cli, customName, root)
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpawningCli(null)
      spawnRequestRef.current = false
    }
  }

  const handleSpawnPersona = async (): Promise<void> => {
    if (spawnRequestRef.current) return
    if (!project) {
      closeDialog()
      openDialog('add-project')
      return
    }
    if (!selectedPersonaId) return

    spawnRequestRef.current = true
    setError(null)
    setSpawningPersona(true)
    try {
      await spawnProjectPersona(project, selectedPersonaId, root)
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpawningPersona(false)
      spawnRequestRef.current = false
    }
  }

  const spawning = spawningCli !== null || spawningPersona

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
              {project.roots.length > 1 && (
                <div>
                  <label htmlFor="spawn-root-select" className="mb-1 block text-xs font-medium text-[var(--pear-text-dim)]">
                    Spawn into
                  </label>
                  <select
                    id="spawn-root-select"
                    value={selectedRootId ?? root?.id ?? ''}
                    onChange={(e) => setSelectedRootId(e.target.value)}
                    disabled={spawning}
                    className="h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                  >
                    {project.roots.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="truncate text-xs text-[var(--pear-text-faint)]">{root?.path || project.rootPath}</div>
              <div>
                <label htmlFor="spawn-agent-name" className="mb-1 block text-xs font-medium text-[var(--pear-text-dim)]">
                  Name <span className="text-[var(--pear-text-faint)]">(optional)</span>
                </label>
                <input
                  id="spawn-agent-name"
                  type="text"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  disabled={spawning}
                  placeholder={`auto: ${AGENT_OPTIONS[0].cli}-N`}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {AGENT_OPTIONS.map(({ cli, label, Icon }) => (
                  <button
                    key={cli}
                    type="button"
                    autoFocus={cli === 'claude'}
                    onClick={() => handleSpawn(cli)}
                    disabled={!root?.pathExists || spawning}
                    className="flex min-h-[92px] flex-col items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
                    title={root?.pathExists ? `Spawn ${label}` : `Path not found: ${root?.path || project.rootPath}`}
                  >
                    <Icon className="h-6 w-6" />
                    <span>{spawningCli === cli ? 'Starting' : label}</span>
                  </button>
                ))}
              </div>

              <div className="border-t border-[var(--pear-border-subtle)] pt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="workforce-persona-select" className="text-xs font-medium text-[var(--pear-text-dim)]">
                    Workforce personas
                  </label>
                  {loadingPersonas && <Loader2 size={13} className="animate-spin text-[var(--pear-text-faint)]" />}
                </div>

                {loadingPersonas ? (
                  <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2 text-xs text-[var(--pear-text-faint)]">
                    Loading personas
                  </div>
                ) : personas.length > 0 ? (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <select
                      id="workforce-persona-select"
                      value={selectedPersonaId}
                      onChange={(event) => setSelectedPersonaId(event.target.value)}
                      disabled={!root?.pathExists || spawning}
                      className="h-9 min-w-0 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                    >
                      {personas.map((persona) => (
                        <option key={persona.id} value={persona.id}>
                          {persona.id}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleSpawnPersona()}
                      disabled={!root?.pathExists || spawning || !selectedPersonaId}
                      className="flex h-9 items-center gap-2 rounded-md bg-[var(--pear-accent)] px-3 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:cursor-not-allowed disabled:opacity-40"
                      title={root?.pathExists ? 'Launch selected persona' : `Path not found: ${root?.path || project.rootPath}`}
                    >
                      {spawningPersona && <Loader2 size={14} className="animate-spin" />}
                      Launch
                    </button>
                  </div>
                ) : (
                  <div className="rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2 text-xs text-[var(--pear-text-faint)]">
                    No workforce personas found in this project
                  </div>
                )}
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
