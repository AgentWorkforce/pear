import { app, ipcMain, dialog, BrowserWindow, Notification, shell } from 'electron'
import { toErrorMessage } from './errors'
import { createHash } from 'crypto'
import { basename, join, resolve } from 'path'
import type { SpawnPtyInput, SendMessageInput } from '@agent-relay/harness-driver'
import {
  loadStore,
  addProject,
  removeProject,
  setActiveProject,
  updateProject,
  addProjectChannel,
  removeProjectChannel,
  setProjectChannelPeople,
  addProjectRoot,
  removeProjectRoot,
  findProjectsWithPath,
  addProjectIntegration,
  removeProjectIntegration
} from './store'
import { brokerManager, isCommandAvailableWithAugmentedPath, BrokerPlacementError } from './broker'
import * as git from './git'
import * as filesystem from './filesystem'
import * as auth from './auth'
import { cloudAgentManager } from './cloud-agent'
import { proactiveAgentManager } from './proactive-agent'
import { integrationsManager } from './integrations'
import { getIntegrationEventTelemetrySnapshot, integrationEventBridge } from './integration-event-bridge'
import { aiHistManager } from './ai-hist'
import {
  agentCli,
  agentSessionBinding,
  agentSummary,
  historyEventTurns,
  readSessionTranscript,
  type SessionTurn
} from './session-transcript'
import { listedRosterAgents, wireMetadata } from './agent-roster'
import { burnManager, type BurnAgentInput, type BurnProjectInput, type BurnSessionBreakdownInput, type BurnFingerprintInput } from './burn'
import { resetRelayWorkspaceManager } from './relay-workspace'
import { isDirectory } from './path-utils'
import { findProjectForPath, projectContainsPath } from './cli'
import { hostname } from 'os'
import { RelayCast, RelayError } from '@relaycast/sdk'
import { RelayChatClient, RelayChatPoller, RELAY_CHAT_POLL_INTERVAL_MS, toConversationId } from './relay-chat-client'
import { RelayChatLive } from './relay-chat-live'
import { SessionBriefCache, briefText } from './session-briefs'
import { DmInboxWatcher } from './dm-inbox-watcher'
import { normalizeRelaycastBaseUrl } from './relay-service-urls'
import type {
  BrokerReconcileMessagesInput,
  BrokerSpawnAgentResult,
  BrokerPlaceAgentInput,
  BrokerPlaceAgentOutcome,
  BrokerNodeSummary,
  ChatHistoryInput,
  ChatInvalidatedEvent,
  ChatMessageEvent,
  ChatOpenConversationEvent,
  ChatSendInput,
  ChatUploadInput,
  RelayChatConversation,
  RelayChatMessage
} from '../shared/types/ipc'
import type { ProactiveAgentDraft } from './proactive-agent.types'

function toBrokerSpawnAgentResult(result: BrokerSpawnAgentResult): BrokerSpawnAgentResult {
  return {
    name: result.name,
    runtime: result.runtime,
    ...(result.cli ? { cli: result.cli } : {})
  }
}

function getProjectIdForPath(targetPath: string): string | null {
  const resolved = resolve(targetPath)
  const { projects } = loadStore()
  const project = findProjectForPath(projects, resolved)
  return project?.id || null
}

function assertPathWithinProjects(targetPath: string): void {
  const resolved = resolve(targetPath)
  if (!getProjectIdForPath(resolved)) {
    throw new Error(`Path is outside all known project roots: ${resolved}`)
  }
}

const gitStatusWarnings = new Set<string>()


function warnGitStatusOnce(path: string, error: unknown): void {
  const message = toErrorMessage(error)
  const key = `${path}:${message}`
  if (gitStatusWarnings.has(key)) return
  gitStatusWarnings.add(key)
  console.warn(`[git] Failed to read status for ${path}: ${message}`)
}


// --- Chat companion (Relaycast) ---
// Credentials reuse the Cloud sign-in + safeStorage pattern from `auth.ts`
// (resolveCloudAuth / getAccountWorkspaceId); no new secret storage. The
// workspace key is resolved through Cloud
// `GET /api/v1/workspaces/{id}/resolve` (its `relaycastApiKey`), and the
// agent token is minted via register-or-rotate and held in memory — like the
// placement `pear-requester-*` identity, restarts re-register rather than
// persisting a secret.
let chatClient: RelayChatClient | null = null
let chatClientPromise: Promise<RelayChatClient> | null = null
let chatWorkspaceKey: string | null = null
let chatAgentToken: string | null = null
let chatAgentName: string | null = null
let chatPoller: RelayChatPoller | null = null
let chatLive: RelayChatLive | null = null

/** Per-machine companion identity so two hosts never rotate each other's token. */
function chatAgentIdentityName(): string {
  let host = 'local'
  try {
    host = hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'local'
  } catch {
    // ignore — fall back to 'local'
  }
  return `pear-chat-${host}`.slice(0, 64)
}

function readResolveRelaycastApiKey(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = (payload as Record<string, unknown>).relaycastApiKey
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function resolveChatWorkspaceKey(): Promise<string> {
  if (chatWorkspaceKey) return chatWorkspaceKey
  const cloudAuth = await auth.resolveCloudAuth()
  if (!cloudAuth) throw new Error('cloud-auth-required')
  const workspaceId = await auth.getAccountWorkspaceId(auth.accountWorkspaceReadyRetryOptions())
  const res = await fetch(
    `${cloudAuth.apiUrl.replace(/\/+$/u, '')}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve`,
    { headers: { Authorization: `Bearer ${cloudAuth.accessToken}`, Accept: 'application/json' } }
  ).catch((error: unknown) => {
    throw new Error(`Workspace resolve failed: ${toErrorMessage(error)}`)
  })
  if (res.status === 401 || res.status === 403) throw new Error('cloud-auth-required:workspace-resolve')
  if (!res.ok) throw new Error(`Workspace resolve failed: ${res.status}`)
  const payload = await res.json().catch(() => null) as unknown
  const key = readResolveRelaycastApiKey(payload)
  if (!key) throw new Error('account-workspace-required:missing-relaycast-key')
  chatWorkspaceKey = key
  return key
}

async function rotateChatWorkspaceKey(): Promise<string | null> {
  chatWorkspaceKey = null
  relayCast = null
  relayCastKey = null
  try {
    return await resolveChatWorkspaceKey()
  } catch {
    return null
  }
}

let relayCast: RelayCast | null = null
let relayCastKey: string | null = null

/** Workspace-scoped Relaycast SDK client. Roster and registration go through this, not a local PTY. */
async function getRelayCast(): Promise<RelayCast> {
  const key = await resolveChatWorkspaceKey()
  const baseUrl = normalizeRelaycastBaseUrl(process.env.RELAYCAST_BASE_URL || process.env.RELAY_BASE_URL)
  if (relayCast && relayCastKey === key) return relayCast
  relayCast = new RelayCast({
    apiKey: key,
    baseUrl,
    originActor: 'pear'
  })
  relayCastKey = key
  return relayCast
}

function agentNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/^relay:/, '')
}

function rosterAgentConversations(agents: Array<{
  name?: string
  type?: string
  status?: string
  lastSeen?: string
  persona?: string | null
  metadata?: Record<string, unknown>
}>): RelayChatConversation[] {
  const rows: RelayChatConversation[] = []
  for (const agent of agents) {
    const name = agent.name?.trim()
    if (!name) continue
    const sessionId = agentSessionBinding(agent.metadata)?.sessionId
    const cli = agentCli(name, agent.metadata, agent.persona)
    const objective = typeof agent.metadata?.objective === 'string' ? agent.metadata.objective.trim() : ''
    if (objective) agentsWithObjective.add(`relay:${name}`)
    else agentsWithObjective.delete(`relay:${name}`)
    const summary = agentSummary(agent.metadata)
    rows.push({
      kind: 'agent',
      id: `relay:${name}`,
      name,
      participants: [name],
      ...(agent.status ? { status: agent.status } : {}),
      ...(agent.lastSeen ? { lastMessageAt: agent.lastSeen } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(cli ? { cli } : {}),
      ...(summary ? { summary } : {}),
      ...(agent.type?.toLowerCase() === 'human' ? { human: true } : {})
    })
  }
  return rows
}

const sessionPromptSummaries = new Map<string, string | null>()
/** Roster rows whose agent published an objective; that outranks any generated brief. */
const agentsWithObjective = new Set<string>()

const sessionBriefs = new SessionBriefCache({
  fetchBrief: fetchSessionBrief,
  onUpdated: () => {
    console.info('[chat] new session briefs from History; refreshing the list')
    broadcastChatInvalidated('summaries')
  }
})

async function fetchSessionBrief(sessionId: string): Promise<string | null> {
  const cloudAuth = await auth.resolveCloudAuth()
  if (!cloudAuth) return null
  const workspaceId = await auth.getAccountWorkspaceId(auth.accountWorkspaceReadyRetryOptions())
  const res = await fetch(
    `${cloudAuth.apiUrl.replace(/\/+$/u, '')}/api/v1/workspaces/${encodeURIComponent(workspaceId)}` +
      `/reflex/sessions/${encodeURIComponent(sessionId)}/brief?admit=false`,
    { headers: { Authorization: `Bearer ${cloudAuth.accessToken}`, Accept: 'application/json' } }
  )
  if (!res.ok) {
    if (!briefStatusesLogged.has(res.status)) {
      briefStatusesLogged.add(res.status)
      console.info(`[chat] session briefs unavailable from Cloud (HTTP ${res.status}); summaries use the fallback`)
    }
    return null
  }
  return briefText(await res.json().catch(() => null))
}

const briefStatusesLogged = new Set<number>()

/**
 * Each agent's summary: its published objective, else History's session
 * brief, else its session title or description, else its first prompt.
 * Briefs load in the background and refresh the list when they arrive.
 */
async function withPromptSummaries(rows: RelayChatConversation[]): Promise<RelayChatConversation[]> {
  void sessionBriefs.refresh(rows.flatMap((row) => (row.sessionId && !agentsWithObjective.has(row.id) ? [row.sessionId] : [])))
  return Promise.all(rows.map(async (row) => {
    if (!row.sessionId || agentsWithObjective.has(row.id)) return row
    const brief = sessionBriefs.get(row.sessionId)
    if (brief) return { ...row, summary: brief }
    if (row.summary) return row
    if (!sessionPromptSummaries.has(row.sessionId)) {
      try {
        const entries = await aiHistManager.getSession(row.sessionId)
        const first = [...entries].sort((a, b) => a.timestampMs - b.timestampMs)[0]?.prompt?.trim()
        sessionPromptSummaries.set(row.sessionId, first ? first.slice(0, 200) : null)
      } catch {
        sessionPromptSummaries.set(row.sessionId, null)
      }
    }
    const summary = sessionPromptSummaries.get(row.sessionId)
    return summary ? { ...row, summary } : row
  }))
}

/**
 * A DM with a listed agent carries that agent's session, tool, and summary
 * into the thread. DM history outlives registrations, so a thread whose agent
 * is no longer reachable is dropped; only the roster says who can receive.
 */
function conversationsWithSessions(
  roster: RelayChatConversation[],
  threads: RelayChatConversation[]
): RelayChatConversation[] {
  const agents = new Map<string, RelayChatConversation>()
  for (const agent of roster) agents.set(agentNameKey(agent.name), agent)
  const tagged = threads.flatMap((thread): RelayChatConversation[] => {
    if (thread.kind === 'channel') return [thread]
    const names = [thread.name, ...(thread.participants || [])]
    for (const name of names) {
      const agent = agents.get(agentNameKey(name))
      if (!agent) continue
      return [{
        ...thread,
        ...(thread.sessionId || !agent.sessionId ? {} : { sessionId: agent.sessionId }),
        ...(thread.cli || !agent.cli ? {} : { cli: agent.cli }),
        ...(thread.summary || !agent.summary ? {} : { summary: agent.summary }),
        ...(thread.status || !agent.status ? {} : { status: agent.status })
      }]
    }
    return []
  })
  const threadIds = new Set(tagged.map((thread) => thread.id))
  return [...roster.filter((agent) => !threadIds.has(agent.id)), ...tagged]
}

/**
 * Registration is create-only. A name this machine already holds is a 409,
 * and `rotate-token` now requires the agent token we do not have. Reclaim
 * the companion with the workspace-key takeover route, which mints a new
 * `at_live_` token.
 */
async function reclaimCompanion(name: string, agentId: string): Promise<{ name: string; token: string }> {
  const key = await resolveChatWorkspaceKey()
  const baseUrl = normalizeRelaycastBaseUrl(process.env.RELAYCAST_BASE_URL || process.env.RELAY_BASE_URL)
  const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/v1/agents/${encodeURIComponent(name)}/takeover`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expected_agent_id: agentId,
      actor: 'pear',
      reason: 'Pear desktop reclaiming its companion identity to send',
      session_ref: `pear:${name}`,
      node_id: 'pear-desktop'
    })
  })
  const payload = await response.json().catch(() => null) as { data?: { name?: string; token?: string }; error?: { message?: string } } | null
  const token = payload?.data?.token
  if (!response.ok || !token) {
    const message = payload?.error?.message || `Companion takeover failed: ${response.status}`
    throw new Error(message)
  }
  return { name: payload.data?.name || name, token }
}

async function claimCompanion(relay: RelayCast, name: string): Promise<{ name: string; token: string }> {
  try {
    const created = await relay.agents.register({ name, type: 'agent' })
    if (!created.token) throw new Error('Registration did not return an agent token')
    return { name: created.name || name, token: created.token }
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== 'name_conflict') throw error
    const existing = await relay.agents.get(name)
    return reclaimCompanion(existing.name || name, existing.id)
  }
}

/**
 * Your own relay identity in this workspace, from Cloud — the one the
 * dashboard and the Relay macOS / iOS apps send and read as, so agents that
 * message you reach Pear too. Null when Cloud won't issue it.
 */
async function personCredential(baseUrl: string): Promise<{ name: string; token: string } | null> {
  try {
    const cloudAuth = await auth.resolveCloudAuth()
    if (!cloudAuth) return null
    const workspaceId = await auth.getAccountWorkspaceId(auth.accountWorkspaceReadyRetryOptions())
    const res = await fetch(
      `${cloudAuth.apiUrl.replace(/\/+$/u, '')}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/messaging/identity/credential`,
      { method: 'POST', headers: { Authorization: `Bearer ${cloudAuth.accessToken}`, Accept: 'application/json' } }
    )
    if (!res.ok) {
      console.warn(`[chat] Cloud messaging identity returned ${res.status}; using this machine's companion`)
      return null
    }
    const body = await res.json().catch(() => null) as { identity?: Record<string, unknown> } | null
    const name = typeof body?.identity?.name === 'string' ? body.identity.name.trim() : ''
    const token = typeof body?.identity?.token === 'string' ? body.identity.token.trim() : ''
    const relaycastUrl = typeof body?.identity?.relaycastUrl === 'string' ? body.identity.relaycastUrl : ''
    if (!name || !token.startsWith('at_live_')) {
      console.warn('[chat] Cloud returned no usable messaging identity; using this machine\'s companion')
      return null
    }
    if (relaycastUrl && normalizeRelaycastBaseUrl(relaycastUrl) !== baseUrl) {
      console.warn(`[chat] Cloud messaging identity is on ${relaycastUrl}, not ${baseUrl}; using this machine's companion`)
      return null
    }
    return { name, token }
  } catch (error) {
    console.warn('[chat] Cloud messaging identity failed; using this machine\'s companion:', toErrorMessage(error))
    return null
  }
}

let chatIdentityIsPerson = false
let agentTokenRefresh: Promise<string | null> | null = null

/** A 401 on the person token: ask Cloud again (coalesced) and restart the live stream on a new token. */
function refreshChatAgentToken(): Promise<string | null> {
  if (!chatIdentityIsPerson) return Promise.resolve(null)
  if (!agentTokenRefresh) {
    const baseUrl = normalizeRelaycastBaseUrl(process.env.RELAYCAST_BASE_URL || process.env.RELAY_BASE_URL)
    agentTokenRefresh = personCredential(baseUrl)
      .then((identity) => {
        if (!identity || identity.name !== chatAgentName) return null
        if (identity.token !== chatAgentToken) {
          chatAgentToken = identity.token
          console.info('[chat] messaging token re-issued by Cloud; reconnecting the live stream')
          chatLive?.stop()
          chatLive = null
          if (chatClient) ensureChatLive(chatClient)
        }
        return identity.token
      })
      .finally(() => {
        agentTokenRefresh = null
      })
  }
  return agentTokenRefresh
}

async function buildChatClient(): Promise<RelayChatClient> {
  await resolveChatWorkspaceKey()
  const baseUrl = normalizeRelaycastBaseUrl(process.env.RELAYCAST_BASE_URL || process.env.RELAY_BASE_URL)
  const client = new RelayChatClient({
    baseUrl,
    getWorkspaceKey: () => chatWorkspaceKey,
    getAgentToken: () => chatAgentToken,
    setWorkspaceKey: (key: string) => {
      chatWorkspaceKey = key
    },
    rotateWorkspaceKey: rotateChatWorkspaceKey,
    refreshAgentToken: refreshChatAgentToken,
    selfName: () => chatAgentName
  })
  const person = await personCredential(baseUrl)
  const identity = person ?? await claimCompanion(await getRelayCast(), chatAgentIdentityName())
  chatIdentityIsPerson = !!person
  chatAgentName = identity.name
  chatAgentToken = identity.token
  console.info(`[chat] messaging as ${identity.name}${person ? ' (your relay identity)' : ' (this machine\'s companion)'}`)
  return client
}

async function getChatClient(): Promise<RelayChatClient> {
  if (chatClient) return chatClient
  if (!chatClientPromise) {
    chatClientPromise = buildChatClient().then((client) => {
      chatClient = client
      ensureChatLive(client)
      return client
    }).catch((error: unknown) => {
      chatClientPromise = null
      throw error
    })
  }
  return chatClientPromise
}

/** Newest events first, a few pages back: enough for the recent conversation. */
const CLOUD_SESSION_EVENT_PAGE = 200
const CLOUD_SESSION_EVENT_PAGES = 3
const cloudSessionTurnsInFlight = new Map<string, Promise<SessionTurn[]>>()
/** Reopening a chat within this window reuses the last read instead of paging History again. */
const CLOUD_SESSION_CACHE_MS = 60_000
const cloudSessionTurnsCache = new Map<string, { turns: SessionTurn[]; at: number }>()

/**
 * A session recorded on another machine, read from RelayHistory through
 * Cloud's session events route (the one the Relay iOS app uses). Empty when
 * the session was never shared with History.
 */
function cloudSessionTurns(sessionId: string): Promise<SessionTurn[]> {
  const cached = cloudSessionTurnsCache.get(sessionId)
  if (cached && Date.now() - cached.at < CLOUD_SESSION_CACHE_MS) return Promise.resolve(cached.turns)
  const pending = cloudSessionTurnsInFlight.get(sessionId)
  if (pending) return pending
  const load = fetchCloudSessionTurns(sessionId)
    .then((turns) => {
      if (turns.length > 0) cloudSessionTurnsCache.set(sessionId, { turns, at: Date.now() })
      return turns
    })
    .finally(() => cloudSessionTurnsInFlight.delete(sessionId))
  cloudSessionTurnsInFlight.set(sessionId, load)
  return load
}

async function fetchCloudSessionTurns(sessionId: string): Promise<SessionTurn[]> {
  const started = Date.now()
  try {
    const cloudAuth = await auth.resolveCloudAuth()
    if (!cloudAuth) return []
    const workspaceId = await auth.getAccountWorkspaceId(auth.accountWorkspaceReadyRetryOptions())
    const base = `${cloudAuth.apiUrl.replace(/\/+$/u, '')}/api/v1/workspaces/${encodeURIComponent(workspaceId)}` +
      `/reflex/sessions/${encodeURIComponent(sessionId)}/events`
    const events: unknown[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < CLOUD_SESSION_EVENT_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(CLOUD_SESSION_EVENT_PAGE), order: 'desc' })
      if (cursor) query.set('cursor', cursor)
      const res = await fetch(`${base}?${query}`, {
        headers: { Authorization: `Bearer ${cloudAuth.accessToken}`, Accept: 'application/json' }
      })
      if (res.status === 404) {
        console.log(`[chat] session ${sessionId} is not shared with History`)
        break
      }
      if (!res.ok) {
        console.warn(`[chat] session ${sessionId} history returned ${res.status}`)
        break
      }
      const body = await res.json().catch(() => null) as { events?: unknown; nextCursor?: unknown } | null
      if (!body || !Array.isArray(body.events)) break
      events.push(...body.events)
      cursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null
      if (!cursor || seenCursors.has(cursor)) break
      seenCursors.add(cursor)
    }
    const turns = historyEventTurns(events)
    console.log(`[chat] session ${sessionId}: ${turns.length} turns from History (${events.length} events) in ${Date.now() - started}ms`)
    return turns
  } catch (error) {
    console.warn(`[chat] session ${sessionId} history failed:`, toErrorMessage(error))
    return []
  }
}

/** Like the Relay iOS app: delivery usually follows within seconds, so check briefly after a send. */
const DELIVERY_CHECKS = 10
const DELIVERY_CHECK_INTERVAL_MS = 3_000
/** Sent messages still showing Sent, by id. One watch per message. */
const awaitingDelivery = new Map<string, { conversationId: string; message: RelayChatMessage; sentAt: number }>()

/** Flip a sent message to Delivered once; later reads of the same message are no-ops. */
function markDelivered(messageId: string, via: string): void {
  const pending = awaitingDelivery.get(messageId)
  if (!pending) return
  awaitingDelivery.delete(messageId)
  console.info(`[chat] ${messageId} delivered after ${((Date.now() - pending.sentAt) / 1000).toFixed(1)}s (${via})`)
  broadcastChatMessage(pending.conversationId, { ...pending.message, delivered: true })
}

/**
 * Re-push a sent message once a recipient has read it, so its label moves
 * from Sent to Delivered without reopening the thread. The live stream's
 * read receipt usually lands first; the readers poll covers a dropped socket.
 */
function watchDelivery(client: RelayChatClient, conversationId: string, message: RelayChatMessage): void {
  if (!message.hasServerID || awaitingDelivery.has(message.id)) return
  awaitingDelivery.set(message.id, { conversationId, message, sentAt: Date.now() })
  void (async () => {
    for (let check = 0; check < DELIVERY_CHECKS; check += 1) {
      await new Promise((resolve) => setTimeout(resolve, DELIVERY_CHECK_INTERVAL_MS))
      if (!awaitingDelivery.has(message.id)) return
      const { delivered } = await client.getMessageReaders(message.id, message.from).catch(() => ({ delivered: false }))
      if (delivered) {
        markDelivered(message.id, 'readers poll')
        return
      }
    }
    if (awaitingDelivery.delete(message.id)) {
      console.info(`[chat] ${message.id} not read within ${DELIVERY_CHECKS * DELIVERY_CHECK_INTERVAL_MS / 1000}s; the recipient may be busy`)
    }
  })()
}

const notifiedMessages = new Set<string>()
/** Electron drops a notification's click handler once the object is collected. */
const openNotifications = new Set<Notification>()
const NOTIFIED_LIMIT = 500
const NOTIFICATION_PREVIEW_CHARS = 180

/**
 * Like the Relay desktop app: a system notification for a message someone
 * sent you while Pear isn't in front. Clicking it opens that conversation.
 */
function notifyIncomingMessage(conversationId: string, message: RelayChatMessage): void {
  if (message.mine || !message.id || notifiedMessages.has(message.id)) return
  if (BrowserWindow.getAllWindows().some((win) => win.isFocused())) return
  if (!Notification.isSupported()) return
  notifiedMessages.add(message.id)
  if (notifiedMessages.size > NOTIFIED_LIMIT) notifiedMessages.delete(notifiedMessages.values().next().value as string)
  const text = message.text.replace(/\s+/gu, ' ').trim()
  const notification = new Notification({
    title: message.channelName ? `${message.from} in #${message.channelName}` : message.from,
    body: text.length > NOTIFICATION_PREVIEW_CHARS
      ? `${text.slice(0, NOTIFICATION_PREVIEW_CHARS - 1)}…`
      : text || 'New message'
  })
  notification.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    const event: ChatOpenConversationEvent = { conversationId, from: message.from }
    win.webContents.send('chat:open-conversation', event)
  })
  openNotifications.add(notification)
  const release = (): void => {
    openNotifications.delete(notification)
  }
  notification.on('close', release)
  notification.on('click', release)
  notification.on('failed', (_event, error) => {
    release()
    console.warn('[chat] notification failed:', error)
  })
  notification.show()
}

const pushedMessages = new Set<string>()
const PUSHED_LIMIT = 2_000
let inboxDuplicates = 0

/**
 * One path for a received message, whichever source saw it first — the live
 * stream or the inbox check. Each message id is pushed and notified once.
 */
function deliverIncoming(conversationId: string, message: RelayChatMessage, via: 'live stream' | 'inbox check'): void {
  if (message.id && pushedMessages.has(message.id)) {
    inboxDuplicates += 1
    if (inboxDuplicates % 50 === 1) console.info(`[chat] already delivered ${message.id} (${inboxDuplicates} repeats)`)
    return
  }
  if (message.id) {
    pushedMessages.add(message.id)
    if (pushedMessages.size > PUSHED_LIMIT) pushedMessages.delete(pushedMessages.values().next().value as string)
  }
  if (!message.mine) console.info(`[chat] message ${message.id} from ${message.from} in ${conversationId} (${via})`)
  broadcastChatMessage(conversationId, message)
  notifyIncomingMessage(conversationId, message)
}

const INBOX_CHECK_INTERVAL_MS = 10_000
const inboxWatcher = new DmInboxWatcher()
let inboxTimer: ReturnType<typeof setInterval> | null = null
let inboxCheck: Promise<void> | null = null

function observeInbox(threads: Awaited<ReturnType<RelayChatClient['listDMConversations']>>): void {
  for (const { conversationId, message } of inboxWatcher.observe(threads)) {
    deliverIncoming(conversationId, message, 'inbox check')
  }
}

/** Like the Relay apps' local notices: catch new DMs the live stream didn't deliver. */
function ensureInboxCheck(client: RelayChatClient): void {
  if (inboxTimer) return
  const check = (): void => {
    if (inboxCheck) return
    inboxCheck = client.listDMConversations()
      .then(observeInbox)
      .catch((error: unknown) => {
        console.warn('[chat] inbox check failed:', toErrorMessage(error))
      })
      .finally(() => {
        inboxCheck = null
      })
  }
  check()
  inboxTimer = setInterval(check, INBOX_CHECK_INTERVAL_MS)
}

/** Relaycast WebSocket: received messages and read receipts arrive as they happen. */
function ensureChatLive(client: RelayChatClient): RelayChatLive {
  if (!chatLive) {
    chatLive = new RelayChatLive({
      createSocket: async () => {
        if (!chatAgentToken) throw new Error('No companion agent token')
        return (await getRelayCast()).as(chatAgentToken)
      },
      selfName: () => chatAgentName,
      toMessage: (record, fallback) => client.messageFromEvent(record, fallback),
      onMessage: (conversationId, message) => {
        deliverIncoming(conversationId, message, 'live stream')
      },
      onRead: (messageId) => {
        markDelivered(messageId, 'read receipt')
      },
      onResync: (reason) => {
        console.info(`[chat] live stream ${reason === 'gap' ? 'missed events' : 'reconnected'}; reloading`)
        broadcastChatInvalidated('reconnect')
      }
    })
  }
  const live = chatLive
  void live.start().catch((error: unknown) => {
    console.warn('[chat] live stream failed to start; polling only:', toErrorMessage(error))
  })
  return live
}

const SLOW_CHAT_CALL_MS = 1_500

function logSlowChatCall(call: string, started: number, detail: string): void {
  const elapsed = Date.now() - started
  if (elapsed >= SLOW_CHAT_CALL_MS) console.warn(`[chat] ${call} took ${elapsed}ms (${detail})`)
}

function broadcastChatInvalidated(reason: ChatInvalidatedEvent['reason']): void {
  const event: ChatInvalidatedEvent = { reason }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:invalidated', event)
  }
}

function broadcastChatMessage(conversationId: string, message: RelayChatMessage): void {
  const event: ChatMessageEvent = { conversationId, message }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:message', event)
  }
}

function ensureChatPoller(client: RelayChatClient): RelayChatPoller {
  if (!chatPoller) {
    chatPoller = new RelayChatPoller(
      {
        pollRoster: async () => {
          await client.listAgents()
          await client.listNodes()
        },
        pollMessages: async () => {
          observeInbox(await client.listDMConversations())
        },
        pollChannels: async () => {
          await client.listChannels()
        },
        loadOpenChannelHistory: undefined,
        onRefreshed: (reason) => {
          broadcastChatInvalidated(reason === 'interval' ? 'poll' : reason)
        },
        onError: (error) => {
          console.warn('[chat] Poll refresh failed:', toErrorMessage(error))
        }
      },
      { intervalMs: RELAY_CHAT_POLL_INTERVAL_MS }
    )
    chatPoller.start()
    ensureInboxCheck(client)
  }
  return chatPoller
}

/** Drop cached chat credentials (e.g. on sign-out) so the next use re-resolves. */
export function resetChatClient(): void {
  chatPoller?.stop()
  chatPoller = null
  chatLive?.stop()
  chatLive = null
  if (inboxTimer) clearInterval(inboxTimer)
  inboxTimer = null
  inboxWatcher.reset()
  pushedMessages.clear()
  chatIdentityIsPerson = false
  awaitingDelivery.clear()
  chatClient = null
  chatClientPromise = null
  chatWorkspaceKey = null
  chatAgentToken = null
  chatAgentName = null
  relayCast = null
  relayCastKey = null
}

function normalizeChatSendInput(input: ChatSendInput): ChatSendInput {
  if (!input || typeof input !== 'object') throw new Error('Chat send input is required')
  if (input.kind !== 'dm' && input.kind !== 'channel') throw new Error('Chat send kind must be "dm" or "channel"')
  const to = input.to?.trim()
  const text = input.text
  if (!to) throw new Error('Chat send target is required')
  if (!text?.trim()) throw new Error('Message text is required')
  return {
    kind: input.kind,
    to,
    text,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  }
}

function normalizeChatHistoryInput(input: ChatHistoryInput): ChatHistoryInput {
  if (!input || typeof input !== 'object') throw new Error('Chat history input is required')
  if (input.kind !== 'dm' && input.kind !== 'channel') throw new Error('Chat history kind must be "dm" or "channel"')
  const id = input.id?.trim()
  if (!id) throw new Error('Chat history id is required')
  return {
    kind: input.kind,
    id,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.withDelivery !== undefined ? { withDelivery: input.withDelivery } : {})
  }
}

export function registerIpcHandlers(): void {
  // Fan proactive-agent events out to all renderer windows.
  proactiveAgentManager.onEvent((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('proactive-agent:event', event)
    }
  })

  // --- App ---
  ipcMain.handle('app:confirm-quit', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Close Pear', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Close Pear?',
      message: 'Close Pear by Agent Relay?',
      detail: 'Agent Relay will be shut down before the app closes.'
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)

    if (result.response !== 0) return false

    await brokerManager.shutdown()
    app.quit()
    return true
  })

  // --- Project ---
  ipcMain.handle('project:list', () => {
    const data = loadStore()
    return {
      projects: data.projects.map((project) => ({
        ...project,
        rootPathExists: isDirectory(project.rootPath),
        roots: project.roots.map((root) => ({
          ...root,
          pathExists: isDirectory(root.path)
        }))
      })),
      activeId: data.activeProjectId
    }
  })

  ipcMain.handle('project:add', async (event, name: string, rootPath?: string) => {
    let path = rootPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window available')
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select project root directory'
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    return addProject(name, path)
  })

  ipcMain.handle('project:remove', (_, id: string) => {
    removeProject(id)
  })

  ipcMain.handle('project:set-active', async (_, id: string | null) => {
    setActiveProject(id)
    await integrationsManager.hydrateActiveProject(id)
  })

  ipcMain.handle('project:update', (_, id: string, update: Record<string, unknown>) => {
    updateProject(id, update)
  })

  ipcMain.handle('project:add-channel', (_, projectId: string, name: string) => {
    addProjectChannel(projectId, name)
  })

  ipcMain.handle('project:remove-channel', (_, projectId: string, name: string) => {
    removeProjectChannel(projectId, name)
  })

  ipcMain.handle('project:set-channel-people', (_, projectId: string, channelName: string, people: string[]) => {
    return setProjectChannelPeople(projectId, channelName, people)
  })

  ipcMain.handle('project:add-root', async (event, projectId: string, name?: string, rootPath?: string) => {
    let path = rootPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window available')
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select project root directory'
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }

    const conflict = findProjectsWithPath(path).find((p) => p.id !== projectId)
    if (conflict) {
      return { kind: 'conflict', projectId, existingProjectId: conflict.id, existingProjectName: conflict.name, path }
    }

    return { kind: 'added', root: addProjectRoot(projectId, path, name) }
  })

  ipcMain.handle('project:create-worktree-root', async (_, projectId: string, repoPath: string, projectName: string, name?: string) => {
    const gitRoot = await git.getGitRoot(repoPath)
    if (!gitRoot) throw new Error(`Not a git repository: ${repoPath}`)

    const repoBasename = basename(gitRoot)
    const repoHash = createHash('sha1').update(gitRoot).digest('hex').slice(0, 8)
    const worktreePath = join(app.getPath('userData'), 'worktrees', projectId, `${repoBasename}-${repoHash}`)

    const branchSlug = projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pear'
    const projectSlug = projectId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 8)
    const branchName = `pear/${branchSlug}${projectSlug ? `-${projectSlug}` : ''}`

    if (!git.worktreeExists(worktreePath)) {
      await git.createWorktree(gitRoot, worktreePath, branchName)
    }
    return addProjectRoot(projectId, worktreePath, name || repoBasename)
  })

  ipcMain.handle('project:remove-root', (_, projectId: string, rootId: string) => {
    removeProjectRoot(projectId, rootId)
  })

  ipcMain.handle('project:add-integration', (_, projectId: string, name: string, type?: string) => {
    return addProjectIntegration(projectId, name, type)
  })

  ipcMain.handle('project:remove-integration', (_, projectId: string, integrationId: string) => {
    removeProjectIntegration(projectId, integrationId)
  })

  // --- Broker ---
  ipcMain.handle('broker:start', async (event, projectId: string, cwd: string, name: string, channels?: string[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      console.warn(`[broker] Project path no longer exists; skipping broker start: ${cwd}`)
      return false
    }
    const started = await brokerManager.start(projectId, cwd, name, win, channels)
    if (started) {
      void integrationsManager.notifyAgentState(projectId).catch((error) => {
        console.warn('[integrations] Failed to notify agents after broker start:', error instanceof Error ? error.message : String(error))
      })
    }
    return started
  })

  ipcMain.handle('broker:sync-channels', async (_, projectId: string, channels: string[]) => {
    await brokerManager.syncChannels(projectId, channels)
  })

  ipcMain.handle('broker:join-workspace', async (
    event,
    projectId: string,
    cwd: string,
    name: string,
    channels: string[] | undefined,
    workspaceKey: string
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      throw new Error(`Project path no longer exists: ${cwd}`)
    }
    const started = await brokerManager.joinWorkspace(projectId, cwd, name, win, channels, workspaceKey)
    if (started) {
      void integrationsManager.notifyAgentState(projectId).catch((error) => {
        console.warn('[integrations] Failed to notify agents after workspace join:', error instanceof Error ? error.message : String(error))
      })
    }
  })

  ipcMain.handle('broker:mint-observer-token', async (_, projectId: string) => {
    return brokerManager.mintObserverToken(projectId)
  })

  ipcMain.handle('broker:auto-fix-runtime', async (
    event,
    projectId: string,
    cwd: string,
    name: string,
    channels?: string[],
    errorMessage?: string
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    if (!isDirectory(cwd)) {
      throw new Error(`Project path no longer exists: ${cwd}`)
    }
    return brokerManager.autoFixRuntime(projectId, cwd, name, win, channels, errorMessage)
  })

  ipcMain.handle('broker:spawn-agent', async (_, projectId: string, input: SpawnPtyInput & { broker?: 'local' | 'cloud' }) => {
    const usePrescriptive = typeof input.cli === 'string' && input.cli !== 'claude'
    const integrationInstructions = usePrescriptive
      ? integrationsManager.prescriptiveSpawnInstructions(projectId)
      : integrationsManager.initialSpawnInstructions(projectId)
    const result = await brokerManager.spawnAgent(projectId, integrationInstructions
      ? {
          ...input,
          task: input.task?.trim()
            ? `${integrationInstructions}\n\nUser task:\n${input.task.trim()}`
            : integrationInstructions
        }
      : input)
    if (!usePrescriptive && integrationInstructions && result?.name) {
      // The spawn task embedded the current integrations snippet — mark the
      // new agent as already notified so the next project broadcast doesn't
      // deliver the same setup context to it a second time.
      // Not needed for prescriptive spawns: they use a different text format
      // that the per-agent delivery tracker doesn't manage.
      integrationsManager.recordSpawnInstructionDelivery(projectId, result.name)
    }
    integrationEventBridge.invalidateProjectAgentCache(projectId)
    return toBrokerSpawnAgentResult(result)
  })

  // Placement requester (#411): dispatch a spawn onto an eligible fleet node.
  // Placement errors (no eligible node, capability mismatch, queue full, unmapped
  // repo) are returned as structured outcomes so the UI can show a clear message
  // and never hang; unexpected failures still reject.
  ipcMain.handle('broker:place-agent', async (_, projectId: string, input: BrokerPlaceAgentInput): Promise<BrokerPlaceAgentOutcome> => {
    try {
      const result = await brokerManager.placeAgent(projectId, input)
      integrationEventBridge.invalidateProjectAgentCache(projectId)
      return { status: 'placed', result }
    } catch (err) {
      if (err instanceof BrokerPlacementError) {
        return {
          status: 'error',
          code: err.code,
          message: err.message,
          ...(err.node ? { node: err.node } : {}),
          ...(err.repo ? { repo: err.repo } : {})
        }
      }
      throw err
    }
  })

  ipcMain.handle('broker:list-nodes', async (_, projectId: string, capability?: string): Promise<BrokerNodeSummary[]> => {
    return brokerManager.listNodes(projectId, capability)
  })

  ipcMain.handle('broker:list-personas', async (_, projectId: string, cwd?: string) => {
    const normalizedProjectId = projectId.trim()
    const personaCwd = cwd?.trim()
    if (personaCwd) {
      const resolved = resolve(personaCwd)
      const { projects } = loadStore()
      const project = projects.find((entry) => entry.id === normalizedProjectId)
      if (!project || !projectContainsPath(project, resolved)) {
        throw new Error(`Path is outside project roots for project ${projectId}: ${resolved}`)
      }
      if (!isDirectory(resolved)) {
        return []
      }
      return brokerManager.listPersonas(normalizedProjectId, resolved)
    }
    return brokerManager.listPersonas(normalizedProjectId)
  })

  ipcMain.handle('broker:spawn-persona', async (_, projectId: string, personaId: string) => {
    try {
      const result = await brokerManager.spawnPersona(projectId, personaId)
      return toBrokerSpawnAgentResult(result)
    } finally {
      integrationEventBridge.invalidateProjectAgentCache(projectId)
    }
  })

  ipcMain.handle('broker:get-pending', async (_, projectId: string | undefined, name: string) => {
    return brokerManager.getPendingMessages(projectId, name)
  })

  ipcMain.handle('broker:flush-pending', async (_, projectId: string | undefined, name: string) => {
    return brokerManager.flushPending(projectId, name)
  })

  ipcMain.handle('broker:send-message', async (_, projectId: string | undefined, input: SendMessageInput) => {
    await brokerManager.sendMessage(projectId, input)
  })

  ipcMain.handle('broker:reconcile-messages', async (_, input: BrokerReconcileMessagesInput) => {
    return brokerManager.reconcileMessages(input)
  })

  ipcMain.handle('broker:refresh-event-stream', async (event, projectId?: string, reason?: string) => {
    const normalizedProjectId = projectId?.trim()
    if (!normalizedProjectId) return
    const win = BrowserWindow.fromWebContents(event.sender)
    await brokerManager.refreshEventStream(normalizedProjectId, reason || 'renderer-request', win || undefined)
  })

  ipcMain.handle('broker:subscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.subscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:unsubscribe-agent-channel', async (_, projectId: string | undefined, name: string, channel: string) => {
    await brokerManager.unsubscribeAgentChannel(projectId, name, channel)
  })

  ipcMain.handle('broker:release-agent', async (_, projectId: string | undefined, name: string) => {
    await brokerManager.releaseAgent(projectId, name)
    integrationEventBridge.invalidateProjectAgentCache(projectId)
  })

  ipcMain.handle('broker:list-agents', async (_, projectId?: string) => {
    return brokerManager.listAgents(projectId)
  })

  ipcMain.handle('broker:check-cli-available', (_, cli: string) => {
    return typeof cli === 'string' && isCommandAvailableWithAugmentedPath(cli)
  })

  ipcMain.handle('broker:list-details', async () => {
    return brokerManager.listBrokerDetails()
  })

  ipcMain.handle('broker:list-events', () => {
    return brokerManager.listBrokerEvents()
  })

  ipcMain.handle('broker:shutdown', async () => {
    await brokerManager.shutdown()
  })

  // --- Chat companion (Relaycast) ---
  ipcMain.handle('chat.listConversations', async () => {
    const started = Date.now()
    let rosterMs = 0
    let threadsMs = 0
    const rosterLoad = (async () => {
      const relay = await getRelayCast()
      const agents = (await relay.agents.list({ status: 'all' }))
        .map((agent) => ({ ...agent, metadata: wireMetadata(agent.metadata) }))
      const listed = listedRosterAgents(agents, chatAgentName ?? chatAgentIdentityName())
      const rows = await withPromptSummaries(rosterAgentConversations(listed))
      rosterMs = Date.now() - started
      return rows
    })()
    const threadsLoad = (async () => {
      try {
        const client = await getChatClient()
        ensureChatPoller(client)
        const threads = await client.listConversations()
        chatLive?.subscribeChannels(threads.filter((thread) => thread.kind === 'channel').map((thread) => thread.name))
        return threads
      } catch (error) {
        console.warn('[chat] Thread list failed; showing the Relaycast roster:', toErrorMessage(error))
        return [] as RelayChatConversation[]
      } finally {
        threadsMs = Date.now() - started
      }
    })()
    // The roster and the thread list are independent; neither waits on the other.
    const [roster, threads] = await Promise.all([rosterLoad, threadsLoad])
    logSlowChatCall(
      'listConversations',
      started,
      `roster ${rosterMs}ms / ${roster.length} agents (${roster.filter((row) => row.sessionId).length} with sessions), ` +
        `threads ${threadsMs}ms / ${threads.length}`
    )
    return conversationsWithSessions(roster, threads)
  })

  ipcMain.handle('chat.getHistory', async (_, input: ChatHistoryInput) => {
    const started = Date.now()
    const client = await getChatClient()
    const poller = ensureChatPoller(client)
    const normalized = normalizeChatHistoryInput(input)
    // Per-open history load + foreground refresh target. The background tick
    // never pulls full channel history — only open/foreground/manual does.
    poller.setOpenChannel(normalized.kind === 'channel' ? normalized.id : null)
    const messages = await client.getHistory(normalized)
    logSlowChatCall('getHistory', started, `${normalized.kind} ${messages.length} messages`)
    return messages
  })

  ipcMain.handle('chat.send', async (_, input: ChatSendInput) => {
    const started = Date.now()
    const client = await getChatClient()
    const claimMs = Date.now() - started
    const normalized = normalizeChatSendInput(input)
    // A throw here rejects the IPC call with a RelayChatError so the
    // renderer can roll back its optimistic row — nothing is fabricated.
    let message: RelayChatMessage
    try {
      message = normalized.kind === 'dm'
        ? await client.sendDM(normalized)
        : await client.sendChannelMessage(normalized.to, normalized)
    } catch (error) {
      console.warn(`[chat] send to ${normalized.kind}:${normalized.to} failed after ${Date.now() - started}ms:`, toErrorMessage(error))
      throw error
    }
    console.info(
      `[chat] sent ${normalized.kind}:${normalized.to} id=${message.id} in ${Date.now() - started}ms (companion ${claimMs}ms)`
    )
    const conversationId = normalized.kind === 'dm'
      ? toConversationId(message.conversationId ?? normalized.to)
      : `channel:${normalized.to.replace(/^#+/, '')}`
    // The sending window refreshes itself; this push only updates other
    // listeners, so no `send` invalidation that would reload everything twice.
    broadcastChatMessage(conversationId, message)
    watchDelivery(client, conversationId, message)
    return message
  })

  ipcMain.handle('chat.markRead', async (_, messageId: string) => {
    const client = await getChatClient()
    if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('Message id is required')
    await client.markRead(messageId)
  })

  ipcMain.handle('chat.joinChannel', async (_, channel: string) => {
    const client = await getChatClient()
    if (typeof channel !== 'string' || !channel.trim()) throw new Error('Channel name is required')
    const result = await client.joinChannel(channel)
    broadcastChatInvalidated('join')
    return result
  })

  ipcMain.handle('chat.uploadFile', async (_, input: ChatUploadInput) => {
    const client = await getChatClient()
    if (!input || typeof input !== 'object') throw new Error('Chat upload input is required')
    if (!input.filename?.trim()) throw new Error('Filename is required')
    if (typeof input.base64 !== 'string' || !input.base64) throw new Error('File bytes are required')
    let bytes: Buffer
    try {
      bytes = Buffer.from(input.base64, 'base64')
    } catch {
      throw new Error('File bytes are not valid base64')
    }
    return client.uploadFile({
      filename: input.filename.trim(),
      contentType: input.contentType?.trim() || 'application/octet-stream',
      bytes: new Uint8Array(bytes)
    })
  })

  // --- Burn ---
  ipcMain.handle('burn:list-agent-summaries', async (_, agents: BurnAgentInput[]) => {
    return burnManager.listAgentSummaries(agents)
  })

  ipcMain.handle('burn:get-agent-breakdown', async (_, agent: BurnAgentInput) => {
    return burnManager.getAgentBreakdown(agent)
  })

  ipcMain.handle('burn:get-project-breakdown', async (_, input: BurnProjectInput) => {
    return burnManager.getProjectBreakdown(input)
  })

  ipcMain.handle('burn:lookup-sessions', async (_, sessionIds: string[]) => {
    return burnManager.lookupSessions(Array.isArray(sessionIds) ? sessionIds : [])
  })

  ipcMain.handle('burn:get-session-breakdown', async (_, input: BurnSessionBreakdownInput) => {
    return burnManager.getSessionBreakdown(input)
  })

  ipcMain.handle('burn:fingerprint', async (_, input: BurnFingerprintInput) => {
    return burnManager.getFingerprint(input ?? {})
  })

  ipcMain.handle('burn:get-project-overhead', async (_, input: { projectId: string }) => {
    return burnManager.getProjectOverhead(input)
  })

  // --- Git ---
  ipcMain.handle('git:status', async (_, path: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return []
    try {
      return await git.getStatus(path)
    } catch (error) {
      warnGitStatusOnce(path, error)
      return []
    }
  })

  ipcMain.handle('git:diff', async (_, path: string, file?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getDiff(path, file)
  })

  ipcMain.handle('git:file-content', async (_, path: string, file: string, revision?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getFileContent(path, file, revision)
  })

  ipcMain.handle('git:summary', async (_, path: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return null
    return git.getSummary(path)
  })

  ipcMain.handle('git:branches', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) return []
    return git.listBranches(root)
  })

  ipcMain.handle('git:branch-details', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) return []
    return git.listBranchDetails(root)
  })

  ipcMain.handle('git:checkout-branch', async (_, root: string, branch: string, options?: git.GitCheckoutBranchOptions) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.checkoutBranch(root, branch, options)
  })

  ipcMain.handle('git:branch-sync-status', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.getBranchSyncStatus(root)
  })

  ipcMain.handle('git:fetch-remote', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.fetchRemote(root)
  })

  ipcMain.handle('git:pull-current-branch', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.pullCurrentBranch(root)
  })

  ipcMain.handle('git:push-current-branch', async (_, root: string) => {
    assertPathWithinProjects(root)
    if (!isDirectory(root)) throw new Error('Git working directory is unavailable')
    return git.pushCurrentBranch(root)
  })

  ipcMain.handle('git:active-pull-requests', async (_, roots: string[]) => {
    const validRoots = Array.isArray(roots)
      ? roots.filter((root): root is string => typeof root === 'string')
      : []

    for (const root of validRoots) {
      assertPathWithinProjects(root)
    }

    return git.getActivePullRequests(validRoots.filter((root) => isDirectory(root)))
  })

  ipcMain.handle('git:history', async (_, path: string, limit?: number) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return []
    return git.getHistory(path, limit)
  })

  ipcMain.handle('git:show', async (_, path: string, hash: string, file?: string) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) return ''
    return git.getCommitDiff(path, hash, file)
  })

  ipcMain.handle('git:discard-files', async (_, path: string, files: string[]) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.discardFiles(path, files)
  })

  ipcMain.handle('git:add-gitignore-patterns', async (_, path: string, patterns: string[]) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.addGitignorePatterns(path, patterns)
  })

  ipcMain.handle('git:commit-selection', async (_, path: string, input: git.GitCommitSelectionInput) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    return git.commitSelection(path, input)
  })

  ipcMain.handle('git:generate-commit-message', async (_, projectId: string, path: string, input: { wholeFiles: string[]; patch?: string }) => {
    assertPathWithinProjects(path)
    if (!isDirectory(path)) throw new Error('Git working directory is unavailable')
    const normalizedProjectId = projectId.trim()
    const { projects } = loadStore()
    const project = projects.find((entry) => entry.id === normalizedProjectId)
    if (!project || !projectContainsPath(project, path)) {
      throw new Error(`Path is outside project roots for project ${projectId}: ${resolve(path)}`)
    }
    const diff = await git.getSelectedDiff(path, input)
    return brokerManager.generateCommitDraft(normalizedProjectId, diff)
  })

  // --- Files ---
  ipcMain.handle('fs:list-dir', async (_, dirPath: string) => {
    assertPathWithinProjects(dirPath)
    return filesystem.listDirectory(dirPath)
  })

  ipcMain.handle('fs:read-preview', async (_, filePath: string) => {
    assertPathWithinProjects(filePath)
    return filesystem.readTextPreview(filePath)
  })

  ipcMain.handle('fs:reveal-path', async (_, filePath: string) => {
    const resolvedPath = resolve(filePath)
    assertPathWithinProjects(resolvedPath)
    shell.showItemInFolder(resolvedPath)
  })

  // --- Auth ---
  ipcMain.handle('auth:login', async (_, input?: { apiUrl?: string }) => {
    const status = await auth.ensureAuthenticated(input?.apiUrl)
    if (status.loggedIn) {
      resetRelayWorkspaceManager()
      resetChatClient()
      // Re-run the cloud auth check so a stale "Cloud sign-in required" banner
      // clears now that we have fresh tokens. Fire-and-forget: the banner
      // clears via the `integration-auth-recovered` event when this resolves,
      // so we don't block the login response on a cloud round-trip.
      void integrationsManager.retryAuthRecovery()
    }
    return status
  })

  ipcMain.handle('auth:logout', () => {
    resetRelayWorkspaceManager()
    resetChatClient()
    auth.logout()
  })

  ipcMain.handle('auth:status', () => {
    return auth.getAuthStatus()
  })

  // --- Cloud Agent ---
  // Renderer-facing channels. The event stream `cloud-agent:event` is emitted by cloudAgentManager via webContents.send().
  ipcMain.handle('cloud-agent:list', async () => {
    return cloudAgentManager.list()
  })

  ipcMain.handle('cloud-agent:create', async (_, input: { name: string; harness: string; model: string }) => {
    return cloudAgentManager.create(input)
  })

  ipcMain.handle('cloud-agent:delete', async (_, id: string) => {
    return cloudAgentManager.delete(id)
  })

  ipcMain.handle('cloud-agent:prewarm', async (_, projectId: string, cloudAgentId: string) => {
    return cloudAgentManager.prewarm(projectId, cloudAgentId)
  })

  ipcMain.handle('cloud-agent:cancel-prewarm', async (_, projectId: string, cloudAgentId?: string) => {
    return cloudAgentManager.cancelPrewarm(projectId, cloudAgentId)
  })

  ipcMain.handle('cloud-agent:attach', async (event, projectId: string, cloudAgentId: string) => {
    return cloudAgentManager.attach(projectId, cloudAgentId, BrowserWindow.fromWebContents(event.sender))
  })

  ipcMain.handle('cloud-agent:detach', async (_, projectId: string) => {
    return cloudAgentManager.detach(projectId)
  })

  ipcMain.handle('cloud-agent:status', async (_, projectId: string) => {
    return cloudAgentManager.status(projectId)
  })

  // --- Proactive Agent ---
  ipcMain.handle('proactive-agent:list', async (_, projectId: string) => {
    return proactiveAgentManager.list(projectId)
  })

  ipcMain.handle('proactive-agent:create', async (_, projectId: string, draft: ProactiveAgentDraft) => {
    return proactiveAgentManager.create(projectId, draft)
  })

  ipcMain.handle('proactive-agent:update', async (_, projectId: string, personaId: string, draft: ProactiveAgentDraft) => {
    return proactiveAgentManager.update(projectId, personaId, draft)
  })

  ipcMain.handle('proactive-agent:deploy', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.deploy(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:pause', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.pause(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:resume', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.resume(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:undeploy', async (_, projectId: string, personaId: string) => {
    return proactiveAgentManager.undeploy(projectId, personaId)
  })

  ipcMain.handle('proactive-agent:runs', async (
    _,
    projectId: string,
    personaId: string,
    opts?: { limit?: number; cursor?: string }
  ) => {
    return proactiveAgentManager.runs(projectId, personaId, opts)
  })

  ipcMain.handle('proactive-agent:run-transcript', async (_, runId: string) => {
    return proactiveAgentManager.runTranscript(runId)
  })

  // --- Integrations ---
  ipcMain.handle('integrations:catalog', async () => {
    return integrationsManager.listCatalog()
  })

  ipcMain.handle('integrations:list', async (_, projectId: string) => {
    return integrationsManager.listConnectedForSettings(projectId)
  })

  ipcMain.handle('integrations:auth-recovery-state', () => {
    return integrationsManager.getAuthRecoveryState()
  })

  ipcMain.handle('integrations:telemetry', () => {
    return getIntegrationEventTelemetrySnapshot()
  })

  ipcMain.handle('integrations:list-mount-dir', async (_, projectId: string, integrationId: string, dirPath: string) => {
    return integrationsManager.listMountDirectory(projectId, integrationId, dirPath)
  })

  ipcMain.handle('integrations:list-remote-dir', async (_, projectId: string, remotePath: string) => {
    return integrationsManager.listRemoteDirectory(projectId, remotePath)
  })

  ipcMain.handle('integrations:read-mount-preview', async (_, projectId: string, integrationId: string, filePath: string) => {
    return integrationsManager.readMountPreview(projectId, integrationId, filePath)
  })

  ipcMain.handle('integrations:read-remote-file', async (_, projectId: string, remotePath: string) => {
    return integrationsManager.readRemoteFile(projectId, remotePath)
  })

  ipcMain.handle('integrations:write-remote-file', async (_, projectId: string, remotePath: string, content: string) => {
    return integrationsManager.writeRemoteFile(projectId, remotePath, content)
  })

  ipcMain.handle('integrations:list-options', async (_, projectId: string, provider: string, resource: string) => {
    return integrationsManager.listOptions(projectId, provider, resource)
  })

  ipcMain.handle('integrations:start-connect', async (_, projectId: string, provider: string) => {
    return integrationsManager.startConnect(projectId, provider)
  })

  ipcMain.handle('integrations:poll-connect', async (_, sessionId: string) => {
    return integrationsManager.pollConnect(sessionId)
  })

  ipcMain.handle(
    'integrations:complete-connect',
    async (
      _,
      projectId: string,
      sessionId: string,
      scope: Record<string, unknown>,
      mountPaths: string[],
      notifyAgent: boolean
    ) => {
      return integrationsManager.completeConnect(projectId, sessionId, scope, mountPaths, notifyAgent)
    }
  )

  ipcMain.handle(
    'integrations:update-scope',
    async (_, projectId: string, integrationId: string, scope: Record<string, unknown>, mountPaths: string[]) => {
      return integrationsManager.updateScope(projectId, integrationId, scope, mountPaths)
    }
  )

  ipcMain.handle(
    'integrations:update-subscription',
    async (_, projectId: string, integrationId: string, subscribeAgent: boolean) => {
      return integrationsManager.updateSubscription(projectId, integrationId, subscribeAgent)
    }
  )

  ipcMain.handle(
    'integrations:update-historical-download',
    async (_, projectId: string, integrationId: string, downloadHistoricalData: boolean) => {
      return integrationsManager.updateHistoricalDownload(projectId, integrationId, downloadHistoricalData)
    }
  )

  ipcMain.handle('integrations:disconnect', async (_, projectId: string, integrationId: string) => {
    return integrationsManager.disconnect(projectId, integrationId)
  })

  ipcMain.handle('ai-hist:status', () => aiHistManager.getStatus())
  ipcMain.handle('ai-hist:recent', (_, opts?: Parameters<typeof aiHistManager.recent>[0]) =>
    aiHistManager.recent(opts)
  )
  ipcMain.handle('ai-hist:list-sessions', (_, opts?: Parameters<typeof aiHistManager.listSessions>[0]) =>
    aiHistManager.listSessions(opts)
  )
  ipcMain.handle('ai-hist:get-session', (_, sessionId: string) =>
    aiHistManager.getSession(sessionId)
  )
  ipcMain.handle('ai-hist:transcript', async (_, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return []
    const id = sessionId.trim()
    const local = readSessionTranscript(id)
    if (local.length > 0) return local
    return cloudSessionTurns(id)
  })
  ipcMain.handle(
    'ai-hist:search',
    (_, query: string, opts?: Parameters<typeof aiHistManager.search>[1]) =>
      aiHistManager.search(query, opts)
  )
  ipcMain.handle(
    'ai-hist:search-sessions',
    (_, query: string, opts?: Parameters<typeof aiHistManager.searchSessions>[1]) =>
      aiHistManager.searchSessions(query, opts)
  )
  ipcMain.handle('ai-hist:stats', () => aiHistManager.stats())
  ipcMain.handle(
    'ai-hist:resume-command',
    (_, entry: Parameters<typeof aiHistManager.resumeCommand>[0]) =>
      aiHistManager.resumeCommand(entry)
  )
  ipcMain.handle('ai-hist:reload', () => aiHistManager.reload())
}
