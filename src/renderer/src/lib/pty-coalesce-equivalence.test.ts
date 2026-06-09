// Real-VT-parser justification for the PTY write-coalescing change
// (perf(terminal): coalesce per-frame PTY chunks into one xterm write).
//
// The runtime's writeChunks() now concatenates the frame's chunks and issues
// ONE term.write() instead of one write per chunk. That is only safe if
// xterm's parser is a true streaming state machine — i.e. write(a)+write(b)
// produces a byte-for-byte identical screen to write(a+b), even when a chunk
// boundary falls in the MIDDLE of an escape sequence.
//
// We assert that against the REAL parser via @xterm/headless (no DOM, no
// renderer — just the VT state machine + buffer), using the cursor-addressing
// redraw shape Claude Code / Ink emit (CUP + EL + SGR runs). This is the
// property the production change relies on; if a future xterm bump broke it,
// coalescing would silently corrupt the screen and this test would catch it.

import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'

const ROWS = 24
const COLS = 80

function buildRedrawStream(frames: number): string {
  let out = ''
  for (let f = 1; f <= frames; f += 1) {
    out += '\x1b[H' // cursor home
    for (let r = 1; r <= ROWS; r += 1) {
      // CUP to (r,1), clear line, then an SGR colour run — the in-place
      // redraw pattern. Multi-digit row numbers guarantee CSI params that
      // can be split mid-sequence below.
      out += `\x1b[${r};1H\x1b[2K`
      out += `\x1b[36mframe ${f.toString().padStart(3, '0')} row ${r
        .toString()
        .padStart(2, '0')}\x1b[0m \x1b[2m── pear redraw ──\x1b[0m`
    }
  }
  return out
}

// Split `data` into chunks of fixed size `size`. Small sizes (1, 2, 3) force
// boundaries inside multi-byte escape sequences like `\x1b[12;1H`.
function splitBySize(data: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < data.length; i += size) {
    chunks.push(data.slice(i, i + size))
  }
  return chunks
}

function readScreen(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < term.rows; i += 1) {
    const line = buf.getLine(buf.baseY + i)
    // Trim trailing spaces/tabs per line only — never collapse the row
    // structure (so row N stays at index N for positional assertions).
    lines.push((line ? line.translateToString(true) : '').replace(/[ \t]+$/, ''))
  }
  return lines.join('\n')
}

function writeSync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()))
}

// xterm processes queued writes in order; fire them all, then await one drain
// callback (avoids tens of thousands of serialized per-chunk awaits).
async function writeAll(term: Terminal, chunks: string[]): Promise<void> {
  for (const chunk of chunks) term.write(chunk)
  await new Promise<void>((resolve) => term.write('', () => resolve()))
}

function makeTerm(): Terminal {
  return new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
}

describe('pty write coalescing — real xterm parser equivalence', () => {
  it('renders identically whether a redraw stream is written per-chunk or coalesced', async () => {
    const stream = buildRedrawStream(8)

    // Baseline: one big coalesced write (what writeChunks now does).
    const coalesced = makeTerm()
    await writeSync(coalesced, stream)
    const expected = readScreen(coalesced)
    expect(expected).toContain('frame 008 row 24') // sanity: it rendered

    // For a range of chunk sizes — including sizes that slice through the
    // middle of CSI sequences — the per-chunk path must match byte-for-byte.
    for (const size of [1, 2, 3, 7, 13, 64, 256]) {
      const perChunk = makeTerm()
      await writeAll(perChunk, splitBySize(stream, size))
      expect(readScreen(perChunk), `chunk size ${size} diverged from coalesced`).toBe(expected)
    }
  }, 20_000)

  it('keeps a CSI sequence split across the boundary equivalent to the whole sequence', async () => {
    // The hardest case: a cursor-position sequence cut in half. write("\x1b[12") +
    // write(";1Hok") must land "ok" at row 12 col 1 — identical to one write.
    const whole = makeTerm()
    await writeSync(whole, '\x1b[12;1Hok')

    const split = makeTerm()
    await writeSync(split, '\x1b[12')
    await writeSync(split, ';1Hok')

    expect(readScreen(split)).toBe(readScreen(whole))
    expect(readScreen(split).split('\n')[11]).toContain('ok')
  })
})
