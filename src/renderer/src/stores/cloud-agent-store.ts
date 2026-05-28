import { create } from 'zustand'
import type {
  CloudAgentRecord,
  CloudAgentBinding,
  CloudAgentStatus,
  CloudAgentEvent
} from '@/lib/ipc'

export type CloudAgentAuthStatus = 'unknown' | 'signed-out' | 'signed-in'
export type CloudAgentCatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface CloudAgentAttachProgress {
  phase: 'idle' | 'warming-sandbox' | 'mounting' | 'connecting-broker' | 'done' | 'error'
  message?: string
  startedAt: number
}

interface CloudAgentState {
  catalog: CloudAgentRecord[]
  catalogLoadedAt: number | null
  catalogLoading: boolean
  catalogStatus: CloudAgentCatalogStatus
  catalogError: string | undefined
  authStatus: CloudAgentAuthStatus
  bindings: Record<string, CloudAgentBinding>
  statuses: Record<string, CloudAgentStatus>
  attachProgress: Record<string, CloudAgentAttachProgress>

  setCatalog(records: CloudAgentRecord[]): void
  setCatalogLoading(loading: boolean): void
  setCatalogStatus(status: CloudAgentCatalogStatus, error?: string | null): void
  setCatalogError(error: string | null): void
  upsertCatalogEntry(record: CloudAgentRecord): void
  removeCatalogEntry(id: string): void

  setAuthStatus(status: CloudAgentAuthStatus): void

  setBinding(projectId: string, binding: CloudAgentBinding | null): void
  setStatus(projectId: string, status: CloudAgentStatus | null): void
  setAttachProgress(projectId: string, progress: CloudAgentAttachProgress | null): void

  applyEvent(event: CloudAgentEvent): void

  getBinding(projectId: string): CloudAgentBinding | undefined
  getStatus(projectId: string): CloudAgentStatus | undefined
  getCatalogEntry(id: string): CloudAgentRecord | undefined

  clearAll(): void
}

export const useCloudAgentStore = create<CloudAgentState>((set, get) => ({
  catalog: [],
  catalogLoadedAt: null,
  catalogLoading: false,
  catalogStatus: 'idle',
  catalogError: undefined,
  authStatus: 'unknown',
  bindings: {},
  statuses: {},
  attachProgress: {},

  setCatalog: (records) => set({
    catalog: records,
    catalogLoadedAt: Date.now(),
    catalogLoading: false,
    catalogStatus: 'ready',
    catalogError: undefined
  }),

  setCatalogLoading: (loading) => set({
    catalogLoading: loading,
    catalogStatus: loading ? 'loading' : get().catalogStatus
  }),

  setCatalogStatus: (status, error = null) => set({
    catalogStatus: status,
    catalogLoading: status === 'loading',
    catalogError: status === 'error' ? error ?? undefined : undefined
  }),

  setCatalogError: (error) => set({
    catalogError: error ?? undefined,
    catalogStatus: error ? 'error' : get().catalogStatus,
    catalogLoading: false
  }),

  upsertCatalogEntry: (record) => set((state) => {
    const existingIndex = state.catalog.findIndex((entry) => entry.id === record.id)
    const catalog = existingIndex === -1
      ? [...state.catalog, record]
      : state.catalog.map((entry, index) => index === existingIndex ? record : entry)
    return { catalog, catalogLoadedAt: Date.now(), catalogError: undefined }
  }),

  removeCatalogEntry: (id) => set((state) => ({
    catalog: state.catalog.filter((entry) => entry.id !== id),
    catalogLoadedAt: Date.now()
  })),

  setAuthStatus: (status) => set({ authStatus: status }),

  setBinding: (projectId, binding) => set((state) => {
    if (binding === null) {
      const { [projectId]: _binding, ...bindings } = state.bindings
      const { [projectId]: _status, ...statuses } = state.statuses
      const { [projectId]: _progress, ...attachProgress } = state.attachProgress
      return { bindings, statuses, attachProgress }
    }
    return { bindings: { ...state.bindings, [projectId]: binding } }
  }),

  setStatus: (projectId, status) => set((state) => {
    if (status === null) {
      const { [projectId]: _status, ...statuses } = state.statuses
      return { statuses }
    }
    return {
      statuses: { ...state.statuses, [projectId]: status },
      bindings: { ...state.bindings, [projectId]: status.binding }
    }
  }),

  setAttachProgress: (projectId, progress) => set((state) => {
    if (progress === null) {
      const { [projectId]: _progress, ...attachProgress } = state.attachProgress
      return { attachProgress }
    }
    return { attachProgress: { ...state.attachProgress, [projectId]: progress } }
  }),

  applyEvent: (event) => set((state) => {
    const current = state.statuses[event.projectId]

    switch (event.type) {
      case 'sandbox-status': {
        // The attach flow emits sandbox-status events from the very first POST
        // response, before any persisted CloudAgentStatus row exists. Always
        // surface the latest status into attachProgress so the picker can show
        // "Warming sandbox… / Connecting broker… / Ready" instead of an opaque
        // spinner. Then merge into the persisted status row if we have one.
        const existingProgress = state.attachProgress[event.projectId]
        const startedAt = existingProgress?.startedAt ?? Date.now()
        const phase: CloudAgentAttachProgress['phase'] =
          event.status === 'ready' ? 'connecting-broker'
          : event.status === 'failed' ? 'error'
          : event.status === 'stopping' || event.status === 'stopped' ? 'idle'
          : 'warming-sandbox'
        const nextProgress: CloudAgentAttachProgress = {
          phase,
          message: `Sandbox ${event.status}`,
          startedAt
        }
        return {
          attachProgress: { ...state.attachProgress, [event.projectId]: nextProgress },
          ...(current ? {
            statuses: {
              ...state.statuses,
              [event.projectId]: {
                ...current,
                sandbox: { ...current.sandbox, status: event.status }
              }
            }
          } : {})
        }
      }

      case 'mount-status': {
        if (!current) return {}
        return {
          statuses: {
            ...state.statuses,
            [event.projectId]: { ...current, mount: event.mount }
          }
        }
      }

      case 'sync-mode-changed': {
        if (!current) return {}
        return {
          statuses: {
            ...state.statuses,
            [event.projectId]: { ...current, syncMode: event.syncMode }
          }
        }
      }

      case 'error':
        return {
          attachProgress: {
            ...state.attachProgress,
            [event.projectId]: {
              phase: 'error',
              message: event.message,
              startedAt: Date.now()
            }
          }
        }
    }

    return {}
  }),

  getBinding: (projectId) => get().bindings[projectId],
  getStatus: (projectId) => get().statuses[projectId],
  getCatalogEntry: (id) => get().catalog.find((entry) => entry.id === id),

  clearAll: () => set({
    catalog: [],
    catalogLoadedAt: null,
    catalogLoading: false,
    catalogStatus: 'idle',
    catalogError: undefined,
    authStatus: 'unknown',
    bindings: {},
    statuses: {},
    attachProgress: {}
  })
}))
