// Optional per-keystroke latency tracing. Enabled by running this in DevTools:
//   localStorage.setItem('pear-typing-trace', '1')
// Then type into a terminal pane and read the rolling stats with:
//   __pearTypingStats()
// Clear with __pearTypingClear(). Disable by removing the localStorage key
// (or setting it to '0') and reloading.

const STORAGE_KEY = 'pear-typing-trace'
const MAX_SAMPLES = 200

interface Sample {
  char: string
  sentAt: number
  echoedAt?: number
}

interface PendingKeystroke {
  char: string
  sentAt: number
}

let enabled = false
const pending: PendingKeystroke[] = []
const samples: Sample[] = []

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function initTypingTrace(): void {
  enabled = readEnabled()
  if (!enabled) return
  ;(window as unknown as { __pearTypingStats?: () => void }).__pearTypingStats = printStats
  ;(window as unknown as { __pearTypingClear?: () => void }).__pearTypingClear = clearStats
  // eslint-disable-next-line no-console
  console.log('[pear-typing-trace] enabled. Call __pearTypingStats() to see samples.')
}

export function isTypingTraceEnabled(): boolean {
  return enabled
}

export function recordKeystrokeSent(data: string): void {
  if (!enabled) return
  if (data.length !== 1) return
  pending.push({ char: data, sentAt: performance.now() })
  if (pending.length > MAX_SAMPLES) {
    pending.splice(0, pending.length - MAX_SAMPLES)
  }
}

export function recordChunkEchoed(chunk: string): void {
  if (!enabled || pending.length === 0) return
  // Find the oldest pending keystroke whose character appears in this chunk.
  for (let i = 0; i < pending.length; i += 1) {
    const candidate = pending[i]
    if (chunk.includes(candidate.char)) {
      pending.splice(i, 1)
      samples.push({
        char: candidate.char,
        sentAt: candidate.sentAt,
        echoedAt: performance.now()
      })
      if (samples.length > MAX_SAMPLES) {
        samples.splice(0, samples.length - MAX_SAMPLES)
      }
      return
    }
  }
}

function printStats(): void {
  const completed = samples.filter((s) => typeof s.echoedAt === 'number') as Required<Sample>[]
  if (completed.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[pear-typing-trace] no samples yet')
    return
  }
  const latencies = completed.map((s) => s.echoedAt - s.sentAt).sort((a, b) => a - b)
  const pct = (p: number): number => latencies[Math.floor((latencies.length - 1) * p)]
  // eslint-disable-next-line no-console
  console.log('[pear-typing-trace]', {
    count: latencies.length,
    p50_ms: +pct(0.5).toFixed(2),
    p90_ms: +pct(0.9).toFixed(2),
    p99_ms: +pct(0.99).toFixed(2),
    min_ms: +latencies[0].toFixed(2),
    max_ms: +latencies[latencies.length - 1].toFixed(2)
  })
}

function clearStats(): void {
  pending.length = 0
  samples.length = 0
}
