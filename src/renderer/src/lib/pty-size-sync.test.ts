// Invariants for the retrying PTY size synchronizer. The property that
// matters: the LAST desired size always eventually reaches the PTY — a
// failed resize IPC must never be recorded as delivered (that left the PTY
// permanently mismatched with the grid, making TUI repaints land mid-screen
// and stack in scrollback).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPtySizeSync } from './pty-size-sync'

type Deferred = {
  rows: number
  cols: number
  resolve: () => void
  reject: () => void
}

function makeHarness(): { sync: ReturnType<typeof createPtySizeSync>; sends: Deferred[] } {
  const sends: Deferred[] = []
  const sync = createPtySizeSync(
    (rows, cols) =>
      new Promise<void>((resolve, reject) => {
        sends.push({ rows, cols, resolve: () => resolve(), reject: () => reject(new Error('ipc failed')) })
      })
  )
  return { sync, sends }
}

// Let the promise chain settle between steps.
const tick = (): Promise<void> => Promise.resolve().then(() => {})

describe('pty-size-sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the desired size once and skips no-op re-asserts after the ack', async () => {
    const { sync, sends } = makeHarness()
    sync.setDesired(24, 80)
    expect(sends).toHaveLength(1)
    sends[0].resolve()
    await tick()

    // Same size again (ResizeObserver spam): no new IPC.
    sync.setDesired(24, 80)
    expect(sends).toHaveLength(1)

    // A real change round-trips.
    sync.setDesired(30, 100)
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ rows: 30, cols: 100 })
  })

  it('retries a failed send until it lands — failure is never recorded as delivered', async () => {
    const { sync, sends } = makeHarness()
    sync.setDesired(24, 80)
    sends[0].reject()
    await tick()
    expect(sends).toHaveLength(1)

    // Backoff elapses → retry fires with the same size.
    vi.advanceTimersByTime(250)
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ rows: 24, cols: 80 })

    // Second failure backs off longer, then still retries.
    sends[1].reject()
    await tick()
    vi.advanceTimersByTime(500)
    expect(sends).toHaveLength(3)
    sends[2].resolve()
    await tick()

    // Delivered now — re-asserting the same size is a no-op.
    sync.setDesired(24, 80)
    expect(sends).toHaveLength(3)
  })

  it('re-sends when desired moved while a send was in flight', async () => {
    const { sync, sends } = makeHarness()
    sync.setDesired(24, 80)
    sync.setDesired(30, 100) // supersedes while #0 in flight
    expect(sends).toHaveLength(1)

    sends[0].resolve()
    await tick()
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ rows: 30, cols: 100 })
    sends[1].resolve()
    await tick()
    expect(sends).toHaveLength(2)
  })

  it('a stale failed send never clobbers a newer delivered size', async () => {
    const { sync, sends } = makeHarness()
    sync.setDesired(24, 80)
    sends[0].reject()
    await tick()

    sync.setDesired(30, 100)
    expect(sends).toHaveLength(2)
    sends[1].resolve()
    await tick()

    // The old failure's backoff retry fires — but desired === acked now, so
    // no stale 24×80 is ever re-sent.
    vi.advanceTimersByTime(10_000)
    expect(sends).toHaveLength(2)
  })

  it('noteAcked suppresses the IPC but re-asserts a diverged desired size', async () => {
    const { sync, sends } = makeHarness()
    // Attach carried 24×80 to the PTY out-of-band.
    sync.noteAcked(24, 80)
    expect(sends).toHaveLength(0)

    // Grid measured something else while attach was in flight → re-assert.
    sync.setDesired(26, 90)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ rows: 26, cols: 90 })
  })

  it('invalidateAck forces a re-send of an unchanged size (SIGWINCH bounce restore)', async () => {
    const { sync, sends } = makeHarness()
    sync.setDesired(24, 80)
    sends[0].resolve()
    await tick()

    sync.invalidateAck()
    sync.setDesired(24, 80)
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ rows: 24, cols: 80 })
  })

  it('dispose cancels pending retries', async () => {
    const { sync, sends } = makeHarness()
    sync.setDesired(24, 80)
    sends[0].reject()
    await tick()

    sync.dispose()
    vi.advanceTimersByTime(60_000)
    expect(sends).toHaveLength(1)

    sync.setDesired(30, 100)
    expect(sends).toHaveLength(1)
  })

  it('ignores degenerate sizes', () => {
    const { sync, sends } = makeHarness()
    sync.setDesired(0, 80)
    sync.setDesired(24, 0)
    sync.setDesired(-1, -1)
    expect(sends).toHaveLength(0)
  })
})
