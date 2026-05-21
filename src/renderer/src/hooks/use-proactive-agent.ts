import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { pear, type ProactiveAgentBinding, type ProactiveAgentEvent } from '@/lib/ipc'

export type ProactiveAgentsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface UseProactiveAgentsResult {
  bindings: ProactiveAgentBinding[]
  status: ProactiveAgentsStatus
  error: string | null
  refresh: () => Promise<void>
  create: (draft: ProactiveAgentBinding['draft']) => Promise<ProactiveAgentBinding | null>
  update: (personaId: string, draft: ProactiveAgentBinding['draft']) => Promise<ProactiveAgentBinding | null>
  deploy: (personaId: string) => Promise<void>
  pause: (personaId: string) => Promise<void>
  resume: (personaId: string) => Promise<void>
  undeploy: (personaId: string) => Promise<void>
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function applyEvent(
  projectId: string,
  event: ProactiveAgentEvent,
  setBindings: Dispatch<SetStateAction<ProactiveAgentBinding[]>>
): void {
  if (event.projectId !== projectId) return

  if (event.type === 'binding-updated') {
    setBindings((current) => {
      const index = current.findIndex((binding) => binding.personaId === event.personaId)
      if (index === -1) return [event.binding, ...current]
      const next = [...current]
      next[index] = event.binding
      return next
    })
    return
  }

  if (event.type === 'binding-removed') {
    setBindings((current) => current.filter((binding) => binding.personaId !== event.personaId))
  }
}

export function useProactiveAgents(projectId: string | null): UseProactiveAgentsResult {
  const [bindings, setBindings] = useState<ProactiveAgentBinding[]>([])
  const [status, setStatus] = useState<ProactiveAgentsStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setBindings([])
      setStatus('idle')
      return
    }

    setStatus('loading')
    try {
      setError(null)
      const nextBindings = await pear.proactiveAgent.list(projectId)
      setBindings(nextBindings)
      setStatus('ready')
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('error')
    }
  }, [projectId])

  const create = useCallback(async (draft: ProactiveAgentBinding['draft']): Promise<ProactiveAgentBinding | null> => {
    if (!projectId) return null

    try {
      setError(null)
      const binding = await pear.proactiveAgent.create(projectId, draft)
      setBindings((current) => [binding, ...current.filter((entry) => entry.personaId !== binding.personaId)])
      setStatus('ready')
      return binding
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('error')
      return null
    }
  }, [projectId])

  const update = useCallback(async (
    personaId: string,
    draft: ProactiveAgentBinding['draft']
  ): Promise<ProactiveAgentBinding | null> => {
    if (!projectId) return null

    try {
      setError(null)
      const binding = await pear.proactiveAgent.update(projectId, personaId, draft)
      setBindings((current) => current.map((entry) => entry.personaId === personaId ? binding : entry))
      setStatus('ready')
      return binding
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('error')
      return null
    }
  }, [projectId])

  const deploy = useCallback(async (personaId: string): Promise<void> => {
    if (!projectId) return

    try {
      setError(null)
      await pear.proactiveAgent.deploy(projectId, personaId)
      await refresh()
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('error')
    }
  }, [projectId, refresh])

  const pause = useCallback(async (personaId: string): Promise<void> => {
    if (!projectId) return

    try {
      setError(null)
      await pear.proactiveAgent.pause(projectId, personaId)
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('error')
    }
  }, [projectId])

  const resume = useCallback(async (personaId: string): Promise<void> => {
    if (!projectId) return

    try {
      setError(null)
      await pear.proactiveAgent.resume(projectId, personaId)
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('error')
    }
  }, [projectId])

  const undeploy = useCallback(async (personaId: string): Promise<void> => {
    if (!projectId) return

    try {
      setError(null)
      await pear.proactiveAgent.undeploy(projectId, personaId)
      setBindings((current) => current.filter((binding) => binding.personaId !== personaId))
    } catch (err) {
      setError(getErrorMessage(err))
      setStatus('error')
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) return undefined
    return pear.proactiveAgent.onEvent((event) => applyEvent(projectId, event, setBindings))
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return {
    bindings,
    status,
    error,
    refresh,
    create,
    update,
    deploy,
    pause,
    resume,
    undeploy
  }
}

export default useProactiveAgents
