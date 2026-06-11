import { describe, expect, test } from 'vitest'
import { detectRepo } from './issue-scoping'

describe('detectRepo', () => {
  test('returns the highest scoring repo', () => {
    expect(detectRepo('Broker webhook retry queue', 'relay-side mount writeback')).toBe('relay')
  })

  test('does not guess when top repo scores are tied', () => {
    expect(detectRepo('Broker IPC bridge', 'route webhook results into the renderer')).toBeNull()
  })

  test('returns null when no repo keywords match', () => {
    expect(detectRepo('Improve onboarding copy', 'clarify the first-run checklist')).toBeNull()
  })
})
