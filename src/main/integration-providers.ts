import { INTEGRATIONS_CATALOG } from './integrations.catalog'

// Single source of truth for integration provider slugs. INTEGRATIONS_CATALOG is
// generated from ../relayfile-adapters/packages by
// scripts/build-integrations-catalog.mjs (infra packages like core/webhook-server/
// relay-helpers are excluded there), so adding an adapter package and
// regenerating the catalog flows through here automatically — no hand-maintained
// parallel provider list to drift.

// Slugs that are not adapter package names and therefore can't come from the
// generated catalog: `google-mail` is cloud's spelling of Gmail (the catalog and
// adapter package use `gmail`). Keep aligned with toRelayfileProvider in
// integrations.ts and cloud/packages/web/lib/integrations/providers.ts.
const PROVIDER_SLUG_ALIASES = ['google-mail'] as const

// Non-provider top-level directories a workspace integration mirror also
// materializes (the discovery index). Not adapter packages.
const NON_PROVIDER_MIRROR_ROOTS = ['discovery'] as const

// Providers pear surfaces as connectable — a curated product subset of every
// adapter the catalog knows about, mirroring the non-deprecated providers in
// cloud/packages/web/lib/integrations/providers.ts. This is a policy list, not
// "every package that exists", so it stays explicit.
export const ACTIVE_PROVIDERS: ReadonlySet<string> = new Set([
  'github',
  'gitlab',
  'slack',
  'notion',
  'linear',
  'jira',
  'confluence',
  'gmail',
  'google-mail',
  'google-calendar',
  'hubspot',
  'granola',
  'fathom',
  'docker-hub'
])

// Top-level directory names that legitimately appear inside a `.integrations`
// mirror. Derived from the generated adapter catalog plus the alias/non-provider
// roots above. Used only to decide whether a stale real `.integrations/`
// directory is safe to archive, so being conservative is safe: a slug missing
// here just leaves a stale mirror untouched rather than archiving it — never
// data loss.
export const INTEGRATION_MIRROR_TOP_LEVELS: ReadonlySet<string> = new Set([
  ...INTEGRATIONS_CATALOG.map((entry) => entry.provider.trim().toLowerCase()),
  ...PROVIDER_SLUG_ALIASES,
  ...NON_PROVIDER_MIRROR_ROOTS
])
