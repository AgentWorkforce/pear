import type React from 'react'
import { bundledLanguages, bundledLanguagesAlias, codeToTokensBase } from 'shiki'
import type { Theme } from '@/stores/ui-store'

export interface HighlightToken {
  content: string
  style?: React.CSSProperties
}

const languageSet = new Set<string>(Object.keys(bundledLanguages))
const languageAliasSet = new Set<string>(Object.keys(bundledLanguagesAlias))

const extensionLanguageMap: Record<string, string> = {
  cjs: 'javascript',
  css: 'css',
  cts: 'typescript',
  go: 'go',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash'
}

const filenameLanguageMap: Record<string, string> = {
  '.env': 'bash',
  '.gitignore': 'gitignore',
  'Dockerfile': 'dockerfile'
}

const themeMap: Record<Theme, string> = {
  dark: 'github-dark-default',
  light: 'github-light-default'
}

function normalizeLanguage(candidate: string | undefined): string {
  if (!candidate) return 'text'
  if (languageSet.has(candidate)) return candidate
  if (languageAliasSet.has(candidate)) return candidate
  return 'text'
}

function tokenStyle(color: string | undefined, fontStyle = 0): React.CSSProperties | undefined {
  const style: React.CSSProperties = {}

  if (color) style.color = color
  if (fontStyle & 1) style.fontStyle = 'italic'
  if (fontStyle & 2) style.fontWeight = 600

  const decorations: string[] = []
  if (fontStyle & 4) decorations.push('underline')
  if (fontStyle & 8) decorations.push('line-through')
  if (decorations.length > 0) style.textDecoration = decorations.join(' ')

  return Object.keys(style).length > 0 ? style : undefined
}

export function detectLanguage(filePath?: string | null): string {
  if (!filePath) return 'text'

  const parts = filePath.split(/[/\\]/)
  const fileName = parts[parts.length - 1] || ''
  const exactMatch = filenameLanguageMap[fileName]
  if (exactMatch) return normalizeLanguage(exactMatch)

  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : ''
  if (extension && extensionLanguageMap[extension]) {
    return normalizeLanguage(extensionLanguageMap[extension])
  }

  return normalizeLanguage(extension)
}

export async function highlightCode(
  code: string,
  filePath: string | null | undefined,
  theme: Theme
): Promise<HighlightToken[][]> {
  const lang = detectLanguage(filePath)
  const lines = await codeToTokensBase(code, {
    lang,
    theme: themeMap[theme]
  })

  return lines.map((line) =>
    line.map((token) => ({
      content: token.content,
      style: tokenStyle(token.color, token.fontStyle)
    }))
  )
}
