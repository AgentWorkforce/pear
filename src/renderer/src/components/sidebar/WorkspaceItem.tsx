import type React from 'react'
import { useState } from 'react'
import { AlertTriangle, Folder, Trash2 } from 'lucide-react'
import { ClaudeIcon, CodexIcon } from '@/components/common/AgentIcons'
import { spawnWorkspaceAgent, type SpawnAgentCli } from '@/lib/spawn-agent'
import { useWorkspaceStore, type Workspace } from '@/stores/workspace-store'

interface Props {
  workspace: Workspace
  isActive: boolean
}

export function WorkspaceItem({ workspace, isActive }: Props): React.ReactNode {
  const [spawningCli, setSpawningCli] = useState<SpawnAgentCli | null>(null)
  const [error, setError] = useState<string | null>(null)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)

  const handleSpawn = async (cli: SpawnAgentCli): Promise<void> => {
    setError(null)
    setSpawningCli(cli)
    try {
      await spawnWorkspaceAgent(workspace, cli)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpawningCli(null)
    }
  }

  const handleSelect = (): void => {
    setError(null)
    setActiveWorkspace(workspace.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleRemove = (): void => {
    if (!window.confirm(`Remove workspace "${workspace.name}"? This won't delete any files.`)) return
    removeWorkspace(workspace.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <div
      className={`rounded-xl border transition-colors ${
        isActive
          ? 'border-[var(--pear-border)] bg-[var(--pear-bg-surface)]'
          : 'border-transparent hover:bg-[var(--pear-bg-surface-hover)]/45'
      }`}
    >
      <div className="flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          onClick={handleSelect}
        >
          <Folder size={14} className="shrink-0 text-[var(--pear-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[var(--pear-text)]">{workspace.name}</div>
            {isActive && (
              <div className="truncate text-[11px] text-[var(--pear-text-faint)]">{workspace.rootPath}</div>
            )}
          </div>
          {!workspace.rootPathExists && (
            <AlertTriangle
              size={13}
              className="shrink-0 text-[var(--pear-yellow)]"
              aria-label="Workspace path missing"
            />
          )}
        </button>
        <button
          type="button"
          onClick={handleRemove}
          className="rounded-md p-1 text-[var(--pear-red)] opacity-70 hover:bg-[var(--pear-bg-overlay)] hover:opacity-100"
          title="Remove workspace"
          aria-label="Remove workspace"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {isActive && (
        <div className="px-3 pb-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleSpawn('claude')}
              disabled={!workspace.rootPathExists || spawningCli !== null}
              className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 py-2 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
              title={workspace.rootPathExists ? 'Spawn Claude' : `Path not found: ${workspace.rootPath}`}
            >
              <ClaudeIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{spawningCli === 'claude' ? 'Starting' : 'Claude'}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSpawn('codex')}
              disabled={!workspace.rootPathExists || spawningCli !== null}
              className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 py-2 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:cursor-not-allowed disabled:opacity-40"
              title={workspace.rootPathExists ? 'Spawn Codex' : `Path not found: ${workspace.rootPath}`}
            >
              <CodexIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{spawningCli === 'codex' ? 'Starting' : 'Codex'}</span>
            </button>
          </div>
          {error && (
            <p className="mt-2 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-2.5 py-2 text-[11px] text-[var(--pear-red)]">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
