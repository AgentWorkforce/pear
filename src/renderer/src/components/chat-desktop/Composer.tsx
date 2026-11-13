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

export function Composer({ conversationId }: { conversationId: string }): React.ReactNode {
  const draft = useChatStore((s) => s.composerDraft)
  const setComposerDraft = useChatStore((s) => s.setComposerDraft)
  const sendMessage = useChatStore((s) => s.sendMessage)

  const [text, setText] = useState(draft)
  const [attachmentIds, setAttachmentIds] = useState<string[]>([])
  const [attachmentNames, setAttachmentNames] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
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

  const canSend = (text.trim().length > 0 || attachmentIds.length > 0) && !sending && !uploading

  const handleAttach = async (files: FileList | null): Promise<void> => {
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

  const handleSend = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    try {
      await sendMessage(text, attachmentIds)
      setText('')
      setAttachmentIds([])
      setAttachmentNames([])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-4 py-3">
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
          disabled={uploading || sending}
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
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleSend()
            }
          }}
          placeholder={uploading ? 'Uploading…' : 'Message this thread…'}
          aria-label="Message"
          rows={1}
          className="max-h-32 min-h-9 flex-1 resize-y rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-3 py-2 text-sm text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)] focus:border-[var(--pear-accent-dim)]"
        />
        <button
          type="button"
          title="Send"
          aria-label="Send message"
          disabled={!canSend}
          onClick={() => void handleSend()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--pear-accent-dim)] text-[var(--pear-text)] disabled:opacity-40"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  )
}
