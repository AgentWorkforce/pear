// Renderer-facing IPC entry point.
//
// All IPC type definitions live in @shared/types/ipc (a single source of
// truth shared with the preload, which uses `satisfies PearAPI` to enforce
// the implementation matches). We re-export everything from there so
// existing `import { ..., type Foo } from '@/lib/ipc'` call sites keep
// working unchanged.

import type { PearAPI as PearAPIType } from '@shared/types/ipc'
import { pear as electronPear } from './ipc-electron'
import { pearMock, pearMockHarness } from './ipc-mock'

export * from '@shared/types/ipc'

const useMockIpc = import.meta.env.VITE_PEAR_MOCK_IPC === 'true'

if (useMockIpc && typeof window !== 'undefined') {
  window.__pearMock = pearMockHarness
}

export const pear: PearAPIType = useMockIpc
  ? pearMock
  : electronPear
