# xterm-internals-and-renderers

The xterm.js parser pipeline, renderer trade-offs, addon discipline, and the bits of internal state that matter when something paints wrong.

## Parser pipeline

Bytes from `term.write(data)` flow through:

```
Parser → InputHandler → Buffer → Renderer
```

- **Parser**: state machine over the VT/ANSI byte stream. Recognizes CSI / OSC / DCS / SS3 / ESC sequences and decodes their parameters.
- **InputHandler**: dispatches parsed commands to buffer mutations (cursor movement, text writes, mode toggles).
- **Buffer**: the in-memory grid. Two buffers exist — `buffer.normal` (main, with scrollback) and `buffer.alternate` (alt-screen, no scrollback, used by full-screen TUIs like vim/htop).
- **Renderer**: paints the buffer's visible viewport to the DOM (DOM/Canvas/WebGL).

Behavioral consequences:

- Cursor movement (`CSI <r>;<c> H`) operates on the buffer grid, not on what's visible. Move up 60 lines from row 1 → cursor pegs at row 1, can't go negative.
- Alt-screen entry/exit (DECSET ?1049 h/l) swaps buffer references. State save/restore happens at the same time. Tools like vim look perfect on exit because the main buffer is exactly as you left it.
- Scrollback trim (when `scrollback: N` is exceeded) drops oldest lines off the top of `buffer.normal`. The cursor's absolute row position adjusts accordingly. TUIs using absolute positioning (cursor up by literal row count from current) break when their target row has been trimmed.

## Renderer trade-offs

xterm.js ships three renderer modes. Pick by failure profile, not by feature list.

- **DOM renderer**: one DOM element per cell. Slowest under heavy streaming. Most compatible. Falls back to it when the Canvas/WebGL renderers crash. Diagnostics that bypass the renderer (extension dev tools inspecting cell contents) work cleanly.
- **Canvas renderer**: 2D canvas blits per row. Mid-tier perf. Fewer addons interact with it well.
- **WebGL renderer**: glyph atlas, GPU-accelerated. Fastest by an order of magnitude under heavy streaming. Failure modes: context loss (browser releases the GL context under memory pressure → entire renderer goes black), addon construction throw, glyph cache invalidation issues after theme change or font reload.

Discipline:

- **Load WebGL deferred** (next `requestAnimationFrame` after `term.open()`), so the terminal opens in DOM mode first and upgrades on next frame. Half-initialized WebGL is much worse than DOM rendering.
- **Persist DOM fallback decision**: on construction throw or `onContextLoss`, set a module-level `suggestedRenderer = 'dom'` and have subsequent runtimes skip WebGL for the session. Don't try to re-init WebGL on the same page once it has failed.
- **Theme swap with WebGL**: the glyph atlas caches with previous colors. Call `webgl.clearTextureAtlas()` (if available in your xterm version) after `term.options.theme = newTheme`. Otherwise glyphs paint stale until next refresh.

## Addon lifecycle

Each addon should be loaded **once** per Terminal instance:

```ts
term.loadAddon(addon)
```

If you call `loadAddon` again with the same addon, behavior is undefined — most versions stack instances and leak GPU resources (WebGL) or duplicate event handlers. Pattern that avoids the bug:

```ts
let webglAddon: WebglAddon | null = null
function loadWebgl(term: Terminal): void {
  if (webglAddon) return  // single-load discipline
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      addon.dispose()
      suggestedRenderer = 'dom'
    })
    term.loadAddon(addon)
    webglAddon = addon
  } catch {
    suggestedRenderer = 'dom'
  }
}
```

## Focus mode (DECSET ?1004)

When a TUI emits `CSI ? 1004 h`, xterm starts reporting textarea focus changes back to the PTY as `\x1b[I` (focus-in) and `\x1b[O` (focus-out). Every programmatic `term.focus()` call fires `focusin` on the underlying textarea, which then emits `\x1b[I`. TUIs that redraw on focus (Claude Code's Ink-based tool cards) stack a new card per focus event.

Diagnostic: if your symptom is "+1 stacked card per tab switch back" and your visibility effect calls `term.focus()`, this is your bug. Drop the auto-focus on visibility change; let `pointerdown` handle user-initiated focus.

## Viewport vs scrollback

Two coordinate systems to keep separate:

- **Viewport**: the rows currently visible on screen. `term.refresh(0, term.rows - 1)` repaints viewport rows from buffer state.
- **Scrollback**: the entire buffer, including rows that have scrolled off the top. Indexed by `buffer.active.baseY` (cumulative). The visible viewport's top row is at `buffer.active.viewportY`.

`scrollToBottom()` moves the viewport so its bottom equals `baseY + rows - 1`. It does NOT move the cursor. The cursor stays wherever it was in the buffer, possibly off-screen.

Consequence: streaming output naturally pins the viewport at the bottom (auto-scroll). If the user is scrolled up reading history, you should NOT call `scrollToBottom()` on every chunk write — that yanks them away from history. Capture `wasPinned = isViewportPinnedToBottom(term)` BEFORE writing chunks, and only call `scrollToBottom()` if `wasPinned`.

## Font measurement timing

xterm measures cell width by inspecting the loaded font at `term.open()` time. If the configured font (e.g. JetBrains Mono) is still loading when `open()` is called, xterm measures the fallback font instead and locks in the wrong cell width. Glyphs look slightly smeared / misaligned until the next resize triggers re-measurement.

Fix:

```ts
await document.fonts.load('13px "JetBrains Mono"')
fitAddon.fit()
term.refresh(0, term.rows - 1)
```

Cap with a timeout so a missing font doesn't hang the open path forever.

## Cursor blink

The cursor blink lives on its own timer, separate from any render frame. `cursorBlink: true` + `cursorStyle: 'bar'` interact differently from `cursorStyle: 'block'` in some xterm versions — the bar is a CSS animation, the block is a paint timer. Don't assume behavior is identical across configurations.

## Companion reading

- `react-lifecycle-decoupling-and-token-ownership.md` — what owns the Terminal across React mounts
- `pty-broker-streaming-pipeline.md` — what feeds `term.write` and how it fails
- `ansi-vt-escape-sequences.md` — the sequence reference TUIs emit
