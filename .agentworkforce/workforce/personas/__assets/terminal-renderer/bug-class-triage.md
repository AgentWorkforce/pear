---
name: bug-class-triage
description: Use BEFORE reading source when a terminal rendering symptom is reported — maps the symptom (duplicate text, ghosting, smeared glyphs, cursor drift, blank canvas) by timing and shape to the most-likely cause and the file to open first.
---

# renderer-bug-class-triage

The lookup table from observed symptom to specific code path. Built from the PR #158 catalogue of fixes and the bugs found while shipping it. Use this **before** reading source — it disambiguates which file to open.

## Triage axis 1: timing

| Timing pattern | Implies bug class |
|---|---|
| Immediately on first attach | Snapshot vs replay race, font-settle race |
| Only after N tab switches | Side-effect of visibility change OR listener leak |
| Only after window cmd-tab | Window-focus handler programmatic focus |
| Only at first redraw of a TUI | Initial-mount focus cascade, no SIGWINCH bounce |
| Only under heavy streaming | Trim cap accounting, predictive echo backpressure |
| After resize | Spurious SIGWINCH, font measure / metric drift |
| After theme change | WebGL glyph atlas not invalidated |
| Only on display:none return | Stale WebGL frame, no `term.refresh()` |

## Triage axis 2: symptom shape

### Duplicate text

| Specific shape | Most likely cause |
|---|---|
| Exact byte-for-byte duplicate immediately after attach | **Snapshot-vs-replay race.** The snapshot contains chunks 1-50; the buffer also contains chunks 1-50; the subscriber sliced from 0 and replayed them. Fix: `flushPtyChunksNow(key)` + `writtenChunks = buffer.length` before subscribe. |
| Duplicate only after N tab switches; multiplier increases with N | **Listener leak.** Each tab switch added a new subscriber. Look for `subscribePtyBuffer` calls without paired `unsub`. |
| +1 identical Claude Code tool-card per tab switch back | **Focus events to a `?1004` TUI.** The visibility-effect fires `term.focus()` → focusin → `\e[I` → TUI redraws. Drop the auto-focus on visibility change. |
| +1 card per cmd-tab back to pear | **Window-focus handler** fires the same `term.focus()`. Drop it for the same reason. |
| ~5 cards on first agent spawn | **Initial-mount focus cascade.** Multiple setTimeouts firing `focusTerminal` at 0/50/150/300ms. Each emits `\e[I`. Reduce to one. |
| Identical message twice in chat under load | **Optimistic-vs-canonical chat dedup gap.** User's optimistic local-UUID record and the broker's canonical event_id record both survived id-based dedup. Fix: scope `local: true` flag + check content-window match for the canonical-of-optimistic case. |
| Same agent message twice in chat under load | **Cross-stream broker replay.** Same logical message delivered via `relay_inbound` AND `reconcileMessages` snapshot with mismatched event_ids. Fix: `isDuplicateAgentEcho` content-window guard with strict project equality. |

### Ghosting / scroll trail

| Specific shape | Most likely cause |
|---|---|
| Trail when sliding split pages | **Canvas under CSS transform.** `translateX` animation over a WebGL canvas produces ghost composites. Use `display: none/block` instead, paired with `runtime.refreshOnShow()`. |
| Smear during pane drag | **Backdrop-filter blur stacked over hot path.** Remove blur from the hot-path surfaces (terminal/chat). Keep blur only on transient dialogs. |
| Stale frame on tab return | **WebGL stale paint.** `display: none` skipped GPU paints; on return the canvas shows the last paint. Call `term.refresh(0, term.rows - 1)` on visibility flip. |

### Smeared / drifting glyphs

| Specific shape | Cause |
|---|---|
| Glyphs slightly misaligned on initial mount; fix themselves at next resize | **Font measurement racing font load.** `term.open()` measured fallback font; `document.fonts.load()` resolved later. Fix: `await document.fonts.load('13px "JetBrains Mono"')` before fit + refresh. |
| Glyphs paint with previous colors after theme change | **WebGL glyph atlas stale.** Theme swap didn't invalidate the texture atlas. Call `webglAddon.clearTextureAtlas()` (where supported) or accept stale glyphs until next major repaint. |
| Single frame of mis-sized glyphs on initial mount | **Font-settle race against WebGL load.** `loadWebgl` scheduled before `awaitFontSettle` resolved. Cosmetic, not load-bearing. Resolves on next refit. |

### Cursor drift / TUI breaks mid-stream

| Shape | Cause |
|---|---|
| Cursor lands in the wrong row after a CSI cursor-up | **TUI's expected row count differs from xterm's actual row count.** Resize wasn't propagated as SIGWINCH; TUI thinks it's 60 rows tall when it's actually 30. Fix: bounce SIGWINCH on initial attach. |
| Card appears at wrong location | Same root cause — absolute positioning landed at a stale row. |
| Card content sliced or partial | Predictive-echo write order race OR a `\e[K` after the cursor-up cleared too much OR alt-screen state leaked. |

### Visible duplicates in chat

| Shape | Cause |
|---|---|
| User sees their own message twice within ~10s | **Optimistic-vs-canonical.** `addHumanMessage` appended the local record; `relay_inbound` then appended the canonical without realizing it was the echo. Fix: `local: true` flag scoping + canonical-of-optimistic match. |
| User sees their identical "ok" send disappear when they double-send | **Over-eager echo dedup.** The guard collapsed two distinct user messages thinking the second was a canonical echo. Fix: drop content-window check from `addHumanMessage`; only apply on the canonical reception side. |
| Two distinct agents in the same channel can't send identical content | **Agent dedup false-positive on `from` not strict enough.** The guard didn't differentiate sender. Fix: include `from` in the content-window predicate. |

### Visible duplicates in terminal (NOT chunk-level)

| Shape | Cause |
|---|---|
| Same multi-line tool card stacked N times in scrollback | Cursor-positioning redraw failed (see "TUI breaks mid-stream"). Not a chunk-write bug — instrument to confirm: each chunk arrives once, each writeChunks fires once. Then look at the TUI's redraw pattern. |
| Streaming output renders twice per chunk | **Predictive echo write path doubled with direct write.** `writeChunks` should EITHER call `predictiveEcho.onServerOutput(chunk)` OR `liveTerm.write(chunk)`, never both. |

### Blank canvas / black screen

| Shape | Cause |
|---|---|
| Terminal pane is blank on first attach | `term.open()` was called with a zero-size container. Defer init to `requestAnimationFrame` and retry until `hasLayout(container)` returns true. |
| Split-page terminal blank when initially hidden | Same — the page mounted with `display: none`, zero-size, init bailed, never retried. Schedule `initIfReady` rAF retry on no-layout. |
| Terminal blanks after WebGL context loss | The `onContextLoss` handler dropped WebGL but didn't fall back to DOM. Set `suggestedRenderer = 'dom'` and dispose the failed addon. |

## How to use this table

1. Read the symptom literally. "+1 card per tab switch back" not "duplication."
2. Find the matching row above.
3. Open the named file/code path BEFORE forming a fix hypothesis.
4. If the symptom doesn't match any row → instrument before guessing (see `fix-discipline.md`).

## When the symptom is reported vaguely

The single most useful question to ask the user:

> Does this happen on first attach, or only after a specific action (tab switch, cmd-tab, resize, theme change)?

This disambiguates 80% of the bug-class space in one question.

If still ambiguous, the second question:

> When you scroll back, are the duplicates exact byte-for-byte (suggesting chunk replay) or do they look like rendered cards that should have been redrawn in place (suggesting cursor positioning failure)?

Now you can pick the right file to open.

## Companion reading

- `pty-broker-pipeline.md` — the chunk path
- `ansi-vt-sequences.md` — what cursor positioning sequences look like
- `fix-discipline.md` — what to do when the table doesn't match
