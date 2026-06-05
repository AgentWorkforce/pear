# Duplicate Event Hardening

Treat duplicate broker/event delivery as expected behavior in Pear. Renderer startup flows, dashboard reconnects, broker stream refreshes, relay replay, and spawned persona sessions can all surface the same logical event more than once.

When changing broker start, event streaming, PTY output, spawned personas, or integration notifications:

- Make side effects idempotent and return whether state actually changed before notifying agents or publishing metadata.
- Coalesce same-project start/attach calls with keyed in-flight promises.
- Dedupe live events by stable identity (`event_id`, `id`, or `seq`) before falling back to short content-based suppression.
- Use generation tokens for refreshed listeners so stale event streams cannot publish IPC output.
- Preserve PTY-specific duplicate guards in main and tolerate repeated chunk metadata in renderer buffers.
- Add regression tests for replay, reconnect, repeated `ensureBroker()`, and repeated terminal output cases.
