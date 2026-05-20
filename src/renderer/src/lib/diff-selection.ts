import {
  getChangeKey,
  parseDiff,
  type ChangeData,
  type FileData,
  type HunkData
} from 'react-diff-view'

const LINE_SELECTION_SEPARATOR = '\u001f'

export function getDiffFilePath(file: FileData): string {
  if (file.newPath && file.newPath !== '/dev/null') return file.newPath
  return file.oldPath
}

export function getLineSelectionId(filePath: string, change: ChangeData): string {
  return `${filePath}${LINE_SELECTION_SEPARATOR}${getChangeKey(change)}`
}

export function getFilePathFromLineSelectionId(id: string): string {
  return id.split(LINE_SELECTION_SEPARATOR)[0] || ''
}

export function getSelectableLineIds(diff: string): string[] {
  try {
    return parseDiff(diff).flatMap((file) => {
      const filePath = getDiffFilePath(file)
      return file.hunks.flatMap((hunk) =>
        hunk.changes
          .filter((change) => change.type !== 'normal')
          .map((change) => getLineSelectionId(filePath, change))
      )
    })
  } catch {
    return []
  }
}

function range(start: number, lines: number): string {
  return `${start},${lines}`
}

function getOldAnchorForInsert(hunk: HunkData, index: number): number {
  let oldLine = hunk.oldStart - 1
  for (const change of hunk.changes.slice(0, index)) {
    if (change.type === 'normal') oldLine = change.oldLineNumber
    if (change.type === 'delete') oldLine = change.lineNumber
  }
  return oldLine
}

function getNewAnchorForDelete(hunk: HunkData, index: number): number {
  let newLine = hunk.newStart - 1
  for (const change of hunk.changes.slice(0, index)) {
    if (change.type === 'normal') newLine = change.newLineNumber
    if (change.type === 'insert') newLine = change.lineNumber
  }
  return newLine
}

function buildHunkPatch(hunk: HunkData, indexedChanges: { change: ChangeData; index: number }[]): string[] {
  const deletes = indexedChanges.filter((entry) => entry.change.type === 'delete')
  const inserts = indexedChanges.filter((entry) => entry.change.type === 'insert')
  const first = indexedChanges[0]
  const oldStart = deletes.length > 0
    ? deletes[0].change.lineNumber
    : getOldAnchorForInsert(hunk, first.index)
  const newStart = inserts.length > 0
    ? inserts[0].change.lineNumber
    : getNewAnchorForDelete(hunk, first.index)
  const oldLines = deletes.length
  const newLines = inserts.length

  return [
    `@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@`,
    ...indexedChanges.map(({ change }) => `${change.type === 'delete' ? '-' : '+'}${change.content}`)
  ]
}

function fileHeader(file: FileData): string[] {
  const displayPath = getDiffFilePath(file)
  const oldGitPath = file.oldPath === '/dev/null' ? `a/${displayPath}` : `a/${file.oldPath}`
  const newGitPath = file.newPath === '/dev/null' ? `b/${displayPath}` : `b/${file.newPath}`
  const oldPath = file.oldPath === '/dev/null' ? '/dev/null' : `a/${file.oldPath}`
  const newPath = file.newPath === '/dev/null' ? '/dev/null' : `b/${file.newPath}`
  const lines = [`diff --git ${oldGitPath} ${newGitPath}`]

  if (file.type === 'add') lines.push(`new file mode ${file.newMode || '100644'}`)
  if (file.type === 'delete') lines.push(`deleted file mode ${file.oldMode || '100644'}`)
  if (file.oldRevision && file.newRevision) {
    const mode = file.newMode || file.oldMode
    lines.push(`index ${file.oldRevision}..${file.newRevision}${mode ? ` ${mode}` : ''}`)
  }

  lines.push(`--- ${oldPath}`)
  lines.push(`+++ ${newPath}`)
  return lines
}

function appendSelectedHunks(file: FileData, selectedLineIds: Set<string>): string[] {
  const filePath = getDiffFilePath(file)
  const hunks: string[] = []

  for (const hunk of file.hunks) {
    let selectedRun: { change: ChangeData; index: number }[] = []

    hunk.changes.forEach((change, index) => {
      const selected = change.type !== 'normal' && selectedLineIds.has(getLineSelectionId(filePath, change))
      if (selected) {
        selectedRun.push({ change, index })
        return
      }

      if (selectedRun.length > 0) {
        hunks.push(...buildHunkPatch(hunk, selectedRun))
        selectedRun = []
      }
    })

    if (selectedRun.length > 0) {
      hunks.push(...buildHunkPatch(hunk, selectedRun))
    }
  }

  return hunks
}

export function buildSelectedPatch(diff: string, selectedLineIds: Set<string>): string {
  if (selectedLineIds.size === 0) return ''

  try {
    const patchFiles = parseDiff(diff)
      .map((file) => {
        const hunks = appendSelectedHunks(file, selectedLineIds)
        return hunks.length > 0 ? [...fileHeader(file), ...hunks].join('\n') : ''
      })
      .filter(Boolean)

    return patchFiles.length > 0 ? `${patchFiles.join('\n')}\n` : ''
  } catch {
    return ''
  }
}
