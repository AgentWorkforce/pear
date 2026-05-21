import type { ChatMessage } from '@/stores/agent-store'

const HUMAN_PARTICIPANT_KEYS = new Set(['human', 'you', 'me'])
const BROADCAST_TARGET_KEYS = new Set(['*', 'broadcast'])

export interface DirectMessageRoom {
  id: string
  participants: string[]
  agentNames: string[]
  title: string
  humanIncluded: boolean
  messageCount: number
  lastMessageAt: number
}

function normalizeParticipantDisplayName(value: string): string {
  return value.trim().replace(/^@+/, '').trim()
}

function rawParticipantKey(value: string): string {
  return normalizeParticipantDisplayName(value).toLowerCase()
}

export function getDirectMessageParticipantKey(value: string): string {
  const key = rawParticipantKey(value)
  return HUMAN_PARTICIPANT_KEYS.has(key) ? 'human' : key
}

export function isHumanParticipant(value: string): boolean {
  return HUMAN_PARTICIPANT_KEYS.has(rawParticipantKey(value))
}

export function sortDirectMessageParticipants(values: string[]): string[] {
  const byKey = new Map<string, string>()

  for (const value of values) {
    const displayName = normalizeParticipantDisplayName(value)
    const key = getDirectMessageParticipantKey(displayName)
    if (!displayName || !key || byKey.has(key)) continue
    byKey.set(key, displayName)
  }

  return [...byKey.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' })
  )
}

export function parseDirectMessageTargets(target: string): string[] {
  const trimmedTarget = target.trim()
  const targetKey = rawParticipantKey(trimmedTarget)

  if (!trimmedTarget || trimmedTarget.startsWith('#') || BROADCAST_TARGET_KEYS.has(targetKey)) {
    return []
  }

  return sortDirectMessageParticipants(
    trimmedTarget
      .split(/[,;|]+/)
      .map(normalizeParticipantDisplayName)
      .filter(Boolean)
  )
}

function isKnownChannelTarget(target: string, channelNames: string[]): boolean {
  const normalizedTarget = target.trim().replace(/^#/, '').toLowerCase()
  return channelNames.some((channelName) => channelName.toLowerCase() === normalizedTarget)
}

export function getDirectMessageParticipants(message: Pick<ChatMessage, 'from' | 'to'>): string[] | null {
  const targets = parseDirectMessageTargets(message.to)
  if (targets.length === 0) return null

  const participants = sortDirectMessageParticipants([message.from, ...targets])
  return participants.length >= 2 ? participants : null
}

export function getDirectMessageRoomId(participants: string[]): string {
  return participants
    .map(getDirectMessageParticipantKey)
    .filter(Boolean)
    .sort()
    .join('|')
}

export function getDirectMessageAgentNames(participants: string[]): string[] {
  return sortDirectMessageParticipants(
    participants.filter((participant) => !isHumanParticipant(participant))
  )
}

export function getDirectMessageRoomTitle(participants: string[]): string {
  const agentNames = getDirectMessageAgentNames(participants)
  const displayNames = agentNames.length > 0 ? agentNames : sortDirectMessageParticipants(participants)
  return displayNames.join(', ') || 'DM'
}

export function isDirectMessageRoomHumanIncluded(participants: string[]): boolean {
  return participants.some(isHumanParticipant)
}

export function messageMatchesDirectMessageRoom(
  message: Pick<ChatMessage, 'from' | 'to'>,
  participants: string[]
): boolean {
  const messageParticipants = getDirectMessageParticipants(message)
  return Boolean(messageParticipants) &&
    getDirectMessageRoomId(messageParticipants!) === getDirectMessageRoomId(participants)
}

export function deriveDirectMessageRooms(
  messages: ChatMessage[],
  projectId?: string,
  channelNames: string[] = []
): DirectMessageRoom[] {
  const rooms = new Map<string, DirectMessageRoom>()

  for (const message of messages) {
    if (projectId && message.projectId !== projectId) continue
    if (isKnownChannelTarget(message.to, channelNames)) continue

    const participants = getDirectMessageParticipants(message)
    if (!participants) continue

    const id = getDirectMessageRoomId(participants)
    const existing = rooms.get(id)
    if (existing) {
      rooms.set(id, {
        ...existing,
        messageCount: existing.messageCount + 1,
        lastMessageAt: Math.max(existing.lastMessageAt, message.timestamp)
      })
      continue
    }

    rooms.set(id, {
      id,
      participants,
      agentNames: getDirectMessageAgentNames(participants),
      title: getDirectMessageRoomTitle(participants),
      humanIncluded: isDirectMessageRoomHumanIncluded(participants),
      messageCount: 1,
      lastMessageAt: message.timestamp
    })
  }

  return [...rooms.values()].sort((left, right) =>
    left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
  )
}

export function getDirectMessageRecipientTargets(participants: string[]): string[] {
  return getDirectMessageAgentNames(participants)
}
