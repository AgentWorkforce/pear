const REPO_KEYWORDS: Record<string, string[]> = {
  relay: ['relay', 'agent-relay', 'broker', 'mcp', 'workspace', 'webhook', 'mount', 'relayfile'],
  pear: ['pear', 'electron', 'renderer', 'terminal', 'ui', 'inbox', 'sidebar', 'dialog', 'ipc'],
  workforce: ['workforce', 'persona', 'autonomous', 'proactive', 'agent-workforce', 'skill'],
}

const SOLO_KEYWORDS = ['fix', 'bug', 'typo']
const SWARM_KEYWORDS = ['migration', 'refactor', 'rewrite']

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function hasKeyword(tokens: string[], keyword: string): boolean {
  const keywordTokens = tokenize(keyword)
  if (keywordTokens.length === 0) return false
  for (let index = 0; index <= tokens.length - keywordTokens.length; index += 1) {
    if (keywordTokens.every((token, offset) => tokens[index + offset] === token)) return true
  }
  return false
}

export function detectRepo(title: string, description: string): string | null {
  const tokens = tokenize(`${title} ${description}`)
  let bestRepo: string | null = null
  let bestScore = 0
  let tied = false

  for (const [repo, keywords] of Object.entries(REPO_KEYWORDS)) {
    const score = keywords.filter((keyword) => hasKeyword(tokens, keyword)).length
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
  const tokens = tokenize(`${title} ${description}`)
  const length = description.length

  if (SWARM_KEYWORDS.some((keyword) => hasKeyword(tokens, keyword)) || length > 2000) {
    return 'swarm'
  }
  if (SOLO_KEYWORDS.some((keyword) => hasKeyword(tokens, keyword)) || length < 200) {
    return 'solo'
  }
  return 'pair'
}
