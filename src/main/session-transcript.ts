import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The spoken transcript of a local Claude, Codex, or Cursor session.
 *
 * Same split the Relay desktop reader and the Cloud session page use: a
 * human or agent text block is the conversation, and tool calls, tool
 * results, and thinking stay out. The file on disk is the source; ai-hist
 * only indexes the prompts.
 */
export interface SessionTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestampMs: number | null
}

/** Same shape Cloud accepts for a self-declared agent session id. No path separators. */
const DECLARED_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export interface AgentSessionBinding {
  sessionId: string
  sessionKind: string | null
}

/**
 * The session an agent says it is, using the same rules as Cloud: a
 * declared `session_id` on an injectable or fleet agent, or a Capy / Cursor
 * Cloud binding. A name is never treated as a session.
 */
export function agentSessionBinding(metadata: Record<string, unknown> | undefined): AgentSessionBinding | null {
  if (!metadata) return null
  const capy = metadata.capy_thread_id
  if (
    metadata.session_kind === 'capy' &&
    metadata.created_by === 'capy-binding' &&
    metadata.source === 'cloud-hosted-mcp' &&
    typeof capy === 'string' &&
    DECLARED_SESSION_ID.test(capy)
  ) {
    return { sessionId: capy, sessionKind: 'capy' }
  }
  const cursor = metadata.cursor_cloud_agent_id
  if (
    metadata.session_kind === 'cursor-cloud' &&
    metadata.created_by === 'cursor-cloud-binding' &&
    metadata.provider === 'cursor-cloud' &&
    typeof cursor === 'string' &&
    DECLARED_SESSION_ID.test(cursor)
  ) {
    return { sessionId: cursor, sessionKind: 'cursor-cloud' }
  }
  const kind = typeof metadata.session_kind === 'string' ? metadata.session_kind.trim().toLowerCase() : ''
  if (metadata.session_scope === 'agent' || (metadata.source === 'relay-desktop' && (kind === 'openclaw' || kind === 'hermes'))) {
    return null
  }
  const id = metadata.session_id
  if (typeof id !== 'string' || !DECLARED_SESSION_ID.test(id)) return null
  if (metadata.injectable !== 'true' && !isMetadataRecord(metadata.fleet)) return null
  return {
    sessionId: id,
    sessionKind: typeof metadata.session_kind === 'string' && metadata.session_kind.trim()
      ? metadata.session_kind.trim()
      : null
  }
}
const TOOL_EVENT_KINDS = new Set([
  'custom_tool_call', 'function_call', 'mcp_tool_call', 'tool_use', 'tool-call', 'tool_call',
  'custom_tool_call_output', 'mcp_tool_call_output', 'tool_result', 'tool-result', 'tool_call_output',
  'function_call_output'
])
const REASONING_TYPES = new Set(['thinking', 'reasoning', 'agent_reasoning'])
/** Harness blocks ahead of a person's prompt; the Relay core's `conductor::PREAMBLE_TAGS`. */
const PREAMBLE_TAGS = new Set([
  'system_instruction', 'recommended_plugins', 'environment_context', 'user_instructions', 'user_info', 'rules'
])
const RELAY_ENVELOPE = /^\[(via Agent Relay|Agent Relay native input) — [^\n]*\]\s*$/u
/** `exec {"input": …` — a tool name then its JSON arguments, even when History truncated the JSON. */
const TOOL_INVOCATION = /^[\w.:-]+\s+\{\s*"/u

/** The opening of a tool call's text, to recognize the same command repeated as an assistant event. */
function commandKey(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').slice(0, 120)
}

function withoutPreamble(text: string): string {
  let rest = text.trimStart()
  for (;;) {
    const open = /^<([a-z_]+)>/u.exec(rest)
    if (!open || !PREAMBLE_TAGS.has(open[1])) return rest
    const end = rest.indexOf(`</${open[1]}>`)
    if (end < 0) return rest
    rest = rest.slice(end + open[1].length + 3).trimStart()
  }
}

/**
 * The speaker of a RelayHistory event, or null for tool activity and
 * reasoning. Cloud's session page rule (`messageRole` / `isToolActivity`).
 */
function historyEventRole(event: Record<string, unknown>): 'user' | 'assistant' | null {
  const kind = stringOf(event.kind)
  const type = stringOf(event.type)
  const actorRole = stringOf(event.actorRole)
  const content = stringOf(event.content).trim()
  if (TOOL_EVENT_KINDS.has((type || kind).toLowerCase()) || actorRole === 'tool_result') return null
  if (actorRole === 'assistant' && /^[\w.:-]+\s+\{[\s\S]*\}$/u.test(content)) return null
  if (REASONING_TYPES.has(type.toLowerCase())) return null
  if (kind === 'prompt' || kind === 'user') return 'user'
  if (kind === 'assistant') return 'assistant'
  if (kind === 'history' || kind === 'session_event') {
    const role = actorRole || stringOf(event.actorName) || type
    if (role === 'user' || role === 'assistant') return role
  }
  return null
}

/**
 * Conversation turns from RelayHistory session events, oldest first. Relay
 * deliveries are left out: the chat already shows them as DMs, so only what
 * the person typed into the session and what the agent said remain.
 */
export function historyEventTurns(events: unknown[]): SessionTurn[] {
  const turns: SessionTurn[] = []
  const seen = new Set<string>()
  const rows = events.map(record).filter((event): event is Record<string, unknown> => event !== null)
  // Codex records each command twice: as a tool call, and as an assistant
  // event carrying the same `exec_command …` text. The tool call identifies it.
  const toolCommands = new Set<string>()
  for (const event of rows) {
    if (historyEventRole(event) === null) {
      const command = commandKey(stringOf(event.content))
      if (command) toolCommands.add(command)
    }
  }
  for (const event of rows) {
    const id = stringOf(event.eventId)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const role = historyEventRole(event)
    if (!role) continue
    let text = stringOf(event.content)
    if (role === 'assistant') {
      if (TOOL_INVOCATION.test(text.trim())) continue
      const command = commandKey(text)
      if (command && toolCommands.has(command)) continue
    }
    if (role === 'user') {
      if (RELAY_ENVELOPE.test(text.split('\n', 1)[0] ?? '')) continue
      text = withoutPreamble(text)
      if (text.startsWith('<system-reminder') || text.startsWith('<task-notification')) continue
    }
    if (!text.trim()) continue
    const timestampMs = Date.parse(stringOf(event.ts))
    turns.push({ id, role, text, timestampMs: Number.isFinite(timestampMs) ? timestampMs : null })
  }
  turns.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0))
  return collapseRepeats(turns)
}

const MAX_VISITS = 4000
const MAX_DEPTH = 5

export function conversationTurns(jsonl: string): SessionTurn[] {
  const turns: SessionTurn[] = []
  const lines = jsonl.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    turns.push(...turnsFromRecord(record, index))
  }
  return collapseRepeats(turns)
}

export function readSessionTranscript(sessionId: string, roots = defaultRoots()): SessionTurn[] {
  const file = findSessionFile(sessionId, roots)
  if (!file) return []
  try {
    return conversationTurns(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

function defaultRoots(): string[] {
  const home = homedir()
  return [
    join(home, '.claude', 'projects'),
    join(home, '.codex', 'sessions'),
    join(home, '.cursor', 'projects')
  ]
}

function findSessionFile(sessionId: string, roots: string[]): string | null {
  if (!DECLARED_SESSION_ID.test(sessionId)) return null
  const needle = sessionId.toLowerCase()
  let visits = 0
  const walk = (dir: string, depth: number): string | null => {
    if (depth > MAX_DEPTH || visits > MAX_VISITS) return null
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }
    for (const name of entries) {
      visits += 1
      if (visits > MAX_VISITS) return null
      const path = join(dir, name)
      let isDirectory = false
      try {
        isDirectory = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) {
        const found = walk(path, depth + 1)
        if (found) return found
        continue
      }
      const lower = name.toLowerCase()
      if (lower.endsWith('.jsonl') && (lower === `${needle}.jsonl` || lower.endsWith(`-${needle}.jsonl`))) {
        return path
      }
    }
    return null
  }
  for (const root of roots) {
    const found = walk(root, 0)
    if (found) return found
  }
  return null
}

function turnsFromRecord(record: unknown, index: number): SessionTurn[] {
  if (!record || typeof record !== 'object') return []
  const event = record as Record<string, unknown>
  const timestampMs = timestampOf(event)
  const claude = claudeTurns(event, index, timestampMs)
  if (claude.length > 0) return claude
  return codexTurns(event, index, timestampMs)
}

/** Claude Code names the speaker in `type`; Cursor agent transcripts name it in `role`. */
function claudeTurns(event: Record<string, unknown>, index: number, timestampMs: number | null): SessionTurn[] {
  const speaker = typeof event.type === 'string' && event.type ? event.type : event.role
  const role = speaker === 'assistant' ? 'assistant' : speaker === 'user' ? 'user' : null
  if (!role) return []
  const message = record(event.message)
  const content = message?.content ?? event.message
  return textBlocks(content)
    .map((text) => (role === 'user' ? cursorUserQuery(text) : text))
    .filter((text) => text.trim())
    .map((text, block) => ({
      id: `${index}:${block}`,
      role,
      text,
      timestampMs
    }))
}

/** Cursor wraps what the person typed in `<user_query>` beside injected context. */
function cursorUserQuery(text: string): string {
  const match = /<user_query>([\s\S]*?)<\/user_query>/u.exec(text)
  return match ? match[1].trim() : text
}

function codexTurns(event: Record<string, unknown>, index: number, timestampMs: number | null): SessionTurn[] {
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'item.completed' || type === 'item.updated') {
    const item = record(event.item)
    if (item?.type !== 'agent_message' || type !== 'item.completed') return []
    const text = stringOf(item.text)
    return text ? [{ id: stringOf(item.id) || `${index}:0`, role: 'assistant', text, timestampMs }] : []
  }
  const payload = record(event.payload) ?? event
  const payloadType = typeof payload.type === 'string' ? payload.type : ''
  if (payloadType === 'user_message' || payloadType === 'agent_message') {
    const text = stringOf(payload.message) || stringOf(payload.text)
    if (!text) return []
    return [{
      id: `${index}:0`,
      role: payloadType === 'user_message' ? 'user' : 'assistant',
      text,
      timestampMs
    }]
  }
  if (payloadType !== 'message') return []
  const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
  if (!role) return []
  return textBlocks(payload.content).map((text, block) => ({
    id: `${index}:${block}`,
    role,
    text,
    timestampMs
  }))
}

/** Text blocks only. Tool calls, tool results, and thinking are not conversation. */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return content.trim() ? [content] : []
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    const entry = record(block)
    if (!entry) continue
    const type = typeof entry.type === 'string' ? entry.type : 'text'
    if (type !== 'text' && type !== 'input_text' && type !== 'output_text') continue
    const text = stringOf(entry.text)
    if (text) texts.push(text)
  }
  return texts
}

function collapseRepeats(turns: SessionTurn[]): SessionTurn[] {
  const kept: SessionTurn[] = []
  for (const turn of turns) {
    const previous = kept[kept.length - 1]
    if (previous && previous.role === turn.role && previous.text === turn.text) continue
    kept.push(turn)
  }
  return kept
}

function timestampOf(event: Record<string, unknown>): number | null {
  const raw = event.timestamp ?? event.timestamp_ms ?? event.timestampMs
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * An exact tool word anywhere wins over a Grok Bot inbox prefix: an agent a
 * Grok bot spawned is named after it (`emgrok-agent-access-codex`) but runs
 * in Codex. The `…grok` suffix only names Grok Bot's own inboxes, which are
 * cloud registrations, so desktop registrations skip it.
 */
function cliInName(value: string, allowGrokSuffix = true): string {
  const words = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const next = words[index + 1]
    if (word === 'claudecode' || word === 'claude') return 'claude'
    if (word === 'opencode' || (word === 'open' && next === 'code')) return 'opencode'
    if (word === 'xai') return 'grok'
    if (['codex', 'grok', 'grokbot', 'cursor', 'gemini', 'copilot', 'openai', 'muse'].includes(word)) {
      return word === 'grokbot' ? 'grok' : word
    }
  }
  if (allowGrokSuffix && words.some((word) => word.length > 4 && word.endsWith('grok'))) return 'grok'
  return ''
}

/**
 * The tool an agent runs in, read like the Relay iOS app: structured
 * metadata first (`session_kind`, `cli`, `tool`, `harness`, `provider`),
 * then the name, then a persona that says "a codex agent".
 */
export function agentCli(name: string, metadata: Record<string, unknown> | undefined, persona?: string | null): string | null {
  const hints = ['session_kind', 'cli', 'tool', 'harness', 'provider'].map((key) => stringOf(metadata?.[key]))
  for (const hint of hints) {
    const cli = cliInName(hint)
    if (cli) return cli
  }
  const desktop = stringOf(metadata?.source) === 'relay-desktop'
  const named = cliInName(name, !desktop)
  if (named) return named
  const description = (persona || '').toLowerCase()
  for (const [phrase, cli] of [
    ['claude code', 'claude'], ['open code', 'opencode'], ['codex', 'codex'], ['claude', 'claude'],
    ['grok', 'grok'], ['cursor', 'cursor'], ['gemini', 'gemini'], ['openai', 'openai'], ['muse', 'muse']
  ] as const) {
    if (description.includes(`a ${phrase} agent`) || description.includes(`a ${phrase} worker`)) return cli
  }
  return null
}

/** What the agent is working on: its published objective or the provider's session title. */
/**
 * What an agent is working on: its objective, what its session says it's
 * doing, a description, then a session title. Titles without a space are
 * generated slugs (`khaliqgant-0e`) and say nothing.
 */
/** Long enough for a full task brief; the chat header shows all of it. */
export const MAX_SUMMARY_LENGTH = 2000

export function agentSummary(metadata: Record<string, unknown> | undefined): string | null {
  // Desktop publishes the generated session slug (`infra-7d`) as both the title and `doing`.
  const sentence = (text: string): string => (/\s/.test(text) ? text : '')
  const candidates = [
    stringOf(metadata?.objective),
    sentence(stringOf(record(metadata?.activity)?.doing)),
    stringOf(metadata?.description),
    stringOf(record(metadata?.card)?.description),
    sentence(stringOf(metadata?.session_title))
  ]
  const text = candidates.find(Boolean)
  return text ? text.slice(0, MAX_SUMMARY_LENGTH) : null
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isMetadataRecord(value) ? value : null
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
