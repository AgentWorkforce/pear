import { describe, expect, it } from 'vitest'
import {
  isSlackProvider,
  isSlackWritebackCommandRoot,
  slackWritebackCommandMountPathFor
} from './slack-writeback-command-roots'

describe('slack writeback command roots', () => {
  it('detects Slack-compatible providers', () => {
    expect(isSlackProvider('slack')).toBe(true)
    expect(isSlackProvider('slack-sage')).toBe(true)
    expect(isSlackProvider('github')).toBe(false)
  })

  it('maps Slack collections to canonical command roots', () => {
    expect(slackWritebackCommandMountPathFor('slack', '/slack/channels/C123')).toBe('/slack/channels/C123/messages')
    expect(slackWritebackCommandMountPathFor('slack', '/slack/dms/D123')).toBe('/slack/dms/D123/messages')
    expect(slackWritebackCommandMountPathFor('slack', '/slack/users/U123/messages')).toBe('/slack/users/U123/messages')
    expect(slackWritebackCommandMountPathFor('slack', '/slack/channels/C123/threads/1713220123_001100')).toBe(
      '/slack/channels/C123/threads/1713220123_001100/replies'
    )
    expect(slackWritebackCommandMountPathFor('slack', '/slack/channels/C123/threads/1713220123_001100/replies')).toBe(
      '/slack/channels/C123/threads/1713220123_001100/replies'
    )
  })

  it('supports Slack-compatible provider roots', () => {
    expect(slackWritebackCommandMountPathFor('slack-sage', '/slack-sage/channels/C123')).toBe(
      '/slack-sage/channels/C123/messages'
    )
    expect(isSlackWritebackCommandRoot('/slack-sage/channels/C123/messages')).toBe(true)
  })

  it('rejects unsupported or malformed command roots', () => {
    expect(slackWritebackCommandMountPathFor('github', '/github/channels/C123')).toBeNull()
    expect(slackWritebackCommandMountPathFor('slack', '/slack/files/F123')).toBeNull()
    expect(slackWritebackCommandMountPathFor('slack', '/slack/channels')).toBeNull()
    expect(slackWritebackCommandMountPathFor('slack', '/slack/channels/C123/../messages')).toBeNull()
    expect(isSlackWritebackCommandRoot('/slack/channels/C123')).toBe(false)
  })
})
