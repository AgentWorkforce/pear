import type React from 'react'
import { MessageSquare } from 'lucide-react'
import { ProjectSidebar } from './ProjectSidebar'
import { useUIStore } from '@/stores/ui-store'

export function Sidebar(): React.ReactNode {
  const openTab = useUIStore((s) => s.openTab)
  const activeTabId = useUIStore((s) => s.activeTabId)
  const conversationsActive = activeTabId === 'ai-hist'

  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg-raised)]/95">
      <div className="min-h-0 flex-1">
        <ProjectSidebar />
      </div>
      <div className="border-t border-[var(--pear-border)] p-2">
        <button
          onClick={() => openTab({ kind: 'ai-hist' })}
          title="Browse Claude / Codex / Cursor / Relay conversation history (requires ai-hist)"
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
            conversationsActive
              ? 'bg-[var(--pear-bg-overlay-strong)] text-[var(--pear-fg)]'
              : 'text-[var(--pear-fg-muted)] hover:bg-[var(--pear-bg-overlay)] hover:text-[var(--pear-fg)]'
          }`}
        >
          <MessageSquare size={14} />
          <span>Conversations</span>
        </button>
      </div>
    </div>
  )
}

export default Sidebar
