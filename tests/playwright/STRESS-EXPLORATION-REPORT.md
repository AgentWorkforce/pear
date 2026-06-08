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
| Duration ramp | custom PTY-only | 1,000 | 10 | 15m | 0% | 9,000,000 | 19.5 | 59.2 | 425.3ms | 0 | FAIL | Two runs: min FPS 18, 21; longest frame 550.4ms, 300.1ms. Last 30s avg stayed 59.4/59.2, so this is intermittent pause behavior, not sustained drift. CDP heap delta +570MB/+1,061MB. |
| Duration ramp | custom PTY-only | 100 | 10 | 15m | 0% | 900,000 | 2.0 | 57.9 | 1,134.3ms | 0 | FAIL | Single run only; second repeat was stopped to avoid contaminating concurrent perf validation. CDP heap delta +117.6MB. Mock PTY store retained 9,100 chunks / 46.4M characters, max 464.6k chars for one agent. |
| Combined high-load | custom | 1,000 | 25 | 5m | 1% | TBD | TBD | TBD | TBD | TBD | TBD | Pending; paused while perf implementation team reruns stress gates to avoid benchmark contention. |

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

The 15-minute 1,000-agent case failed twice, but not as sustained degradation. Average FPS remained around 59 and the final 30-second windows were healthy. The failures came from isolated long pauses: 550ms and 300ms longest frames, with min FPS 18 and 21. CDP heap sampling showed large growth over the run: +570MB and +1,061MB, consistent with heap-pressure/major-GC pauses.

A 100-agent 15-minute scaling check also failed on one long pause, with min FPS 2 and a 1,134ms longest frame, while its final 30-second average was still 59.5 FPS. CDP heap delta was +117.6MB, much lower than the 1,000-agent runs. The mock PTY store retained 9,100 chunk entries and 46.4M characters for that run, so at least part of the heap growth is retained PTY text; the remaining gap is consistent with renderer terminal/xterm buffer structures. The second 100-agent repeat was intentionally stopped to avoid contaminating concurrent perf validation in the same checkout.

## Bottleneck Hypothesis

Current data suggests the PTY-heavy break is driven more by agent/stream multiplicity than by raw PTY line count. The renderer stays smooth at 1,000 streams with up to 250k logical PTY events/sec, but drops below the FPS gate at 1,750-2,000 streams with only 17.5k-20k logical PTY events/sec.

Likely contributors are per-agent terminal bookkeeping, PTY buffer fanout by agent key, store reconciliation over larger agent collections, and DOM/list work associated with many tracked agents. The 15-minute heap data strengthens the xterm/terminal-buffer hypothesis: the long-run failures look like major GC pauses after retained terminal/PTY state grows, not raw throughput collapse. The known chat-heavy expected-fail remains a separate per-row chat rendering bottleneck.

The chat mix data confirms a separate chat-path bottleneck: even 3,000 live chat messages over 30s is borderline, and 7,500 chat messages fails consistently. That points at message reconciliation, chat list virtualization pressure, markdown formatting, `ChatMessage` subtree cost, and agent metadata lookups in chat rows.

## Recommendations

Recommendations from the completed axes:

- Add a perf regression target around 1,625-1,750 PTY-only agents at 10 events/sec/agent; this is the current knee.
- Profile per-agent PTY dispatch and terminal bookkeeping before optimizing raw chunk size. The 25 events/sec result suggests throughput bytes are not the first limit.
- Keep PTY aggregation in place for high-volume stream traffic; removing it turns the test into a per-tick chunk churn benchmark and inflates wall time.
- Prioritize bounding retained terminal/PTY state for non-visible agents before deeper CPU tuning. The 15-minute failures are heap/GC shaped, and lazy mounting inactive terminals should directly reduce xterm scrollback allocation.
- Add a chat-mix regression target around 1%-2.5% chat at 1,000 agents and 10 events/sec/agent; this is the current chat-path knee.
- Treat the chat-heavy profile as a separate optimization track: reduce per-row chat render work, memoize agent metadata lookup used by chat rows, and consider batching/debouncing message reconciliation under replay bursts.
- Add a follow-up "agents but non-rendered" explorer mode before the next production fix. If 2,000+ spawned agents stay smooth when only one `TerminalInstance` is mounted, lazy unmounting inactive terminal panes should be the highest-leverage PTY-side optimization.
