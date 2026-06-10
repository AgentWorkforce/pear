#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

export const DEFAULT_LABEL = 'merge-on-green'
export const DEFAULT_ORG = 'AgentWorkforce'

const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const FAILING_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required'])
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending'])
const FAILING_STATUS_STATES = new Set(['failure', 'error'])

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase()
}

function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function isBotUser(user) {
  const login = String(user?.login ?? '')
  const type = String(user?.type ?? '')
  return type.toLowerCase() === 'bot' || login.toLowerCase().endsWith('[bot]')
}

function getLabelNames(labels) {
  if (!Array.isArray(labels)) return []
  return labels
    .map((label) => typeof label === 'string' ? label : label?.name)
    .filter((label) => typeof label === 'string' && label.trim())
}

export function hasMergeOnGreenLabel(pr, labelName = DEFAULT_LABEL) {
  const wanted = normalizeName(labelName)
  return getLabelNames(pr?.labels).some((label) => normalizeName(label) === wanted)
}

export function requiredBotReviewers(pr, configuredBots = []) {
  const required = new Map()
  for (const login of configuredBots) {
    const key = normalizeName(login)
    if (key) required.set(key, login.trim())
  }

  for (const reviewer of pr?.requested_reviewers ?? []) {
    if (!isBotUser(reviewer)) continue
    const login = String(reviewer.login ?? '').trim()
    if (login) required.set(normalizeName(login), login)
  }

  return Array.from(required.values()).sort((a, b) => a.localeCompare(b))
}

function latestReviewsByUser(reviews) {
  const byUser = new Map()
  for (const review of reviews ?? []) {
    const login = String(review?.user?.login ?? '').trim()
    if (!login) continue
    byUser.set(normalizeName(login), review)
  }
  return byUser
}

export function evaluateBotReviews(pr, reviews, configuredBots = []) {
  const latest = latestReviewsByUser(reviews)
  const required = requiredBotReviewers(pr, configuredBots)
  const missing = []
  const blocking = []

  for (const login of required) {
    const review = latest.get(normalizeName(login))
    const state = normalizeName(review?.state)
    if (state === 'changes_requested') {
      blocking.push(login)
    } else if (state !== 'approved') {
      missing.push(login)
    }
  }

  for (const review of latest.values()) {
    if (!isBotUser(review?.user)) continue
    if (normalizeName(review?.state) !== 'changes_requested') continue
    const login = String(review.user.login ?? '').trim()
    if (login && !blocking.some((entry) => normalizeName(entry) === normalizeName(login))) {
      blocking.push(login)
    }
  }

  if (blocking.length > 0) {
    return {
      state: 'blocked',
      summary: `bot review changes requested: ${blocking.join(', ')}`,
      required,
      missing,
      blocking
    }
  }

  if (missing.length > 0) {
    return {
      state: 'pending',
      summary: `waiting for bot review approval: ${missing.join(', ')}`,
      required,
      missing,
      blocking
    }
  }

  return {
    state: 'passing',
    summary: required.length > 0 ? `bot reviews approved: ${required.join(', ')}` : 'no required bot reviews',
    required,
    missing,
    blocking
  }
}

function latestSignals(signals) {
  const latest = new Map()
  for (const signal of signals) {
    const key = normalizeName(signal.key || signal.name)
    if (!key) continue
    latest.set(key, signal)
  }
  return Array.from(latest.values())
}

export function evaluateChecks(signals, ignoredNames = []) {
  const ignored = new Set(ignoredNames.map(normalizeName).filter(Boolean))
  const considered = latestSignals(signals ?? [])
    .filter((signal) => !ignored.has(normalizeName(signal.name)))
    .filter((signal) => !ignored.has(normalizeName(signal.key)))

  const failing = []
  const pending = []

  for (const signal of considered) {
    const state = normalizeName(signal.state)
    const status = normalizeName(signal.status)
    const conclusion = normalizeName(signal.conclusion)
    const name = signal.name || signal.key || 'unknown check'

    if (FAILING_STATUS_STATES.has(state) || FAILING_CONCLUSIONS.has(conclusion)) {
      failing.push(name)
      continue
    }

    if (
      state === 'pending' ||
      PENDING_STATUSES.has(status) ||
      (status === 'completed' && conclusion && !PASSING_CONCLUSIONS.has(conclusion)) ||
      (status && status !== 'completed' && !PASSING_CONCLUSIONS.has(status))
    ) {
      pending.push(name)
      continue
    }

    if (state === 'success' || PASSING_CONCLUSIONS.has(conclusion) || PASSING_CONCLUSIONS.has(status)) {
      continue
    }

    pending.push(name)
  }

  if (considered.length === 0) {
    return { state: 'pending', summary: 'waiting for checks: no check results found', considered, failing, pending }
  }

  if (failing.length > 0) {
    return { state: 'blocked', summary: `failing checks: ${failing.join(', ')}`, considered, failing, pending }
  }

  if (pending.length > 0) {
    return { state: 'pending', summary: `pending checks: ${pending.join(', ')}`, considered, failing, pending }
  }

  return { state: 'passing', summary: `all checks passing (${considered.length})`, considered, failing, pending }
}

export function shouldEvaluateEvent(payload, options = {}) {
  const labelName = options.labelName ?? DEFAULT_LABEL
  const eventName = options.eventName ?? process.env.GITHUB_EVENT_NAME ?? ''
  if (eventName === 'pull_request' && payload?.action === 'unlabeled') {
    const label = String(payload?.label?.name ?? '')
    return normalizeName(label) !== normalizeName(labelName)
  }

  if (eventName === 'check_run') {
    const checkRun = payload?.check_run
    const appSlug = normalizeName(checkRun?.app?.slug)
    const checkName = normalizeName(checkRun?.name)
    const selfNames = new Set((options.selfCheckNames ?? ['evaluate']).map(normalizeName))
    if (appSlug === 'github-actions' && selfNames.has(checkName)) return false
  }

  return true
}

export function candidatePullRequestsFromEvent(payload, options = {}) {
  const owner = options.owner ?? payload?.repository?.owner?.login
  const repo = options.repo ?? payload?.repository?.name
  const numbers = new Set()

  if (payload?.pull_request?.number) numbers.add(Number(payload.pull_request.number))
  if (payload?.inputs?.pull_request) numbers.add(Number(payload.inputs.pull_request))
  for (const pr of payload?.check_run?.pull_requests ?? []) {
    if (pr?.number) numbers.add(Number(pr.number))
  }

  return Array.from(numbers)
    .filter((number) => Number.isInteger(number) && number > 0)
    .map((number) => ({ owner, repo, number }))
    .filter((candidate) => candidate.owner && candidate.repo)
}

export function isMatchingOrg(owner, org) {
  return normalizeName(owner) === normalizeName(org)
}

class GitHubClient {
  constructor({ token, apiBaseUrl = 'https://api.github.com' }) {
    if (!token) throw new Error('GITHUB_TOKEN is required')
    this.token = token
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '')
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'pear-merge-on-green',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers ?? {})
      }
    })

    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    if (!response.ok) {
      const message = body?.message || response.statusText || `GitHub API ${response.status}`
      const error = new Error(message)
      error.status = response.status
      error.body = body
      throw error
    }
    return body
  }

  async paginate(path) {
    const results = []
    let page = 1
    while (true) {
      const separator = path.includes('?') ? '&' : '?'
      const batch = await this.request(`${path}${separator}per_page=100&page=${page}`)
      if (!Array.isArray(batch) || batch.length === 0) break
      results.push(...batch)
      if (batch.length < 100) break
      page += 1
    }
    return results
  }

  getPullRequest(owner, repo, number) {
    return this.request(`/repos/${owner}/${repo}/pulls/${number}`)
  }

  listLabeledPullRequests(owner, repo, labelName) {
    return this.paginate(`/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(labelName)}`)
      .then((issues) => issues.filter((issue) => issue.pull_request).map((issue) => ({
        owner,
        repo,
        number: issue.number
      })))
  }

  listReviews(owner, repo, number) {
    return this.paginate(`/repos/${owner}/${repo}/pulls/${number}/reviews`)
  }

  async listCheckSignals(owner, repo, sha) {
    const [status, checkRuns] = await Promise.all([
      this.request(`/repos/${owner}/${repo}/commits/${sha}/status`),
      this.request(`/repos/${owner}/${repo}/commits/${sha}/check-runs?filter=latest`)
    ])

    const statusSignals = (status?.statuses ?? []).map((entry) => ({
      key: `status:${entry.context}`,
      name: entry.context,
      state: entry.state
    }))

    const checkRunSignals = (checkRuns?.check_runs ?? []).map((entry) => ({
      key: `check:${entry.app?.slug ?? 'unknown'}:${entry.name}`,
      name: entry.name,
      status: entry.status,
      conclusion: entry.conclusion
    }))

    return [...statusSignals, ...checkRunSignals]
  }

  mergePullRequest(owner, repo, number, sha, method) {
    return this.request(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        merge_method: method,
        sha
      })
    })
  }
}

async function evaluatePullRequest(client, candidate, options) {
  const pr = await client.getPullRequest(candidate.owner, candidate.repo, candidate.number)
  const qualified = `${candidate.owner}/${candidate.repo}#${candidate.number}`

  if (!isMatchingOrg(candidate.owner, options.org)) {
    return { qualified, state: 'skipped', summary: `outside ${options.org} org` }
  }

  if (pr.merged) return { qualified, state: 'skipped', summary: 'already merged' }
  if (pr.state !== 'open') return { qualified, state: 'skipped', summary: `PR is ${pr.state}` }
  if (pr.draft) return { qualified, state: 'pending', summary: 'PR is draft' }
  if (!hasMergeOnGreenLabel(pr, options.labelName)) {
    return { qualified, state: 'skipped', summary: `missing ${options.labelName} label` }
  }

  const sha = pr.head?.sha
  if (!sha) return { qualified, state: 'pending', summary: 'missing PR head SHA' }

  const [signals, reviews] = await Promise.all([
    client.listCheckSignals(candidate.owner, candidate.repo, sha),
    client.listReviews(candidate.owner, candidate.repo, candidate.number)
  ])

  const checks = evaluateChecks(signals, options.ignoredCheckNames)
  if (checks.state !== 'passing') {
    return { qualified, state: checks.state, summary: checks.summary, checks }
  }

  const botReviews = evaluateBotReviews(pr, reviews, options.requiredBots)
  if (botReviews.state !== 'passing') {
    return { qualified, state: botReviews.state, summary: botReviews.summary, checks, botReviews }
  }

  try {
    const merge = await client.mergePullRequest(candidate.owner, candidate.repo, candidate.number, sha, options.mergeMethod)
    return { qualified, state: 'merged', summary: merge?.message || 'merged', checks, botReviews }
  } catch (error) {
    if (error?.status === 405 || error?.status === 409 || error?.status === 422) {
      return { qualified, state: 'blocked', summary: error.message, checks, botReviews }
    }
    throw error
  }
}

export async function evaluateCandidates(client, candidates, options, log = console.log) {
  let hadError = false

  for (const candidate of candidates) {
    const qualified = `${candidate.owner}/${candidate.repo}#${candidate.number}`
    try {
      const result = await evaluatePullRequest(client, candidate, options)
      log(`[merge-on-green] ${result.qualified}: ${result.state} - ${result.summary}`)
    } catch (error) {
      hadError = true
      log(`[merge-on-green] ${qualified}: error - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { hadError }
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const [owner, repo] = repository.split('/')
  const labelName = process.env.MERGE_ON_GREEN_LABEL || DEFAULT_LABEL
  const org = process.env.MERGE_ON_GREEN_ORG || DEFAULT_ORG
  const payload = eventPath ? JSON.parse(await readFile(eventPath, 'utf8')) : {}

  const options = {
    eventName: process.env.GITHUB_EVENT_NAME,
    owner,
    repo,
    labelName,
    org,
    mergeMethod: process.env.MERGE_ON_GREEN_METHOD || 'squash',
    requiredBots: splitCsv(process.env.MERGE_ON_GREEN_REQUIRED_BOTS),
    ignoredCheckNames: [
      'Merge on Green',
      'evaluate',
      ...splitCsv(process.env.MERGE_ON_GREEN_IGNORED_CHECKS)
    ]
  }

  if (!shouldEvaluateEvent(payload, options)) {
    console.log('[merge-on-green] skipped self-trigger event')
    return
  }

  const client = new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    apiBaseUrl: process.env.GITHUB_API_URL
  })

  const eventCandidates = candidatePullRequestsFromEvent(payload, options)
  const candidates = eventCandidates.length > 0
    ? eventCandidates
    : await client.listLabeledPullRequests(owner, repo, labelName)

  const unique = new Map(candidates.map((candidate) => [
    `${candidate.owner}/${candidate.repo}#${candidate.number}`,
    candidate
  ]))

  if (unique.size === 0) {
    console.log('[merge-on-green] no candidate PRs')
    return
  }

  const { hadError } = await evaluateCandidates(client, unique.values(), options)
  if (hadError) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[merge-on-green] failed:', error)
    process.exitCode = 1
  })
}
