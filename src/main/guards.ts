/**
 * Shared runtime type guards for the main process.
 *
 * Several modules grew private copies of these primitives; keeping a single
 * canonical definition here avoids the subtle drift that accumulated (some
 * copies treated arrays as records, others did not).
 */

/** True for non-null, non-array objects — i.e. plain `Record`-like values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
