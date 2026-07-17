import { describe, expect, it } from 'vitest'
import { BYTE_ACCOUNTING_NOTE, deriveByteAccounting } from './byte-accounting'

// Pins the client-vs-broker byte derivation used in divergence-bundle meta.
// The whole point of the module is that the exact-2.0 codex artifact can no
// longer reach meta as an unlabeled, misreadable pair — so these tests assert
// the labels, the shared-baseline ratio, and the guard rails.
describe('deriveByteAccounting', () => {
  it('reports a ~1.0 ratio for one-to-one delivery on a shared baseline', () => {
    const acc = deriveByteAccounting({
      clientBytesReceived: 4096,
      clientChunks: 12,
      snapshotOffset: 4096
    })
    expect(acc.clientToBrokerByteRatio).toBe(1)
    expect(acc.commensurable).toBe(true)
    expect(acc.snapshotOffset).toBe(4096)
  })

  it('rounds the ratio to 4 dp', () => {
    const acc = deriveByteAccounting({
      clientBytesReceived: 1000,
      clientChunks: 3,
      snapshotOffset: 3000
    })
    expect(acc.clientToBrokerByteRatio).toBe(0.3333)
  })

  it('surfaces (does not hide) the historic exact-2.0 reading, with the do-not-misread note', () => {
    const acc = deriveByteAccounting({
      clientBytesReceived: 8192,
      clientChunks: 20,
      snapshotOffset: 4096
    })
    // The number is preserved for forensics — but it is explicitly labeled and
    // carries the note so it can never again be read as "double delivery".
    expect(acc.clientToBrokerByteRatio).toBe(2)
    expect(acc.note).toBe(BYTE_ACCOUNTING_NOTE)
    expect(acc.note).toMatch(/NOT proof of double PTY delivery/)
    expect(acc.clientUnit).not.toBe(acc.brokerUnit)
    expect(acc.clientBaseline).toMatch(/probe-install/)
    expect(acc.brokerBaseline).toMatch(/worker-start/)
  })

  it('yields a null ratio and non-commensurable flag when the broker predates offsets', () => {
    const acc = deriveByteAccounting({
      clientBytesReceived: 500,
      clientChunks: 4,
      snapshotOffset: undefined
    })
    expect(acc.snapshotOffset).toBeNull()
    expect(acc.clientToBrokerByteRatio).toBeNull()
    expect(acc.commensurable).toBe(false)
  })

  it('yields a null ratio when the offset is zero (avoids divide-by-zero)', () => {
    const acc = deriveByteAccounting({
      clientBytesReceived: 0,
      clientChunks: 0,
      snapshotOffset: 0
    })
    expect(acc.clientToBrokerByteRatio).toBeNull()
    // The offset was present (0) so the baselines are still comparable.
    expect(acc.commensurable).toBe(true)
  })
})
