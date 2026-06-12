import { describe, expect, it } from 'vitest'

import { clampInt } from './clamp-int'

describe('clampInt', () => {
  it('returns min when n is less than min', () => {
    expect(clampInt(2, 3, 10)).toBe(3)
  })

  it('returns max when n is greater than max', () => {
    expect(clampInt(11, 3, 10)).toBe(10)
  })

  it('returns n when n is within bounds', () => {
    expect(clampInt(7, 3, 10)).toBe(7)
  })
})
