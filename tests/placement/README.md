# Placement requester E2E (issue #411)

Rung-1 gate for the fleet placement **requester** side. Stands up two isolated
agent-relay brokers on this machine, enrolls broker **B** as a pear fleet node
(advertising `spawn:claude`), then — from a requester exactly as
`BrokerManager.placeAgent` does — places a **real** claude agent on B and proves
the mechanics acceptance #411 requires.

## Run

```sh
npx tsx tests/placement/rung1-cross-node.mts
# keep temp brokers/state for inspection:
PLACEMENT_E2E_KEEP=1 npx tsx tests/placement/rung1-cross-node.mts
# hard-abort (do not degrade) if the target workspace isn't hermetic:
PLACEMENT_E2E_REQUIRE_HERMETIC=1 npx tsx tests/placement/rung1-cross-node.mts
```

Requires: `claude` installed + authenticated; the agent-relay-broker binary
resolvable (auto-resolved, or `AGENT_RELAY_BIN`); relay/cloud auth available to
the spawned broker (same as the live app).

## What it proves

| Check | Acceptance |
|---|---|
| placement lands on remote node B (`ack.node==B`, invocation completed) | #1 cross-node |
| target node B exposes the placed agent PTY (HTTP 200) | transport |
| **requester broker A does NOT own the PTY (HTTP 404)** | **#2b — empirical proof the raw terminal has no relay transport (upstream gap)** |
| placed agent reachable over relay chat (round-trip) | #2a chat reachability |
| no-eligible → fails fast with a clear message | #4 fallback |
| targeted node lacking capability → `capability_mismatch` | error matrix |
| node death → subsequent placement fails clearly | #3 node death |

## Isolation & safety (hard)

- Unique instance names, OS-free loopback ports, dedicated state dirs, temp cwds.
  **Never** instance `pear`, **never** port `3889`, **never** `agent-relay local up`.
- **Mandatory failsafe:** before placing, the script enumerates every
  `spawn:claude`-capable node in the target workspace. A **no-host** placement is
  used ONLY when the workspace is hermetic (B is the only capable node). If any
  **foreign** capable node is present (e.g. the live `pear` node), a no-host
  placement could dispatch a real spawn onto someone else's broker — so the
  script falls back to **targeted** placement on B (which can only resolve to B),
  or hard-aborts under `PLACEMENT_E2E_REQUIRE_HERMETIC=1`.
- Teardown releases the placed agent and shuts down both brokers.

## Known limitation

Hermetic isolation (a workspace whose only members are the two test nodes) is not
achievable on a machine with cloud auth: a spawned broker resolves cloud auth
outside `$HOME` and joins the operator's default workspace. So the no-host
**least-loaded** selection is proven only in a dedicated workspace; here we prove
the cross-node mechanics deterministically via targeted placement. A bare v10
broker also advertises `spawn:*`, so even a clean two-broker workspace makes
no-host nondeterministic between requester and target.
