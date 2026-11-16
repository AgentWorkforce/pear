# Working in pear

```sh
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

- Broker lifecycle effects are idempotent and concurrent starts coalesce. Scope reconnect listeners by generation; notifications require a real transition.
- PTY chunks use (generation, byte offset) AND content hash, never content alone or nonexistent event/seq IDs. Missing offsets deliver all bytes and report the blind spot.
- Keep main and renderer delivery guards. Never drop different bytes sharing an offset, or identical consecutive terminal output.
- Preserve terminal reconciliation as a backstop, including quiet/recheck/confirm/rate gates, independent divergence telemetry, dimension reassertion, stranded-prediction rollback and a surviving poll loop.
- Read the terminal-reconciler module header and `docs/agent-reference.md` before changing those invariants; add replay and failure-path coverage.

## Agency and guidance

- Act autonomously on routine assigned work; ask forgiveness rather than permission. Preserve explicit production, release and credential gates.
- For guidance, ask the engineering leads, the agent that spawned you, or the layered owner on Agent Relay.
- Only a truly pressing or blocking question goes to `khaliq-gant` or `will-washburn` on Agent Relay.

## Cross-repo context

- Before and during changes, understand how this repo fits the wider system; consult its repo map and related-repo docs where available.
- Check relevant agents’ summaries on Agent Relay and proactively contact owning agents about dependencies, adjacent changes and work in flight.

## Pull requests (when used)

- Open PRs as ready for review by default. If merging requires Khaliq’s OK, use `merge-train:hold` instead of draft status.
- If you open a PR, immediately subscribe to its feedback through Agent Relay using [this skill](https://github.com/AgentWorkforce/skills/blob/main/skills/subscribing-relay-webhooks-and-writebacks/SKILL.md), and verify subscription readiness.
- Evaluate each review finding. Address applicable feedback and explain declined changes in the thread.
- A PR is not ready while feedback remains unaddressed or merge conflicts remain.
- When ready, alert the CODEOWNERS and the agent that spawned you on Agent Relay.
- Keep related open PRs from going stale: find their authoring agent on Agent Relay and coordinate; if that agent is no longer on the relay, escalate to the CODEOWNERS or the layered owner.
