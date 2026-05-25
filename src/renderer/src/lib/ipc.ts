// Renderer-facing IPC entry point.
//
// All IPC type definitions live in @shared/types/ipc (a single source of
// truth shared with the preload, which uses `satisfies PearAPI` to enforce
// the implementation matches). We re-export everything from there so
// existing `import { ..., type Foo } from '@/lib/ipc'` call sites keep
// working unchanged.

import type { PearAPI } from '@shared/types/ipc'

export * from '@shared/types/ipc'

declare global {
  interface Window {
    pear: PearAPI
  }
}

export const pear = window.pear
