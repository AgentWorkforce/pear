import type { PearAPI } from '@shared/types/ipc'

declare global {
  interface Window {
    pear: PearAPI
  }
}

// Guard against evaluation in non-browser environments (vitest in node env,
// web preview bundle eval before the selector switches modes, etc.). In
// mock mode `ipc.ts` reads `pearMock` and never touches this value, so
// production callers always run inside Electron with the preload installed.
export const pear: PearAPI = (typeof window !== 'undefined' ? window.pear : undefined) as PearAPI
