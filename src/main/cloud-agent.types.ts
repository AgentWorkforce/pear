export type CloudAgentRecord = {
  id: string
  name: string
  displayName?: string
  harness: string
  defaultModel: string
  status: 'ready' | 'warming' | 'error' | 'stopped'
  lastUsedAt?: string
  lastError?: string
  lastAuthenticatedAt?: string | null
}

export type CreateCloudAgentInput = {
  name: string
  harness: string
  model: string
}

export type CloudAgentSandbox = {
  sandboxId: string
  execUrl: string
  filesUrl: string
  relayfileToken: string
  relayfileMountPath: string
  status: CloudAgentSandboxStatus
  phase?: CloudAgentSandboxPhase
  etaMs?: number
  apiKey?: string
  error?: string
}

export type CloudAgentSandboxStatus = 'warming' | 'ready' | 'failed' | 'stopping' | 'stopped'
export type CloudAgentSandboxPhase = 'queued' | 'pulling-image' | 'starting' | 'cloning' | 'mounting' | 'ready'

export type CloudAgentBinding = {
  projectId: string
  cloudAgentId: string
  sandboxId: string
  relayfileMountPath: string
  attachedAt: string
}

export type PersistedCloudAgent = {
  id: string
  sandboxId: string
  attachedAt: string
  relayfileMountPath: string
  autoPullAfterRun?: boolean
}

export type CloudAgentMountStatus = {
  ready: boolean
  lastReconcileAt?: string
  pendingWrites: number
  conflicts: number
}

export type CloudAgentSyncMode = 'sandbox-priority' | 'local-priority'

export type CloudAgentStatus = {
  binding: CloudAgentBinding
  sandbox: { id: string; status: CloudAgentSandboxStatus; phase?: CloudAgentSandboxPhase; etaMs?: number }
  mount: CloudAgentMountStatus
  syncMode: CloudAgentSyncMode
}

export type CloudAgentEvent =
  | { type: 'sandbox-status'; projectId: string; status: CloudAgentSandboxStatus; phase?: CloudAgentSandboxPhase; etaMs?: number }
  | { type: 'mount-status'; projectId: string; mount: CloudAgentMountStatus }
  | { type: 'sync-mode-changed'; projectId: string; syncMode: CloudAgentSyncMode }
  | { type: 'error'; projectId: string; message: string }
