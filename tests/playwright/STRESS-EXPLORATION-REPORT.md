# Renderer Stress Exploration Report

## Setup

- Branch: `claude/stress-exploration`
- Base commit tested: `8c7278b`
- Hardware: Apple M4, 10 physical cores / 10 logical cores, 16 GB memory
- Node: `v25.8.1`
- Browser: Playwright Chromium
- Harness: `tests/playwright/stress-explorer.spec.ts`, served with the existing Vite preview config on `127.0.0.1:4174`

## Method

The explorer spec is parameterized with:

- `STRESS_LABEL`
- `STRESS_PROFILE=pty-heavy|chat-heavy`
- `STRESS_AGENT_COUNT`
- `STRESS_DURATION_MS`
- `STRESS_EVENTS_PER_SEC`
- `STRESS_CHAT_RATIO` from `0` to `1`
- `STRESS_RESULT_PATH` for JSONL output

Each configuration is intended to run twice. If min FPS, average FPS, or longest-frame results vary by more than 20%, run a third time and report the median. FPS failure is recorded as data rather than failing the test process, so a ramp can continue after finding the first break point.

For duration runs, the explorer also records first/last one-second FPS windows, first/last 30-second FPS windows, and heap snapshots where Chromium exposes them. CDP heap sampling was added after the 2-minute and 5-minute duration runs; those first duration rows only have the coarser in-page `performance.memory` fields.

## Scaling Table

| Axis | Profile | Agents | Events/sec/agent | Duration | Chat ratio | Total events | min FPS | avg FPS | Longest frame | Console errors | Pass/fail | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Baseline reference | pty-heavy | 1,000 | 10 | 30s | ~0.3% final chat outside FPS window | 300,000 | 51.0 | 58.5 | 67.3ms | 0 | PASS | Broker-provided validated baseline from `stress-1000-agents.spec.ts`. |
| Baseline reference | chat-heavy | 1,000 | 10 | 30s | ~1.7% | 304,000 | 20.0 | 39.3 | 133.5ms | 0 | FAIL | Broker-provided expected-fail calibration. |
| Agent ramp | custom PTY-only | 1,000 | 10 | 30s | 0% | 300,000 | 48.5 | 58.7 | 75.3ms | 0 | PASS | Two runs: min FPS 50, 47. |
| Agent ramp | custom PTY-only | 1,250 | 10 | 30s | 0% | 375,000 | 46.0 | 55.7 | 75.2ms | 0 | PASS | Two runs: min FPS 46, 46. |
| Agent ramp | custom PTY-only | 1,500 | 10 | 30s | 0% | 450,000 | 39.0 | 49.0 | 67.5ms | 0 | PASS | Two runs: min FPS 39, 39. |
| Agent ramp | custom PTY-only | 1,625 | 10 | 30s | 0% | 487,500 | 31.0 | 44.8 | 83.5ms | 0 | PASS | Three runs after mixed pass/fail: min FPS 29, 31, 34. Median just clears gate. |
| Agent ramp | custom PTY-only | 1,750 | 10 | 30s | 0% | 525,000 | 27.5 | 43.3 | 141.8ms | 0 | FAIL | Two runs: min FPS 28, 27. Sustained low FPS with intermittent long frames. |
| Agent ramp | custom PTY-only | 2,000 | 10 | 30s | 0% | 600,000 | 27.5 | 43.7 | 109.4ms | 0 | FAIL | Two runs: min FPS 27, 28. Sustained low FPS, no crash. |
| Event-rate ramp | custom PTY-only | 1,000 | 25 | 30s | 0% | 750,000 | 50.5 | 58.5 | 68.0ms | 0 | PASS | Two runs: min FPS 49, 52. Higher line count alone did not reproduce the 2k-agent failure. |
| Event-rate ramp | custom PTY-only | 1,000 | 50 | 30s | 0% | 1,500,000 | 51.5 | 58.8 | 66.8ms | 0 | PASS | Two runs: min FPS 51, 52. |
| Event-rate ramp | custom PTY-only | 1,000 | 100 | 30s | 0% | 3,000,000 | 51.5 | 58.7 | 76.0ms | 0 | PASS | Two runs: min FPS 52, 51. |
| Event-rate ramp | custom PTY-only | 1,000 | 250 | 30s | 0% | 7,500,000 | 49.0 | 58.6 | 82.9ms | 0 | PASS | Two runs: min FPS 50, 48. No crash or timeout despite high line volume. |
| Chat mix ramp | custom | 1,000 | 10 | 30s | 1% | 300,000 | 30.0 | 46.4 | 68.3ms | 0 | PASS | Three runs after mixed pass/fail: min FPS 29, 30, 31 with 3,000 chat events. Borderline. |
| Chat mix ramp | custom | 1,000 | 10 | 30s | 2.5% | 300,000 | 26.0 | 50.7 | 67.9ms | 0 | FAIL | Two runs: min FPS 27, 25 with 7,500 chat events. |
| Chat mix ramp | custom | 1,000 | 10 | 30s | 5% | 300,000 | 25.5 | 50.1 | 82.4ms | 0 | FAIL | Two runs: min FPS 24, 27 with 15,000 chat events. 10%/25% were skipped after this confirmed the lower break. |
| Duration ramp | custom PTY-only | 1,000 | 10 | 2m | 0% | 1,200,000 | 50.0 | 59.1 | 75.1ms | 0 | PASS | Two runs: min FPS 49, 51. First 30s avg 58.6/58.7; last 30s avg 59.2/59.2. |
| Duration ramp | custom PTY-only | 1,000 | 10 | 5m | 0% | 3,000,000 | 50.5 | 59.1 | 68.2ms | 0 | PASS | Two runs: min FPS 50, 51. First 30s avg 58.9/58.9; last 30s avg 59.2/59.3. |
| Duration ramp | custom PTY-only | 1,000 | 10 | 15m | 0% | TBD | TBD | TBD | TBD | TBD | TBD | Pending. |
| Combined high-load | custom | 5,000 | 50 | 5m | 25% | TBD | TBD | TBD | TBD | TBD | TBD | Pending. |

## Break Point Analysis

### Agent Count Ramp

At 10 logical events/sec/agent with PTY aggregation every 10 ticks, 1,500 agents passes consistently and 1,750 agents fails consistently. The 1,625-agent midpoint straddled the invariant with min FPS 29, 31, and 34; by median it passes, but it is too close to the 30 FPS gate to treat as stable headroom.

The practical break point on this machine is therefore between 1,625 and 1,750 agents, or roughly 16k-17.5k logical PTY events/sec spread across independent agent streams. The failure mode is sustained lower frame throughput plus intermittent long frames, not a browser crash, hang, or console-error failure.

### Event-Rate Ramp

At fixed 1,000 agents, increasing PTY event rate up to 250 events/sec/agent still passed twice at every point. The 250-rate configuration generated 7.5 million logical PTY events in the 30s window while keeping min FPS at 48-50.

This isolates the PTY-heavy break away from pure total line volume or total bytes/sec. The renderer can absorb very large aggregated chunks for 1,000 streams, but not the larger number of independent streams in the agent-count ramp.

### Chat Mix Ramp

At fixed 1,000 agents and 10 logical events/sec/agent, the chat mix threshold is much lower than the PTY line-volume threshold. A 1% chat mix produced 3,000 chat messages and landed exactly on the gate by median, with min FPS 29, 30, and 31. A 2.5% chat mix produced 7,500 chat messages and failed twice. A 5% chat mix produced 15,000 chat messages and failed twice, with the lowest observed min FPS at 24.

The failure mode is sustained low per-second FPS during the run, not one-off long-frame spikes. Longest frames stayed in the 68-83ms range for these custom chat runs, while min FPS dropped because many seconds spent too much time in repeated chat reconciliation/render work. The 10% and 25% chat cases were intentionally skipped after 5% failed twice; they would not refine the lower break point.

### Duration Ramp

The safe 1,000-agent PTY-only profile does not show FPS drift through 5 minutes. Both 2-minute runs and both 5-minute runs passed with min FPS at or above 49, and every run's last 30-second average FPS was slightly higher than its first 30-second average FPS.

The in-page `performance.memory` reading stayed flat within each of these runs, but this appears too coarse to rely on. CDP heap sampling has been added for the remaining 15-minute and combined runs.

## Bottleneck Hypothesis

Current data suggests the PTY-heavy break is driven more by agent/stream multiplicity than by raw PTY line count. The renderer stays smooth at 1,000 streams with up to 250k logical PTY events/sec, but drops below the FPS gate at 1,750-2,000 streams with only 17.5k-20k logical PTY events/sec.

Likely contributors are per-agent terminal bookkeeping, PTY buffer fanout by agent key, store reconciliation over larger agent collections, and DOM/list work associated with many tracked agents. The known chat-heavy expected-fail remains a separate per-row chat rendering bottleneck.

The chat mix data confirms a separate chat-path bottleneck: even 3,000 live chat messages over 30s is borderline, and 7,500 chat messages fails consistently. That points at message reconciliation, chat list virtualization pressure, markdown formatting, `ChatMessage` subtree cost, and agent metadata lookups in chat rows.

## Recommendations

Recommendations from the completed axes:

- Add a perf regression target around 1,625-1,750 PTY-only agents at 10 events/sec/agent; this is the current knee.
- Profile per-agent PTY dispatch and terminal bookkeeping before optimizing raw chunk size. The 25 events/sec result suggests throughput bytes are not the first limit.
- Keep PTY aggregation in place for high-volume stream traffic; removing it turns the test into a per-tick chunk churn benchmark and inflates wall time.
- Add a chat-mix regression target around 1%-2.5% chat at 1,000 agents and 10 events/sec/agent; this is the current chat-path knee.
- Treat the chat-heavy profile as a separate optimization track: reduce per-row chat render work, memoize agent metadata lookup used by chat rows, and consider batching/debouncing message reconciliation under replay bursts.
- Add a follow-up "agents but non-rendered" explorer mode before the next production fix. If 2,000+ spawned agents stay smooth when only one `TerminalInstance` is mounted, lazy unmounting inactive terminal panes should be the highest-leverage PTY-side optimization.
