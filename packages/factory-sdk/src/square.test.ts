import { describe, expect, it } from 'vitest'

import { square } from './index'

describe('square', () => {
  it('squares positive numbers', () => {
    expect(square(4)).toBe(16)
  })

  it('squares negative numbers', () => {
    expect(square(-5)).toBe(25)
  })

  it('squares zero', () => {
    expect(square(0)).toBe(0)
  })
})
