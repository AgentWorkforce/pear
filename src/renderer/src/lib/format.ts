const compactCountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact'
})

export function formatGitDiffLineCount(count: number): string {
  return compactCountFormatter.format(count).toLowerCase()
}
