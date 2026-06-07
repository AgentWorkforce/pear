# .agentworkforce/

pear's AgentWorkforce persona assets, discovered by the workforce persona loader
under `workforce/personas/`.

## Package-sourced personas

The following personas are **sourced from published persona packs** — they are
not hand-maintained. They are materialized here so the personas are available to
pear's local workforce tooling.

- `workforce/personas/autonomous-actor.json` from
  [`@agentworkforce/persona-autonomous-actor`](https://www.npmjs.com/package/@agentworkforce/persona-autonomous-actor)
- `workforce/personas/slack-comms.json` and
  `workforce/personas/__assets/slack-comms/slack-comms.md` from
  [`@agentworkforce/persona-slack-comms`](https://www.npmjs.com/package/@agentworkforce/persona-slack-comms)

Refresh it from the latest published pack (copies the spec into
`workforce/personas/`) with:

```bash
npm run personas:refresh
```

which installs both published persona packs with `--overwrite`. To change these
personas, edit them in their package, republish, then re-run the refresh — do
not hand-edit the materialized specs or assets. Commit the resulting diff.

Other personas in `workforce/personas/` (e.g. `settings-panel-hero.json`) are
repo-local and unaffected.
