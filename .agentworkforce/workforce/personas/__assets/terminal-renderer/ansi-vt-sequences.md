# ansi-vt-escape-sequences

The byte-level command vocabulary TUIs use to drive the terminal. When you can read the chunks, you can name the bug.

## Sequence taxonomy

All escape sequences start with `\x1b` (ESC, often shown as `\e` in logs). Then:

- `\e[ ...` — **CSI** (Control Sequence Introducer). The bulk of cursor / color / mode commands.
- `\e]...` — **OSC** (Operating System Command). Window title, hyperlinks, cursor color.
- `\eP...` — **DCS** (Device Control String). Sixel graphics, terminfo queries.
- `\eN ...`, `\eO ...` — **SS2 / SS3**. Single-shift to alternate character sets.
- `\e(B`, `\e(0` — **Character set designation** (no space between `(` and the final byte). `B` = US-ASCII, `0` = DEC special graphics.
- `\eM`, `\eD`, `\eE` — **Cursor controls outside CSI**. Reverse index, index, next line.

CSI subforms:
- `\e[ <params> <final>` — standard
- `\e[ ? <params> <final>` — private (DECSET / DECRST family)
- `\e[ > <params> <final>` — secondary device attributes
- `\e[ ! ...` — soft terminal reset family

## Cursor movement

| Sequence | Meaning |
|---|---|
| `\e[A`, `\e[<n>A` | Cursor up 1 or n rows |
| `\e[B`, `\e[<n>B` | Cursor down n rows |
| `\e[C`, `\e[<n>C` | Cursor right n columns |
| `\e[D`, `\e[<n>D` | Cursor left n columns |
| `\e[<r>;<c>H` | Absolute position (1-indexed) |
| `\e[H` | Position (1,1) — home |
| `\e[s` / `\e[u` | Save / restore cursor |
| `\e[6n` | Query cursor position (terminal responds `\e[<r>;<c>R`) |

**Cursor up beyond row 1 pegs at row 1.** It does NOT scroll history into view. Cursor up from row 1 = cursor stays at row 1.

**Absolute positioning** is what TUIs use for in-place redraws. The TUI's notion of "the card is at rows 5-15" depends on the row count never changing under it. If pear's viewport scrolls or buffer trims a row off, the TUI's `\e[5;1H` lands at a different visible row than it expected → stacked redraws.

## Line / screen clearing

| Sequence | Meaning |
|---|---|
| `\e[K` | Clear from cursor to end of line |
| `\e[1K` | Clear from start of line to cursor |
| `\e[2K` | Clear entire line |
| `\e[J` | Clear from cursor to end of screen |
| `\e[1J` | Clear from start of screen to cursor |
| `\e[2J` | Clear entire screen |
| `\e[3J` | Clear scrollback (xterm extension) |

`\e[2J` does NOT reset the cursor. Many TUIs follow it with `\e[H` for the clear-and-home idiom.

## Scroll region

`\e[<top>;<bottom>r` — set the scroll region to rows `top` through `bottom` (1-indexed). All subsequent scrolling is contained within this region. Used by TUIs to keep a status bar at the bottom while content scrolls above it.

## DECSET / DECRST modes (private CSI ?)

The modes that change behavior xterm-wide. Format: `\e[?<n>h` to set, `\e[?<n>l` to reset.

| Mode | Effect | Bug class |
|---|---|---|
| `?25` | Cursor visibility (h = show, l = hide) | Hidden cursor on tab return = TUI forgot to re-show after losing focus |
| `?1000` | X10 mouse tracking | Mouse clicks emit as bytes to the PTY |
| `?1006` | SGR mouse encoding (modern) | Same |
| `?1004` | **Focus event reporting** | TUI receives `\e[I` / `\e[O` on focusin / focusout — **stacked redraws on `term.focus()` calls** |
| `?1049` | Alt-screen with state save | vim/htop entry/exit. Main buffer untouched. |
| `?2004` | Bracketed paste | Pasted text wrapped in `\e[200~` / `\e[201~` so TUI distinguishes from typed input |
| `?2026` | **Synchronized output mode** | TUI wraps a multi-write frame in begin/end markers; terminal defers paint until end marker. Avoids tearing on multi-chunk redraws. |
| `?7` | Auto-wrap mode | Off = cursor pegs at right edge, doesn't auto-wrap |

**?1004 + programmatic focus = stacked redraws.** This is the bug class behind "+1 card per tab switch back" when a TUI like Claude Code's Ink renderer is running. Fix is not to suppress the mode; fix is not to call `term.focus()` on every visibility change in the host.

**?1049 vs main buffer**: alt-screen is a clean canvas. The TUI draws once, exits, and the main buffer is exactly as it was. vim and htop are the canonical users. If you see "the TUI's output is in scrollback after I exited it", the TUI didn't use alt-screen — it drew directly into the main buffer. This is the failure mode behind Claude Code's tool-card history.

**?2026 sync mode**: codex-1's TUI uses this. Each redraw frame is bracketed:

```text
\e[?2026h     ← begin sync
\e[H          ← home cursor
<card content>
\e[?2026l     ← end sync, atomic paint
```

xterm.js supports it in recent versions. If you don't see card stacking on codex-1 but do on Claude Code, sync mode is one of the differences.

## OSC (Operating System Command)

Terminated by `\x07` (BEL) or `\e\\` (ST).

| Sequence | Meaning |
|---|---|
| `\e]0;<title>\x07` | Set window title |
| `\e]8;;<url>\e\\<text>\e]8;;\e\\` | Hyperlink (clickable text) |
| `\e]10;<color>\x07` / `\e]11;...` | Set fg / bg color |
| `\e]52;c;<base64>\x07` | OSC 52 clipboard write — security-relevant |

## DCS (Device Control String)

Terminated by `\e\\` (ST).

Most common: sixel graphics `\eP<params>q<data>\e\\`. Not all xterm builds support it. Image addon required.

## Character sets

`\e(B` = US-ASCII (default). `\e(0` = DEC special graphics (box-drawing). Some legacy TUIs switch to the special set to draw `┌─┐│` style boxes; if you see weird non-ASCII characters in scrollback after a TUI exits without restoring `\e(B`, the set wasn't restored.

## TUI redraw patterns

Three flavors, each with a different failure mode:

### 1. Redraw-in-place via cursor positioning

The TUI emits a card, then later moves cursor back up and rewrites the same lines. Example: Claude Code's tool cards.

- **Works when**: the cursor's row in the buffer hasn't moved (no intervening scroll, no buffer trim).
- **Fails when**: viewport scrolled OR buffer trimmed OR the TUI's notion of row count is stale (no SIGWINCH on resize).
- **Symptom**: stacked duplicate cards in scrollback.

### 2. Alt-screen full-redraw

The TUI enters `?1049h`, draws everything, exits on close. Example: vim, htop, less.

- **Works**: always cleanly. Main buffer preserved.
- **Fails**: rarely. Alt-screen state can leak if the TUI is killed without sending `?1049l` (resize the terminal, scrollback shows alt-screen contents instead of main).

### 3. Synchronized output (?2026)

The TUI brackets each frame between `?2026h` / `?2026l`. Example: codex-1's TUI.

- **Works**: tear-free atomic frames.
- **Fails**: xterm versions without ?2026 support ignore the brackets and the frame content streams in normally — typically still works because the cursor-positioning model is the same as pattern 1.

## How to read a chunk preview

When debugging a chunk stream, replace escapes with readable markers:

```ts
function previewChunk(chunk: string): string {
  return chunk.slice(0, 80)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\x1b/g, '\\e')
}
```

A chunk like `"\\e[H\\e[5;1H\\e[K"` reads as: "home cursor, move to row 5 col 1, clear to end of line". Now you can match it against the bug class catalogue.

## Companion reading

- `pty-broker-pipeline.md` — how chunks arrive
- `bug-class-triage.md` — symptoms ↔ specific sequences
