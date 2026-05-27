export type IntegrationAuthMethod = 'oauth' | 'token' | 'apikey'

export type IntegrationCapabilities = {
  webhook: boolean
  poll: boolean
  writeback: boolean
}

export type IntegrationAdapter = {
  provider: string
  displayName: string
  iconUrl?: string
  version: string
  capabilities: IntegrationCapabilities
  authMethod: IntegrationAuthMethod
  requiredScopes?: string[]
  defaultMountPaths: string[]
  description: string
}

export type ConnectedIntegration = {
  provider: string
  integrationId: string
  scope: Record<string, unknown>
  mountPaths: string[]
  connectedAt: string
  notifyAgent: boolean
  subscribeAgent?: boolean
  localMountPaths?: string[]
  lastSyncAt?: string
  lastError?: string
}

export type IntegrationConnectStatus =
  | 'pending'
  | 'awaiting-user'
  | 'choosing-scope'
  | 'completed'
  | 'error'
  | 'expired'

export type IntegrationConnectSession = {
  sessionId: string
  provider: string
  status: IntegrationConnectStatus
  authUrl?: string
  scopeChoices?: Record<string, unknown>
  integrationId?: string
  error?: string
}

export type IntegrationsEvent =
  | { type: 'session-update'; sessionId: string; session: IntegrationConnectSession }
  | { type: 'integration-added'; projectId: string; integration: ConnectedIntegration }
  | { type: 'integration-removed'; projectId: string; integrationId: string }
  | { type: 'integration-error'; projectId: string; integrationId: string; message: string }
