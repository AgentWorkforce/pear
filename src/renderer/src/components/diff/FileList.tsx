import type React from 'react'
import type { FileStatus } from '@/stores/git-store'
import { useGitStore } from '@/stores/git-store'
import {
  FileChangeStatusIcon,
  FilePathLabel,
  fileChangeKindFromStatus,
  fileChangeStatusLabel
} from './FileChangeLabel'

interface Props {
  files: FileStatus[]
  selectedFile: string | null
  rootPath: string
}

export function FileList({ files, selectedFile, rootPath }: Props): React.ReactNode {
  const selectFile = useGitStore((s) => s.selectFile)

  if (files.length === 0) return <></>

  return (
    <div className="max-h-[200px] shrink-0 overflow-y-auto border-b border-[var(--pear-bg-surface)]">
      {files.map((file) => {
        const isSelected = selectedFile === file.path
        const kind = fileChangeKindFromStatus(file.status)
        const statusLabel = fileChangeStatusLabel(kind)

        return (
          <button
            key={file.path}
            onClick={() => selectFile(file.path, rootPath)}
            className={`flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left transition-colors ${
              isSelected
                ? 'bg-[var(--pear-bg-surface)]'
                : 'hover:bg-[var(--pear-bg-surface)]/50'
            }`}
          >
            <FilePathLabel path={file.path} oldPath={file.oldPath} className="flex-1 text-[15px]" />
            {file.staged && (
              <span className="text-[10px] text-[var(--pear-accent-bright)]">staged</span>
            )}
            <FileChangeStatusIcon kind={kind} label={statusLabel} />
          </button>
        )
      })}
    </div>
  )
}
