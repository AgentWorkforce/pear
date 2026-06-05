import { create } from 'zustand'

export type UpdateStatus = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error'

interface UpdateState {
  status: UpdateStatus
  version: string | null
  percent: number
  error: string | null
  dismissed: boolean

  markAvailable: (version: string) => void
  markDownloading: (percent: number) => void
  markDownloaded: (version: string) => void
  markError: (message: string) => void
  dismiss: () => void
}

/**
 * Mirrors the main-process auto-update lifecycle for the in-app banner. Fed by
 * `useUpdateEvents`; read by `UpdateBanner`. A new `available`/`downloaded`
 * transition clears `dismissed` so the relevant CTA always re-surfaces.
 */
export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  version: null,
  percent: 0,
  error: null,
  dismissed: false,

  markAvailable: (version) => set({ status: 'available', version, error: null, dismissed: false }),
  markDownloading: (percent) => set({ status: 'downloading', percent }),
  markDownloaded: (version) =>
    set({ status: 'downloaded', version, percent: 100, error: null, dismissed: false }),
  markError: (message) => set({ status: 'error', error: message }),
  dismiss: () => set({ dismissed: true })
}))
