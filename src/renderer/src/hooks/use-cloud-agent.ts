import { useCallback, useEffect, useState } from 'react'
import {
  pear,
  type CloudAgentBinding,
  type CloudAgentEvent,
  type CloudAgentRecord,
  type CloudAgentStatus
} from '@/lib/ipc'
import { useCloudAgentStore } from '@/stores/cloud-agent-store'

export interface CreateCloudAgentInput {
  name: string
  harness: string
  model: string
}

type CloudAgentError = string | null

let cloudAgentEventSubscribers = 0
let unsubscribeCloudAgentEvents: (() => void) | null = null

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setCloudAgentStatus(projectId: string, status: CloudAgentStatus | null): void {
  const store = useCloudAgentStore.getState()
  if (status === null) {
    store.setBinding(projectId, null)
    return
  }
  store.setStatus(projectId, status)
}

function subscribeCloudAgentEvents(): () => void {
  cloudAgentEventSubscribers += 1

  if (cloudAgentEventSubscribers === 1) {
    unsubscribeCloudAgentEvents = pear.cloudAgent.onEvent((event: CloudAgentEvent) => {
      useCloudAgentStore.getState().applyEvent(event)
    })
  }

  return () => {
    cloudAgentEventSubscribers = Math.max(0, cloudAgentEventSubscribers - 1)
    if (cloudAgentEventSubscribers === 0) {
      unsubscribeCloudAgentEvents?.()
      unsubscribeCloudAgentEvents = null
    }
  }
}

export function useCloudAgent(projectId: string | null): {
  binding: CloudAgentBinding | null
  status: CloudAgentStatus | null
  syncMode: CloudAgentStatus['syncMode'] | undefined
  attach: (cloudAgentId: string) => Promise<CloudAgentBinding | null>
  detach: () => Promise<void>
  refresh: () => Promise<CloudAgentStatus | null>
  isAttaching: boolean
  isDetaching: boolean
  error: CloudAgentError
} {
  const status = useCloudAgentStore((state) => projectId ? state.statuses[projectId] ?? null : null)
  const [isAttaching, setIsAttaching] = useState(false)
  const [isDetaching, setIsDetaching] = useState(false)
  const [error, setError] = useState<CloudAgentError>(null)

  const refresh = useCallback(async (): Promise<CloudAgentStatus | null> => {
    if (!projectId) return null

    try {
      setError(null)
      const nextStatus = await pear.cloudAgent.status(projectId)
      setCloudAgentStatus(projectId, nextStatus)
      return nextStatus
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    }
  }, [projectId])

  const attach = useCallback(async (cloudAgentId: string): Promise<CloudAgentBinding | null> => {
    if (!projectId) return null

    setIsAttaching(true)
    try {
      setError(null)
      const binding = await pear.cloudAgent.attach(projectId, cloudAgentId)
      await refresh()
      return binding
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    } finally {
      setIsAttaching(false)
    }
  }, [projectId, refresh])

  const detach = useCallback(async (): Promise<void> => {
    if (!projectId) return

    setIsDetaching(true)
    try {
      setError(null)
      await pear.cloudAgent.detach(projectId)
      setCloudAgentStatus(projectId, null)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsDetaching(false)
    }
  }, [projectId])

  useEffect(() => {
    return subscribeCloudAgentEvents()
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return {
    binding: status?.binding ?? null,
    status,
    syncMode: status?.syncMode,
    attach,
    detach,
    refresh,
    isAttaching,
    isDetaching,
    error
  }
}

export function useCloudAgentEvents(): void {
  useEffect(() => {
    return subscribeCloudAgentEvents()
  }, [])
}

export function useCloudAgentCatalog(): {
  catalog: CloudAgentRecord[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | undefined
  refresh: () => Promise<CloudAgentRecord[]>
  create: (input: CreateCloudAgentInput) => Promise<CloudAgentRecord | null>
  remove: (id: string) => Promise<void>
} {
  const catalog = useCloudAgentStore((state) => state.catalog)
  const status = useCloudAgentStore((state) => state.catalogStatus)
  const error = useCloudAgentStore((state) => state.catalogError)
  const setCatalog = useCloudAgentStore((state) => state.setCatalog)
  const setCatalogStatus = useCloudAgentStore((state) => state.setCatalogStatus)

  const refresh = useCallback(async (): Promise<CloudAgentRecord[]> => {
    setCatalogStatus('loading')
    try {
      const records = await pear.cloudAgent.list()
      setCatalog(records)
      setCatalogStatus('ready')
      return records
    } catch (err) {
      setCatalogStatus('error', getErrorMessage(err))
      return []
    }
  }, [setCatalog, setCatalogStatus])

  const create = useCallback(async (input: CreateCloudAgentInput): Promise<CloudAgentRecord | null> => {
    setCatalogStatus('loading')
    try {
      const record = await pear.cloudAgent.create(input)
      const currentCatalog = useCloudAgentStore.getState().catalog
      setCatalog([record, ...currentCatalog.filter((entry) => entry.id !== record.id)])
      setCatalogStatus('ready')
      return record
    } catch (err) {
      setCatalogStatus('error', getErrorMessage(err))
      return null
    }
  }, [setCatalog, setCatalogStatus])

  const remove = useCallback(async (id: string): Promise<void> => {
    setCatalogStatus('loading')
    try {
      await pear.cloudAgent.delete(id)
      const currentCatalog = useCloudAgentStore.getState().catalog
      setCatalog(currentCatalog.filter((entry) => entry.id !== id))
      setCatalogStatus('ready')
    } catch (err) {
      setCatalogStatus('error', getErrorMessage(err))
    }
  }, [setCatalog, setCatalogStatus])

  useEffect(() => {
    if (status === 'idle') {
      void refresh()
    }
  }, [refresh, status])

  return {
    catalog,
    status,
    error,
    refresh,
    create,
    remove
  }
}
