import type React from 'react'
import { useState } from 'react'
import { X } from 'lucide-react'
import { pear } from '@/lib/ipc'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'

const CLI_OPTIONS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'opencode', label: 'OpenCode' }
]

const inputClass =
  'w-full rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg)] px-4 py-2.5 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30'

export function SpawnAgentDialog(): React.ReactNode {
  const [name, setName] = useState('')
  const [cli, setCli] = useState('claude')
  const [model, setModel] = useState('')
  const [task, setTask] = useState('')
  const [selectedChannels, setSelectedChannels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const worktree = useWorkspaceStore((s) => s.getActiveWorktree())
  const workspace = useWorkspaceStore((s) => s.getActiveWorkspace())
  const trackSpawnedAgent = useAgentStore((s) => s.trackSpawnedAgent)
  const closeDialog = useUIStore((s) => s.closeDialog)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) return
    setError(null)
    setSubmitting(true)
    try {
      const agentName = name.trim()
      await pear.broker.spawnAgent({
        name: agentName,
        cli,
        model: model || undefined,
        task: task || undefined,
        channels: selectedChannels.length > 0 && workspace && worktree
          ? selectedChannels.map((c) => `${workspace.name}-${worktree.branch}-${c}`)
          : undefined,
        cwd: worktree?.path || workspace?.rootPath
      })
      trackSpawnedAgent(agentName, worktree?.id || workspace?.rootPath || '')
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeDialog}>
      <div
        className="w-[420px] rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-6 py-4">
          <h2 className="text-base font-semibold">Spawn Agent</h2>
          <button onClick={closeDialog} className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]">
            <X size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5">
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">Agent name</label>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="auth-agent" className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">CLI</label>
                <select value={cli} onChange={(e) => setCli(e.target.value)} className={inputClass}>
                  {CLI_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">Model</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="optional" className={inputClass} />
              </div>
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">Task</label>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Describe what this agent should do..."
                rows={3}
                className={`${inputClass} resize-none`}
              />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--pear-text-secondary)]">Channels</label>
              {(worktree?.channels || []).length > 0 ? (
                <div className="space-y-1.5 rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg)] px-4 py-2.5">
                  {(worktree?.channels || []).map((ch) => (
                    <label key={ch} className="flex items-center gap-2 text-sm text-[var(--pear-text)]">
                      <input
                        type="checkbox"
                        checked={selectedChannels.includes(ch)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedChannels([...selectedChannels, ch])
                          } else {
                            setSelectedChannels(selectedChannels.filter((c) => c !== ch))
                          }
                        }}
                        className="rounded border-[var(--pear-border)]"
                      />
                      # {ch}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[var(--pear-text-faint)]">No channels in worktree</p>
              )}
            </div>
          </div>

          {(worktree || workspace) && (
            <p className="mt-3 text-xs text-[var(--pear-text-faint)]">
              cwd: {worktree?.path || workspace?.rootPath}
            </p>
          )}
          {error && (
            <p className="mt-3 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-xs text-[var(--pear-red)]">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-3">
            <button type="button" onClick={closeDialog} className="rounded-lg px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="rounded-lg bg-[var(--pear-accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:opacity-40"
            >
              {submitting ? 'Spawning...' : 'Spawn'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
