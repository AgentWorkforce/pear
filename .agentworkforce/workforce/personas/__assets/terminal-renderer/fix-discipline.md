# fix-discipline-and-instrumentation

The operating discipline that keeps renderer fixes from being speculative or regressing. Read this before writing any fix.

## The one-write invariant

> Each PTY chunk that arrives from the broker is written to `term.write` exactly once.

When duplication appears, count the writes. The bug is in exactly one of three places:

1. **Upstream** — the chunk arrives at `appendPtyChunk` twice. Broker re-emit, double subscribe, or main-process worker-stream replay. Not a renderer bug.
2. **Pipeline** — the chunk arrives once but the listener fires twice. Listener leak in the registry (two `subscribePtyBuffer` without paired unsub).
3. **TUI re-emit** — the chunk arrives once, fires once, but the TUI emits the same content again later (cursor positioning failed, redraw stacked). Not a chunk dup; an interpretation bug.

You **must** know which before writing a fix. Add instrumentation if you can't tell from reading.

## Read before guessing

For any reported renderer bug, before writing a fix:

1. Open the file the user named.
2. Trace from the producer (`broker:pty-chunk` IPC arrival) to the consumer (`term.write`) and identify every place a chunk could be duplicated, dropped, or interpreted wrong.
3. Name the specific step that produces the observed symptom.
4. If you can't name the step, you don't have a fix — you have a guess.

Examples of "naming the step":

- ✅ "Line 234 of predictive-echo.js writes the chunk before line 236 awaits the model write. The model write is the only thing that suspends, so if `onResize` fires between them, the model is sized for post-resize cols while the chunk was written assuming pre-resize cols. Mis-attributes column counts."
- ❌ "It might be a race in predictive echo."

The first is a fix hypothesis you can confirm or reject. The second is a paragraph of vague speculation that wastes review time.

## Pattern-match symptom to bug class

Before opening any file, use `renderer-bug-class-triage.md` to map the symptom to a candidate file. "+1 stacked card per tab switch" is not a triage prompt — it IS the bug class signal. Open the visibility-effect code path; don't read the chunk pipeline.

When multiple classes fit, plan the cheapest disambiguation experiment first. Often: a temporary `console.log` at the chunk-write site counting writes per chunk. Five minutes of instrumentation beats two hours of speculative fixes.

## Minimal-diff scope

A 5-line targeted change in the right file beats a 50-line refactor across three files. If a fix requires touching unrelated abstractions, the bug class is probably different from what you think — re-check the triage.

Specifically:

- Don't refactor architecture beyond the minimum the fix needs.
- Don't introduce new abstractions "for future flexibility." The next renderer bug will be different and you'll have built the wrong abstraction.
- Don't add config knobs ("disable virtualization fallback", "fall back to DOM renderer if WebGL fails twice"). Each knob adds a new failure mode.
- Don't paper over a duplication symptom by adding a dedupe layer downstream. Find where the duplicate is introduced upstream and remove it there.

## Instrument-don't-guess after two failed fixes

After two consecutive fixes for the same symptom fail, the third action is **temporary instrumentation**, never another speculative fix.

The instrumentation must:

1. Capture **literal runtime values**, not assumptions. If you think a listener is firing twice, log the listener-call count + a preview of the chunk per call.
2. Be **gated behind a localStorage flag** so production renderers don't pay the cost:

```ts
let __diagChecked = false
let __diagEnabled = false
export function diagEnabled(): boolean {
  if (__diagChecked) return __diagEnabled
  __diagChecked = true
  try {
    __diagEnabled = localStorage.getItem('PEAR_DIAG_PTY') === '1'
  } catch {
    __diagEnabled = false
  }
  return __diagEnabled
}

// at the call site:
if (diagEnabled()) {
  console.log(`[diag:pty-append] key=${key} bytes=${chunk.length} preview="${preview}"`)
}
```

3. Be **reverted in the same PR cycle** as the root-cause fix. Never leave diagnostics live in production. The localStorage gate makes this safe-by-default, but the code still adds noise to the file.

Enable for capture:

```
localStorage.setItem('PEAR_DIAG_PTY', '1')
location.reload()
// ... reproduce the bug
// copy console output
localStorage.removeItem('PEAR_DIAG_PTY')
```

## Defensive fixes name the UX trade-off

If a fix accepts a UX cost to suppress a bug:

- ✅ "Dropped auto-focus on visibility change. UX cost: one extra click after tab switch to focus the terminal. Worth it because the focus event was producing a stacked card per switch on Claude Code's TUI."
- ❌ Silent commit message: "fix: tab switch issue."

Name the trade-off in the commit body so the operator can decide whether to accept it. Defensive fixes are legitimate but they're explicit choices.

## When AGENTS.md requires regression tests

Pear's `AGENTS.md`:

> Add regression tests when touching broker start, event streaming, PTY buffering, spawned personas, or integration notifications. Include duplicate/replay cases, not just the happy path.

This supersedes any "manual test plans are the contract" default. The PTY buffering layer is **unit-testable** with vitest against the `pty-buffer-store` (no DOM needed). The agent-store reconciler is unit-testable. The runtime registry is unit-testable with `happy-dom` + an xterm mock.

What the manual test plan IS for: visual rendering / paint timing / GPU compositing — things genuinely not automatable in a headless runner. That carve-out is the anti-goal, not "skip all tests."

A regression test for a duplication bug should:

1. Set up the exact pre-condition the bug needed (e.g. buffer state, subscribed listeners).
2. Trigger the action that produced the dup.
3. Assert the post-state is correct (count of records, listener-fire count, etc.).

If you can't write that test, the bug isn't fully understood yet.

## What "battle-tested" means for a renderer fix

A renderer fix is proven only when:

1. The failure-class regression test runs RED without the fix (so you know the test isn't vacuous).
2. The test runs GREEN with the fix.
3. Heavy-load behavior (stress-test harness) doesn't regress on a related metric.
4. The manual-test repro the operator can run no longer surfaces the bug.

"It worked once on my machine" is not battle-tested. "It passes vitest" is necessary but not sufficient — vitest can't catch frame timing or GPU compositing bugs.

## Don't recommend a fix you wouldn't sign your name to

The output of a renderer-bug investigation is:

- **Diagnosis**: file:line + specific code-path + escape-sequence behavior that produces the symptom.
- **Fix**: file:line + minimal-diff scope.
- **Gates**: typecheck, build, vitest pass; manual test plan with concrete repro steps.
- **UX trade-off** (if any) named explicitly.
- **What couldn't be validated** without running the app.

If you can't fill in all five, you don't have a fix yet. Say so. Propose the smallest diagnostic experiment that would let you fill them in.

## Antipatterns

- **Retry loops without root-cause**: "If the broker IPC fails, retry 3 times" hides the actual bug.
- **Polling fallbacks**: "If the event doesn't arrive, poll every 5s." Now you have two delivery mechanisms drifting apart.
- **Catch-all `try { } catch { /* ignore */ }`**: swallows the next bug that surfaces in the same code path.
- **Adding a SIGWINCH bounce "to be safe"**: each fake resize is a TUI redraw cost. Don't add bounces speculatively — only when you've confirmed the TUI keys initial paint off a winsize change.
- **"Should be fine"**: every renderer bug landed in main was "should be fine" at some point.

## Companion reading

- `renderer-bug-class-triage.md` — what to consult before opening any file
- `pty-broker-streaming-pipeline.md` + `xterm-internals-and-renderers.md` — the systems the discipline applies to
