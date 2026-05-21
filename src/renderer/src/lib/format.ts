const compactCountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact'
})

export function formatGitDiffLineCount(count: number): string {
  return compactCountFormatter.format(count).toLowerCase()
}

export function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export function formatRelativeShort(timestamp: number, now = Date.now()): string {
  const ageMs = now - timestamp
  if (ageMs >= 0 && ageMs < MINUTE_MS) return 'just now'
  if (ageMs >= 0 && ageMs < HOUR_MS) return `${Math.max(1, Math.floor(ageMs / MINUTE_MS))}m ago`
  if (ageMs >= 0 && ageMs < DAY_MS) return `${Math.max(1, Math.floor(ageMs / HOUR_MS))}h ago`
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
