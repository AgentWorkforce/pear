import type React from 'react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import {
  parseDiff,
  expandFromRawCode,
  getChangeKey,
  getCollapsedLinesCountBetween,
  type HunkData,
  type FileData,
  type HunkTokens,
  type TokenNode,
  type ChangeData
} from 'react-diff-view'
import { pear } from '@/lib/ipc'
import { getDiffFilePath, getLineSelectionId } from '@/lib/diff-selection'
import { highlightCode } from '@/lib/syntax-highlighter'
import { useUIStore } from '@/stores/ui-store'

interface Props {
  diff: string
  rootPath?: string
  focusedFilePath?: string | null
  selectable?: boolean
  selectedLineIds?: Set<string>
  selectedFiles?: Set<string>
  onToggleLine?: (filePath: string, lineId: string) => void
  onSetLines?: (filePath: string, lineIds: string[], selected: boolean) => void
}

const EMPTY_SELECTION = new Set<string>()
const MAX_DIFF_HIGHLIGHT_CACHE_ENTRIES = 100

interface SyntaxTokenNode extends TokenNode {
  type: 'syntax'
  value: string
  style?: React.CSSProperties
}

interface SelectionMaps {
  lineIdsByChangeKey: Map<string, string>
  blockLineIdsByChangeKey: Map<string, string[]>
  blockIdByChangeKey: Map<string, string>
}

interface DragSelection {
  filePath: string
  lineId: string
  wasSelected: boolean
  changed: boolean
  appliedLineIds: Set<string>
}

type ExpandedRangesByFilePath = Record<string, string[]>

function isSyntaxToken(token: TokenNode): token is SyntaxTokenNode {
  return token.type === 'syntax'
}

function toTokenNodes(tokens: { content: string; style?: React.CSSProperties }[]): TokenNode[] {
  if (tokens.length === 0) return [{ type: 'text', value: '' }]

  return tokens.map((token) =>
    token.style
      ? {
          type: 'syntax',
          value: token.content,
          style: token.style
        }
      : {
          type: 'text',
          value: token.content
        }
  )
}

async function buildHighlightedTokens(file: FileData, theme: 'dark' | 'light'): Promise<HunkTokens | null> {
  const filePath = file.newPath === '/dev/null' ? file.oldPath : file.newPath
  const old: TokenNode[][] = []
  const next: TokenNode[][] = []
  const highlightableChanges: ChangeData[] = []

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type === 'insert' || change.type === 'delete' || change.type === 'normal') {
        highlightableChanges.push(change)
      }
    }
  }

  if (highlightableChanges.length === 0) {
    return { old, new: next }
  }

  const highlightedLines = await highlightCode(
    highlightableChanges.map((change) => change.content).join('\n'),
    filePath,
    theme
  )

  highlightableChanges.forEach((change, index) => {
    const tokenNodes = toTokenNodes(highlightedLines[index] || [])

    if (change.type === 'insert' && change.lineNumber > 0) {
      next[change.lineNumber - 1] = tokenNodes
    }

    if (change.type === 'delete' && change.lineNumber > 0) {
      old[change.lineNumber - 1] = tokenNodes
    }

    if (change.type === 'normal') {
      if (change.oldLineNumber > 0) old[change.oldLineNumber - 1] = tokenNodes
      if (change.newLineNumber > 0) next[change.newLineNumber - 1] = tokenNodes
    }
  })

  return { old, new: next }
}

function isSelectableChange(change: ChangeData | null): change is ChangeData {
  return !!change && change.type !== 'normal'
}

function buildSelectionMaps(filePath: string, hunks: HunkData[]): SelectionMaps {
  const lineIdsByChangeKey = new Map<string, string>()
  const blockLineIdsByChangeKey = new Map<string, string[]>()
  const blockIdByChangeKey = new Map<string, string>()
  let blockIndex = 0

  for (const hunk of hunks) {
    let blockChanges: ChangeData[] = []

    const flushBlock = (): void => {
      if (blockChanges.length === 0) return

      const blockLineIds = blockChanges.map((change) => getLineSelectionId(filePath, change))
      const blockId = `block-${blockIndex}`
      blockIndex += 1

      for (const change of blockChanges) {
        const changeKey = getChangeKey(change)
        blockLineIdsByChangeKey.set(changeKey, blockLineIds)
        blockIdByChangeKey.set(changeKey, blockId)
      }
      blockChanges = []
    }

    for (const change of hunk.changes) {
      if (change.type === 'normal') {
        flushBlock()
        continue
      }

      const lineId = getLineSelectionId(filePath, change)
      lineIdsByChangeKey.set(getChangeKey(change), lineId)
      blockChanges.push(change)
    }

    flushBlock()
  }

  return { lineIdsByChangeKey, blockLineIdsByChangeKey, blockIdByChangeKey }
}

function sourcePathForFile(file: FileData): string | null {
  if (file.type === 'add') return null
  return file.oldPath && file.oldPath !== '/dev/null' ? file.oldPath : null
}

function sourceLineCount(source: string): number {
  const lines = source.split('\n')
  return lines[lines.length - 1] === '' ? Math.max(lines.length - 1, 0) : lines.length
}

function rangeKey(start: number, end: number): string {
  return `${start}:${end}`
}

function rangeFromKey(key: string): [number, number] | null {
  const [start, end] = key.split(':').map((part) => Number(part))
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null
}

function oldLineNumber(change: ChangeData): number | undefined {
  if (change.type === 'insert') return undefined
  if (change.type === 'normal') return change.oldLineNumber
  return change.lineNumber
}

function newLineNumber(change: ChangeData): number | undefined {
  if (change.type === 'delete') return undefined
  if (change.type === 'normal') return change.newLineNumber
  return change.lineNumber
}

function lineSign(change: ChangeData): string {
  if (change.type === 'insert') return '+'
  if (change.type === 'delete') return '-'
  return ' '
}

function tokensForChange(tokens: HunkTokens | null | undefined, change: ChangeData): TokenNode[] | null {
  if (!tokens) return null

  if (change.type === 'delete' && change.lineNumber > 0) {
    return tokens.old[change.lineNumber - 1] || null
  }

  if (change.type === 'insert' && change.lineNumber > 0) {
    return tokens.new[change.lineNumber - 1] || null
  }

  if (change.type === 'normal') {
    return tokens.new[change.newLineNumber - 1] || tokens.old[change.oldLineNumber - 1] || null
  }

  return null
}

function renderTokenNode(token: TokenNode, tokenIndex: number): React.ReactNode {
  if (isSyntaxToken(token)) {
    return (
      <span key={tokenIndex} style={token.style}>
        {token.value}
      </span>
    )
  }

  if (token.type === 'text') {
    return token.value
  }

  if (typeof token.value === 'string') {
    return (
      <span key={tokenIndex} className={token.className}>
        {token.value}
      </span>
    )
  }

  if (token.children) {
    return (
      <span key={tokenIndex} className={token.className}>
        {token.children.map(renderTokenNode)}
      </span>
    )
  }

  return null
}

function renderCodeContent(tokens: TokenNode[] | null, fallback: string): React.ReactNode {
  if (!tokens || tokens.length === 0) return fallback || ' '
  if (tokens.length === 1 && tokens[0].type === 'text' && !tokens[0].value) return ' '
  return tokens.map(renderTokenNode)
}

function renderPendingCodeContent(fallback: string): React.ReactNode {
  return (
    <span aria-hidden="true" className="diff-code-content-pending">
      {fallback || ' '}
    </span>
  )
}

function renderEmptyFileState(): React.ReactNode {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center px-4 text-[13px] font-medium text-[var(--pear-text)]">
      The file is empty
    </div>
  )
}

function fileHasRenderableChanges(file: FileData): boolean {
  return file.hunks.some((hunk) => hunk.changes.length > 0)
}

function fileHighlightKey(file: FileData, theme: 'dark' | 'light'): string {
  const filePath = getDiffFilePath(file)
  const changeSignature = file.hunks
    .flatMap((hunk) =>
      hunk.changes.map((change) => (
        `${change.type}:${oldLineNumber(change) ?? ''}:${newLineNumber(change) ?? ''}:${change.content}`
      ))
    )
    .join('\n')

  return `${theme}\0${filePath}\0${changeSignature}`
}

function renderFoldRow({
  key,
  content,
  hiddenLines,
  canExpand,
  onExpand
}: {
  key: string
  content: string
  hiddenLines: number
  canExpand: boolean
  onExpand: () => void
}): React.ReactElement {
  return (
    <tr key={key} className="diff-decoration diff-hunk-decoration">
      <td className="diff-decoration-content diff-hunk-decoration-content" colSpan={4}>
        <button
          type="button"
          onClick={canExpand ? onExpand : undefined}
          disabled={!canExpand}
          className="diff-fold-control"
          title={canExpand ? 'Expand All' : content}
          aria-label={canExpand ? `Expand ${hiddenLines} hidden unchanged lines` : content}
        >
          <span className="diff-fold-marker">
            {hiddenLines > 0 ? <ChevronsUpDown size={14} strokeWidth={2.4} /> : '@@'}
          </span>
          <span className="diff-fold-content">{content}</span>
          {hiddenLines > 0 && (
            <span className="diff-fold-count">{hiddenLines} hidden</span>
          )}
        </button>
      </td>
    </tr>
  )
}

function renderHunkRows({
  hunks,
  source,
  onExpandRange,
  renderChange
}: {
  hunks: HunkData[]
  source: string | null | undefined
  onExpandRange: (start: number, end: number) => void
  renderChange: (change: ChangeData, key: string) => React.ReactElement
}): React.ReactElement[] {
  const rows: React.ReactElement[] = []
  const hasSource = source !== null && source !== undefined
  const lineCount = hasSource ? sourceLineCount(source) : 0

  hunks.forEach((hunk, index) => {
    const previousHunk = index > 0 ? hunks[index - 1] : null
    const hiddenLines = Math.max(0, getCollapsedLinesCountBetween(previousHunk, hunk))
    const foldStart = previousHunk ? previousHunk.oldStart + previousHunk.oldLines : 1
    const foldEnd = hunk.oldStart

    rows.push(renderFoldRow({
      key: `decoration-${hunk.content}-${index}`,
      content: hunk.content,
      hiddenLines,
      canExpand: hasSource && hiddenLines > 0,
      onExpand: () => onExpandRange(foldStart, foldEnd)
    }))

    hunk.changes.forEach((change) => {
      rows.push(renderChange(change, `change-${hunk.content}-${getChangeKey(change)}`))
    })
  })

  if (hasSource) {
    const lastHunk = hunks[hunks.length - 1]
    const hiddenLines = Math.max(0, lineCount - (lastHunk.oldStart + lastHunk.oldLines) + 1)
    if (hiddenLines > 0) {
      const foldStart = lastHunk.oldStart + lastHunk.oldLines
      const foldEnd = lineCount + 1
      rows.push(renderFoldRow({
        key: 'decoration-tail',
        content: 'End of file',
        hiddenLines,
        canExpand: true,
        onExpand: () => onExpandRange(foldStart, foldEnd)
      }))
    }
  }

  return rows
}

export const DiffViewer = memo(function DiffViewer({
  diff,
  rootPath,
  focusedFilePath,
  selectable = false,
  selectedLineIds = EMPTY_SELECTION,
  selectedFiles = EMPTY_SELECTION,
  onToggleLine,
  onSetLines
}: Props): React.ReactNode {
  const parsedFiles = useMemo(() => {
    if (!diff.trim()) return []

    try {
      return parseDiff(diff)
    } catch {
      return []
    }
  }, [diff])
  const files = useMemo(() => {
    if (!focusedFilePath) return parsedFiles
    return parsedFiles.filter((file) =>
      getDiffFilePath(file) === focusedFilePath || file.oldPath === focusedFilePath
    )
  }, [focusedFilePath, parsedFiles])
  const theme = useUIStore((s) => s.theme)
  const [highlightedFilesByKey, setHighlightedFilesByKey] = useState<Map<string, HunkTokens | null>>(
    () => new Map()
  )
  const highlightedFilesByKeyRef = useRef(highlightedFilesByKey)
  const pendingHighlightKeysRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  const [fileSources, setFileSources] = useState<Record<string, string | null>>({})
  const [expandedRangesByFilePath, setExpandedRangesByFilePath] = useState<ExpandedRangesByFilePath>({})
  const dragSelectionRef = useRef<DragSelection | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const finishDragSelection = (): void => {
      const dragSelection = dragSelectionRef.current
      if (!dragSelection) return

      dragSelectionRef.current = null

      if (!dragSelection.changed) {
        if (dragSelection.wasSelected) {
          onSetLines?.(dragSelection.filePath, [dragSelection.lineId], false)
        }
        return
      }

      if (!dragSelection.appliedLineIds.has(dragSelection.lineId)) {
        onSetLines?.(dragSelection.filePath, [dragSelection.lineId], true)
      }
    }

    window.addEventListener('mouseup', finishDragSelection)
    return () => window.removeEventListener('mouseup', finishDragSelection)
  }, [onSetLines])

  useEffect(() => {
    setExpandedRangesByFilePath({})
  }, [diff, rootPath])

  useEffect(() => {
    if (!rootPath || files.length === 0) {
      setFileSources({})
      return
    }

    let ignore = false

    Promise.all(
      files.map(async (file) => {
        const filePath = getDiffFilePath(file)
        const sourcePath = sourcePathForFile(file)

        if (!sourcePath) return [filePath, null] as const

        try {
          return [filePath, await pear.git.fileContent(rootPath, sourcePath, 'HEAD')] as const
        } catch {
          return [filePath, null] as const
        }
      })
    ).then((entries) => {
      if (ignore) return
      setFileSources(Object.fromEntries(entries))
    })

    return () => {
      ignore = true
    }
  }, [files, rootPath])

  const displayFiles = useMemo(() => {
    return files.map((file) => {
      const filePath = getDiffFilePath(file)
      const source = fileSources[filePath]
      const expandedRangeKeys = expandedRangesByFilePath[filePath] || []
      if (source === null || source === undefined || expandedRangeKeys.length === 0 || file.hunks.length === 0) {
        return file
      }

      return {
        ...file,
        hunks: expandedRangeKeys
          .map(rangeFromKey)
          .filter((range): range is [number, number] => !!range)
          .sort(([a], [b]) => a - b)
          .reduce((hunks, [start, end]) => expandFromRawCode(hunks, source, start, end), file.hunks)
      }
    })
  }, [expandedRangesByFilePath, fileSources, files])
  const displayFilesWithHighlightKeys = useMemo(() => {
    return displayFiles.map((file) => ({
      file,
      highlightKey: fileHighlightKey(file, theme)
    }))
  }, [displayFiles, theme])
  const hasPendingHighlights = displayFilesWithHighlightKeys.some(
    ({ highlightKey }) => !highlightedFilesByKey.has(highlightKey)
  )
  const selectionMapsByFilePath = useMemo(() => {
    const maps = new Map<string, SelectionMaps>()
    if (!selectable) return maps

    displayFiles.forEach((file) => {
      const filePath = getDiffFilePath(file)
      maps.set(filePath, buildSelectionMaps(filePath, file.hunks))
    })

    return maps
  }, [displayFiles, selectable])

  function setLines(filePath: string, lineIds: string[], selected: boolean): void {
    if (onSetLines) {
      onSetLines(filePath, lineIds, selected)
      return
    }

    if (selected) {
      lineIds.forEach((lineId) => onToggleLine?.(filePath, lineId))
    }
  }

  function isLineSelected(filePath: string, lineId: string): boolean {
    return selectedFiles.has(filePath) || selectedLineIds.has(lineId)
  }

  function stopSelectionEvent(event: Pick<React.MouseEvent<HTMLElement>, 'preventDefault' | 'stopPropagation'>): void {
    event.preventDefault()
    event.stopPropagation()
  }

  function beginLineSelection(
    filePath: string,
    lineId: string,
    selected: boolean,
    event: Pick<React.MouseEvent<HTMLElement>, 'preventDefault' | 'stopPropagation'>
  ): void {
    stopSelectionEvent(event)

    const appliedLineIds = new Set<string>()
    if (!selected) {
      setLines(filePath, [lineId], true)
      appliedLineIds.add(lineId)
    }

    dragSelectionRef.current = {
      filePath,
      lineId,
      wasSelected: selected,
      changed: false,
      appliedLineIds
    }
  }

  function dragAcrossLine(filePath: string, lineId: string): void {
    const dragSelection = dragSelectionRef.current
    if (!dragSelection || dragSelection.filePath !== filePath) return

    if (dragSelection.lineId !== lineId) {
      dragSelection.changed = true
    }

    if (dragSelection.appliedLineIds.has(lineId)) return

    setLines(filePath, [lineId], true)
    dragSelection.appliedLineIds.add(lineId)
  }

  function setBlockHover(
    event: React.MouseEvent<HTMLElement>,
    blockId: string | undefined,
    hovered: boolean
  ): void {
    if (!blockId) return

    const table = event.currentTarget.closest('table')
    if (!table) return

    table
      .querySelectorAll<HTMLElement>(`[data-diff-block="${blockId}"]`)
      .forEach((row) => row.classList.toggle('diff-line-block-hover', hovered))
  }

  useEffect(() => {
    const cacheHighlightedFile = (highlightKey: string, tokens: HunkTokens | null): void => {
      if (!mountedRef.current) return

      setHighlightedFilesByKey((current) => {
        if (current.has(highlightKey)) return current

        const next = new Map(current)
        next.set(highlightKey, tokens)

        while (next.size > MAX_DIFF_HIGHLIGHT_CACHE_ENTRIES) {
          const oldestKey = next.keys().next().value
          if (!oldestKey) break
          next.delete(oldestKey)
        }

        highlightedFilesByKeyRef.current = next
        return next
      })
    }

    displayFilesWithHighlightKeys.forEach(({ file, highlightKey }) => {
      if (
        highlightedFilesByKeyRef.current.has(highlightKey) ||
        pendingHighlightKeysRef.current.has(highlightKey)
      ) {
        return
      }

      pendingHighlightKeysRef.current.add(highlightKey)
      buildHighlightedTokens(file, theme)
        .then((tokens) => cacheHighlightedFile(highlightKey, tokens))
        .catch(() => cacheHighlightedFile(highlightKey, null))
        .finally(() => {
          pendingHighlightKeysRef.current.delete(highlightKey)
        })
    })
  }, [displayFilesWithHighlightKeys, theme])

  if (displayFiles.length === 0) {
    return (
      <div className="p-0">
        <pre className="whitespace-pre-wrap text-xs text-[var(--pear-text-dim)]">
          {diff || 'No diff available'}
        </pre>
      </div>
    )
  }

  if (!displayFiles.some(fileHasRenderableChanges)) {
    return renderEmptyFileState()
  }

  return (
    <div className="diff-view" aria-busy={hasPendingHighlights}>
      {displayFilesWithHighlightKeys.map(({ file, highlightKey }) => {
        const filePath = getDiffFilePath(file)
        const source = fileSources[filePath]
        const selectionMaps = selectionMapsByFilePath.get(filePath)
        const highlightReady = highlightedFilesByKey.has(highlightKey)
        const highlightedTokens = highlightedFilesByKey.get(highlightKey) || null
        const expandRange = (start: number, end: number): void => {
          if (end <= start) return

          setExpandedRangesByFilePath((current) => {
            const key = rangeKey(start, end)
            const currentRanges = current[filePath] || []
            if (currentRanges.includes(key)) return current

            return {
              ...current,
              [filePath]: [...currentRanges, key]
            }
          })
        }
        const renderChange = (change: ChangeData, key: string): React.ReactElement => {
          const changeKey = getChangeKey(change)
          const lineId = selectable && selectionMaps && isSelectableChange(change)
            ? selectionMaps.lineIdsByChangeKey.get(changeKey)
            : undefined
          const blockLineIds = selectable && selectionMaps && isSelectableChange(change)
            ? selectionMaps.blockLineIdsByChangeKey.get(changeKey) || []
            : []
          const blockId = selectable && selectionMaps && isSelectableChange(change)
            ? selectionMaps.blockIdByChangeKey.get(changeKey)
            : undefined
          const selected = !!lineId && isLineSelected(filePath, lineId)
          const blockSelected = blockLineIds.length > 0 &&
            blockLineIds.every((id) => isLineSelected(filePath, id))
          const blockActive = blockLineIds.length > 0 &&
            blockLineIds.some((id) => isLineSelected(filePath, id))
          const gutterClassName = `diff-gutter diff-gutter-${change.type} ${selected ? 'diff-gutter-selected' : ''}`
          const selectableClassName = lineId ? 'is-selectable' : ''
          const lineSelectEvents = lineId
            ? {
                onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
                  beginLineSelection(filePath, lineId, selected, event)
                },
                onMouseEnter: () => {
                  dragAcrossLine(filePath, lineId)
                }
              }
            : {}

          return (
            <tr
              key={key}
              className="diff-line"
              data-diff-block={blockId}
            >
              <td className={`diff-block-gutter diff-gutter-${change.type} ${blockActive ? 'is-active' : ''} ${blockSelected ? 'is-selected' : ''}`}>
                <button
                  type="button"
                  disabled={blockLineIds.length === 0}
                  className={`diff-block-selector ${blockActive ? 'is-active' : ''} ${blockSelected ? 'is-selected' : ''}`}
                  title={blockSelected ? 'Unselect block' : 'Select block'}
                  aria-label={blockSelected ? 'Unselect diff block' : 'Select diff block'}
                  onMouseDown={stopSelectionEvent}
                  onClick={(event) => {
                    stopSelectionEvent(event)
                    if (blockLineIds.length === 0) return
                    setLines(filePath, blockLineIds, !blockSelected)
                  }}
                  onMouseEnter={(event) => {
                    setBlockHover(event, blockId, true)
                  }}
                  onMouseLeave={(event) => {
                    setBlockHover(event, blockId, false)
                  }}
                />
              </td>
              <td
                className={`${gutterClassName} diff-gutter-old-cell ${selectableClassName}`}
                {...lineSelectEvents}
              >
                <span className={`diff-gutter-number diff-gutter-number-old ${selected ? 'is-selected' : ''}`}>
                  {oldLineNumber(change)}
                </span>
              </td>
              <td
                className={`${gutterClassName} diff-gutter-new-cell ${selectableClassName}`}
                {...lineSelectEvents}
              >
                <span className={`diff-gutter-number diff-gutter-number-new ${selected ? 'is-selected' : ''}`}>
                  {newLineNumber(change)}
                </span>
              </td>
              <td
                className={`diff-code diff-code-${change.type} ${selected ? 'diff-code-selected' : ''} ${selectableClassName}`}
                data-change-key={changeKey}
                {...lineSelectEvents}
              >
                <span className="diff-code-prefix">{lineSign(change)}</span>
                <span className="diff-code-content">
                  {highlightReady
                    ? renderCodeContent(tokensForChange(highlightedTokens, change), change.content)
                    : renderPendingCodeContent(change.content)}
                </span>
              </td>
            </tr>
          )
        }

        return (
          <div key={file.oldPath + file.newPath} className="mb-2">
            <table className="diff diff-unified diff-three-column-gutter">
              <colgroup>
                <col className="diff-block-col" />
                <col className="diff-gutter-col diff-gutter-old-col" />
                <col className="diff-gutter-col diff-gutter-new-col" />
                <col />
              </colgroup>
              <tbody className="diff-hunk">
                {renderHunkRows({
                  hunks: file.hunks,
                  source,
                  onExpandRange: expandRange,
                  renderChange
                })}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
})
