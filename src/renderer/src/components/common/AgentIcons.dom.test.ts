// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { agentIconKey } from './AgentIcons'
import { GROK_AVATAR_SHAPES, grokAvatarShape } from './GrokAvatar'

describe('agentIconKey', () => {
  it('maps provider spellings onto the shared marks', () => {
    expect(agentIconKey('grok')).toBe('grok')
    expect(agentIconKey('xai')).toBe('grok')
    expect(agentIconKey('grok-bot')).toBe('grok')
    expect(agentIconKey('claudecode')).toBe('claude')
    expect(agentIconKey('cursor-cloud')).toBe('cursor')
    expect(agentIconKey('OpenAI')).toBe('openai')
    expect(agentIconKey('muse')).toBe('muse')
    expect(agentIconKey('unknown')).toBeNull()
    expect(agentIconKey(undefined)).toBeNull()
  })
})

describe('grokAvatarShape', () => {
  it('keeps one shape per agent name', () => {
    expect(grokAvatarShape('devopsgrok')).toBe(grokAvatarShape('devopsgrok'))
    expect(GROK_AVATAR_SHAPES).toContain(grokAvatarShape('devopsgrok'))
    const shapes = new Set(['devopsgrok', 'salesgrok', 'infragrok', 'gtmgrok', 'kjgrok'].map(grokAvatarShape))
    expect(shapes.size).toBeGreaterThan(1)
  })
})

describe('isSignedInPerson', () => {
  it('matches a Relaycast human to the signed-in user by name, handle, or email', async () => {
    const { isSignedInPerson } = await import('@/lib/auth-user')
    const user = { name: 'Khaliq Gant', email: 'khaliq@agentrelay.com', githubUsername: 'khaliqgant' }
    expect(isSignedInPerson('khaliq-gant', user)).toBe(true)
    expect(isSignedInPerson('khaliq-gant@finn-mac-mini', user)).toBe(true)
    expect(isSignedInPerson('khaliqgant', user)).toBe(true)
    expect(isSignedInPerson('khaliq', user)).toBe(true)
    expect(isSignedInPerson('khaliq-answer', user)).toBe(false)
    expect(isSignedInPerson('khaliq-gant', null)).toBe(false)
  })
})
