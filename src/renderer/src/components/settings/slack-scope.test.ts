import { describe, expect, test } from 'vitest'
import {
  isSlackChannelMountPath,
  isSlackUserMessagesMountPath,
  mergeSlackScopeMountPaths,
  slackDmMountSegment,
  slackDmUserId,
  slackUserResourceFromOption
} from './slack-scope'

describe('slack DM recipient helpers', () => {
  test('slackUserResourceFromOption keeps a bare Slack user id', () => {
    const resource = slackUserResourceFromOption({ value: 'U123', label: '@alice', hint: 'Alice A.' })
    expect(resource.id).toBe('U123')
    expect(resource.metadata?.userId).toBe('U123')
    expect(slackDmUserId(resource)).toBe('U123')
  })

  test('slackDmMountSegment yields <U>/messages, never suffixed', () => {
    const resource = slackUserResourceFromOption({ value: 'U123', label: '@alice' })
    expect(slackDmMountSegment(resource)).toBe('U123/messages')
  })

  test('slackDmMountSegment supports enterprise W… ids', () => {
    const resource = slackUserResourceFromOption({ value: 'W0123ABCDEF', label: '@ent' })
    expect(slackDmUserId(resource)).toBe('W0123ABCDEF')
    expect(slackDmMountSegment(resource)).toBe('W0123ABCDEF/messages')
  })

  test('slackDmMountSegment is empty without an id', () => {
    expect(slackDmMountSegment({})).toBe('')
  })

  test('slackDmMountSegment does not use display names as user ids', () => {
    expect(slackDmMountSegment({ name: 'alice', displayName: '@alice' })).toBe('')
  })

  test('slack DM helpers tolerate nullish resources', () => {
    expect(slackDmUserId(null)).toBe('')
    expect(slackDmUserId(undefined)).toBe('')
    expect(slackDmMountSegment(null)).toBe('')
    expect(slackDmMountSegment(undefined)).toBe('')
  })

  test('slackUserResourceFromOption tolerates missing option data', () => {
    const resource = slackUserResourceFromOption(null)
    expect(resource.id).toBe('')
    expect(resource.displayName).toBe('')
    expect(resource.name).toBe('')
    expect(resource.metadata?.userId).toBe('')
  })
})

describe('slack mount-path classifiers', () => {
  test('channel vs user-message paths are distinguished', () => {
    expect(isSlackChannelMountPath('/slack/channels/C123__proj')).toBe(true)
    expect(isSlackChannelMountPath('/slack/channels')).toBe(true)
    expect(isSlackChannelMountPath('/slack/users/U1/messages')).toBe(false)

    expect(isSlackUserMessagesMountPath('/slack/users/U1/messages')).toBe(true)
    expect(isSlackUserMessagesMountPath('/slack/users/W1/messages/1780.json')).toBe(true)
    expect(isSlackUserMessagesMountPath('/slack/users')).toBe(false)
    expect(isSlackUserMessagesMountPath('/slack/channels/C1')).toBe(false)
    // raw D conversation stays diagnostic, not a user-message product path
    expect(isSlackUserMessagesMountPath('/slack/channels/D1/messages')).toBe(false)
  })

  test('malformed mount paths are ignored', () => {
    for (const path of [null, undefined, 12, {}, []]) {
      expect(isSlackChannelMountPath(path)).toBe(false)
      expect(isSlackUserMessagesMountPath(path)).toBe(false)
    }
  })
})

describe('mergeSlackScopeMountPaths', () => {
  test('selecting a DM recipient adds /slack/users/<U>/messages and preserves channels + discovery', () => {
    const merged = mergeSlackScopeMountPaths({
      existing: ['/discovery/slack', '/slack/channels/C1__proj'],
      channelPaths: null,
      dmPaths: ['/slack/users/U1/messages']
    })
    expect(merged).toEqual([
      '/discovery/slack',
      '/slack/channels/C1__proj',
      '/slack/users/U1/messages'
    ])
  })

  test('changing channels preserves existing DM mounts', () => {
    const merged = mergeSlackScopeMountPaths({
      existing: ['/slack/channels/C1__proj', '/slack/users/U1/messages'],
      channelPaths: ['/slack/channels/C2__proj'],
      dmPaths: null
    })
    expect(merged).toEqual(['/slack/channels/C2__proj', '/slack/users/U1/messages'])
  })

  test('clearing DM recipients drops user-message mounts but keeps channels', () => {
    const merged = mergeSlackScopeMountPaths({
      existing: ['/slack/channels/C1__proj', '/slack/users/U1/messages'],
      channelPaths: null,
      dmPaths: []
    })
    expect(merged).toEqual(['/slack/channels/C1__proj'])
  })

  test('listenDms-only (no recipient mounts) invents nothing', () => {
    const merged = mergeSlackScopeMountPaths({
      existing: ['/slack/channels/C1__proj'],
      channelPaths: null,
      dmPaths: null
    })
    expect(merged).toEqual(['/slack/channels/C1__proj'])
    expect(merged.some(isSlackUserMessagesMountPath)).toBe(false)
  })

  test('result is de-duplicated and order-stable', () => {
    const merged = mergeSlackScopeMountPaths({
      existing: ['/slack/channels/C1__proj', '/slack/users/U1/messages'],
      channelPaths: ['/slack/channels/C1__proj', '/slack/channels/C1__proj'],
      dmPaths: ['/slack/users/U1/messages']
    })
    expect(merged).toEqual(['/slack/channels/C1__proj', '/slack/users/U1/messages'])
  })

  test('malformed path entries are ignored while merging', () => {
    const merged = mergeSlackScopeMountPaths({
      existing: ['/discovery/slack', null, '/slack/channels/C1__proj', 12],
      channelPaths: null,
      dmPaths: ['/slack/users/U1/messages', undefined]
    })
    expect(merged).toEqual([
      '/discovery/slack',
      '/slack/channels/C1__proj',
      '/slack/users/U1/messages'
    ])
  })
})
