import type { RelayChatMessage } from '../shared/types/ipc'
import type { RelayDMThread } from './relay-chat-client'

/**
 * New incoming DMs seen from the conversation list, the way the Relay apps
 * post local notices: compare each thread's last message id with the last
 * check. The first check is a baseline, so starting up never replays old
 * messages. This backs up the live stream, which another client signed in as
 * the same identity can win; the caller dedupes the two by message id.
 */
export class DmInboxWatcher {
  private readonly latest = new Map<string, string>()
  private baselined = false

  /** New messages from someone else since the previous check, oldest first. */
  observe(threads: readonly RelayDMThread[]): Array<{ conversationId: string; message: RelayChatMessage }> {
    const fresh: Array<{ conversationId: string; message: RelayChatMessage }> = []
    for (const thread of threads) {
      const message = thread.lastMessage
      if (!message) continue
      const previous = this.latest.get(thread.id)
      this.latest.set(thread.id, message.id)
      if (!this.baselined || previous === message.id || message.mine) continue
      fresh.push({ conversationId: thread.id, message })
    }
    this.baselined = true
    return fresh.sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))
  }

  reset(): void {
    this.latest.clear()
    this.baselined = false
  }
}
