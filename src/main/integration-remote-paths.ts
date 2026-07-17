export function normalizeRemoteDirectoryPath(remotePath: string): string | null {
  const segments = remotePath.split('/').map((segment) => segment.trim()).filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return `/${segments.join('/')}`
}

export function remotePathName(remotePath: string): string {
  const segments = remotePath.split('/').filter(Boolean)
  return segments[segments.length - 1] || remotePath
}

const LINEAR_ISSUE_FILE_NAME_PATTERN = /^[A-Z][A-Z0-9]*-\d+__[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/iu

export type LinearIssueCommentPayloadIssue = {
  id: string
  identifier?: string | null
  title?: string | null
  url?: string | null
  team?: {
    id?: string | null
    key?: string | null
    name?: string | null
  } | null
  teamId?: string | null
}

export type LinearIssueCommentCreatePayload = {
  body: string
  botActor: string
  isArtificialAgentSessionRoot: boolean
  issue: {
    id: string
    identifier?: string
    title?: string
    url?: string
    team?: {
      id?: string
      key?: string
      name?: string
    }
    teamId?: string
  }
  issue_id: string
  issueId: string
}

export function linearIssueCommentRemotePath(issueRemotePath: string, commentFileName: string): string | null {
  if (typeof issueRemotePath !== 'string') return null
  const normalizedIssuePath = normalizeRemoteDirectoryPath(issueRemotePath)
  if (!normalizedIssuePath) return null
  const issueSegments = normalizedIssuePath.split('/').filter(Boolean)
  if (issueSegments.length !== 3 || issueSegments[0] !== 'linear' || issueSegments[1] !== 'issues') return null
  const issueFileName = issueSegments[2]
  if (!LINEAR_ISSUE_FILE_NAME_PATTERN.test(issueFileName)) return null

  const normalizedCommentFile = typeof commentFileName === 'string' ? commentFileName.trim() : ''
  if (!normalizedCommentFile || normalizedCommentFile.includes('/') || normalizedCommentFile.includes('\\')) return null
  if (normalizedCommentFile === '.' || normalizedCommentFile === '..' || !normalizedCommentFile.endsWith('.json')) return null

  return `/linear/issues/${issueFileName}/comments/${normalizedCommentFile}`
}

export function linearIssueCommentCreatePayload(
  body: string,
  issue: LinearIssueCommentPayloadIssue
): LinearIssueCommentCreatePayload {
  const trimmedBody = typeof body === 'string' ? body.trim() : ''
  const issueId = typeof issue?.id === 'string' ? issue.id.trim() : ''
  if (!trimmedBody) throw new Error('Linear comment body is required')
  if (!issueId) throw new Error('Linear issue id is required')

  const issuePayload: LinearIssueCommentCreatePayload['issue'] = { id: issueId }
  if (issue.identifier) issuePayload.identifier = issue.identifier
  if (issue.title) issuePayload.title = issue.title
  if (issue.url) issuePayload.url = issue.url
  if (issue.teamId) issuePayload.teamId = issue.teamId
  if (issue.team) {
    issuePayload.team = {}
    if (issue.team.id) issuePayload.team.id = issue.team.id
    if (issue.team.key) issuePayload.team.key = issue.team.key
    if (issue.team.name) issuePayload.team.name = issue.team.name
  }

  return {
    body: trimmedBody,
    botActor: '',
    isArtificialAgentSessionRoot: false,
    issue: issuePayload,
    issue_id: issueId,
    issueId
  }
}

export function isRelayfilePathWithinRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = rootPath.trim().replace(/\/+$/, '') || '/'
  const normalizedTarget = targetPath.trim().replace(/\/+$/, '') || '/'
  if (normalizedRoot === '/') return normalizedTarget === '/' || normalizedTarget.startsWith('/')
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

function isImmediateNonDiscoveryParent(parentPath: string, childPath: string): boolean {
  const normalizedParent = parentPath.trim().replace(/\/+$/, '') || '/'
  const normalizedChild = childPath.trim().replace(/\/+$/, '') || '/'
  if (normalizedChild.startsWith('/discovery/')) return false
  if (normalizedParent === '/' || normalizedParent === normalizedChild) return false
  if (!normalizedChild.startsWith(`${normalizedParent}/`)) return false
  return normalizedChild.slice(normalizedParent.length + 1).split('/').length === 1
}

export function canListRemoteDirectoryForMountPaths(remotePath: string, mountPaths: string[]): boolean {
  return mountPaths.some((mountPath) =>
    isRelayfilePathWithinRoot(mountPath, remotePath) ||
    isImmediateNonDiscoveryParent(remotePath, mountPath)
  )
}

export function canShowRemoteDirectoryEntryForMountPaths(entryPath: string, mountPaths: string[]): boolean {
  return mountPaths.some((mountPath) =>
    isRelayfilePathWithinRoot(mountPath, entryPath) ||
    isRelayfilePathWithinRoot(entryPath, mountPath)
  )
}

// Slack direct-message and per-user message paths are delivered as events when
// DM listening is enabled (SLACK_DM_EVENT_GLOBS: /slack/users/*/messages/** and
// /slack/channels/D*/**), but they are not part of the canonical channel mount
// paths, so the mount-path scope checks above reject them. This predicate
// recognizes exactly those event-subscribed DM roots so list/read can be
// allowed when (and only when) DM listening is on, without widening scope to
// non-DM channels. The "D" prefix on a channel segment is Slack's DM channel
// convention, which a plain root path cannot express.
export function isSlackDmListablePath(remotePath: string): boolean {
  const segments = (remotePath || '').trim().replace(/\/+$/, '').split('/').filter(Boolean)
  if (segments[0] !== 'slack') return false
  if (segments[1] === 'users') return true
  if (segments[1] === 'channels' && /^D/u.test(segments[2] ?? '')) return true
  return false
}

// Linear integrations configure mount scopes at the team level — e.g.
// /linear/teams or /linear/teams/AR (see integrations.catalog.ts
// defaultMountPaths) — but the adapter materializes the team's workflow
// states at the sibling /linear/states subtree, which is reference data, not
// a configurable mount of its own, so the mount-path scope checks above reject
// it. Recognize exactly that subtree so list/read (never write) can be allowed
// when a Linear integration is visible, mirroring the Slack DM carve-out.
export function isLinearStatesListablePath(remotePath: string): boolean {
  const segments = (remotePath || '').trim().replace(/\/+$/, '').split('/').filter(Boolean)
  return segments[0] === 'linear' && segments[1] === 'states'
}

// The Issues tab (issues-store.ts) lists /linear/issues and reads/writes the
// issue records beneath it (status writeback, comments), but — exactly like
// /linear/states above — the adapter materializes /linear/issues as a sibling
// of the team-level mount scope (/linear/teams...), so the mount-path checks
// reject it. Recognize the /linear/issues subtree so list/read AND write are
// allowed when a Linear integration is visible. Unlike states, this carve-out
// permits writes: issue status changes and comments are the whole point of the
// Issues control center.
export function isLinearIssuesListablePath(remotePath: string): boolean {
  const segments = (remotePath || '').trim().replace(/\/+$/, '').split('/').filter(Boolean)
  return segments[0] === 'linear' && segments[1] === 'issues'
}
