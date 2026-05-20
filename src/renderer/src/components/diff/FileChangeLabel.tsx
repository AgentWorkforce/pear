import type React from 'react'
import { ArrowRight, Minus, Plus } from 'lucide-react'

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked'

const statusClasses: Record<FileChangeKind, string> = {
  added: 'border-[var(--pear-green)] text-[var(--pear-green)]',
  modified: 'border-[var(--pear-yellow)] text-[var(--pear-yellow)]',
  deleted: 'border-[var(--pear-red)] text-[var(--pear-red)]',
  renamed: 'border-[var(--pear-blue)] text-[var(--pear-blue)]',
  copied: 'border-[var(--pear-blue)] text-[var(--pear-blue)]',
  untracked: 'border-[var(--pear-green)] text-[var(--pear-green)]'
}

const statusLabels: Record<FileChangeKind, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Removed',
  renamed: 'Moved',
  copied: 'Copied',
  untracked: 'Untracked'
}

export function fileChangeKindFromStatus(status: string): FileChangeKind {
  if (status === 'added' || status.startsWith('A')) return 'added'
  if (status === 'deleted' || status.startsWith('D')) return 'deleted'
  if (status === 'renamed' || status.startsWith('R')) return 'renamed'
  if (status.startsWith('C')) return 'copied'
  if (status === 'untracked') return 'untracked'
  return 'modified'
}

export function fileChangeStatusLabel(kind: FileChangeKind): string {
  return statusLabels[kind]
}

export function FileChangeStatusIcon({
  kind,
  label = statusLabels[kind]
}: {
  kind: FileChangeKind
  label?: string
}): React.ReactNode {
  return (
    <span
      className={`flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border-2 ${statusClasses[kind]}`}
      title={label}
      aria-label={label}
    >
      {kind === 'modified' ? (
        <span className="h-[3px] w-[3px] rounded-full bg-current" />
      ) : kind === 'deleted' ? (
        <Minus size={10} strokeWidth={2.8} />
      ) : kind === 'renamed' || kind === 'copied' ? (
        <ArrowRight size={10} strokeWidth={2.8} />
      ) : (
        <Plus size={10} strokeWidth={2.8} />
      )}
    </span>
  )
}

function splitFilePath(path: string): { directory: string; fileName: string } {
  const separatorIndex = path.lastIndexOf('/')
  if (separatorIndex === -1) return { directory: '', fileName: path }
  return {
    directory: path.slice(0, separatorIndex + 1),
    fileName: path.slice(separatorIndex + 1)
  }
}

function FilePathSegment({ path, className = '' }: { path: string; className?: string }): React.ReactNode {
  const { directory, fileName } = splitFilePath(path)

  return (
    <span className={`flex min-w-0 items-baseline overflow-hidden ${className}`}>
      {directory && <span className="min-w-0 truncate text-[var(--pear-text-dim)]">{directory}</span>}
      <span className="max-w-full shrink-0 truncate font-semibold text-[var(--pear-text)]">{fileName}</span>
    </span>
  )
}

export function FilePathLabel({
  path,
  oldPath,
  className = ''
}: {
  path: string
  oldPath?: string
  className?: string
}): React.ReactNode {
  if (oldPath && oldPath !== path) {
    return (
      <span className={`flex min-w-0 items-center gap-2 overflow-hidden ${className}`}>
        <FilePathSegment path={oldPath} className="flex-1 basis-0" />
        <ArrowRight size={12} strokeWidth={2.4} className="shrink-0 text-[var(--pear-text-secondary)]" />
        <FilePathSegment path={path} className="flex-1 basis-0" />
      </span>
    )
  }

  return <FilePathSegment path={path} className={className} />
}
