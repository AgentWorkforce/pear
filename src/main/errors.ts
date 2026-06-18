/**
 * Shared error-to-string helpers for the main process.
 *
 * `toErrorMessage` is the concise form used almost everywhere; `describeError`
 * is the richer fallback (used for opaque integration/transport errors) that
 * digs through common error-shaped fields before giving up.
 */
// @ts-expect-error Node's strip-types test runner requires the explicit .ts extension.
import { isRecord } from './guards.ts'

/** Concise message: `Error.message`, or `String()` of any other thrown value. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Best-effort human-readable description for opaque/transport errors that may
 * arrive as plain objects, strings, or structured `{ code, status, ... }`
 * payloads rather than `Error` instances.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    return message || error.name || error.constructor.name || 'Error'
  }
  if (typeof error === 'string') {
    const message = error.trim()
    return message || 'empty string error'
  }
  if (isRecord(error)) {
    const record = error as Record<string, unknown>
    const message = record.message
    if (typeof message === 'string' && message.trim()) return message.trim()
    const reason = record.reason
    if (typeof reason === 'string' && reason.trim()) return reason.trim()
    const parts = [
      typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null,
      typeof record.type === 'string' && record.type.trim() ? `type=${record.type.trim()}` : null,
      typeof record.code === 'string' && record.code.trim() ? `code=${record.code.trim()}` : typeof record.code === 'number' ? `code=${record.code}` : null,
      typeof record.status === 'string' && record.status.trim() ? `status=${record.status.trim()}` : typeof record.status === 'number' ? `status=${record.status}` : null,
      typeof record.statusCode === 'string' && record.statusCode.trim() ? `statusCode=${record.statusCode.trim()}` : typeof record.statusCode === 'number' ? `statusCode=${record.statusCode}` : null,
      typeof record.httpStatus === 'string' && record.httpStatus.trim() ? `httpStatus=${record.httpStatus.trim()}` : typeof record.httpStatus === 'number' ? `httpStatus=${record.httpStatus}` : null
    ].filter((entry): entry is string => entry !== null)
    if (parts.length > 0) return parts.join(' ')
    const constructorName = record.constructor?.name
    if (constructorName && constructorName !== 'Object') return constructorName

    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch {
      // Fall through to String(error).
    }
  }
  const text = String(error).trim()
  return text && text !== '[object Object]' ? text : 'unknown error'
}
