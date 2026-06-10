import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  candidatePullRequestsFromEvent,
  evaluateBotReviews,
  evaluateCandidates,
  evaluateChecks,
  hasMergeOnGreenLabel,
  isMatchingOrg,
  requiredBotReviewers,
  shouldEvaluateEvent
} from './merge-on-green.mjs'

test('detects merge-on-green labels case-insensitively', () => {
  assert.equal(hasMergeOnGreenLabel({ labels: [{ name: 'merge-on-green' }] }), true)
  assert.equal(hasMergeOnGreenLabel({ labels: [{ name: 'Merge-On-Green' }] }), true)
  assert.equal(hasMergeOnGreenLabel({ labels: [{ name: 'ready' }] }), false)
})

test('check evaluation requires at least one non-ignored passing signal', () => {
  assert.equal(evaluateChecks([]).state, 'pending')
  assert.equal(evaluateChecks([{ name: 'evaluate', conclusion: 'success', status: 'completed' }], ['evaluate']).state, 'pending')
  assert.equal(evaluateChecks([{ name: 'CI', conclusion: 'success', status: 'completed' }]).state, 'passing')
})

test('check evaluation blocks failures and waits on pending checks', () => {
  assert.deepEqual(evaluateChecks([
    { key: 'check:github-actions:CI', name: 'CI', status: 'completed', conclusion: 'success' },
    { key: 'check:github-actions:lint', name: 'lint', status: 'completed', conclusion: 'failure' }
  ]).state, 'blocked')

  assert.deepEqual(evaluateChecks([
    { key: 'check:github-actions:CI', name: 'CI', status: 'in_progress', conclusion: null }
  ]).state, 'pending')
})

test('bot reviewer gate requires configured and requested bot approvals', () => {
  const pr = {
    requested_reviewers: [
      { login: 'reviewer-bot[bot]', type: 'Bot' }
    ]
  }
  assert.deepEqual(requiredBotReviewers(pr, ['codex-reviewer[bot]']), [
    'codex-reviewer[bot]',
    'reviewer-bot[bot]'
  ])

  const pending = evaluateBotReviews(pr, [
    { user: { login: 'codex-reviewer[bot]', type: 'Bot' }, state: 'APPROVED' }
  ], ['codex-reviewer[bot]'])
  assert.equal(pending.state, 'pending')
  assert.deepEqual(pending.missing, ['reviewer-bot[bot]'])

  const passing = evaluateBotReviews(pr, [
    { user: { login: 'codex-reviewer[bot]', type: 'Bot' }, state: 'APPROVED' },
    { user: { login: 'reviewer-bot[bot]', type: 'Bot' }, state: 'APPROVED' }
  ], ['codex-reviewer[bot]'])
  assert.equal(passing.state, 'passing')
})

test('latest bot changes requested review blocks merge even when not requested', () => {
  const result = evaluateBotReviews({ requested_reviewers: [] }, [
    { user: { login: 'reviewer-bot[bot]', type: 'Bot' }, state: 'APPROVED' },
    { user: { login: 'reviewer-bot[bot]', type: 'Bot' }, state: 'CHANGES_REQUESTED' }
  ])
  assert.equal(result.state, 'blocked')
  assert.deepEqual(result.blocking, ['reviewer-bot[bot]'])
})

test('event candidates include pull request and check run pull requests', () => {
  const payload = {
    repository: { owner: { login: 'AgentWorkforce' }, name: 'pear' },
    pull_request: { number: 99 },
    check_run: { pull_requests: [{ number: 100 }, { number: 99 }] },
    inputs: { pull_request: '101' }
  }
  assert.deepEqual(candidatePullRequestsFromEvent(payload), [
    { owner: 'AgentWorkforce', repo: 'pear', number: 99 },
    { owner: 'AgentWorkforce', repo: 'pear', number: 101 },
    { owner: 'AgentWorkforce', repo: 'pear', number: 100 }
  ])
})

test('self check run events are ignored to avoid workflow replay loops', () => {
  assert.equal(shouldEvaluateEvent({
    check_run: {
      name: 'evaluate',
      app: { slug: 'github-actions' }
    }
  }, { eventName: 'check_run' }), false)

  assert.equal(shouldEvaluateEvent({
    check_run: {
      name: 'checks',
      app: { slug: 'github-actions' }
    }
  }, { eventName: 'check_run' }), true)
})

test('org matching is case-insensitive', () => {
  assert.equal(isMatchingOrg('agentworkforce', 'AgentWorkforce'), true)
  assert.equal(isMatchingOrg('AgentWorkforce', 'agentworkforce'), true)
  assert.equal(isMatchingOrg('other', 'AgentWorkforce'), false)
})

test('candidate evaluation logs per-PR errors and keeps processing', async () => {
  const merged = []
  const client = {
    async getPullRequest(owner, repo, number) {
      if (number === 1) throw new Error('temporary API failure')
      return {
        state: 'open',
        merged: false,
        draft: false,
        labels: [{ name: 'merge-on-green' }],
        head: { sha: `sha-${number}` },
        requested_reviewers: []
      }
    },
    async listCheckSignals() {
      return [{ name: 'CI', status: 'completed', conclusion: 'success' }]
    },
    async listReviews() {
      return []
    },
    async mergePullRequest(owner, repo, number, sha) {
      merged.push({ owner, repo, number, sha })
      return { message: 'Pull Request successfully merged' }
    }
  }
  const logs = []

  const result = await evaluateCandidates(client, [
    { owner: 'AgentWorkforce', repo: 'pear', number: 1 },
    { owner: 'agentworkforce', repo: 'pear', number: 2 }
  ], {
    labelName: 'merge-on-green',
    org: 'AgentWorkforce',
    ignoredCheckNames: [],
    requiredBots: [],
    mergeMethod: 'squash'
  }, (message) => logs.push(message))

  assert.equal(result.hadError, true)
  assert.equal(logs.length, 2)
  assert.match(logs[0], /error - temporary API failure/)
  assert.match(logs[1], /agentworkforce\/pear#2: merged/)
  assert.deepEqual(merged, [{ owner: 'agentworkforce', repo: 'pear', number: 2, sha: 'sha-2' }])
})
