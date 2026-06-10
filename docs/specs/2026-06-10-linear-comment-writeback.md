# Linear comment writeback contract

## Finding

Linear comment writeback succeeded at the relay file dispatch layer but did not
create visible Linear comments because dispatcher writes targeted UUID-only
directories under the issue mount:

```text
/linear/issues/04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json/comments/agent-dispatch-001.json
```

The mounted Linear issue resources are canonical files named with both the
identifier and UUID:

```text
/linear/issues/AR-99__04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json
```

The UUID-only write creates local VFS content under a non-resource directory.
The outbox can still report `dispatchStatus: "succeeded"` because the file write
was accepted, but the synced comment files do not get Linear-managed fields such
as `id`, `url`, `createdAt`, `user`, or `_webhook`, and no comment appears in
the Linear UI.

## Evidence

Read before changing the contract:

- `.integrations/discovery/linear/.adapter.md`
- `.integrations/discovery/linear/issues/{issueId}/comments/.schema.json`
- `.integrations/discovery/linear/issues/{issueId}/comments/.create.example.json`

The comment create example includes:

```json
{
  "body": "",
  "botActor": "",
  "isArtificialAgentSessionRoot": false,
  "issue": {},
  "issue_id": ""
}
```

The acknowledged outbox entries for the invisible comments only included:

```json
{
  "body": "Agent dispatched...",
  "issue_id": "04ef067e-35b6-4ec4-81e7-66acc1f2e31f"
}
```

Those payloads were written to UUID-only `.json/comments` paths. Existing synced
issue updates in the same outbox used canonical issue files such as
`/linear/issues/AR-99__04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json`.

## Correct writeback shape

Build comment paths from the canonical issue file path returned by
`/linear/issues` directory listing:

```text
/linear/issues/AR-99__04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json/comments/agent-dispatch-001.json
```

Use a create payload that includes the adapter example fields plus stable issue
identity:

```json
{
  "body": "Agent dispatched...",
  "botActor": "",
  "isArtificialAgentSessionRoot": false,
  "issue": {
    "id": "04ef067e-35b6-4ec4-81e7-66acc1f2e31f",
    "identifier": "AR-99",
    "title": "Reviewer: merge on green",
    "url": "https://linear.app/agent-relay/issue/AR-99/reviewer-merge-on-green",
    "team": {
      "id": "50cf92f3-f53c-4ab6-bf05-ea76ebd21692",
      "key": "AR",
      "name": "Agent Relay"
    },
    "teamId": "50cf92f3-f53c-4ab6-bf05-ea76ebd21692"
  },
  "issue_id": "04ef067e-35b6-4ec4-81e7-66acc1f2e31f",
  "issueId": "04ef067e-35b6-4ec4-81e7-66acc1f2e31f"
}
```

Do not set read-only fields (`id`, `url`, `createdAt`, `created_at`,
`updatedAt`, `updated_at`, `user`, or webhook fields) at the comment record
root. Linear derives actor fields from the integration credentials, so `userId`
is not required for this writeback path.
