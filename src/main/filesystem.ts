import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'

export interface ExplorerEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

export interface FilePreview {
  kind: 'text' | 'binary' | 'too-large' | 'missing'
  content: string
  size: number
}

const MAX_PREVIEW_BYTES = 256 * 1024

export async function listDirectory(dirPath: string): Promise<ExplorerEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })

  return entries
    .map((entry) => ({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      type: entry.isDirectory() ? 'directory' : 'file'
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export async function readTextPreview(filePath: string): Promise<FilePreview> {
  try {
    const info = await stat(filePath)
    if (info.size > MAX_PREVIEW_BYTES) {
      return {
        kind: 'too-large',
        content: '',
        size: info.size
      }
    }

    const buffer = await readFile(filePath)
    if (buffer.includes(0)) {
      return {
        kind: 'binary',
        content: '',
        size: info.size
      }
    }

    return {
      kind: 'text',
      content: buffer.toString('utf8'),
      size: info.size
    }
  } catch (error) {
    return {
      kind: 'missing',
      content: error instanceof Error ? error.message : 'Unable to read file',
      size: 0
    }
  }
}
