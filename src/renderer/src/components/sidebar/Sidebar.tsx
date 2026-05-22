import type React from 'react'
import { ProjectSidebar } from './ProjectSidebar'

export function Sidebar(): React.ReactNode {
  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg-raised)]/95">
      <div className="min-h-0 flex-1">
        <ProjectSidebar />
      </div>
    </div>
  )
}

export default Sidebar
