import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  canShowRemoteDirectoryEntryForMountPaths,
  canListRemoteDirectoryForMountPaths,
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
