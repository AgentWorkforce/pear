import { describe, expect, it } from 'vitest'

import { clamp } from './clamp'

describe('clamp', () => {
  it('returns min when n is below min', () => {
    expect(clamp(2, 5, 10)).toBe(5)
  })

  it('returns max when n is above max', () => {
    expect(clamp(12, 5, 10)).toBe(10)
  })

  it('returns n unchanged when n is in range', () => {
    expect(clamp(7, 5, 10)).toBe(7)
  })
})
