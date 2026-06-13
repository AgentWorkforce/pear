import { describe, expect, it } from 'vitest'

import { square } from './square'

describe('square', () => {
  it('squares positive, negative, and zero values', () => {
    expect(square(4)).toBe(16)
    expect(square(-3)).toBe(9)
    expect(square(0)).toBe(0)
  })
})
