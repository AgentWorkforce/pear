export interface PearAPI {
  workspace: {
    list: () => Promise<{ workspaces: unknown[]; activeId: string | null }>
    add: (name: string, rootPath?: string) => Promise<unknown>
    remove: (id: string) => Promise<void>
    setActive: (id: string | null) => Promise<void>
    update: (id: string, update: Record<string, unknown>) => Promise<void>
  }
  worktree: {
    addChannel: (workspaceId: string, worktreeId: string, name: string) => Promise<void>
    removeChannel: (workspaceId: string, worktreeId: string, name: string) => Promise<void>
  }
  broker: {
    start: (cwd: string, name: string) => Promise<void>
    spawnAgent: (input: {
      name: string
      cli: string
      model?: string
      task?: string
      channels?: string[]
      cwd?: string
    }) => Promise<void>
    sendInput: (name: string, data: string) => Promise<void>
    resizePty: (name: string, rows: number, cols: number) => Promise<void>
    sendMessage: (input: { to: string; text: string; from?: string }) => Promise<void>
    releaseAgent: (name: string) => Promise<void>
    listAgents: () => Promise<string[]>
    shutdown: () => Promise<void>
    onEvent: (callback: (event: unknown) => void) => () => void
    onStatus: (callback: (status: { status: string; error?: string }) => void) => () => void
  }
  git: {
    listWorktrees: (root: string) => Promise<{ path: string; branch: string; head: string }[]>
    addWorktree: (root: string, branch: string, baseBranch?: string) => Promise<string>
    removeWorktree: (root: string, path: string) => Promise<void>
    status: (path: string) => Promise<{ path: string; status: string; staged: boolean }[]>
    diff: (path: string, file?: string) => Promise<string>
    branches: (root: string) => Promise<string[]>
  }
  fs: {
    listDir: (dirPath: string) => Promise<
      { name: string; path: string; type: 'file' | 'directory' }[]
    >
    readPreview: (filePath: string) => Promise<{
      kind: 'text' | 'binary' | 'too-large' | 'missing'
      content: string
      size: number
    }>
  }
  onMenu: (channel: string, callback: (...args: unknown[]) => void) => () => void
}

declare global {
  interface Window {
    pear: PearAPI
  }
}

export const pear = window.pear
