import { describe, expect, it } from 'vitest'

import { isOdd } from './is-odd'

describe('isOdd', () => {
  it('returns true for odd numbers', () => {
    expect(isOdd(1)).toBe(true)
  })

  it('returns false for even numbers', () => {
    expect(isOdd(2)).toBe(false)
  })

  it('returns false for zero', () => {
    expect(isOdd(0)).toBe(false)
  })

  it('returns false for non-integer numbers', () => {
    expect(isOdd(1.5)).toBe(false)
  })

  it('returns false for non-finite numbers', () => {
    expect(isOdd(NaN)).toBe(false)
    expect(isOdd(Infinity)).toBe(false)
    expect(isOdd(-Infinity)).toBe(false)
  })
})
