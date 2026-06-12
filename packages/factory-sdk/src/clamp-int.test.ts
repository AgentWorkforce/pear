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

  it('throws when min is greater than max', () => {
    expect(() => clampInt(7, 10, 3)).toThrow(RangeError)
  })

  it('throws when n is not an integer', () => {
    expect(() => clampInt(7.2, 3, 10)).toThrow(TypeError)
  })

  it('throws when bounds are not integers', () => {
    expect(() => clampInt(7, 3.2, 10)).toThrow(TypeError)
    expect(() => clampInt(7, 3, Number.NaN)).toThrow(TypeError)
  })
})
