import { INTEGRATIONS_CATALOG } from './integrations.catalog'

// Single source of truth for "which integration providers exist". The bulk of
// the list is derived from INTEGRATIONS_CATALOG, which is itself generated from
// ../relayfile-adapters/packages by scripts/build-integrations-catalog.mjs — so
// adding an adapter package and regenerating the catalog flows through here
// automatically, with no hand-maintained parallel list to drift.

// Providers active in ../cloud that the generated static catalog does not (yet)
// include: cloud-only providers with no baked adapter metadata, plus
// `google-mail` (cloud's spelling of Gmail — the catalog uses `gmail`). These
// are the only slugs still enumerated by hand; keep them aligned with
// cloud/packages/web/lib/integrations/providers.ts. Defined once and shared by
// both the connect-eligibility set and the mirror-shape allowlist below.
export const CLOUD_ONLY_ACTIVE_PROVIDERS = [
  'google-mail',
  'granola',
  'fathom',
  'docker-hub'
] as const

// Curated set of providers currently connectable from cloud. Intentionally a
// subset of everything the catalog knows about — mirrors the non-deprecated
// providers in cloud/packages/web/lib/integrations/providers.ts.
export const ACTIVE_PROVIDERS: ReadonlySet<string> = new Set([
  'github',
  'gitlab',
  'slack',
  'notion',
  'linear',
  'jira',
  'confluence',
  'gmail',
  'google-calendar',
  'hubspot',
  ...CLOUD_ONLY_ACTIVE_PROVIDERS
])

// Non-provider top-level directories a workspace integration mirror also
// materializes (the discovery index). Not adapter packages, so they can't come
// from the catalog.
const NON_PROVIDER_MIRROR_ROOTS = ['discovery'] as const

// Top-level directory names that legitimately appear inside a `.integrations`
// mirror. Used only to decide whether a stale real `.integrations/` directory is
// safe to archive, so this is deliberately broad (it may include providers that
// are no longer connectable). Being conservative is safe here: a slug missing
// from this set just means a stale mirror for that provider is left untouched
// rather than archived — never data loss.
export const INTEGRATION_MIRROR_TOP_LEVELS: ReadonlySet<string> = new Set([
  ...INTEGRATIONS_CATALOG.map((entry) => entry.provider.trim().toLowerCase()),
  ...CLOUD_ONLY_ACTIVE_PROVIDERS,
  ...NON_PROVIDER_MIRROR_ROOTS
])
