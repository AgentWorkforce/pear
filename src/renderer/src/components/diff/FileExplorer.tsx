import type React from 'react'
import { startTransition, useDeferredValue, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Search
} from 'lucide-react'
import { pear } from '@/lib/ipc'
import { highlightCode } from '@/lib/syntax-highlighter'
import { useUIStore } from '@/stores/ui-store'

interface Props {
  rootPath: string
}

interface ExplorerEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

interface FilePreview {
  kind: 'text' | 'binary' | 'too-large' | 'missing'
  content: string
  size: number
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function displayPath(rootPath: string, targetPath: string): string {
  if (!targetPath.startsWith(rootPath)) return targetPath
  const relative = targetPath.slice(rootPath.length).replace(/^[/\\]/, '')
  return relative || '.'
}

export function FileExplorer({ rootPath }: Props): React.ReactNode {
  const [query, setQuery] = useState('')
  const [expandedDirectories, setExpandedDirectories] = useState<string[]>([])
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, ExplorerEntry[]>>({})
  const [loadingDirectories, setLoadingDirectories] = useState<Record<string, boolean>>({})
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [highlightedPreview, setHighlightedPreview] = useState<
    { content: string; style?: React.CSSProperties }[][] | null
  >(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const theme = useUIStore((s) => s.theme)

  useEffect(() => {
    setExpandedDirectories([rootPath])
    setEntriesByDirectory({})
    setLoadingDirectories({})
    setSelectedPath(null)
    setPreview(null)
    setLoadError(null)

    if (!pear.fs) {
      setLoadError('File browsing is unavailable in this build. Reload the app to pick up the new preload API.')
      return
    }

    let ignore = false
    setLoadingDirectories({ [rootPath]: true })

    pear.fs
      .listDir(rootPath)
      .then((entries) => {
        if (ignore) return
        startTransition(() => {
          setEntriesByDirectory({ [rootPath]: entries })
          setLoadingDirectories({})
          setLoadError(null)
        })
      })
      .catch(() => {
        if (ignore) return
        setEntriesByDirectory({ [rootPath]: [] })
        setLoadingDirectories({})
        setLoadError('Unable to load files for this root.')
      })

    return () => {
      ignore = true
    }
  }, [rootPath])

  useEffect(() => {
    if (!selectedPath) {
      setPreview(null)
      return
    }

    if (!pear.fs) {
      setPreview({
        kind: 'missing',
        content: 'File preview is unavailable in this build.',
        size: 0
      })
      setPreviewLoading(false)
      return
    }

    let ignore = false
    setPreviewLoading(true)

    pear.fs
      .readPreview(selectedPath)
      .then((nextPreview) => {
        if (ignore) return
        setPreview(nextPreview)
        setPreviewLoading(false)
      })
      .catch(() => {
        if (ignore) return
        setPreview({
          kind: 'missing',
          content: 'Unable to read file',
          size: 0
        })
        setPreviewLoading(false)
      })

    return () => {
      ignore = true
    }
  }, [selectedPath])

  useEffect(() => {
    if (!selectedPath || preview?.kind !== 'text') {
      setHighlightedPreview(null)
      return
    }

    let ignore = false

    highlightCode(preview.content, selectedPath, theme)
      .then((tokens) => {
        if (ignore) return
        setHighlightedPreview(tokens)
      })
      .catch(() => {
        if (ignore) return
        setHighlightedPreview(null)
      })

    return () => {
      ignore = true
    }
  }, [preview, selectedPath, theme])

  async function ensureDirectoryLoaded(dirPath: string): Promise<void> {
    if (!pear.fs) {
      setLoadError('File browsing is unavailable in this build.')
      return
    }
    if (entriesByDirectory[dirPath] || loadingDirectories[dirPath]) return

    setLoadingDirectories((current) => ({ ...current, [dirPath]: true }))
    try {
      const entries = await pear.fs.listDir(dirPath)
      startTransition(() => {
        setEntriesByDirectory((current) => ({ ...current, [dirPath]: entries }))
        setLoadingDirectories((current) => ({ ...current, [dirPath]: false }))
      })
    } catch {
      setEntriesByDirectory((current) => ({ ...current, [dirPath]: [] }))
      setLoadingDirectories((current) => ({ ...current, [dirPath]: false }))
      setLoadError('Unable to load one or more folders.')
    }
  }

  function toggleDirectory(dirPath: string): void {
    const isExpanded = expandedDirectories.includes(dirPath)
    if (!isExpanded) {
      void ensureDirectoryLoaded(dirPath)
    }
    setExpandedDirectories((current) =>
      isExpanded ? current.filter((value) => value !== dirPath) : [...current, dirPath]
    )
  }

  function matches(entry: ExplorerEntry): boolean {
    return !deferredQuery || entry.name.toLowerCase().includes(deferredQuery)
  }

  function directoryHasVisibleChildren(dirPath: string): boolean {
    const children = entriesByDirectory[dirPath] || []
    return children.some((entry) => {
      if (matches(entry)) return true
      if (entry.type === 'directory') return directoryHasVisibleChildren(entry.path)
      return false
    })
  }

  function renderEntries(dirPath: string, depth = 0): React.ReactNode {
    const entries = entriesByDirectory[dirPath] || []
    const visibleEntries = entries.filter((entry) => {
      if (matches(entry)) return true
      if (entry.type === 'directory') return directoryHasVisibleChildren(entry.path)
      return false
    })

    if (visibleEntries.length === 0 && !loadingDirectories[dirPath] && dirPath === rootPath) {
      return (
        <div className="px-3 py-4 text-sm text-[var(--pear-text-faint)]">
          {deferredQuery ? 'No matching loaded files' : 'No files found'}
        </div>
      )
    }

    return visibleEntries.map((entry) => {
      const isDirectory = entry.type === 'directory'
      const isExpanded = expandedDirectories.includes(entry.path)
      const showChildren = isDirectory && (deferredQuery ? true : isExpanded)

      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() => {
              if (isDirectory) {
                toggleDirectory(entry.path)
                return
              }
              setSelectedPath(entry.path)
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
              selectedPath === entry.path
                ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface)]/60'
            }`}
            style={{ paddingLeft: `${12 + depth * 14}px` }}
          >
            {isDirectory ? (
              <>
                {showChildren ? (
                  <ChevronDown size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
                ) : (
                  <ChevronRight size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
                )}
                {showChildren ? (
                  <FolderOpen size={14} className="shrink-0 text-[var(--pear-accent)]" />
                ) : (
                  <Folder size={14} className="shrink-0 text-[var(--pear-accent)]" />
                )}
              </>
            ) : (
              <>
                <span className="w-[14px] shrink-0" />
                <FileCode2 size={14} className="shrink-0 text-[var(--pear-text-dim)]" />
              </>
            )}
            <span className="truncate">{entry.name}</span>
          </button>

          {isDirectory && showChildren && (
            <div>
              {loadingDirectories[entry.path] ? (
                <div
                  className="px-3 py-1.5 text-xs text-[var(--pear-text-faint)]"
                  style={{ paddingLeft: `${26 + depth * 14}px` }}
                >
                  Loading...
                </div>
              ) : (
                renderEntries(entry.path, depth + 1)
              )}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--pear-border-subtle)] p-3">
        <label className="flex items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-sm text-[var(--pear-text-secondary)]">
          <Search size={14} className="text-[var(--pear-text-faint)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files..."
            className="w-full border-0 bg-transparent text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
          />
        </label>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {loadError && (
          <div className="border-b border-[var(--pear-border-subtle)] px-3 py-2 text-sm text-[var(--pear-red)]">
            {loadError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto border-b border-[var(--pear-border-subtle)]">
          {loadingDirectories[rootPath] && !entriesByDirectory[rootPath] ? (
            <div className="px-3 py-4 text-sm text-[var(--pear-text-faint)]">Loading files...</div>
          ) : (
            renderEntries(rootPath)
          )}
        </div>

        <div className="h-56 shrink-0 overflow-auto bg-[var(--pear-bg)]">
          <div className="border-b border-[var(--pear-border-subtle)] px-3 py-2">
            <div className="truncate text-xs font-medium uppercase tracking-[0.14em] text-[var(--pear-text-faint)]">
              Preview
            </div>
            <div className="truncate text-xs text-[var(--pear-text-dim)]">
              {selectedPath ? displayPath(rootPath, selectedPath) : 'Select a file to preview'}
            </div>
          </div>

          {!selectedPath && (
            <div className="flex h-[calc(100%-49px)] items-center justify-center px-4 text-sm text-[var(--pear-text-faint)]">
              Choose a file from the explorer to view its contents.
            </div>
          )}

          {selectedPath && previewLoading && (
            <div className="px-3 py-4 text-sm text-[var(--pear-text-faint)]">Loading preview...</div>
          )}

          {selectedPath && !previewLoading && preview?.kind === 'text' && (
            <div className="px-3 py-2">
              <div className="mb-2 text-xs text-[var(--pear-text-faint)]">
                {formatBytes(preview.size)}
              </div>
              {highlightedPreview ? (
                <div className="font-mono text-[12px] leading-5 text-[var(--pear-text-secondary)]">
                  {highlightedPreview.map((line, lineIndex) => (
                    <div key={`${selectedPath}:${lineIndex}`} className="whitespace-pre-wrap break-words">
                      {line.length > 0
                        ? line.map((token, tokenIndex) => (
                            <span key={`${selectedPath}:${lineIndex}:${tokenIndex}`} style={token.style}>
                              {token.content}
                            </span>
                          ))
                        : ' '}
                    </div>
                  ))}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[var(--pear-text-secondary)]">
                  {preview.content}
                </pre>
              )}
            </div>
          )}

          {selectedPath && !previewLoading && preview?.kind === 'binary' && (
            <div className="px-3 py-4 text-sm text-[var(--pear-text-faint)]">
              Binary file preview is not available.
            </div>
          )}

          {selectedPath && !previewLoading && preview?.kind === 'too-large' && (
            <div className="px-3 py-4 text-sm text-[var(--pear-text-faint)]">
              File is too large to preview ({formatBytes(preview.size)}).
            </div>
          )}

          {selectedPath && !previewLoading && preview?.kind === 'missing' && (
            <div className="px-3 py-4 text-sm text-[var(--pear-red)]">{preview.content}</div>
          )}
        </div>
      </div>
    </div>
  )
}
