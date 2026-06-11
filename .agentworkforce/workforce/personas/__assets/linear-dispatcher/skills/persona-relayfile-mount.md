---
name: persona-relayfile-mount
description: Use when authoring an AgentWorkforce persona's `mount` field — covers when to use mount, the gitignore allow-list idiom and its non-obvious `!web` vs `!web/` walker bug, `readonlyPatterns` scope rules, the per-agent dotfile overlay, and `.git` sandbox behavior
---

# Relayfile mount policy for AgentWorkforce personas

You are advising an author writing the `mount` field on an AgentWorkforce persona spec. Use `mount` when the persona should run in a filesystem sandbox: it should see only some files, treat others as read-only, or both. Omit `mount` when the persona is fine running in-place with full project access (the default for most personas).

## Shape

```json
"mount": {
  "ignoredPatterns": ["..."],
  "readonlyPatterns": ["..."]
}
```

Both arrays use gitignore-style globs (powered by the `ignore` library).

- `ignoredPatterns` — matches are omitted from the mount entirely; the agent cannot see or write them.
- `readonlyPatterns` — matches are copied into the mount but `chmod 444`; agent edits to these paths never sync back to the project.

## Mount vs permissions

Mount gates *files*. `permissions` gates *tools*. They compose — a persona that shouldn't see `.env` AND shouldn't shell out needs both.

## Per-agent dotfile overlays

The persona's `id` is passed to relayfile as `agentName`. At launch, relayfile also loads:

- `.{id}.agentignore`
- `.{id}.agentreadonly`

from the project root, appending their contents to the persona spec's patterns. Persona authors control the in-spec baseline; deployers can layer per-agent dotfiles on top without editing the persona JSON.

## Allow-list idiom (agent only sees one subtree)

Use gitignore negation, NOT a broad `**` exclude.

**Correct:**

```json
"ignoredPatterns": ["/*", "!web", "!web/**", "secrets/", ".env"]
```

**Four rules to avoid bricking the mount:**

1. **Use `/*` as the broad-exclude, never `**`.** Gitignore semantics skip excluded parent directories entirely. Once `**` excludes a directory, a later `!dir/**` cannot bring its contents back — the dir was never walked. `/*` only excludes root-level entries, so subdirs of allowed paths stay visible.
2. **Negate the directory with `!web`, NOT `!web/`.** This one is non-obvious and breaks every "obvious" allow-list. The relayfile walker calls the `ignore` library twice per directory entry — once with the bare name (`web`) and once with the trailing-slash form (`web/`) — and OR's the results. The bare-name check fires first, and `/*` matches `web` regardless of type. A trailing-slash negation `!web/` only counters the trailing-slash form, so the bare-name check still returns "ignored" and the walker skips the directory. `!web` (no slash) negates BOTH forms, which is what you need. **If your allow-listed subtree isn't appearing in the mount, this is almost always the bug.**
3. **Include BOTH the directory and its contents.** `!web` re-includes the directory node so the walker recurses into it; `!web/**` re-includes everything inside it. You need both.
4. **No `./` prefixes.** The `ignore` library expects bare relative patterns; `./web/**` is treated as a literal path that almost never matches.

**Wrong (looks right, silently empty mount):**

```json
"ignoredPatterns": ["/*", "!web/", "!web/**"]
```

**Right:**

```json
"ignoredPatterns": ["/*", "!web", "!web/**"]
```

## readonlyPatterns scope

`readonlyPatterns` is for paths the agent should READ but never MODIFY — lockfiles, vendor code, configs the persona references but shouldn't touch.

**Never include the persona's primary work directory.** If you do, the agent's writes to that directory are silently filtered out on sync-back. The persona looks like it ran successfully but produced zero project-side changes — one of the worst failure modes because nothing complains.

Example: a blog-writer persona whose job is to author files under `web/content/blog/` must NOT have `web/**` in `readonlyPatterns`.

## Git inside the mount

The mount auto-includes `.git`, so `git status`/`log`/`diff` work inside the sandbox. Sync rules:

- Project-side changes under `.git/**` flow INTO the mount (e.g. teammate moves HEAD while the agent runs).
- Mount-side changes under `.git/**` are NOT synced back. Branches, commits, and refs the agent creates in the mount stay sandboxed and are discarded on cleanup unless the agent pushes to a remote.

## Pre-handoff checklist

- [ ] Does the persona actually need a sandbox? If full project access is fine, omit `mount` entirely.
- [ ] For allow-lists: `/*` (not `**`) plus paired `!dir` (NO trailing slash) and `!dir/**` for each allowed path?
- [ ] Is the persona's *work* directory NOT in `readonlyPatterns`?
- [ ] Are secrets, `.env`, and any private dirs in `ignoredPatterns`?
- [ ] Does `permissions` cover the tool-side scope (Bash, file edits, MCP) the persona should and shouldn't have?
