import { describe, expect, it } from 'vitest'

import { isPositive } from './is-positive'

describe('isPositive', () => {
  it('returns true for positive numbers', () => {
    expect(isPositive(1)).toBe(true)
  })

  it('returns false for negative numbers', () => {
    expect(isPositive(-1)).toBe(false)
  })

  it('returns false for zero', () => {
    expect(isPositive(0)).toBe(false)
  })
})
