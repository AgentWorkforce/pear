import { describe, expect, it } from 'vitest'
import { INTEGRATIONS_CATALOG } from './integrations.catalog'
import { ACTIVE_PROVIDERS, INTEGRATION_MIRROR_TOP_LEVELS } from './integration-providers'

describe('integration providers', () => {
  it('derives every generated catalog provider into the mirror allowlist', () => {
    for (const entry of INTEGRATIONS_CATALOG) {
      expect(INTEGRATION_MIRROR_TOP_LEVELS.has(entry.provider.trim().toLowerCase())).toBe(true)
    }
  })

  it('includes the google-mail alias and the discovery mirror root', () => {
    // `google-mail` (cloud's Gmail spelling) is not an adapter package name, and
    // `discovery` is a non-provider mirror root — neither comes from the catalog.
    expect(INTEGRATION_MIRROR_TOP_LEVELS.has('google-mail')).toBe(true)
    expect(INTEGRATION_MIRROR_TOP_LEVELS.has('discovery')).toBe(true)
  })

  it('does not treat infrastructure adapter packages as mirror providers', () => {
    // ../relayfile-adapters ships infra/SDK packages that never materialize a
    // `.integrations/<name>` mirror; the catalog generator excludes them, so
    // they must not appear in the allowlist.
    for (const infra of ['core', 'webhook-server', 'relay-helpers']) {
      expect(INTEGRATION_MIRROR_TOP_LEVELS.has(infra)).toBe(false)
    }
  })

  it('keeps the curated active set a subset of the mirror allowlist', () => {
    for (const provider of ACTIVE_PROVIDERS) {
      expect(INTEGRATION_MIRROR_TOP_LEVELS.has(provider)).toBe(true)
    }
  })
})
