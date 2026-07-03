import { describe, expect, it } from 'vitest'
import { INTEGRATIONS_CATALOG } from './integrations.catalog'
import {
  ACTIVE_PROVIDERS,
  CLOUD_ONLY_ACTIVE_PROVIDERS,
  INTEGRATION_MIRROR_TOP_LEVELS
} from './integration-providers'

describe('integration providers', () => {
  it('derives every generated catalog provider into the mirror allowlist', () => {
    for (const entry of INTEGRATIONS_CATALOG) {
      expect(INTEGRATION_MIRROR_TOP_LEVELS.has(entry.provider.trim().toLowerCase())).toBe(true)
    }
  })

  it('includes cloud-only active providers not yet in the generated catalog', () => {
    // These ship in cloud but have no static-catalog entry, so they can only
    // reach the allowlist via the shared cloud-only list.
    for (const provider of CLOUD_ONLY_ACTIVE_PROVIDERS) {
      expect(INTEGRATION_MIRROR_TOP_LEVELS.has(provider)).toBe(true)
      expect(ACTIVE_PROVIDERS.has(provider)).toBe(true)
    }
  })

  it('includes the non-provider discovery mirror root', () => {
    expect(INTEGRATION_MIRROR_TOP_LEVELS.has('discovery')).toBe(true)
  })

  it('does not treat infrastructure adapter packages as mirror providers', () => {
    // ../relayfile-adapters ships infra packages (core, daytona, gcp, etc.)
    // that never materialize a `.integrations/<name>` mirror; they must not
    // leak into the allowlist via the catalog.
    for (const infra of ['core', 'daytona', 'gcp', 'cloudflare', 'relay-helpers', 'webhook-server']) {
      expect(INTEGRATION_MIRROR_TOP_LEVELS.has(infra)).toBe(false)
    }
  })

  it('keeps the curated active set a subset of the mirror allowlist', () => {
    for (const provider of ACTIVE_PROVIDERS) {
      expect(INTEGRATION_MIRROR_TOP_LEVELS.has(provider)).toBe(true)
    }
  })
})
