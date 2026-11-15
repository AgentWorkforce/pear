import { useEffect } from 'react'
import { MessageCircle } from 'lucide-react'
import { ConversationList } from './ConversationList'
import { ThreadView } from './ThreadView'
import { Composer } from './Composer'
import { ChatGrid } from './ChatGrid'
import { useChatStore } from '@/stores/chat-store'

/**
 * Task/thread-first home: Pear opens on the threads it owns. The list
 * below only contains Pear-owned DM threads and channels from
 * `chat.listConversations`, and the composer renders solely inside a
 * selected thread — there is deliberately no universal @name composer,
 * no roster browser, and no onboarding/provider/settings chrome (those
 * belong to relay-desktop).
 */
export function ChatDesktopView(): React.ReactNode {
  const startSync = useChatStore((s) => s.startSync)
  const stopSync = useChatStore((s) => s.stopSync)
  const selectedId = useChatStore((s) => s.selectedId)
  const chatLayout = useChatStore((s) => s.chatLayout)

  useEffect(() => {
    startSync()
    return () => stopSync()
  }, [startSync, stopSync])

  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg)]">
      <div className="flex min-h-0 flex-1">
        <ConversationList />
        <div className="flex min-w-0 flex-1 flex-col">
          {chatLayout === 'grid' ? (
            <ChatGrid />
          ) : selectedId ? (
            <>
              <ThreadView conversationId={selectedId} />
              <Composer conversationId={selectedId} />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
              <MessageCircle size={28} className="text-[var(--pear-text-faint)]" />
              <p className="text-sm text-[var(--pear-text-secondary)]">
                Select a thread to read and reply
              </p>
              <p className="max-w-sm text-xs text-[var(--pear-text-faint)]">
                Messages compose only inside a Pear-owned thread, with delivery
                shown inline under your last message.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
