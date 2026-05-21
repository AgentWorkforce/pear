export type PersistedRelayWorkspace = {
  id: string
  createdAt: string
  apiUrl: string
  authKey: string
}

export type RelayWorkspaceRecord = PersistedRelayWorkspace

export type RelayWorkspaceJoinParams = {
  agentName: string
  scopes: readonly string[]
}

export type RelayWorkspaceBootstrapMode = 'create' | 'join'

export type RelayWorkspaceManagerLike = {
  getWorkspaceId(): Promise<string>
  getWorkspaceHandle(): Promise<unknown>
  getPersisted(): PersistedRelayWorkspace | null
}

export type RelayWorkspaceError =
  | { kind: 'not-signed-in' }
  | { kind: 'create-failed'; message: string }
  | { kind: 'join-failed'; id: string; message: string }
  | { kind: 'token-refresh-failed'; message: string }
