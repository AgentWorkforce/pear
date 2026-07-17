import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { ClaudeIcon, CodexIcon, GrokIcon, OpenCodeIcon } from '@/components/common/AgentIcons'
import { SPAWN_AGENT_CLI_INSTALL_COMMANDS, listProjectPersonas, spawnProjectAgent, spawnProjectPersona, placeProjectAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { pear, type WorkforcePersona, type BrokerNodeSummary } from '@/lib/ipc'
import { useProjectStore, type ProjectRoot } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'

// Sentinel for the "any eligible node" placement option (distinct from '' =
// this Mac, and from a concrete node name).
const ANY_NODE = '__any__'

const AGENT_OPTIONS: Array<{ cli: SpawnAgentCli; label: string; Icon: typeof ClaudeIcon }> = [
  { cli: 'claude', label: 'Claude', Icon: ClaudeIcon },
  { cli: 'codex', label: 'Codex', Icon: CodexIcon },
  { cli: 'grok', label: 'Grok', Icon: GrokIcon },
  { cli: 'opencode', label: 'OpenCode', Icon: OpenCodeIcon }
]

export function SpawnAgentDialog(): React.ReactNode {
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [spawningPersona, setSpawningPersona] = useState(false)
  const [personas, setPersonas] = useState<WorkforcePersona[]>([])
  const [loadingPersonas, setLoadingPersonas] = useState(false)
  const [selectedPersonaId, setSelectedPersonaId] = useState('')
  const [customName, setCustomName] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cliAvailability, setCliAvailability] = useState<Partial<Record<SpawnAgentCli, boolean>>>({})
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null)
  // Placement (#411): '' = this Mac (direct local spawn), ANY_NODE = any eligible
  // least-loaded node, or a specific remote node name. Only remote/any go through
  // the placement engine; the local default stays on the proven direct path.
  const [nodes, setNodes] = useState<BrokerNodeSummary[]>([])
  const [selectedNode, setSelectedNode] = useState<string>('')
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null)
  const project = useProjectStore((s) => s.getActiveProject())
  const defaultRoot = useProjectStore((s) => s.getActiveRoot())
  const selectedRoot = project?.roots.find((r) => r.id === selectedRootId)
  const root: ProjectRoot | undefined = selectedRoot ?? defaultRoot
  const safeSelectedRootId = project?.roots.some((r) => r.id === selectedRootId) ? selectedRootId ?? '' : root?.id ?? ''
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
    if (selectedRootId && !project?.roots.some((r) => r.id === selectedRootId)) {
      setSelectedRootId(root?.id ?? null)
    }
  }, [project, root?.id, selectedRootId])

  // Load the fleet node roster for the placement picker. Best-effort: a broker
  // that isn't up yet just yields an empty list (local-only spawn still works).
  useEffect(() => {
    if (!project) return
    let cancelled = false
    void pear.broker.listNodes(project.id).then(
      (roster) => { if (!cancelled) setNodes(roster) },
      () => { if (!cancelled) setNodes([]) }
    )
    return () => { cancelled = true }
  }, [project?.id])

  useEffect(() => {
    let cancelled = false
    const clis: SpawnAgentCli[] = ['claude', 'codex', 'opencode']
    void Promise.all(clis.map(async (cli) => {
      const available = await pear.broker.checkCliAvailable(cli).catch(() => false)
      return [cli, available] as const
    })).then((results) => {
      if (!cancelled) setCliAvailability(Object.fromEntries(results))
    })
    return () => { cancelled = true }
  }, [])

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
        const discovered = await listProjectPersonas(project, root)
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
    setRemoteNotice(null)
    setSpawningCli(cli)
    try {
      if (selectedNode === '') {
        // This Mac — proven direct local spawn path (unchanged).
        await spawnProjectAgent(project, cli, customName, root, customModel)
        closeDialog()
      } else {
        // Placement engine: any eligible node, or a specific remote node.
        const targetNode = selectedNode === ANY_NODE ? undefined : selectedNode
        const placed = await placeProjectAgent(project, cli, targetNode, customName, customModel, root)
        if (placed.local) {
          closeDialog()
        } else {
          // Remote landing — no terminal view yet (upstream gap). Keep the dialog
          // open with a clear chat-first message rather than opening a broken pane.
          setRemoteNotice(
            `Placed “${placed.name}” on ${placed.node}. It’s reachable via chat — a terminal view for remote nodes isn’t available yet (upstream gap).`
          )
        }
      }
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
                    value={safeSelectedRootId}
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
                <label htmlFor="spawn-node-select" className="mb-1 block text-xs font-medium text-[var(--pear-text-dim)]">
                  Run on
                </label>
                <select
                  id="spawn-node-select"
                  value={selectedNode}
                  onChange={(e) => { setSelectedNode(e.target.value); setRemoteNotice(null) }}
                  disabled={spawning}
                  className="h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                >
                  <option value="">This Mac</option>
                  <option value={ANY_NODE}>Any available node (may include this Mac)</option>
                  {nodes.filter((n) => !n.isSelf && n.live).map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name}{typeof n.load === 'number' ? ` · load ${n.load}` : ''}
                    </option>
                  ))}
                </select>
                {selectedNode !== '' && (
                  <p className="mt-1 text-[11px] leading-snug text-[var(--pear-text-faint)]">
                    Remote agents run on another node and are reachable via chat; a terminal view for remote nodes isn’t available yet.
                  </p>
                )}
              </div>
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
              <div>
                <label htmlFor="spawn-agent-model" className="mb-1 block text-xs font-medium text-[var(--pear-text-dim)]">
                  Model <span className="text-[var(--pear-text-faint)]">(optional)</span>
                </label>
                <input
                  id="spawn-agent-model"
                  type="text"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  disabled={spawning}
                  placeholder="e.g. claude-opus-4-7"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9 w-full rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)] disabled:opacity-50"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {AGENT_OPTIONS.map(({ cli, label, Icon }) => (
                  <button
                    key={cli}
                    type="button"
                    autoFocus={cli === 'claude'}
                    onClick={() => handleSpawn(cli)}
                    disabled={!root?.pathExists || spawning || cliAvailability[cli] === false}
                    className="flex min-h-[92px] flex-col items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
                    title={
                      !root?.pathExists ? `Path not found: ${root?.path || project.rootPath}`
                      : cliAvailability[cli] === false ? `${label} is not installed - run: ${SPAWN_AGENT_CLI_INSTALL_COMMANDS[cli]}`
                      : `Spawn ${label}`
                    }
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

          {remoteNotice && (
            <p className="mt-3 rounded-md border border-[var(--pear-accent-dim)]/30 bg-[var(--pear-accent)]/10 px-3 py-2 text-xs text-[var(--pear-text-dim)]">
              {remoteNotice}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
