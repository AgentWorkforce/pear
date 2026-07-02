import {
  getDirectMessageParticipantKey,
  getDirectMessageParticipants
} from '@/lib/direct-messages'
import { useAgentStore, type ChatMessage } from '@/stores/agent-store'
import type { BrokerReconciledChatMessage, ObserverChatUpdate } from '@/lib/ipc'

/**
 * Bridge observer-stream chat updates (main process, PEAR_OBSERVER_STREAM —
 * see src/main/observer-stream.ts) into the renderer's existing message
 * state. Deliberately no parallel store: every update funnels through
 * `useAgentStore.getState().reconcileMessages`, the same id-deduping merge
 * the REST polling reconciliation uses, so both feeds converge on the same
 * canonical relaycast message ids.
 */

function toReconciled(message: ChatMessage): BrokerReconciledChatMessage {
  // Strip the renderer-only optimistic marker so an observer-sourced merge
  // can never re-mark a canonical record as a pending local echo.
  const { local: _local, ...rest } = message
  return rest
}

/**
 * Resolve a DM message's `to` from the conversation's known participants.
 * The observer event only carries the sender + conversation id, but the DM
 * room list derives rooms from `from`/`to` participant names — so a message
 * for a conversation we have never seen locally is skipped (the polling
 * reconciliation still hydrates it when the room is opened).
 */
function resolveDirectMessage(
  existingMessages: ChatMessage[],
  entry: ObserverChatUpdate['directMessages'][number]
): BrokerReconciledChatMessage | null {
  const known = existingMessages.find((message) => message.conversationId === entry.conversationId)
  if (!known) return null
  const participants = getDirectMessageParticipants(known)
  if (!participants) return null

  const senderKey = getDirectMessageParticipantKey(entry.message.from)
  const others = participants.filter(
    (participant) => getDirectMessageParticipantKey(participant) !== senderKey
  )
  return {
    ...entry.message,
    to: others.length > 0 ? others.join(', ') : known.to
  }
}

export function applyObserverChatUpdate(update: ObserverChatUpdate): void {
  const state = useAgentStore.getState()
  const existingMessages = state.messages
  const incoming: BrokerReconciledChatMessage[] = [...update.messages]

  for (const entry of update.directMessages) {
    const resolved = resolveDirectMessage(existingMessages, entry)
    if (resolved) incoming.push(resolved)
  }

  for (const entry of update.threadReplies) {
    const parent = existingMessages.find((message) => message.id === entry.parentId)
    // A reply whose parent we have never merged is skipped — the store only
    // carries thread replies attached to a full parent record. The polling
    // reconciliation cannot recover these either (it does not fetch thread
    // replies), so a skipped reply reappears only when the parent lands.
    if (!parent) continue
    if (parent.threadReplies?.some((reply) => reply.id === entry.reply.id)) continue
    incoming.push({
      ...toReconciled(parent),
      threadReplies: [...(parent.threadReplies || []), entry.reply]
    })
  }

  if (incoming.length > 0) {
    state.reconcileMessages(incoming)
  }
}
