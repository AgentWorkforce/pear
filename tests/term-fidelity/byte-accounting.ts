// Pure derivation of the client-vs-broker byte accounting recorded in each
// divergence-bundle `meta.json`. Kept dependency-free (no Playwright, no xterm)
// so it is unit-testable in isolation — and so the two byte figures can never
// again be dropped into meta as a bare, unlabeled pair that reads as an
// "exact-2.0 double-delivery" signal.
//
// Background (term-fidelity program, 2026-07-17): `quiet.activity.bytes` and
// `brokerOffset` read exactly 2.0 apart in 5/5 codex bundles. That was PROVEN
// NOT to be double delivery — a headless probe measured client-bytes /
// snapshot-offset = 1.0000, and BrokerManager does exactly one IPC send per
// worker_stream event. The 2.0 was a derivation artifact of pairing two figures
// that measure different things on (historically) unstated baselines. This
// module makes what each figure measures explicit and computes the ratio on a
// SHARED baseline so the number is meaningful.

export interface ByteAccountingInput {
  // Client side: cumulative UTF-8 byte length of every `broker:pty-chunk` STRING
  // this renderer received for the agent since the activity probe was installed.
  // The probe is installed at harness launch, BEFORE the agent is spawned, so
  // this series starts at the agent's very first byte (baseline = agent start).
  clientBytesReceived: number
  clientChunks: number
  // Broker side: the attach snapshot's cumulative per-worker byte `offset` — raw
  // PTY bytes the broker grid had consumed at capture, counted from worker start
  // (offset 0). `undefined` on brokers that predate stream-offset support.
  snapshotOffset: number | undefined
}

export interface ByteAccounting {
  clientBytesReceived: number
  clientChunks: number
  snapshotOffset: number | null
  // clientBytesReceived / snapshotOffset, rounded to 4 dp. `null` when the
  // offset is absent or zero (no meaningful ratio). ~1.0 on a faithful
  // one-IPC-send-per-chunk pipeline.
  clientToBrokerByteRatio: number | null
  // True when both figures share the agent-start baseline and are therefore
  // directly comparable. (Always true when snapshotOffset is present, because
  // the probe is installed before spawn; recorded explicitly so a future change
  // that installs the probe mid-stream can flip it to false rather than silently
  // producing an incomparable ratio.)
  commensurable: boolean
  clientBaseline: string
  brokerBaseline: string
  clientUnit: string
  brokerUnit: string
  note: string
}

export const BYTE_ACCOUNTING_NOTE =
  'clientToBrokerByteRatio compares client-received IPC bytes to the broker raw-PTY ' +
  'offset on a shared agent-start baseline. ~1.0 means one-to-one delivery. A ratio ' +
  'near an integer such as 2.0 is NOT proof of double PTY delivery — historically it ' +
  'was a derivation artifact (UTF-8 re-encoding of the decoded IPC string vs raw PTY ' +
  'bytes, and differing baselines). Never infer a delivery mechanism from this number; ' +
  'confirm duplicate delivery by counting BrokerManager IPC sends per worker_stream event.'

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function deriveByteAccounting(input: ByteAccountingInput): ByteAccounting {
  const hasOffset =
    typeof input.snapshotOffset === 'number' &&
    Number.isFinite(input.snapshotOffset)
  const snapshotOffset = hasOffset ? (input.snapshotOffset as number) : null
  const ratio =
    snapshotOffset !== null && snapshotOffset > 0
      ? round4(input.clientBytesReceived / snapshotOffset)
      : null
  return {
    clientBytesReceived: input.clientBytesReceived,
    clientChunks: input.clientChunks,
    snapshotOffset,
    clientToBrokerByteRatio: ratio,
    commensurable: snapshotOffset !== null,
    clientBaseline: 'activity-probe-install (installed pre-spawn ⇒ agent first byte)',
    brokerBaseline: 'worker-start (snapshot offset 0)',
    clientUnit: 'utf8-bytes-of-decoded-broker:pty-chunk-string',
    brokerUnit: 'raw-pty-bytes-consumed-by-broker-grid',
    note: BYTE_ACCOUNTING_NOTE
  }
}
