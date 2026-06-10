import type { PtyInputStream } from '@agent-relay/harness-driver'

// After this many consecutive failures to open a PTY input stream, give up on
// the WS fast path for that agent briefly and send over HTTP while it cools down.
const MAX_INPUT_STREAM_OPEN_FAILURES = 3
const INPUT_STREAM_FALLBACK_RETRY_MS = 15_000

// Minimal slice of the broker client this manager needs to open a stream.
export interface InputStreamClient {
  openInputStream(name: string): PtyInputStream
}

// Owns the WS-with-HTTP-fallback PTY input path and all its per-agent state.
// Keys are `${sessionKey}:${name}` so a project's local and cloud brokers keep
// independent streams for the same agent name. BrokerManager delegates here and
// keeps the actual `stream.send` / HTTP-fallback wiring inline (it owns the
// session client and the error classification used to decide the fallback).
export class PtyInputStreamManager {
  private inputStreams = new Map<string, PtyInputStream>()
  private inputStreamFallbacks = new Set<string>()
  private inputStreamFallbackRetryAt = new Map<string, number>()
  // Keys whose WS input stream has completed the broker's pty_input_ready
  // handshake — only these are safe to send on without blocking. Everything
  // else routes over HTTP until the stream is confirmed open.
  private inputStreamReady = new Set<string>()
  // Consecutive background open failures per key; after MAX we pause WS retries
  // for this agent briefly and keep HTTP input flowing.
  private inputStreamOpenFailures = new Map<string, number>()

  getInputStreamKey(sessionKey: string, name: string): string {
    return `${sessionKey}:${name}`
  }

  hasFallback(key: string): boolean {
    return this.inputStreamFallbacks.has(key)
  }

  addFallback(key: string): void {
    this.inputStreamFallbacks.add(key)
  }

  getStream(key: string): PtyInputStream | undefined {
    return this.inputStreams.get(key)
  }

  // Returns the input stream for an agent plus whether it is *ready* to send on
  // (the broker has acked pty_input_ready). The WS handshake runs in the
  // background and is never awaited here, so a keystroke is never blocked on the
  // up-to-10s open timeout — callers send over HTTP until `ready` flips true.
  ensureInputStream(
    client: InputStreamClient,
    key: string,
    name: string
  ): { stream: PtyInputStream; ready: boolean } {
    const existing = this.inputStreams.get(key)
    if (existing && !existing.closed) {
      return { stream: existing, ready: this.inputStreamReady.has(key) }
    }

    const stream = client.openInputStream(name)
    this.inputStreams.set(key, stream)
    this.inputStreamReady.delete(key)
    stream.waitUntilOpen().then(
      () => {
        if (this.inputStreams.get(key) === stream) {
          this.inputStreamReady.add(key)
          this.inputStreamFallbacks.delete(key)
          this.inputStreamFallbackRetryAt.delete(key)
          this.inputStreamOpenFailures.delete(key)
        }
      },
      () => {
        if (this.inputStreams.get(key) !== stream) return
        this.inputStreams.delete(key)
        this.inputStreamReady.delete(key)
        const failures = (this.inputStreamOpenFailures.get(key) ?? 0) + 1
        this.inputStreamOpenFailures.set(key, failures)
        // A stream that never opens (e.g. broker never sends pty_input_ready)
        // would otherwise be re-opened on every keystroke. Stop trying the WS
        // after a few failures, ride HTTP briefly, then retry. Cloud terminals
        // can stay mounted across focus changes, so attachTerminal is not the
        // only reliable signal that the fast path should get another chance.
        // This is the one case worth surfacing: transient not-ready is normal,
        // but a *persistently* unopenable stream means the low-latency fast path
        // is off for this agent — log it once rather than hiding it.
        if (failures >= MAX_INPUT_STREAM_OPEN_FAILURES && !this.inputStreamFallbacks.has(key)) {
          console.warn(
            `[broker] PTY input stream for ${name} failed to open ${failures}x; ` +
            `routing input over HTTP for this agent and retrying PTY stream shortly`
          )
        }
        if (failures >= MAX_INPUT_STREAM_OPEN_FAILURES) {
          this.inputStreamFallbacks.add(key)
          this.inputStreamFallbackRetryAt.set(key, Date.now() + INPUT_STREAM_FALLBACK_RETRY_MS)
        }
      }
    )
    return { stream, ready: false }
  }

  refreshExpiredInputStreamFallback(key: string): void {
    const retryAt = this.inputStreamFallbackRetryAt.get(key)
    if (retryAt === undefined || Date.now() < retryAt) return
    this.inputStreamFallbacks.delete(key)
    this.inputStreamFallbackRetryAt.delete(key)
    this.inputStreamOpenFailures.delete(key)
  }

  closeInputStream(key: string, code = 1000, reason = 'closed'): void {
    const stream = this.inputStreams.get(key)
    this.inputStreams.delete(key)
    this.inputStreamReady.delete(key)
    this.inputStreamFallbacks.delete(key)
    this.inputStreamFallbackRetryAt.delete(key)
    this.inputStreamOpenFailures.delete(key)
    if (stream) {
      stream.close(code, reason)
    }
  }

  // Drop any cached HTTP-only fallback + failure count for an agent so a fresh
  // terminal attach gets another chance at the low-latency WS stream. Does not
  // disturb a healthy open stream.
  resetInputStreamFallback(key: string): void {
    this.inputStreamFallbacks.delete(key)
    this.inputStreamFallbackRetryAt.delete(key)
    this.inputStreamOpenFailures.delete(key)
  }

  closeInputStreamsForSession(sessionKey: string): void {
    const prefix = `${sessionKey}:`
    for (const key of Array.from(this.inputStreams.keys())) {
      if (key.startsWith(prefix)) {
        this.closeInputStream(key, 1000, 'project closed')
      }
    }
    for (const key of Array.from(this.inputStreamFallbacks)) {
      if (key.startsWith(prefix)) this.inputStreamFallbacks.delete(key)
    }
    for (const key of Array.from(this.inputStreamFallbackRetryAt.keys())) {
      if (key.startsWith(prefix)) this.inputStreamFallbackRetryAt.delete(key)
    }
    for (const key of Array.from(this.inputStreamOpenFailures.keys())) {
      if (key.startsWith(prefix)) this.inputStreamOpenFailures.delete(key)
    }
    for (const key of Array.from(this.inputStreamReady)) {
      if (key.startsWith(prefix)) this.inputStreamReady.delete(key)
    }
  }
}
