import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  canShowRemoteDirectoryEntryForMountPaths,
  canListRemoteDirectoryForMountPaths,
  linearIssueCommentCreatePayload,
  linearIssueCommentRemotePath,
  isSlackDmListablePath,
  normalizeRemoteDirectoryPath,
  remotePathName
} from '../integration-remote-paths.ts'

test('remote directory paths reject traversal segments', () => {
  assert.equal(normalizeRemoteDirectoryPath('/slack/channels'), '/slack/channels')
  assert.equal(normalizeRemoteDirectoryPath('/slack/../channels'), null)
  assert.equal(normalizeRemoteDirectoryPath('/slack/./channels'), null)
  assert.equal(remotePathName('/slack/channels/C123'), 'C123')
})

test('remote directory listing is limited to configured mount roots', () => {
  assert.equal(canListRemoteDirectoryForMountPaths('/slack/channels/C123', [
    '/slack/channels/C123'
  ]), true)
  assert.equal(canListRemoteDirectoryForMountPaths('/slack/channels/C123/messages', [
    '/slack/channels/C123'
  ]), true)
  assert.equal(canListRemoteDirectoryForMountPaths('/slack/channels', [
    '/slack/channels/C123'
  ]), true)
  assert.equal(canListRemoteDirectoryForMountPaths('/slack', [
    '/slack/channels/C123'
  ]), false)
  assert.equal(canListRemoteDirectoryForMountPaths('/slack/channels/C999', [
    '/slack/channels/C123'
  ]), false)
})

test('remote directory listing permits provider discovery only for that provider', () => {
  assert.equal(canListRemoteDirectoryForMountPaths('/discovery/slack/actions', [
    '/discovery/slack'
  ]), true)
  assert.equal(canListRemoteDirectoryForMountPaths('/discovery', [
    '/discovery/slack'
  ]), false)
  assert.equal(canListRemoteDirectoryForMountPaths('/discovery/github/actions', [
    '/discovery/slack'
  ]), false)
})

test('remote directory entries are filtered to configured mount roots', () => {
  assert.equal(canShowRemoteDirectoryEntryForMountPaths('/slack/channels/C123', [
    '/slack/channels/C123'
  ]), true)
  assert.equal(canShowRemoteDirectoryEntryForMountPaths('/slack/channels/C123/messages', [
    '/slack/channels/C123'
  ]), true)
  assert.equal(canShowRemoteDirectoryEntryForMountPaths('/slack/channels/C999', [
    '/slack/channels/C123'
  ]), false)
  assert.equal(canShowRemoteDirectoryEntryForMountPaths('/discovery', [
    '/discovery/slack'
  ]), true)
  assert.equal(canShowRemoteDirectoryEntryForMountPaths('/discovery/github', [
    '/discovery/slack'
  ]), false)
})

test('Slack DM and per-user message paths are recognized as DM-listable', () => {
  // Per-user message paths (/slack/users/*/messages/**)
  assert.equal(isSlackDmListablePath('/slack/users'), true)
  assert.equal(isSlackDmListablePath('/slack/users/U0ADJH4P83T/messages/1781020047_821749/meta.json'), true)
  // DM channels use Slack's "D" channel-id convention (/slack/channels/D*/**)
  assert.equal(isSlackDmListablePath('/slack/channels/D123/messages/1.json'), true)
  assert.equal(isSlackDmListablePath('/slack/channels/D123'), true)
})

test('non-DM Slack paths are not treated as DM-listable', () => {
  assert.equal(isSlackDmListablePath('/slack/channels/C123/messages/1.json'), false)
  assert.equal(isSlackDmListablePath('/slack/channels'), false)
  assert.equal(isSlackDmListablePath('/slack'), false)
  assert.equal(isSlackDmListablePath('/github/repos/acme/app'), false)
  assert.equal(isSlackDmListablePath('/discovery/slack'), false)
})

test('Linear issue comment paths use canonical issue resource files', () => {
  assert.equal(
    linearIssueCommentRemotePath(
      '/linear/issues/AR-99__04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json',
      'agent-dispatch-001.json'
    ),
    '/linear/issues/AR-99__04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json/comments/agent-dispatch-001.json'
  )
})

test('Linear issue comment paths reject UUID-only writeback directories', () => {
  assert.equal(
    linearIssueCommentRemotePath(
      '/linear/issues/04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json',
      'agent-dispatch-001.json'
    ),
    null
  )
  assert.equal(
    linearIssueCommentRemotePath(
      '/linear/issues/by-uuid/04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json',
      'agent-dispatch-001.json'
    ),
    null
  )
  assert.equal(
    linearIssueCommentRemotePath(
      '/linear/issues/AR-99__04ef067e-35b6-4ec4-81e7-66acc1f2e31f.json',
      '../agent-dispatch-001.json'
    ),
    null
  )
})

test('Linear issue comment create payload includes issue context', () => {
  assert.deepEqual(
    linearIssueCommentCreatePayload('Dispatch started', {
      id: '04ef067e-35b6-4ec4-81e7-66acc1f2e31f',
      identifier: 'AR-99',
      title: 'Reviewer: merge on green',
      url: 'https://linear.app/agent-relay/issue/AR-99/reviewer-merge-on-green',
      team: {
        id: '50cf92f3-f53c-4ab6-bf05-ea76ebd21692',
        key: 'AR',
        name: 'Agent Relay'
      },
      teamId: '50cf92f3-f53c-4ab6-bf05-ea76ebd21692'
    }),
    {
      body: 'Dispatch started',
      botActor: '',
      isArtificialAgentSessionRoot: false,
      issue: {
        id: '04ef067e-35b6-4ec4-81e7-66acc1f2e31f',
        identifier: 'AR-99',
        title: 'Reviewer: merge on green',
        url: 'https://linear.app/agent-relay/issue/AR-99/reviewer-merge-on-green',
        team: {
          id: '50cf92f3-f53c-4ab6-bf05-ea76ebd21692',
          key: 'AR',
          name: 'Agent Relay'
        },
        teamId: '50cf92f3-f53c-4ab6-bf05-ea76ebd21692'
      },
      issue_id: '04ef067e-35b6-4ec4-81e7-66acc1f2e31f',
      issueId: '04ef067e-35b6-4ec4-81e7-66acc1f2e31f'
    }
  )
})
