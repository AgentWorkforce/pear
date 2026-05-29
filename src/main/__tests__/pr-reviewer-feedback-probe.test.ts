import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatFeedbackProbeGreeting } from '../pr-reviewer-feedback-probe.ts'

describe('formatFeedbackProbeGreeting', () => {
  it('greets a trimmed display name', () => {
    assert.equal(formatFeedbackProbeGreeting({ displayName: '  Ada  ' }), 'Hello, Ada')
  })

  it('uses a fallback when profile data is missing', () => {
    assert.equal(formatFeedbackProbeGreeting(null), 'Hello, there')
    assert.equal(formatFeedbackProbeGreeting({}), 'Hello, there')
    assert.equal(formatFeedbackProbeGreeting({ displayName: null }), 'Hello, there')
    assert.equal(formatFeedbackProbeGreeting({ displayName: '   ' }), 'Hello, there')
  })
})
