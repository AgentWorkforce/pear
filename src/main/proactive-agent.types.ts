export type ProactiveAgentHarness = 'claude' | 'codex' | 'opencode'
export type ProactiveAgentStatus = 'draft' | 'warming' | 'active' | 'paused' | 'error'
export type ProactiveAgentRunStatus = 'running' | 'succeeded' | 'failed'
export type ProactiveAgentRunMode = 'cloud' | 'local'
export type ProactiveAgentWatchEventKind = 'created' | 'updated' | 'deleted'
export type ProactiveAgentDeployPhase = 'validate' | 'bundle' | 'upload' | 'warm' | 'register'

export type ProactiveAgentWatchRule = {
  paths: string[]
  events: ProactiveAgentWatchEventKind[]
  debounceMs?: number
  match?: string
}

export type ProactiveAgentMemoryConfig = {
  enabled: boolean
  scopes?: Array<'workspace' | 'project' | 'persona'>
  ttlDays?: number
}

export type ProactiveAgentHarnessSettings = {
  reasoning?: 'low' | 'medium' | 'high'
  timeoutSeconds?: number
}

export type ProactiveAgentMountConfig = {
  enabled: boolean
}

export type ProactiveAgentDraft = {
  id: string
  name: string
  description?: string
  cloudAgentId: string
  harness: ProactiveAgentHarness
  model: string
  systemPrompt: string
  integrations: Record<string, Record<string, unknown>>
  watch: ProactiveAgentWatchRule[]
  handlerCode: string
  inputs?: Record<string, string>
  memory?: ProactiveAgentMemoryConfig
  harnessSettings?: ProactiveAgentHarnessSettings
  mount?: ProactiveAgentMountConfig
  useSubscription?: boolean
  runMode?: ProactiveAgentRunMode
}

export type ProactiveAgentBinding = {
  projectId: string
  personaId: string
  cloudAgentId: string
  status: ProactiveAgentStatus
  lastError?: string
  lastFiredAt?: string
  createdAt: string
  updatedAt: string
  draft: ProactiveAgentDraft
}

export type ProactiveAgentRunTrigger = {
  type: 'relayfile-change'
  path: string
  eventKind: ProactiveAgentWatchEventKind
}

export type ProactiveAgentRun = {
  runId: string
  projectId: string
  personaId: string
  firedAt: string
  trigger: ProactiveAgentRunTrigger
  durationMs?: number
  status: ProactiveAgentRunStatus
  summary?: string
  error?: string
}

export type ProactiveAgentTranscriptMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  ts: string
}

export type ProactiveAgentTranscript = {
  runId: string
  projectId?: string
  personaId?: string
  messages: ProactiveAgentTranscriptMessage[]
}

export type ProactiveAgentRunsPage = {
  runs: ProactiveAgentRun[]
  nextCursor?: string
}

export type ProactiveAgentDeployResult = {
  status: 'active' | 'warming' | 'error'
  error?: string
}

export type ProactiveAgentEvent =
  | { type: 'binding-updated'; projectId: string; personaId: string; binding: ProactiveAgentBinding }
  | { type: 'binding-removed'; projectId: string; personaId: string }
  | { type: 'run-started'; projectId: string; personaId: string; run: ProactiveAgentRun }
  | { type: 'run-update'; projectId: string; personaId: string; runId: string; chunk: string }
  | { type: 'run-finished'; projectId: string; personaId: string; run: ProactiveAgentRun }
