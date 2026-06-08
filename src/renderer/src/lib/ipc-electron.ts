import type { PearAPI } from '@shared/types/ipc'

declare global {
  interface Window {
    pear: PearAPI
  }
}

export const pear = window.pear
