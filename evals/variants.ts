/**
 * Onboarding variants for pear integration mount evals.
 *
 * Ordered lightest → heaviest. Goal: find the MINIMUM guidance that achieves
 * reliable writeback, so we can reduce or eliminate spawn injection.
 *
 * bare         → zero guidance (can the agent self-discover the mount?)
 * claude-md    → CLAUDE.md with a one-liner pointing at .integrations/discovery/
 * slim-inject  → task prefix: provider names + mount roots only
 * full-inject  → full <integrations-update> block matching current production output
 */

export const VARIANTS = ['bare', 'claude-md', 'slim-inject', 'full-inject', 'prescriptive'] as const
export type Variant = typeof VARIANTS[number]

/** Returns CLAUDE.md content to write into the fixture dir, or null. */
export function variantClaudeMd(variant: Variant): string | null {
  if (variant === 'claude-md') {
    return `# Integration context

Integration data and writeback schemas are at \`.integrations/\`.

Before writing to any integration, read \`.integrations/discovery/<provider>/.adapter.md\` for the writeback contract and exact path structure.
`
  }
  return null
}

/**
 * Text to prepend to the user task. Empty for variants that use other mechanisms.
 * Pass mountDir to embed the absolute integration path (for CLIs that may not
 * inherit the correct cwd from the relay headless runner).
 */
export function variantTaskPrefix(variant: Variant, mountDir?: string): string {
  switch (variant) {
    case 'bare':
    case 'claude-md':
      return ''

    case 'slim-inject': {
      const base = mountDir ? mountDir + '/.integrations' : '.integrations'
      return (
        `Connected integrations: slack (mount: ${base}/slack/), linear (mount: ${base}/linear/). ` +
        `Writeback schemas and adapter docs at ${base}/discovery/<provider>/. ` +
        'Read the adapter docs before writing.\n\n'
      )
    }

    case 'full-inject':
      return mountDir ? fullInjectPrefix(mountDir) : FULL_INJECT_PREFIX

    case 'prescriptive':
      return mountDir ? prescriptivePrefix(mountDir) : PRESCRIPTIVE_PREFIX
  }
}

/**
 * Explicit lookup table — no discovery reads required.
 * When mountDir is provided, paths are absolute (for CLIs with unreliable cwd).
 * Designed for smaller models and non-Claude CLIs.
 */
function prescriptivePrefix(mountDir?: string): string {
  const base = mountDir ? mountDir + '/.integrations' : '.integrations'
  return `To dispatch an integration action, write a JSON file to the provider path — do NOT use relay messaging for these actions.

Integration write paths (use exactly as shown):
  Slack channel message → ${base}/slack/channels/<channelDir>/messages/<name>.json
    <channelDir> is the mount directory name provided in the task (format: <channelId>__<slug>)
    payload: {"text":"<message>","channelId":"<channelId>"}
  Slack DM             → ${base}/slack/users/<userId>/messages/<name>.json
    payload: {"text":"<message>"}
  Linear create issue  → ${base}/linear/issues/<name>.json
    payload: {"title":"<title>","description":"<desc>","priority":<0-4>}
  Linear update issue  → ${base}/linear/issues/<name>.json
    payload: {"id":"<issueId>","_action":"update",<fields to change>}
  Linear delete issue  → ${base}/linear/issues/<name>.json
    payload: {"id":"<issueId>","_action":"delete"}
  Linear comment       → ${base}/linear/issues/<issueId>/comments/<name>.json
    payload: {"issueId":"<id>","body":"<text>"}

Rules: use any filename ending in .json; do not write inside discovery/.

`
}

const PRESCRIPTIVE_PREFIX = prescriptivePrefix()

/**
 * Replicates what initialSpawnInstructions() produces for the eval fake mount.
 * When mountDir is provided, paths are absolute (for CLIs with unreliable cwd).
 */
function fullInjectPrefix(mountDir?: string): string {
  const base = mountDir ? mountDir + '/.integrations' : '.integrations'
  return `Initial project integration context. Treat this as setup context, not as the user task.
<integrations-update>
The user has connected the following integrations to this project:
- slack: workspace-wide (event scope ${base}/slack/channels/C12345EVAL__general/messages). Writeback schemas and examples are available at ${base}/discovery/slack; create writeback files under ${base}/slack/channels/C12345EVAL__general/messages, not under discovery. Local historical provider records are not broadly downloaded. Writeback command roots are mounted at ${base}/slack/channels/C12345EVAL__general/messages; provider context should be read on demand or through incoming events.
- linear: all configured scope (event scope ${base}/linear/issues). Writeback schemas and examples are available at ${base}/discovery/linear; create writeback files under ${base}/linear/issues, not under discovery. Local historical provider records are not broadly downloaded. Writeback command roots are mounted at ${base}/linear/issues; provider context should be read on demand or through incoming events.

Active integration event subscriptions for this project:
- slack: file changes at ${base}/slack/channels/C12345EVAL__general/messages; delivered to all project agents
- linear: file changes at ${base}/linear/issues; delivered to all project agents
You will receive <integration-event> system messages for these subscribed changes. Do not poll these integrations for background changes; wait for the event notification, then read the mounted files for context if needed.
Writeback discovery schemas and examples are mounted through ${base}/discovery/<provider>/ for connected integrations. Use those schemas to create files under the provider paths such as ${base}/slack/channels/<channelId>/messages; do not create provider records inside discovery. Historical provider records are only intentionally downloaded when historical download is enabled. Incoming webhook events do not require downloading history.
</integrations-update>

`
}

/**
 * Replicates what initialSpawnInstructions() produces for the eval fake mount:
 *   - slack: channel C12345EVAL__general
 *   - linear: issues mount
 */
const FULL_INJECT_PREFIX = `Initial project integration context. Treat this as setup context, not as the user task.
<integrations-update>
The user has connected the following integrations to this project:
- slack: workspace-wide (event scope .integrations/slack/channels/C12345EVAL__general/messages). Writeback schemas and examples are available at .integrations/discovery/slack; create writeback files under .integrations/slack/channels/C12345EVAL__general/messages, not under discovery. Local historical provider records are not broadly downloaded. Writeback command roots are mounted at .integrations/slack/channels/C12345EVAL__general/messages; provider context should be read on demand or through incoming events.
- linear: all configured scope (event scope .integrations/linear/issues). Writeback schemas and examples are available at .integrations/discovery/linear; create writeback files under .integrations/linear/issues, not under discovery. Local historical provider records are not broadly downloaded. Writeback command roots are mounted at .integrations/linear/issues; provider context should be read on demand or through incoming events.

Active integration event subscriptions for this project:
- slack: file changes at .integrations/slack/channels/C12345EVAL__general/messages; delivered to all project agents
- linear: file changes at .integrations/linear/issues; delivered to all project agents
You will receive <integration-event> system messages for these subscribed changes. Do not poll these integrations for background changes; wait for the event notification, then read the mounted files for context if needed.
Writeback discovery schemas and examples are mounted through .integrations/discovery/<provider>/ for connected integrations. Use those schemas to create files under the provider paths such as .integrations/slack/channels/<channelId>/messages; do not create provider records inside discovery. Historical provider records are only intentionally downloaded when historical download is enabled. Incoming webhook events do not require downloading history.
</integrations-update>

`
