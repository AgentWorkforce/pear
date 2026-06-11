const REPO_KEYWORDS: Record<string, string[]> = {
  relay: ['relay', 'agent-relay', 'broker', 'mcp', 'workspace', 'webhook', 'mount', 'relayfile'],
  pear: ['pear', 'electron', 'renderer', 'terminal', 'ui', 'inbox', 'sidebar', 'dialog', 'ipc'],
  workforce: ['workforce', 'persona', 'autonomous', 'proactive', 'agent-workforce', 'skill'],
}

export function detectRepo(title: string, description: string): string | null {
  const text = `${title} ${description}`.toLowerCase()
  let bestRepo: string | null = null
  let bestScore = 0
  let tied = false

  for (const [repo, keywords] of Object.entries(REPO_KEYWORDS)) {
    const score = keywords.filter((kw) => text.includes(kw)).length
    if (score > bestScore) {
      bestScore = score
      bestRepo = repo
      tied = false
    } else if (score > 0 && score === bestScore) {
      tied = true
    }
  }

  return tied ? null : bestRepo
}

export function suggestTeamSize(title: string, description: string): 'solo' | 'pair' | 'swarm' {
  const text = `${title} ${description}`.toLowerCase()
  const length = description.length

  if (text.includes('migration') || text.includes('refactor') || text.includes('rewrite') || length > 2000) {
    return 'swarm'
  }
  if (text.includes('fix') || text.includes('bug') || text.includes('typo') || length < 200) {
    return 'solo'
  }
  return 'pair'
}
