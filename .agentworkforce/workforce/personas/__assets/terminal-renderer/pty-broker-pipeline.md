---
name: pty-broker-pipeline
description: Use when diagnosing the PTY byte path from broker IPC to term.write — rAF chunk coalescing, the snapshot-vs-replay race on attach, SIGWINCH/resize redraws, trim-cap chunk loss, and predictive-echo reconciliation.
---

# pty-broker-streaming-pipeline

The end-to-end PTY byte path from the broker IPC into `term.write`, the races between snapshot and stream, and the discipline that prevents the duplicate-text bug class.

## Pipeline shape

```text
PTY child process
   ↓ raw bytes
broker (main process)
   ↓ IPC (broker:pty-chunk)
pear renderer
   ↓ appendPtyChunk(key, chunk)
pty-buffer-store
   ↓ rAF flush
runtime.writeChunks(tail)
   ↓ predictiveEcho.onServerOutput OR liveTerm.write directly
xterm.js
```

Each arrow is a place where the wrong invariant can cost you a "duplicate text" production bug.

## rAF coalescing (the why)

Bytes arrive at sub-frame granularity. Without coalescing, every chunk triggers a synchronous `term.write()` call and, for components subscribed to the buffer for previews, a React state update. Under heavy streaming, this pegs the renderer at <10 FPS during agent output.

The store stages incoming chunks per agent key:

```ts
const pending = new Map<string, string[]>()
const pendingFrames = new Map<string, number>()

function appendPtyChunk(key: string, chunk: string): void {
  const queue = pending.get(key)
  if (queue) queue.push(chunk)
  else pending.set(key, [chunk])
  if (pendingFrames.has(key)) return
  pendingFrames.set(key, requestAnimationFrame(() => flushPending(key)))
}
```

Subscribers see at most one notification per animation frame, with the new tail. The full buffer accumulates separately (capped at 10k chunks).

## Tail-only listener semantics

Notifications carry **only the new chunks since last flush**, not the full buffer history:

```ts
type Listener = (newChunks: string[]) => void
```

This sidesteps the trim race: if a subscriber held a `writtenChunks` offset and the buffer trims 50 entries off the head, the subscriber slicing `buffer.slice(writtenChunks)` would slice past the new tail's end and drop the freshly-added chunks. Tail-only listeners can't hit that bug — they receive the literal new chunks and trust the producer to handle accounting.

Cost: a subscriber that subscribes mid-stream must explicitly catch up against the canonical buffer:

```ts
unsubBuffer = subscribePtyBuffer(key, writeChunks)
const buffered = getPtyChunks(key)
writeChunks(buffered.slice(writtenChunks))  // initial catch-up
```

## Snapshot-vs-replay race

`broker.attachTerminal()` returns a snapshot of the screen state at some T₁ (the broker's view of the PTY's current visible buffer). Between T₁ and the moment pear writes the snapshot, more chunks arrive into the local buffer. Without care:

1. Write snapshot (state through T₁).
2. Set `writtenChunks = 0`.
3. Subscribe; subscriber replays `buffer.slice(0)` — the entire buffer, including the T₁ chunks already covered by the snapshot.

Result: duplicate text.

Fix: synchronously drain pending into the canonical buffer BEFORE capturing the baseline:

```ts
term.write(result.snapshot.screen)
flushPtyChunksNow(key)  // synchronous drain
writtenChunks = getPtyChunks(key).length
```

`flushPtyChunksNow` cancels any pending rAF and flushes immediately:

```ts
export function flushPtyChunksNow(key: string): void {
  const handle = pendingFrames.get(key)
  if (handle !== undefined) {
    cancelAnimationFrame(handle)
    pendingFrames.delete(key)
  }
  if (pending.has(key)) flushPending(key)
}
```

## SIGWINCH semantics

When the PTY is resized, the running TUI receives SIGWINCH and redraws. This is normal. The bug is **spurious** SIGWINCH:

- A `ResizeObserver` fires for every dragged pixel during a layout drag. Without debouncing + same-size-skip, every pixel produces an IPC `resizePty` → SIGWINCH → TUI redraw. The TUI's redraw output spams the chunk stream, the user sees visible judder.

Discipline:

```ts
let lastSentRows = -1, lastSentCols = -1
function fitAndSync(): void {
  const size = fitAddon.fit()
  if (!size) return
  if (size.rows !== lastSentRows || size.cols !== lastSentCols) {
    lastSentRows = size.rows
    lastSentCols = size.cols
    pear.broker.resizePty(projectId, agentName, size.rows, size.cols)
  }
}
```

Plus: debounce the ResizeObserver (75ms trailing), skip zero-size entries (allotment drags + `display:none` produce them).

## The SIGWINCH bounce (initial-attach case)

Ink-based TUIs (Claude Code) lock in their row/col count from initial state and only recompute on a winsize **change**, not initial value. If pear attaches and tells the broker `rows=42` and the TUI's notion is `rows=42`, no change happens — but the TUI was started with a default size and never matched the actual terminal. Subsequent redraws use the stale row count.

Fix: 200ms after `attachAndSeed()` completes, fire a one-row bounce (resize by one terminal row, not one pixel):

```ts
await broker.resizePty(projectId, name, rows - 1, cols)
// re-read in case user resized during the await
const currentRows = liveTerm.rows
const currentCols = liveTerm.cols
await broker.resizePty(projectId, name, currentRows, currentCols)
```

The intermediate `rows - 1` is NOT recorded in `lastSentRows/Cols` — the cache check would otherwise skip the bounce. The TUI gets one fake winsize change and recomputes its layout.

## Trim cap accounting

The buffer caps at `MAX_PTY_BUFFER_CHUNKS = 10_000`. When `combined.length > MAX`, trim the oldest entries:

```ts
const trimmed = combined.length > MAX ? combined.slice(combined.length - MAX) : combined
```

A subscriber that holds `writtenChunks = N` against the pre-trim buffer will, on the next listener notification, attempt to read at index N which is past the trimmed array's head. This is exactly why **tail-only listener semantics** are correct: the listener doesn't slice, it receives the tail explicitly. The buffer accumulation and subscriber accounting are decoupled.

If a subscriber needs to recover the full history (e.g. re-attach), they should:

```ts
const canonical = getPtyChunks(key)
// canonical is the post-trim canonical buffer; just replay from index 0
```

…and reset their own `writtenChunks` to `canonical.length` after replay.

## Channel separation: pty-chunk vs broker:event

PTY chunks ride a dedicated IPC channel (`broker:pty-chunk` in pear), not the general `broker:event` stream. The reason: structured-clone cost. Every `broker:event` is wrapped in a metadata envelope (kind, projectId, etc.) which Electron's IPC has to deep-clone. For per-keystroke streaming, that overhead pegs the main process.

`broker:pty-chunk` is `(projectId, name, chunk)` — three primitives, minimal cloning. If you find yourself routing PTY data through `broker:event` for any reason, that's the regression that costs you smooth typing.

## Predictive echo

Optional layer between the chunk arrival and `liveTerm.write`. Engine intercepts user input, optimistically renders predicted glyphs to the live terminal, and reconciles when authoritative server output arrives. Adaptive on measured echo latency (`getInputSrtt`), so on a fast local link it stays dormant (invisible).

Key invariants:

- Lives in a **headless xterm clone** (separate Terminal instance with `scrollback: 0`) that tracks confirmed cursor state. Don't read cursor position from the LIVE terminal to make prediction decisions — the live terminal contains optimistic glyphs and lies.
- Construction takes a `write` callback. The engine writes erase sequences (`\x1b[K`) for predicted glyphs and re-renders on reconciliation through this callback. Don't bypass it — direct `liveTerm.write()` plus engine writes will double-write.
- `onResize(cols, rows)` MUST be called when the live terminal resizes; otherwise the headless model's column counting drifts from reality and prediction lands at the wrong column.
- The `getInputSrtt` callback is captured at engine construction. If pear's React lifecycle creates a new `inputSrttRef` per hook mount but the engine survives across mounts, the engine reads a frozen ref forever. Trampoline through a runtime-owned slot and expose `setInputSrttGetter()` for re-binding.

## Companion reading

- `xterm-internals.md` — what consumes the chunks
- `ansi-vt-sequences.md` — what the chunks contain
- `bug-class-triage.md` — pattern-match symptoms to specific pipeline bugs
