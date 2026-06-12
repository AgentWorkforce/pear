/**
 * Clamp an integer to the inclusive range between min and max.
 */
export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(min) || !Number.isInteger(max)) {
    throw new TypeError('clampInt expects integer inputs')
  }

  if (min > max) {
    throw new RangeError('min must be less than or equal to max')
  }

  if (n < min) {
    return min
  }

  if (n > max) {
    return max
  }

  return n
}
