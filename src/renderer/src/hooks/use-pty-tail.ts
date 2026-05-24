import { useEffect, useRef, useState } from 'react'
import { getPtyChunks, subscribePty } from '@/lib/pty-stream'

/**
 * Returns the joined text of the last `maxChunks` PTY chunks for an agent,
 * re-rendering at most once per animation frame as new output arrives. Used for
 * lightweight terminal previews (e.g. graph nodes) now that the raw stream
 * lives outside the store.
 */
export function usePtyTail(
  projectId: string | undefined,
  name: string,
  maxChunks = 80
): string {
  const [text, setText] = useState(() => getPtyChunks(projectId, name).slice(-maxChunks).join(''))
  const frameRef = useRef<number>(0)

  useEffect(() => {
    const read = (): string => getPtyChunks(projectId, name).slice(-maxChunks).join('')
    setText(read())

    const unsubscribe = subscribePty(projectId, name, () => {
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0
        setText(read())
      })
    })

    return () => {
      unsubscribe()
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }
    }
  }, [projectId, name, maxChunks])

  return text
}
