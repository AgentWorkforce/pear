import { describe, expect, it } from 'vitest'

import { square } from './square'

describe('square', () => {
  it('returns the square of a positive number', () => {
    expect(square(4)).toBe(16)
  })

  it('returns the square of a negative number', () => {
    expect(square(-5)).toBe(25)
  })

  it('returns zero for zero', () => {
    expect(square(0)).toBe(0)
  })
})
