import type React from 'react'
import { FileIcon, FilePlus, FileMinus, FileEdit, ArrowRightLeft, FileQuestion } from 'lucide-react'
import type { FileStatus } from '@/stores/git-store'
import { useGitStore } from '@/stores/git-store'

interface Props {
  files: FileStatus[]
  selectedFile: string | null
  worktreePath: string
}

const statusIcons: Record<FileStatus['status'], typeof FileIcon> = {
  added: FilePlus,
  modified: FileEdit,
  deleted: FileMinus,
  renamed: ArrowRightLeft,
  untracked: FileQuestion
}

const statusColors: Record<FileStatus['status'], string> = {
  added: 'var(--pear-accent-bright)',
  modified: 'var(--pear-yellow)',
  deleted: 'var(--pear-red)',
  renamed: 'var(--pear-accent)',
  untracked: 'var(--pear-text-faint)'
}

export function FileList({ files, selectedFile, worktreePath }: Props): React.ReactNode {
  const selectFile = useGitStore((s) => s.selectFile)

  if (files.length === 0) return <></>

  return (
    <div className="max-h-[200px] shrink-0 overflow-y-auto border-b border-[var(--pear-bg-surface)]">
      {files.map((file) => {
        const Icon = statusIcons[file.status]
        const color = statusColors[file.status]
        const isSelected = selectedFile === file.path

        return (
          <button
            key={file.path}
            onClick={() => selectFile(isSelected ? null : file.path, worktreePath)}
            className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors ${
              isSelected
                ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface)]/50'
            }`}
          >
            <Icon size={13} style={{ color }} />
            <span className="flex-1 truncate">{file.path}</span>
            {file.staged && (
              <span className="text-[10px] text-[var(--pear-accent-bright)]">staged</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
