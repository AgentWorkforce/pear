import { useEffect, useRef, useState } from 'react'
import { Paperclip, Send, X } from 'lucide-react'
import { pear } from '@/lib/ipc'
import { useChatStore } from '@/stores/chat-store'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

/**
 * Images on the clipboard, named so several pastes stay distinguishable
 * (macOS names every pasted screenshot `image.png`).
 */
export function pastedImages(clipboard: Pick<DataTransfer, 'files'> | null, now: Date = new Date()): File[] {
  const images = Array.from(clipboard?.files || []).filter((file) => file.type.startsWith('image/'))
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return images.map((file, index) => {
    const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const name = `pasted-${stamp}${images.length > 1 ? `-${index + 1}` : ''}.${extension}`
    return new File([file], name, { type: file.type })
  })
}

export function Composer({ conversationId, compact = false }: { conversationId: string; compact?: boolean }): React.ReactNode {
  // A restored failed message goes to the focused pane only, not every composer in the grid.
  const draft = useChatStore((s) => (s.selectedId === conversationId ? s.composerDraft : ''))
  const setComposerDraft = useChatStore((s) => s.setComposerDraft)
  const sendMessage = useChatStore((s) => s.sendMessage)

  const [text, setText] = useState(draft)
  const [attachmentIds, setAttachmentIds] = useState<string[]>([])
  const [attachmentNames, setAttachmentNames] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Failed pending rows restore their text here via tap-to-edit.
  useEffect(() => {
    if (draft) setText(draft)
  }, [draft])

  const prevConversationIdRef = useRef(conversationId)
  useEffect(() => {
    if (prevConversationIdRef.current === conversationId) return
    prevConversationIdRef.current = conversationId
    setText('')
    setAttachmentIds([])
    setAttachmentNames([])
    setUploadError(null)
  }, [conversationId])

  const canSend = (text.trim().length > 0 || attachmentIds.length > 0) && !uploading

  const handleAttach = async (files: FileList | File[] | null): Promise<void> => {
    if (!files || files.length === 0) return
    setUploading(true)
    setUploadError(null)
    try {
      const uploaded: string[] = []
      const names: string[] = []
      for (const file of Array.from(files)) {
        const base64 = await fileToBase64(file)
        const attachment = await pear.chat.uploadFile({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          base64
        })
        uploaded.push(attachment.file_id)
        names.push(attachment.filename)
      }
      setAttachmentIds((prev) => [...prev, ...uploaded])
      setAttachmentNames((prev) => [...prev, ...names])
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // The thread shows the message as Sending at once and keeps a failed one
  // for tap-to-edit, so the composer clears without waiting on Relaycast.
  const handleSend = (): void => {
    if (!canSend) return
    void sendMessage(text, attachmentIds, conversationId)
    setText('')
    setAttachmentIds([])
    setAttachmentNames([])
  }

  return (
    <div className={`shrink-0 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] ${compact ? 'px-2.5 py-2' : 'px-4 py-3'}`}>
      {attachmentNames.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachmentNames.map((name, index) => (
            <span
              key={`${name}-${index}`}
              className="flex items-center gap-1 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2 py-1 text-xs text-[var(--pear-text-secondary)]"
            >
              <span className="max-w-40 truncate">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => {
                  setAttachmentIds((prev) => prev.filter((_, i) => i !== index))
                  setAttachmentNames((prev) => prev.filter((_, i) => i !== index))
                }}
                className="text-[var(--pear-text-faint)] hover:text-[var(--pear-red)]"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {uploadError && <p className="mb-2 text-xs text-[var(--pear-red)]">{uploadError}</p>}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Choose files to attach"
          onChange={(event) => void handleAttach(event.target.files)}
        />
        <button
          type="button"
          title="Attach files"
          aria-label="Attach files"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pear-border-subtle)] text-[var(--pear-text-secondary)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)] disabled:opacity-40"
        >
          <Paperclip size={16} />
        </button>
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            if (draft) setComposerDraft('')
          }}
          onPaste={(event) => {
            const images = pastedImages(event.clipboardData)
            if (images.length === 0) return
            event.preventDefault()
            void handleAttach(images)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              handleSend()
            }
          }}
          placeholder={uploading ? 'Uploading…' : 'Message this thread…'}
          aria-label="Message"
          rows={compact ? 2 : 3}
          className={`${compact ? 'max-h-40 min-h-[56px]' : 'max-h-72 min-h-[84px]'} flex-1 resize-y rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3.5 py-2.5 ${compact ? 'text-[13px]' : 'text-[15px]'} leading-relaxed text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]`}
        />
        <button
          type="button"
          title="Send"
          aria-label="Send message"
          disabled={!canSend}
          onClick={handleSend}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--pear-accent-dim)] text-[var(--pear-text)] disabled:opacity-40"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  )
}
