import type React from 'react'

export type ChatFormatAction =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'link'
  | 'numbered-list'
  | 'bulleted-list'
  | 'code'

export interface ChatFormatResult {
  text: string
  selectionStart: number
  selectionEnd: number
}

interface ChatFormatOptions {
  linkUrl?: string
}

const FORMAT_MARKERS: Record<Exclude<ChatFormatAction, 'link' | 'numbered-list' | 'bulleted-list'>, {
  open: string
  close: string
  placeholder: string
}> = {
  bold: { open: '*', close: '*', placeholder: 'bold text' },
  italic: { open: '_', close: '_', placeholder: 'italic text' },
  underline: { open: '__', close: '__', placeholder: 'underlined text' },
  strikethrough: { open: '~', close: '~', placeholder: 'strikethrough text' },
  code: { open: '`', close: '`', placeholder: 'code' }
}

function clampSelection(value: string, selectionStart: number, selectionEnd: number): [number, number] {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(0, Math.min(selectionEnd, value.length))
  return start <= end ? [start, end] : [end, start]
}

export function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|mailto:)[^\s<>]+$/i.test(value.trim())
}

function normalizeLinkUrl(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (looksLikeUrl(trimmed)) return trimmed

  if (/^[^\s<>]+\.[^\s<>]+$/.test(trimmed)) {
    return `https://${trimmed}`
  }

  return null
}

function applyInlineFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: Exclude<ChatFormatAction, 'link' | 'numbered-list' | 'bulleted-list'>
): ChatFormatResult {
  const [start, end] = clampSelection(value, selectionStart, selectionEnd)
  const { open, close, placeholder } = FORMAT_MARKERS[action]
  const selected = value.slice(start, end)

  if (
    selected.length > open.length + close.length &&
    selected.startsWith(open) &&
    selected.endsWith(close)
  ) {
    const unwrapped = selected.slice(open.length, selected.length - close.length)
    return {
      text: `${value.slice(0, start)}${unwrapped}${value.slice(end)}`,
      selectionStart: start,
      selectionEnd: start + unwrapped.length
    }
  }

  if (
    start >= open.length &&
    value.slice(start - open.length, start) === open &&
    value.slice(end, end + close.length) === close
  ) {
    return {
      text: `${value.slice(0, start - open.length)}${selected}${value.slice(end + close.length)}`,
      selectionStart: start - open.length,
      selectionEnd: end - open.length
    }
  }

  const content = selected || placeholder
  const nextText = `${value.slice(0, start)}${open}${content}${close}${value.slice(end)}`
  const nextSelectionStart = start + open.length

  return {
    text: nextText,
    selectionStart: nextSelectionStart,
    selectionEnd: nextSelectionStart + content.length
  }
}

function getLineRange(value: string, selectionStart: number, selectionEnd: number): [number, number] {
  const [start, end] = clampSelection(value, selectionStart, selectionEnd)
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const lineEndIndex = value.indexOf('\n', end)
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex

  return [lineStart, lineEnd]
}

function applyListFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  ordered: boolean
): ChatFormatResult {
  const [lineStart, lineEnd] = getLineRange(value, selectionStart, selectionEnd)
  const block = value.slice(lineStart, lineEnd)
  const lines = block.length > 0 ? block.split('\n') : ['']
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
  const prefixPattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/
  const shouldRemove = nonEmptyLines.length > 0 && nonEmptyLines.every((line) => prefixPattern.test(line))
  const nextLines = lines.map((line, index) => {
    if (!line.trim()) return ordered ? `${index + 1}. ` : '- '
    if (shouldRemove) return line.replace(prefixPattern, '')
    return ordered
      ? line.replace(/^\s*/, `${index + 1}. `)
      : line.replace(/^\s*/, '- ')
  })
  const nextBlock = nextLines.join('\n')

  return {
    text: `${value.slice(0, lineStart)}${nextBlock}${value.slice(lineEnd)}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + nextBlock.length
  }
}

function applyLinkFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  linkUrl: string | undefined
): ChatFormatResult {
  const [start, end] = clampSelection(value, selectionStart, selectionEnd)
  const selected = value.slice(start, end)
  const url = normalizeLinkUrl(linkUrl || (looksLikeUrl(selected) ? selected : undefined))

  if (!url) {
    return { text: value, selectionStart: start, selectionEnd: end }
  }

  const nextLink = selected && !looksLikeUrl(selected)
    ? `<${url}|${selected}>`
    : `<${url}>`
  const linkTextStart = selected && !looksLikeUrl(selected)
    ? start + url.length + 2
    : start + 1
  const linkTextEnd = selected && !looksLikeUrl(selected)
    ? linkTextStart + selected.length
    : linkTextStart + url.length

  return {
    text: `${value.slice(0, start)}${nextLink}${value.slice(end)}`,
    selectionStart: linkTextStart,
    selectionEnd: linkTextEnd
  }
}

export function applyChatFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: ChatFormatAction,
  options: ChatFormatOptions = {}
): ChatFormatResult {
  if (action === 'numbered-list') {
    return applyListFormat(value, selectionStart, selectionEnd, true)
  }
  if (action === 'bulleted-list') {
    return applyListFormat(value, selectionStart, selectionEnd, false)
  }
  if (action === 'link') {
    return applyLinkFormat(value, selectionStart, selectionEnd, options.linkUrl)
  }

  return applyInlineFormat(value, selectionStart, selectionEnd, action)
}

function sanitizeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return value
    }
  } catch {
    return null
  }

  return null
}

interface SlackLinkMatch {
  href: string
  label: string
  end: number
}

function readSlackLink(value: string, start: number): SlackLinkMatch | null {
  const end = value.indexOf('>', start + 1)
  if (end === -1) return null

  const body = value.slice(start + 1, end)
  if (!body || body.includes('\n')) return null

  const separatorIndex = body.indexOf('|')
  const href = separatorIndex === -1 ? body : body.slice(0, separatorIndex)
  const label = separatorIndex === -1 ? body : body.slice(separatorIndex + 1)
  const safeHref = sanitizeUrl(href)

  if (!safeHref || !label) return null

  return {
    href: safeHref,
    label,
    end: end + 1
  }
}

function readAutoLink(value: string, start: number): SlackLinkMatch | null {
  const match = value.slice(start).match(/^(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)/i)
  if (!match) return null

  let href = match[0]
  const trailingPunctuation = href.match(/[),.;:!?]+$/)?.[0] || ''
  if (trailingPunctuation) {
    href = href.slice(0, -trailingPunctuation.length)
  }

  const safeHref = sanitizeUrl(href)
  if (!safeHref) return null

  return {
    href: safeHref,
    label: href,
    end: start + href.length
  }
}

function getNextTextBoundary(value: string, start: number): number {
  const candidates = ['<', '`', '__', '*', '_', '~']
    .map((token) => value.indexOf(token, start))
    .filter((index) => index !== -1)
  const urlMatch = value.slice(start).match(/https?:\/\/|mailto:/i)
  if (urlMatch?.index !== undefined) {
    candidates.push(start + urlMatch.index)
  }

  return candidates.length > 0 ? Math.min(...candidates) : value.length
}

function renderInline(value: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let index = 0

  while (index < value.length) {
    const slackLink = value[index] === '<' ? readSlackLink(value, index) : null
    if (slackLink) {
      nodes.push(
        <a
          key={`${keyPrefix}-link-${index}`}
          href={slackLink.href}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--pear-accent-bright)] underline decoration-[var(--pear-accent-dim)] underline-offset-2 hover:text-[var(--pear-accent)]"
        >
          {renderInline(slackLink.label, `${keyPrefix}-link-${index}`)}
        </a>
      )
      index = slackLink.end
      continue
    }

    const autoLink = readAutoLink(value, index)
    if (autoLink) {
      nodes.push(
        <a
          key={`${keyPrefix}-autolink-${index}`}
          href={autoLink.href}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--pear-accent-bright)] underline decoration-[var(--pear-accent-dim)] underline-offset-2 hover:text-[var(--pear-accent)]"
        >
          {autoLink.label}
        </a>
      )
      index = autoLink.end
      continue
    }

    if (value[index] === '`') {
      const end = value.indexOf('`', index + 1)
      if (end > index + 1) {
        nodes.push(
          <code
            key={`${keyPrefix}-code-${index}`}
            className="rounded border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-overlay)] px-1 py-0.5 font-mono text-[0.92em] text-[var(--pear-text)]"
          >
            {value.slice(index + 1, end)}
          </code>
        )
        index = end + 1
        continue
      }
    }

    if (value.startsWith('__', index)) {
      const end = value.indexOf('__', index + 2)
      if (end > index + 2) {
        nodes.push(
          <u key={`${keyPrefix}-underline-${index}`} className="underline-offset-2">
            {renderInline(value.slice(index + 2, end), `${keyPrefix}-underline-${index}`)}
          </u>
        )
        index = end + 2
        continue
      }
    }

    if (value[index] === '*') {
      const end = value.indexOf('*', index + 1)
      if (end > index + 1) {
        nodes.push(
          <strong key={`${keyPrefix}-bold-${index}`} className="font-semibold text-[var(--pear-text)]">
            {renderInline(value.slice(index + 1, end), `${keyPrefix}-bold-${index}`)}
          </strong>
        )
        index = end + 1
        continue
      }
    }

    if (value[index] === '_') {
      const end = value.indexOf('_', index + 1)
      if (end > index + 1) {
        nodes.push(
          <em key={`${keyPrefix}-italic-${index}`}>
            {renderInline(value.slice(index + 1, end), `${keyPrefix}-italic-${index}`)}
          </em>
        )
        index = end + 1
        continue
      }
    }

    if (value[index] === '~') {
      const end = value.indexOf('~', index + 1)
      if (end > index + 1) {
        nodes.push(
          <s key={`${keyPrefix}-strike-${index}`}>
            {renderInline(value.slice(index + 1, end), `${keyPrefix}-strike-${index}`)}
          </s>
        )
        index = end + 1
        continue
      }
    }

    const nextBoundary = getNextTextBoundary(value, index + 1)
    nodes.push(value.slice(index, nextBoundary))
    index = nextBoundary
  }

  return nodes
}

function renderTextBlock(lines: string[], blockIndex: number): React.ReactNode {
  return (
    <p key={`text-${blockIndex}`}>
      {lines.map((line, lineIndex) => (
        <span key={`text-${blockIndex}-${lineIndex}`}>
          {renderInline(line, `text-${blockIndex}-${lineIndex}`)}
          {lineIndex < lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  )
}

export function renderChatMessageBody(body: string): React.ReactNode {
  const lines = body.split('\n')
  const blocks: React.ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      blocks.push(<div key={`blank-${index}`} className="h-2" aria-hidden="true" />)
      index += 1
      continue
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/)
    if (bulletMatch) {
      const items: string[] = []
      while (index < lines.length) {
        const match = lines[index].match(/^\s*[-*]\s+(.+)$/)
        if (!match) break
        items.push(match[1])
        index += 1
      }
      blocks.push(
        <ul key={`ul-${index}`} className="list-disc space-y-0.5 pl-5">
          {items.map((item, itemIndex) => (
            <li key={`ul-${index}-${itemIndex}`}>
              {renderInline(item, `ul-${index}-${itemIndex}`)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (orderedMatch) {
      const items: string[] = []
      while (index < lines.length) {
        const match = lines[index].match(/^\s*\d+[.)]\s+(.+)$/)
        if (!match) break
        items.push(match[1])
        index += 1
      }
      blocks.push(
        <ol key={`ol-${index}`} className="list-decimal space-y-0.5 pl-5">
          {items.map((item, itemIndex) => (
            <li key={`ol-${index}-${itemIndex}`}>
              {renderInline(item, `ol-${index}-${itemIndex}`)}
            </li>
          ))}
        </ol>
      )
      continue
    }

    const textLines: string[] = []
    while (index < lines.length) {
      const nextLine = lines[index]
      if (!nextLine.trim() || /^\s*[-*]\s+.+$/.test(nextLine) || /^\s*\d+[.)]\s+.+$/.test(nextLine)) {
        break
      }
      textLines.push(nextLine)
      index += 1
    }
    blocks.push(renderTextBlock(textLines, index))
  }

  return blocks
}
