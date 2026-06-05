# Agent Instructions

## Duplicate Event Hardening

Pear broker work must treat duplicate delivery as a normal failure mode. Renderer effects, dashboard reconnects, broker event-stream refreshes, and relay replay can all cause the same logical event to be observed more than once.

- Make lifecycle operations idempotent. `broker:start`, agent registration, integration notifications, and mount/link setup should return or record whether they actually changed state before triggering side effects.
- Coalesce concurrent starts or attaches with keyed in-flight promises. Repeated UI calls for the same project/root/channels should wait on the existing operation instead of starting another broker or event stream.
- Prefer stable event identity over content matching. PTY and broker events should carry `event_id`, `id`, or `seq`; dedupe by that identity first and use short content-based windows only as a fallback.
- Scope live event listeners with a generation token when reconnecting or refreshing streams. Stale callbacks from an older listener must bail before publishing IPC events.
- Keep PTY stream delivery separately guarded in main and renderer code. Main should suppress duplicate `worker_stream` chunks before `broker:pty-chunk`; renderer buffers should tolerate repeated chunk metadata as a final guardrail.
- Do not post integration or launch metadata on reused broker sessions. Notify agents only after a real broker start, reconnect, or state transition, and make repeated payloads no-ops when possible.
- Add regression tests when touching broker start, event streaming, PTY buffering, spawned personas, or integration notifications. Include duplicate/replay cases, not just the happy path.
- Add low-noise telemetry for suppressed duplicates and missing event identity so replay issues are visible without flooding the terminal.
