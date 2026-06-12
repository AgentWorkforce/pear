import { describe, expect, it } from 'vitest'

import { lerp } from './lerp'

describe('lerp', () => {
  it('returns a when t is 0', () => {
    expect(lerp(2, 10, 0)).toBe(2)
  })

  it('returns b when t is 1', () => {
    expect(lerp(2, 10, 1)).toBe(10)
  })

  it('returns the midpoint when t is 0.5', () => {
    expect(lerp(2, 10, 0.5)).toBe(6)
  })
})
