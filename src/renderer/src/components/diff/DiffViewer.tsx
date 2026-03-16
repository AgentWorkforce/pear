import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  parseDiff,
  Diff,
  Hunk,
  type HunkData,
  type FileData,
  type HunkTokens,
  type TokenNode
} from 'react-diff-view'
import { highlightCode } from '@/lib/syntax-highlighter'
import { useUIStore } from '@/stores/ui-store'

interface Props {
  diff: string
}

interface SyntaxTokenNode extends TokenNode {
  type: 'syntax'
  value: string
  style?: React.CSSProperties
}

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

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type === 'insert' || change.type === 'delete' || change.type === 'normal') {
        const highlightedLine = await highlightCode(change.content, filePath, theme)
        const tokenNodes = toTokenNodes(highlightedLine[0] || [])

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
      }
    }
  }

  return { old, new: next }
}

export function DiffViewer({ diff }: Props): React.ReactNode {
  const files = useMemo(() => {
    try {
      return parseDiff(diff)
    } catch {
      return []
    }
  }, [diff])
  const theme = useUIStore((s) => s.theme)
  const [highlightedFiles, setHighlightedFiles] = useState<(HunkTokens | null)[]>([])

  useEffect(() => {
    if (files.length === 0) {
      setHighlightedFiles([])
      return
    }

    let ignore = false

    Promise.all(files.map((file) => buildHighlightedTokens(file, theme)))
      .then((tokens) => {
        if (ignore) return
        setHighlightedFiles(tokens)
      })
      .catch(() => {
        if (ignore) return
        setHighlightedFiles(files.map(() => null))
      })

    return () => {
      ignore = true
    }
  }, [files, theme])

  if (files.length === 0) {
    return (
      <div className="p-0">
        <pre className="whitespace-pre-wrap text-xs text-[var(--pear-text-dim)]">
          {diff || 'No diff available'}
        </pre>
      </div>
    )
  }

  return (
    <div className="diff-view">
      {files.map((file: FileData, index) => (
        <div key={file.oldPath + file.newPath} className="mb-2">
          <div className="sticky top-0 z-10 border-b border-[var(--pear-bg-surface)] bg-[var(--pear-bg)] px-3 py-1.5 text-xs font-medium text-[var(--pear-accent)]">
            {file.newPath === '/dev/null' ? file.oldPath : file.newPath}
          </div>
          <Diff
            viewType="unified"
            diffType={file.type}
            hunks={file.hunks}
            tokens={highlightedFiles[index]}
            renderToken={(token, defaultRender, tokenIndex) => {
              if (isSyntaxToken(token)) {
                return (
                  <span key={tokenIndex} style={token.style}>
                    {token.value}
                  </span>
                )
              }

              return defaultRender(token, tokenIndex)
            }}
          >
            {(hunks: HunkData[]) =>
              hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)
            }
          </Diff>
        </div>
      ))}
    </div>
  )
}
