import { describe, expect, it } from 'vitest'

import { isOdd } from './is-odd'

describe('isOdd', () => {
  it('returns true for odd numbers', () => {
    expect(isOdd(1)).toBe(true)
    expect(isOdd(-3)).toBe(true)
  })

  it('returns false for even numbers', () => {
    expect(isOdd(2)).toBe(false)
    expect(isOdd(-4)).toBe(false)
  })

  it('returns false for zero', () => {
    expect(isOdd(0)).toBe(false)
  })

  it('returns false for non-integers', () => {
    expect(isOdd(1.5)).toBe(false)
    expect(isOdd(Number.NaN)).toBe(false)
    expect(isOdd(Number.POSITIVE_INFINITY)).toBe(false)
  })
})
