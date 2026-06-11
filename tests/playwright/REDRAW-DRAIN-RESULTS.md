# Redraw-drain harness — results

Headless measurement of terminal renderer drain under heavy TUI redraw
streaming (the "typing lag" class). Real `@xterm/xterm` + real predictive-echo
in headless Chrome, driven by `window.__pearMock.injectPtyChunk` and read back
through the `__pearReadTerminalViewport` registry probe.

Run: `npm run test:redraw` (builds the web/mock bundle, then Playwright).

## Why burst mode matters

`REDRAW_BURST_FRAMES` (default 16) injects N redraw frames back-to-back with no
yield, so they all land in **one** `pty-buffer` rAF flush — the exact condition
`writeChunks` coalescing acts on. With one chunk per frame (paced mode) the
coalescing change is a no-op and the harness cannot see it; burst mode is what
isolates it.

## Per-chunk vs coalesced (burst: 16 frames/flush × 120 rounds = 1920 frames)

Coalescing measured by toggling `writeChunks` between the per-chunk loop
(main baseline) and the single coalesced write (PR: "coalesce per-frame PTY
chunks into one xterm write").

| Metric | Per-chunk (baseline) | Coalesced | Effect |
|---|---|---|---|
| Max render lag | 1773 frames | 16 frames | bounded to one burst |
| Frames rendered | 833 / 1920 (43%) | 1920 / 1920 (100%) | fully drains |
| Drained within 8s | no (never) | yes (26ms) | — |
| Longest frame | 119.7ms | 53.8ms | ~2× shorter |

Under per-chunk writes the renderer falls ~1773 frames behind and never catches
up (only 43% of injected frames ever render). Coalescing collapses the N
predictive-echo headless-model parses + promise ticks into one per flush; the
grid then keeps up — full drain, lag bounded to the current burst, longest
frame nearly halved.

Numbers are from a single dev-machine run (macOS, headless Chrome) and are
indicative, not thresholds. The suite GATES on the machine-independent drain
invariants (`drained === true` within the deadline and
`finalFrameRendered === true`) so a parser-backlog regression fails CI, while
the timing metrics stay informational. Byte-for-byte correctness of
coalescing is proven separately by the real-parser equivalence unit test
(`src/renderer/src/lib/pty-coalesce-equivalence.test.ts`), and routing
correctness (direct/engine transitions, reseed, flood bypass) by
`src/renderer/src/lib/echo-router.test.ts`.

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `REDRAW_BURST_FRAMES` | 16 | frames injected per rAF flush (set 1 for paced mode) |
| `REDRAW_BURST_ROUNDS` | 120 | number of bursts |
| `REDRAW_PANEL_ROWS`/`COLS` | 24 / 80 | redraw panel size |
| `REDRAW_DRAIN_TIMEOUT_MS` | 8000 | how long to wait for the grid to catch up |
| `REDRAW_LABEL` | redraw-baseline | label stamped into the result JSON |
| `REDRAW_RESULT_PATH` | — | append result JSON to this file |
