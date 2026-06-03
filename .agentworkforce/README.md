# .agentworkforce/

pear's AgentWorkforce persona assets, discovered by the workforce persona loader
under `workforce/personas/`.

## Package-sourced personas

`workforce/personas/autonomous-actor.json` is **sourced from the published
persona pack**
[`@agentworkforce/persona-autonomous-actor`](https://www.npmjs.com/package/@agentworkforce/persona-autonomous-actor)
— it is not hand-maintained. It is materialized here so the persona is available
to pear's local workforce tooling.

Refresh it with the workforce CLI (copies the spec into `workforce/personas/`):

```bash
agentworkforce install @agentworkforce/persona-autonomous-actor --overwrite
```

(Requires the pack at `>=0.1.2`, which ships the `agentworkforce.personas`
layout.) To change the persona, edit it in the package, republish, then re-run
the install — do not hand-edit `autonomous-actor.json`.

Other personas in `workforce/personas/` (e.g. `settings-panel-hero.json`) are
repo-local and unaffected.
