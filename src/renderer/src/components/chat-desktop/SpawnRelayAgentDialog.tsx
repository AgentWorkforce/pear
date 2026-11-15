import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { pear, type RelaySpawnNode } from '@/lib/ipc'
import { folderHistory, folderSuggestions, lastSegmentRange, withFolder } from '@/lib/spawn-folders'
import { agentIdentity, useChatStore } from '@/stores/chat-store'
import { useUIStore } from '@/stores/ui-store'

const inputClass =
  'w-full rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg)] px-3 py-2 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent)] focus:ring-1 focus:ring-[var(--pear-accent)]/30 disabled:opacity-50'
const labelClass = 'mb-1.5 block text-xs font-medium text-[var(--pear-text-secondary)]'
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,47}$/
const STORAGE_KEY = 'pear.spawn.last'

interface Remembered {
  node?: string
  harness?: string
  /** Folders used per machine, newest first; paths only make sense on the machine they came from. */
  folders?: Record<string, string[] | string>
}

function remembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Remembered
  } catch {
    return {}
  }
}

function remember(value: Remembered): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Defaults just won't carry over.
  }
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

/** Start an agent on any relay machine that advertises `spawn:<harness>`. */
export function SpawnRelayAgentDialog(): React.ReactNode {
  const closeDialog = useUIStore((s) => s.closeDialog)
  const openTab = useUIStore((s) => s.openTab)
  const refreshConversations = useChatStore((s) => s.refreshConversations)
  const selectConversation = useChatStore((s) => s.selectConversation)

  const [nodes, setNodes] = useState<RelaySpawnNode[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [node, setNode] = useState('')
  const [harness, setHarness] = useState('')
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [folder, setFolder] = useState('')
  /** The suggested folder, until edited: focusing it selects the project name. */
  const prefilled = useRef('')
  const [phase, setPhase] = useState<'form' | 'starting' | 'unconfirmed'>('form')
  const [error, setError] = useState<string | null>(null)

  const prefillFolder = (machine: string): void => {
    const value = folderHistory(remembered().folders?.[machine])[0] ?? ''
    prefilled.current = value
    setFolder(value)
  }

  const load = (): void => {
    setNodes(null)
    setLoadError(null)
    pear.chat.spawnTargets().then((list) => {
      setNodes(list)
      const last = remembered()
      const chosen = list.find((candidate) => candidate.name === last.node) ?? list[0]
      if (!chosen) return
      setNode(chosen.name)
      setHarness(chosen.harnesses.includes(last.harness ?? '') ? (last.harness as string) : chosen.harnesses[0])
      prefillFolder(chosen.name)
    }).catch((err: unknown) => setLoadError(errorText(err)))
  }

  useEffect(load, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && phase !== 'starting') closeDialog()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeDialog, phase])

  const selected = useMemo(() => nodes?.find((candidate) => candidate.name === node), [nodes, node])
  const suggestions = useMemo(
    () => folderSuggestions(folderHistory(remembered().folders?.[node]), selected?.repositories),
    [node, selected]
  )
  const trimmedName = name.trim()
  const nameProblem = trimmedName && !NAME_PATTERN.test(trimmedName)
    ? 'Start with a lowercase letter; use 2–48 lowercase letters, digits, or dashes.'
    : null
  const folderValue = folder.trim()
  const folderProblem = folderValue && !folderValue.startsWith('/')
    ? `Enter the full path on ${node || 'that machine'}, starting with /.`
    : null
  const canSubmit = phase === 'form' && !!selected && !!harness && NAME_PATTERN.test(trimmedName) &&
    !!task.trim() && !folderProblem

  const chooseNode = (value: string): void => {
    setNode(value)
    const next = nodes?.find((candidate) => candidate.name === value)
    if (next && !next.harnesses.includes(harness)) setHarness(next.harnesses[0])
    prefillFolder(value)
  }

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return
    setError(null)
    setPhase('starting')
    const last = remembered()
    remember({ node, harness, folders: { ...last.folders, [node]: withFolder(folderHistory(last.folders?.[node]), folderValue) } })
    try {
      const result = await pear.chat.spawn({ node, harness, name: trimmedName, task: task.trim(), workingDirectory: folderValue || undefined })
      if (result.outcome === 'unconfirmed') {
        setPhase('unconfirmed')
        return
      }
      await refreshConversations()
      const identity = agentIdentity(result.name)
      const row = useChatStore.getState().conversations.find((conversation) =>
        conversation.kind === 'agent' && agentIdentity(conversation.name) === identity)
      openTab({ kind: 'agents' })
      if (row) void selectConversation(row.id)
      closeDialog()
    } catch (err) {
      setError(errorText(err))
      setPhase('form')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={phase === 'starting' ? undefined : closeDialog}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Start agent on a relay machine"
        className="w-[460px] rounded-xl border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--pear-border-subtle)] px-6 py-4">
          <h2 className="text-base font-semibold">Start agent on a relay machine</h2>
          <button
            onClick={closeDialog}
            disabled={phase === 'starting'}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)] disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        {phase === 'unconfirmed' ? (
          <div className="px-6 py-5 text-sm text-[var(--pear-text-dim)]">
            <p>
              {node} accepted the request to start <span className="font-medium text-[var(--pear-text)]">{trimmedName}</span>,
              but hasn&apos;t confirmed it yet. It may still be starting.
            </p>
            <p className="mt-2">Check the agent list before trying again, so it isn&apos;t started twice.</p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  void refreshConversations()
                  closeDialog()
                }}
                className="rounded-lg bg-[var(--pear-accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)]"
              >
                OK
              </button>
            </div>
          </div>
        ) : nodes === null && !loadError ? (
          <div className="flex items-center gap-2 px-6 py-8 text-sm text-[var(--pear-text-faint)]">
            <Loader2 size={14} className="animate-spin" /> Finding machines on the relay…
          </div>
        ) : loadError || nodes?.length === 0 ? (
          <div className="px-6 py-5 text-sm text-[var(--pear-text-dim)]">
            <p>
              {loadError
                ? `Couldn't list relay machines: ${loadError}`
                : 'No online machine on the relay can start agents right now. Machines appear here when Agent Relay runs on them with agent types enabled.'}
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={load}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--pear-border)] px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:text-[var(--pear-text)]"
              >
                <RefreshCw size={13} /> Try again
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={labelClass}>Machine</span>
                <select value={node} onChange={(event) => chooseNode(event.target.value)} disabled={phase === 'starting'} className={inputClass}>
                  {nodes?.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Agent type</span>
                <select value={harness} onChange={(event) => setHarness(event.target.value)} disabled={phase === 'starting'} className={inputClass}>
                  {selected?.harnesses.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block">
              <span className={labelClass}>Name</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value.toLowerCase())}
                placeholder="e.g. docs-fixer"
                disabled={phase === 'starting'}
                className={inputClass}
              />
              {nameProblem && <span className="mt-1 block text-xs text-[var(--pear-red)]">{nameProblem}</span>}
            </label>
            <label className="block">
              <span className={labelClass}>Task</span>
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                placeholder="What should it work on?"
                rows={3}
                disabled={phase === 'starting'}
                className={`${inputClass} resize-none`}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Folder on {node || 'the machine'} (optional)</span>
              <input
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                onFocus={(event) => {
                  const input = event.currentTarget
                  if (!input.value || input.value !== prefilled.current) return
                  const [start, end] = lastSegmentRange(input.value)
                  requestAnimationFrame(() => input.setSelectionRange(start, end))
                }}
                list="spawn-folder-suggestions"
                placeholder="/Users/name/project"
                spellCheck={false}
                disabled={phase === 'starting'}
                className={inputClass}
              />
              <datalist id="spawn-folder-suggestions">
                {suggestions.map((value) => <option key={value} value={value} />)}
              </datalist>
              {folderProblem
                ? <span className="mt-1 block text-xs text-[var(--pear-red)]">{folderProblem}</span>
                : folder && folder === prefilled.current && (
                  <span className="mt-1 block text-xs text-[var(--pear-text-faint)]">
                    Last folder used on {node}. Type to swap the project, or pick another from the list.
                  </span>
                )}
            </label>
            {error && (
              <p className="whitespace-pre-wrap rounded-lg border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-4 py-2.5 text-xs text-[var(--pear-red)]">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-3 pt-1">
              {phase === 'starting' && (
                <span className="mr-auto flex items-center gap-2 text-xs text-[var(--pear-text-faint)]">
                  <Loader2 size={13} className="animate-spin" /> Starting {trimmedName} on {node}…
                </span>
              )}
              <button
                type="button"
                onClick={closeDialog}
                disabled={phase === 'starting'}
                className="rounded-lg px-4 py-2 text-sm text-[var(--pear-text-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded-lg bg-[var(--pear-accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--pear-accent-bright)] disabled:opacity-40"
              >
                Start
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
