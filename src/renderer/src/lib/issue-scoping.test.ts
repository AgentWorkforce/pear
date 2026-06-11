import { describe, expect, test } from 'vitest'
import { detectRepo, suggestTeamSize } from './issue-scoping'

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

  test('does not score repo keywords inside larger words', () => {
    expect(detectRepo('Build health dashboard', 'show build status and rebuild history')).toBeNull()
  })
})

describe('suggestTeamSize', () => {
  test('does not match sizing keywords inside larger words', () => {
    expect(suggestTeamSize('Prefix cleanup', 'Keep the description long enough to avoid the short-description fallback.'.repeat(4))).toBe('pair')
  })

  test('uses description length thresholds', () => {
    expect(suggestTeamSize('Clarify copy', 'x'.repeat(199))).toBe('solo')
    expect(suggestTeamSize('Broad implementation', 'x'.repeat(2001))).toBe('swarm')
  })

  test('uses keyword-based sizing', () => {
    expect(suggestTeamSize('Bug in issue dispatch', 'The retry logic fails after reconnect.'.repeat(8))).toBe('solo')
    expect(suggestTeamSize('Queue migration', 'Move the dispatch pipeline to a new queue.'.repeat(8))).toBe('swarm')
  })
})
