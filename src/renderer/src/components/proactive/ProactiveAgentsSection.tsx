// TODO(sibling: ui-store): remove the local tab payload cast after AppTabKind
// includes `proactive-agent-editor` and AppTabInput includes `personaId` plus
// the editor view fields used by proactive-agent editor/run-history tabs.
import type React from 'react'
import { useMemo } from 'react'
import { AlertTriangle, Loader2, Plus, RadioTower, Sparkles } from 'lucide-react'
import { ProactiveAgentCard } from '@/components/proactive/ProactiveAgentCard'
import { useProactiveAgents } from '@/hooks/use-proactive-agent'
import type { ProactiveAgentBinding } from '@/lib/ipc'
import { useUIStore } from '@/stores/ui-store'

export interface ProactiveAgentsSectionProps {
  projectId: string
}

type ProactiveAgentEditorTabInput = Parameters<ReturnType<typeof useUIStore.getState>['openTab']>[0] & {
  kind: 'proactive-agent-editor'
  projectId: string
  personaId: string | null
  view?: 'editor' | 'runs'
}

function createEditorTabInput(
  projectId: string,
  personaId: string | null,
  view: 'editor' | 'runs' = 'editor'
): ProactiveAgentEditorTabInput {
  return {
    kind: 'proactive-agent-editor',
    projectId,
    personaId,
    view
  } as unknown as ProactiveAgentEditorTabInput
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.ReactNode {
  return (
    <div className="rounded-lg border border-dashed border-[var(--pear-border)] bg-[var(--pear-bg-raised)] px-4 py-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-accent)]">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--pear-text)]">No proactive agents yet</h3>
            <p className="mt-1 max-w-xl text-xs leading-5 text-[var(--pear-text-faint)]">
              Create a cloud agent that watches project files and runs when matching changes land.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-[var(--pear-border)] px-3 text-sm text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
        >
          <Plus size={14} />
          Create proactive agent
        </button>
      </div>
    </div>
  )
}

function LoadingState(): React.ReactNode {
  return (
    <div className="space-y-2">
      {[0, 1].map((index) => (
        <div
          key={index}
          className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-4 py-3"
        >
          <div className="flex animate-pulse items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-[var(--pear-bg-overlay)]" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-40 rounded bg-[var(--pear-bg-overlay)]" />
              <div className="h-2.5 w-64 max-w-full rounded bg-[var(--pear-bg-overlay)]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function LocalAgentStub(): React.ReactNode {
  return (
    <button
      type="button"
      disabled
      className="flex w-full items-center gap-3 rounded-lg border border-dashed border-[var(--pear-border-subtle)] px-4 py-3 text-left text-sm text-[var(--pear-text-faint)] opacity-70"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)]">
        <Plus size={14} />
      </span>
      <span className="min-w-0 flex-1">Add local agent (coming soon)</span>
    </button>
  )
}

function sortBindings(bindings: ProactiveAgentBinding[]): ProactiveAgentBinding[] {
  return [...bindings].sort((a, b) => {
    const aName = a.draft.name.trim() || a.personaId
    const bName = b.draft.name.trim() || b.personaId
    return aName.localeCompare(bName)
  })
}

export function ProactiveAgentsSection({ projectId }: ProactiveAgentsSectionProps): React.ReactNode {
  const { bindings, status, error, pause, resume, undeploy } = useProactiveAgents(projectId)
  const openTab = useUIStore((state) => state.openTab)
  const sortedBindings = useMemo(() => sortBindings(bindings), [bindings])
  const loading = status === 'loading' && sortedBindings.length === 0

  const openEditor = (personaId: string | null, view: 'editor' | 'runs' = 'editor'): void => {
    openTab(createEditorTabInput(projectId, personaId, view))
  }

  return (
    <section className="border-t border-[var(--pear-border-subtle)] pt-6">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">Agents</h2>
          {status === 'loading' && sortedBindings.length > 0 && (
            <Loader2 size={13} className="shrink-0 animate-spin text-[var(--pear-text-faint)]" />
          )}
        </div>
        <button
          type="button"
          onClick={() => openEditor(null)}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md px-2.5 text-xs text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-text)]"
        >
          <Plus size={13} />
          Create proactive agent
        </button>
      </div>

      <div className="space-y-2">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--pear-red)]/20 bg-[var(--pear-red)]/10 px-3 py-2 text-sm text-[var(--pear-red)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        {loading ? (
          <LoadingState />
        ) : sortedBindings.length === 0 ? (
          <EmptyState onCreate={() => openEditor(null)} />
        ) : (
          sortedBindings.map((binding) => (
            <ProactiveAgentCard
              key={binding.personaId}
              binding={binding}
              onEdit={(personaId) => openEditor(personaId)}
              onViewRuns={(personaId) => openEditor(personaId, 'runs')}
              onPause={pause}
              onResume={resume}
              onUndeploy={undeploy}
            />
          ))
        )}

        <LocalAgentStub />

        {status === 'idle' && sortedBindings.length > 0 && (
          <div className="flex items-center gap-2 px-1 text-xs text-[var(--pear-text-faint)]">
            <RadioTower size={12} />
            Proactive agents will refresh when the runtime connects.
          </div>
        )}
      </div>
    </section>
  )
}

export default ProactiveAgentsSection
