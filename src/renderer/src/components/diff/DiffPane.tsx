import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'
import { buildSelectedPatch, getFilePathFromLineSelectionId, getSelectableLineIds } from '@/lib/diff-selection'
import { pear, type AuthUser, type GitBranchSyncStatus } from '@/lib/ipc'
import { useProjectStore, type ProjectRoot } from '@/stores/project-store'
import { useGitStore } from '@/stores/git-store'
import { useUIStore } from '@/stores/ui-store'
import { getAgentKey, useAgentStore } from '@/stores/agent-store'
import { PaneSidebar } from '@/components/common/PaneShell'
import { CurrentBranchSelector, CurrentRootSelector, FetchOriginButton } from './RepoHeader'
import { ChangesDiffView, FileListPanel } from './FileListPanel'
import { CommitForm } from './CommitForm'
import { CommitHistoryDetail, CommitHistoryList } from './HistoryView'
import { FileContextMenu } from './FileContextMenu'
import { EmptyRepoState, PaneTabs } from './DiffPaneChrome'
import {
  absoluteFilePath,
  agentToCoAuthor,
  appendCoAuthorTrailers,
  coAuthorKey,
  coAuthorSearchScore,
  compactReviewDiff,
  contextMenuPosition,
  fileRange,
  gitStateForRoot,
  mergeCoAuthors,
  nextFilePath,
  nextReviewChannelName,
  normalizeCoAuthor,
  normalizeCoAuthorUsername,
  orderedSelectedPaths,
  pluralize,
  sameStringSet,
  scrollCommitRowIntoView,
  scrollFileRowIntoView,
  selectedChangeFiles,
  shouldPublishBranch,
  startPanelResize,
  useWindowFocused,
  writeClipboardText,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  SOURCE_HEADER_HEIGHT,
  type CoAuthor,
  type EmptyFileProbe,
  type FileContextMenuState,
  type PaneTab,
  type RootGitState
} from './diffPaneUtils'

export function DiffPane(): React.ReactNode {
  const [activeTab, setActiveTab] = useState<PaneTab>('changes')
  const [filter, setFilter] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [coAuthorPanelOpen, setCoAuthorPanelOpen] = useState(false)
  const [coAuthorInput, setCoAuthorInput] = useState('')
  const [coAuthors, setCoAuthors] = useState<CoAuthor[]>([])
  const [selectedCoAuthorSuggestionIndex, setSelectedCoAuthorSuggestionIndex] = useState(0)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set())
  const [emptyFileProbe, setEmptyFileProbe] = useState<EmptyFileProbe | null>(null)
  const [selectionInitialized, setSelectionInitialized] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(420)
  const [historyFilesWidth, setHistoryFilesWidth] = useState(360)
  const [commitDetailsExpanded, setCommitDetailsExpanded] = useState(false)
  const [branchSyncStatus, setBranchSyncStatus] = useState<GitBranchSyncStatus | null>(null)
  const [branchStatusLoading, setBranchStatusLoading] = useState(false)
  const [branchSyncLoading, setBranchSyncLoading] = useState(false)
  const [branchSyncError, setBranchSyncError] = useState<string | null>(null)
  const [lastFetchedByRoot, setLastFetchedByRoot] = useState<Record<string, number>>({})
  const [rootGitStates, setRootGitStates] = useState<Record<string, RootGitState>>({})
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null)
  const [fileRowSelection, setFileRowSelection] = useState<Set<string>>(new Set())
  const [fileRowSelectionAnchor, setFileRowSelectionAnchor] = useState<string | null>(null)
  const coAuthorTriggerRef = useRef<HTMLButtonElement>(null)
  const coAuthorPanelRef = useRef<HTMLDivElement>(null)
  const coAuthorInputRef = useRef<HTMLInputElement>(null)
  const changedFilesListRef = useRef<HTMLDivElement>(null)
  const historyCommitListRef = useRef<HTMLDivElement>(null)
  const historyFilesListRef = useRef<HTMLDivElement>(null)
  const windowFocused = useWindowFocused()
  const activeProject = useProjectStore((s) => s.getActiveProject())
  const root = useProjectStore((s) => s.getActiveRoot()) as ProjectRoot
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveRoot = useProjectStore((s) => s.setActiveRoot)
  const agents = useAgentStore((s) => s.agents)
  const files = useGitStore((s) => s.files)
  const diff = useGitStore((s) => s.diff)
  const selectedFile = useGitStore((s) => s.selectedFile)
  const history = useGitStore((s) => s.history)
  const selectedCommit = useGitStore((s) => s.selectedCommit)
  const selectedCommitFile = useGitStore((s) => s.selectedCommitFile)
  const commitDiff = useGitStore((s) => s.commitDiff)
  const summary = useGitStore((s) => s.summary)
  const loading = useGitStore((s) => s.loading)
  const historyLoading = useGitStore((s) => s.historyLoading)
  const actionLoading = useGitStore((s) => s.actionLoading)
  const selectFile = useGitStore((s) => s.selectFile)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const selectCommitFile = useGitStore((s) => s.selectCommitFile)
  const commitSelection = useGitStore((s) => s.commitSelection)
  const generateCommitMessage = useGitStore((s) => s.generateCommitMessage)
  const commitDraftStatus = useGitStore((s) => (root ? s.commitDraftStatusByRoot[root.path] : undefined))
  const commitDraftError = useGitStore((s) => (root ? s.commitDraftErrorByRoot[root.path] : undefined))
  const pendingCommitDraft = useGitStore((s) => (root ? s.commitDraftByRoot[root.path] : undefined))
  const consumeCommitDraft = useGitStore((s) => s.consumeCommitDraft)
  const clearCommitDraftError = useGitStore((s) => s.clearCommitDraftError)
  const fetchStatus = useGitStore((s) => s.fetchStatus)
  const fetchSummary = useGitStore((s) => s.fetchSummary)
  const fetchHistory = useGitStore((s) => s.fetchHistory)
  const selectedFileEntry = files.find((file) => file.path === selectedFile)
  const activeRootGitState = root ? gitStateForRoot(root, rootGitStates) : 'not-git'
  const hasActiveGitRoot = !!root?.pathExists && activeRootGitState === 'git'
  const rootProbeKey = useMemo(
    () => activeProject?.roots
      .map((projectRoot) => `${projectRoot.id}:${projectRoot.path}:${projectRoot.pathExists ? '1' : '0'}`)
      .join('\n') || '',
    [activeProject?.roots]
  )

  useEffect(() => {
    const roots = activeProject?.roots || []
    if (roots.length === 0) {
      setRootGitStates({})
      return
    }

    let cancelled = false
    const initialStates: Record<string, RootGitState> = {}
    roots.forEach((projectRoot) => {
      initialStates[projectRoot.id] = projectRoot.pathExists ? 'checking' : 'not-git'
    })
    setRootGitStates(initialStates)

    roots.forEach((projectRoot) => {
      if (!projectRoot.pathExists) return

      pear.git.summary(projectRoot.path)
        .then((summary) => {
          if (cancelled) return
          setRootGitStates((current) => ({
            ...current,
            [projectRoot.id]: summary ? 'git' : 'not-git'
          }))
        })
        .catch(() => {
          if (cancelled) return
          setRootGitStates((current) => ({ ...current, [projectRoot.id]: 'not-git' }))
        })
    })

    return () => {
      cancelled = true
    }
  }, [activeProject?.id, rootProbeKey])

  useEffect(() => {
    if (!activeProject || activeProject.roots.length === 0) return
    if (root?.pathExists && activeRootGitState !== 'not-git') return

    const firstGitRoot = activeProject.roots.find((projectRoot) => rootGitStates[projectRoot.id] === 'git')
    if (firstGitRoot && firstGitRoot.id !== root?.id) {
      setActiveRoot(firstGitRoot.id)
    }
  }, [activeProject, activeRootGitState, root?.id, root?.pathExists, rootGitStates, setActiveRoot])

  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return files
    return files.filter((file) => file.path.toLowerCase().includes(query))
  }, [files, filter])
  const coAuthorSuggestions = useMemo(() => {
    const selected = new Set(coAuthors.map((coAuthor) => coAuthorKey(coAuthor.username)))
    const query = normalizeCoAuthorUsername(coAuthorInput)
    const byUsername = new Map<string, CoAuthor>()

    for (const agent of agents) {
      if (agent.status !== 'running') continue
      if (activeProjectId && agent.projectId !== activeProjectId) continue

      const coAuthor = agentToCoAuthor(agent)
      if (!coAuthor) continue

      const key = coAuthorKey(coAuthor.username)
      if (selected.has(key) || byUsername.has(key)) continue
      if (coAuthorSearchScore(coAuthor.username, query) === Number.POSITIVE_INFINITY) continue

      byUsername.set(key, coAuthor)
    }

    return Array.from(byUsername.values())
      .sort((left, right) => {
        const scoreDelta =
          coAuthorSearchScore(left.username, query) - coAuthorSearchScore(right.username, query)
        if (scoreDelta !== 0) return scoreDelta
        return left.username.localeCompare(right.username)
      })
      .slice(0, 6)
  }, [activeProjectId, agents, coAuthorInput, coAuthors])
  const selectedFileList = useMemo(() => Array.from(selectedFiles), [selectedFiles])
  const selectedChangeFileList = useMemo(
    () => selectedChangeFiles(selectedFiles, selectedLineIds),
    [selectedFiles, selectedLineIds]
  )
  const filteredFilePaths = useMemo(() => filteredFiles.map((file) => file.path), [filteredFiles])
  const historyCommitHashes = useMemo(() => history.map((commit) => commit.hash), [history])
  const selectedCommitFilePaths = useMemo(
    () => selectedCommit?.files.map((file) => file.path) || [],
    [selectedCommit]
  )
  const selectableLineIdsByFilePath = useMemo(() => {
    const lineIdsByFilePath = new Map<string, string[]>()

    getSelectableLineIds(diff).forEach((lineId) => {
      const filePath = getFilePathFromLineSelectionId(lineId)
      if (!filePath) return
      lineIdsByFilePath.set(filePath, [...(lineIdsByFilePath.get(filePath) || []), lineId])
    })

    return lineIdsByFilePath
  }, [diff])
  const fullySelectedLineFilePaths = useMemo(() => {
    const filePaths = new Set<string>()

    selectableLineIdsByFilePath.forEach((lineIds, filePath) => {
      if (lineIds.length > 0 && lineIds.every((lineId) => selectedLineIds.has(lineId))) {
        filePaths.add(filePath)
      }
    })

    return filePaths
  }, [selectableLineIdsByFilePath, selectedLineIds])
  const partiallySelectedFilePaths = useMemo(
    () => new Set(Array.from(selectedLineIds).map(getFilePathFromLineSelectionId).filter(Boolean)),
    [selectedLineIds]
  )
  const toggleFile = useCallback((path: string, currentlySelected = false): void => {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (currentlySelected || next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(Array.from(current).filter((id) => getFilePathFromLineSelectionId(id) !== path))
      return sameStringSet(current, next) ? current : next
    })
  }, [])
  const toggleLine = useCallback((filePath: string, lineId: string): void => {
    setSelectedFiles((current) => {
      if (!current.has(filePath)) return current
      const next = new Set(current)
      next.delete(filePath)
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(current)
      if (next.has(lineId)) {
        next.delete(lineId)
      } else {
        next.add(lineId)
      }
      return next
    })
  }, [])
  const setLinesSelected = useCallback((filePath: string, lineIds: string[], selected: boolean): void => {
    setSelectedFiles((current) => {
      if (!current.has(filePath)) return current
      const next = new Set(current)
      next.delete(filePath)
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(current)
      lineIds.forEach((lineId) => {
        if (selected) {
          next.add(lineId)
        } else {
          next.delete(lineId)
        }
      })
      return sameStringSet(current, next) ? current : next
    })
  }, [])

  useEffect(() => {
    setSelectedFiles(new Set())
    setSelectedLineIds(new Set())
    setSelectionInitialized(false)
    setCoAuthorPanelOpen(false)
    setCoAuthorInput('')
    setCoAuthors([])
    setSelectedCoAuthorSuggestionIndex(0)
    setFileContextMenu(null)
    setFileRowSelection(new Set())
    setFileRowSelectionAnchor(null)
  }, [root?.path])

  useEffect(() => {
    setCommitDetailsExpanded(false)
  }, [selectedCommit?.hash])

  useEffect(() => {
    if (!coAuthorPanelOpen) return
    window.requestAnimationFrame(() => {
      coAuthorInputRef.current?.focus()
    })
  }, [coAuthorPanelOpen])

  useEffect(() => {
    if (!coAuthorPanelOpen) return

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target
      if (!(target instanceof Node)) return
      if (coAuthorTriggerRef.current?.contains(target)) return
      if (coAuthorPanelRef.current?.contains(target)) return

      setCoAuthorPanelOpen(false)
      setCoAuthorInput('')
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [coAuthorPanelOpen])

  useEffect(() => {
    setSelectedCoAuthorSuggestionIndex(0)
  }, [activeProjectId, coAuthorInput, coAuthors])

  useEffect(() => {
    let cancelled = false
    pear.auth.status()
      .then((status) => {
        if (!cancelled) setAuthUser(status.user || null)
      })
      .catch(() => {
        if (!cancelled) setAuthUser(null)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const currentPaths = new Set(files.map((file) => file.path))
    setSelectedFiles((current) => {
      const next = !selectionInitialized && files.length > 0
        ? new Set(files.map((file) => file.path))
        : new Set(Array.from(current).filter((path) => currentPaths.has(path)))
      return sameStringSet(current, next) ? current : next
    })
    if (!selectionInitialized && files.length > 0) {
      setSelectionInitialized(true)
    }
    setSelectedLineIds((current) => {
      const next = Array.from(current).filter((id) => currentPaths.has(getFilePathFromLineSelectionId(id)))
      const nextSet = new Set(next)
      return sameStringSet(current, nextSet) ? current : nextSet
    })
  }, [files, selectionInitialized])

  useEffect(() => {
    const currentPaths = new Set(files.map((file) => file.path))
    setFileRowSelection((current) => {
      const next = new Set(Array.from(current).filter((path) => currentPaths.has(path)))
      return sameStringSet(current, next) ? current : next
    })
    setFileRowSelectionAnchor((current) => current && currentPaths.has(current) ? current : null)
    setFileContextMenu((current) => {
      if (!current) return current
      const nextPaths = current.paths.filter((path) => currentPaths.has(path))
      return nextPaths.length === current.paths.length ? current : null
    })
  }, [files])

  useEffect(() => {
    if (!fileContextMenu) return

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setFileContextMenu(null)
      }
    }

    function closeMenu(): void {
      setFileContextMenu(null)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [fileContextMenu])

  useEffect(() => {
    if (activeTab !== 'changes' || !root || !hasActiveGitRoot) return

    const firstFile = files[0]?.path || null
    const selectedFileStillExists = !!selectedFile && files.some((file) => file.path === selectedFile)

    if (!firstFile) {
      if (selectedFile) selectFile(null, root.path)
      return
    }

    if (!selectedFileStillExists) {
      selectFile(firstFile, root.path)
    }
  }, [activeTab, files, hasActiveGitRoot, root, selectFile, selectedFile])

  useEffect(() => {
    if (activeTab !== 'changes' || !hasActiveGitRoot) return

    window.requestAnimationFrame(() => {
      changedFilesListRef.current?.focus({ preventScroll: true })
    })
  }, [activeTab, hasActiveGitRoot, root?.path])

  // Drain any commit draft that arrived while DiffPane was unmounted (e.g.
  // user clicked Generate, switched tabs, then came back). The store holds
  // the draft until it's consumed here.
  useEffect(() => {
    if (!root || !pendingCommitDraft) return
    const draft = consumeCommitDraft(root.path)
    if (!draft) return
    setTitle(draft.title)
    setBody(draft.body)
    setMessage('Generated commit message.')
  }, [root, pendingCommitDraft, consumeCommitDraft])

  useEffect(() => {
    if (!root || !commitDraftError) return
    setMessage(commitDraftError)
    clearCommitDraftError(root.path)
  }, [root, commitDraftError, clearCommitDraftError])

  useEffect(() => {
    if (activeTab !== 'history' || !hasActiveGitRoot) return

    window.requestAnimationFrame(() => {
      historyCommitListRef.current?.focus({ preventScroll: true })
    })
  }, [activeTab, hasActiveGitRoot, root?.path])

  useEffect(() => {
    if (!root || !hasActiveGitRoot || !selectedFileEntry || loading || diff.trim()) {
      setEmptyFileProbe(null)
      return
    }

    let cancelled = false
    const rootPath = root.path
    const filePath = selectedFileEntry.path

    setEmptyFileProbe((current) =>
      current?.rootPath === rootPath && current.path === filePath ? current : null
    )

    pear.fs.readPreview(absoluteFilePath(rootPath, filePath))
      .then((preview) => {
        if (cancelled) return
        setEmptyFileProbe({
          rootPath,
          path: filePath,
          empty: preview.kind !== 'missing' && preview.size === 0
        })
      })
      .catch(() => {
        if (!cancelled) setEmptyFileProbe({ rootPath, path: filePath, empty: false })
      })

    return () => {
      cancelled = true
    }
  }, [diff, hasActiveGitRoot, loading, root, selectedFileEntry?.path])

  useEffect(() => {
    if (activeTab !== 'changes') return
    scrollFileRowIntoView(changedFilesListRef.current, selectedFile)
  }, [activeTab, filteredFilePaths, selectedFile])

  useEffect(() => {
    if (activeTab !== 'history') return
    scrollCommitRowIntoView(historyCommitListRef.current, selectedCommit?.hash || null)
  }, [activeTab, historyCommitHashes, selectedCommit?.hash])

  useEffect(() => {
    if (activeTab !== 'history') return
    scrollFileRowIntoView(historyFilesListRef.current, selectedCommitFile)
  }, [activeTab, selectedCommitFile, selectedCommitFilePaths])

  useEffect(() => {
    if (activeTab !== 'history' || !root || !hasActiveGitRoot) return
    void fetchHistory(root.path)
  }, [activeTab, fetchHistory, hasActiveGitRoot, root])

  useEffect(() => {
    if (!root || !hasActiveGitRoot) {
      setBranchSyncStatus(null)
      setBranchStatusLoading(false)
      return
    }

    let cancelled = false
    setBranchStatusLoading(true)
    setBranchSyncError(null)
    pear.git.branchSyncStatus(root.path)
      .then((status) => {
        if (!cancelled) setBranchSyncStatus(status)
      })
      .catch((error) => {
        if (!cancelled) {
          setBranchSyncStatus(null)
          setBranchSyncError(error instanceof Error ? error.message : 'Unable to read branch status')
        }
      })
      .finally(() => {
        if (!cancelled) setBranchStatusLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [hasActiveGitRoot, root, summary?.branch])

  if (!root || !root.pathExists || activeRootGitState !== 'git') {
    const rootMessage = !root
      ? 'Select a project root to see changes.'
      : !root.pathExists
        ? 'Select an available project root to see changes.'
        : activeRootGitState === 'checking'
          ? 'Checking this root for git.'
          : 'Select a git repository root to see changes.'

    return (
      <EmptyRepoState
        rootMessage={rootMessage}
        project={activeProject}
        activeRoot={root}
        gitStates={rootGitStates}
        width={leftSidebarWidth}
        onSelectRoot={setActiveRoot}
      />
    )
  }

  const allVisibleSelected = filteredFiles.length > 0 &&
    filteredFiles.every((file) => selectedFiles.has(file.path) || fullySelectedLineFilePaths.has(file.path))
  const someVisibleSelected = filteredFiles.some((file) =>
    selectedFiles.has(file.path) ||
    partiallySelectedFilePaths.has(file.path) ||
    fullySelectedLineFilePaths.has(file.path)
  ) && !allVisibleSelected
  const selectedCommitFileCount = selectedChangeFileList.length
  const commitTarget = summary?.branch || 'HEAD'
  const canCommit = selectedChangeFileList.length > 0 && title.trim().length > 0 && !actionLoading
  const coAuthorPanelVisible = coAuthorPanelOpen || coAuthors.length > 0
  const showCoAuthorSuggestions =
    coAuthorPanelOpen &&
    coAuthorSuggestions.length > 0 &&
    (coAuthorInput.trim().length > 0 || coAuthors.length === 0)
  const lastFetchedAt = root?.path ? lastFetchedByRoot[root.path] || null : null
  const selectedFileIsEmpty = !!selectedFileEntry &&
    emptyFileProbe?.rootPath === root.path &&
    emptyFileProbe.path === selectedFileEntry.path &&
    emptyFileProbe.empty
  const selectedFileProbePending = !!selectedFileEntry &&
    !loading &&
    !diff.trim() &&
    (
      !emptyFileProbe ||
      emptyFileProbe.rootPath !== root.path ||
      emptyFileProbe.path !== selectedFileEntry.path
    )

  function toggleAllVisible(): void {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        filteredFiles.forEach((file) => next.delete(file.path))
      } else {
        filteredFiles.forEach((file) => next.add(file.path))
      }
      return next
    })
  }

  async function refreshRepository(nextStatus?: GitBranchSyncStatus): Promise<void> {
    if (nextStatus) setBranchSyncStatus(nextStatus)
    await Promise.all([
      fetchStatus(root.path),
      fetchSummary(root.path),
      fetchHistory(root.path)
    ])
    const nextFiles = useGitStore.getState().files
    const nextSelectedFile = nextFiles.find((file) => file.path === selectedFile)?.path || nextFiles[0]?.path || null
    selectFile(nextSelectedFile, root.path)
  }

  async function handleBranchChanged(status: GitBranchSyncStatus): Promise<void> {
    setBranchSyncError(null)
    setSelectedFiles(new Set())
    setSelectedLineIds(new Set())
    setSelectionInitialized(false)
    await refreshRepository(status)
  }

  async function handleRemoteSync(): Promise<void> {
    setBranchSyncLoading(true)
    setBranchSyncError(null)
    try {
      let nextStatus: GitBranchSyncStatus
      if (branchSyncStatus && branchSyncStatus.ahead > 0 && branchSyncStatus.behind > 0) {
        throw new Error('Branch has incoming and local commits; resolve manually.')
      }
      if (shouldPublishBranch(branchSyncStatus, lastFetchedAt)) {
        nextStatus = await pear.git.pushCurrentBranch(root.path)
      } else if (branchSyncStatus && branchSyncStatus.behind > 0) {
        nextStatus = await pear.git.pullCurrentBranch(root.path)
      } else if (branchSyncStatus && branchSyncStatus.ahead > 0) {
        nextStatus = await pear.git.pushCurrentBranch(root.path)
      } else {
        nextStatus = await pear.git.fetchRemote(root.path)
      }
      setLastFetchedByRoot((current) => ({ ...current, [root.path]: Date.now() }))
      await refreshRepository(nextStatus)
    } catch (error) {
      setBranchSyncError(error instanceof Error ? error.message : 'Unable to sync with remote')
    } finally {
      setBranchSyncLoading(false)
    }
  }

  function selectChangedFileRow(path: string, event?: React.MouseEvent): void {
    selectFile(path, root.path)

    if (event?.shiftKey && fileRowSelectionAnchor) {
      setFileRowSelection(new Set(fileRange(filteredFilePaths, fileRowSelectionAnchor, path)))
      return
    }

    if (event?.metaKey || event?.ctrlKey) {
      setFileRowSelection((current) => {
        const next = new Set(current)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next.size > 0 ? next : new Set([path])
      })
      setFileRowSelectionAnchor(path)
      return
    }

    setFileRowSelection(new Set([path]))
    setFileRowSelectionAnchor(path)
  }

  function selectChangedFilePath(path: string, extendRange = false): void {
    selectFile(path, root.path)
    if (extendRange && fileRowSelectionAnchor) {
      setFileRowSelection(new Set(fileRange(filteredFilePaths, fileRowSelectionAnchor, path)))
      return
    }
    setFileRowSelection(new Set([path]))
    setFileRowSelectionAnchor(path)
  }

  function handleChangedFileContextMenu(event: React.MouseEvent, path: string): void {
    event.preventDefault()
    event.stopPropagation()

    const selectedPaths = fileRowSelection.has(path)
      ? orderedSelectedPaths(filteredFilePaths, fileRowSelection)
      : [path]
    if (!fileRowSelection.has(path)) {
      setFileRowSelection(new Set([path]))
      setFileRowSelectionAnchor(path)
      selectFile(path, root.path)
    }

    setFileContextMenu({
      ...contextMenuPosition(event.clientX, event.clientY),
      paths: selectedPaths
    })
  }

  function handleChangedFilesKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const path = nextFilePath(filteredFilePaths, selectedFile, event.key === 'ArrowDown' ? 1 : -1)
      if (path) selectChangedFilePath(path, event.shiftKey)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (selectedFile && filteredFilePaths.includes(selectedFile)) {
        selectFile(selectedFile, root.path)
      }
      return
    }

    if (event.key === ' ') {
      event.preventDefault()
      if (selectedFile && filteredFilePaths.includes(selectedFile)) {
        const selected = selectedFiles.has(selectedFile) || fullySelectedLineFilePaths.has(selectedFile)
        toggleFile(selectedFile, selected)
      }
    }
  }

  function handleHistoryCommitsKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const hash = nextFilePath(historyCommitHashes, selectedCommit?.hash || null, event.key === 'ArrowDown' ? 1 : -1)
      const commit = hash ? history.find((entry) => entry.hash === hash) || null : null
      if (commit) void selectCommit(root.path, commit)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (selectedCommit) void selectCommit(root.path, selectedCommit)
    }
  }

  function handleHistoryFilesKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const path = nextFilePath(selectedCommitFilePaths, selectedCommitFile, event.key === 'ArrowDown' ? 1 : -1)
      if (path) {
        void selectCommitFile(root.path, path)
      }
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (selectedCommitFile && selectedCommitFilePaths.includes(selectedCommitFile)) {
        void selectCommitFile(root.path, selectedCommitFile)
      }
    }
  }

  function focusCoAuthorInput(): void {
    window.requestAnimationFrame(() => {
      coAuthorInputRef.current?.focus()
    })
  }

  function handleAddCoAuthor(): void {
    setCoAuthorPanelOpen(true)
    focusCoAuthorInput()
  }

  function selectedPatchInput(): string | undefined {
    const patch = buildSelectedPatch(diff, selectedLineIds)
    return patch || undefined
  }

  function addCoAuthor(coAuthor: CoAuthor | string): void {
    if (!normalizeCoAuthor(coAuthor)) return
    setCoAuthors((current) => mergeCoAuthors(current, coAuthor))
    setCoAuthorInput('')
    setCoAuthorPanelOpen(true)
    focusCoAuthorInput()
  }

  function removeCoAuthor(username: string): void {
    setCoAuthors((current) =>
      current.filter((coAuthor) => coAuthorKey(coAuthor.username) !== coAuthorKey(username))
    )
  }

  function handleCoAuthorInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' && coAuthorSuggestions.length > 0) {
      event.preventDefault()
      setSelectedCoAuthorSuggestionIndex((current) => (current + 1) % coAuthorSuggestions.length)
      return
    }

    if (event.key === 'ArrowUp' && coAuthorSuggestions.length > 0) {
      event.preventDefault()
      setSelectedCoAuthorSuggestionIndex((current) =>
        (current - 1 + coAuthorSuggestions.length) % coAuthorSuggestions.length
      )
      return
    }

    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      const suggestion = coAuthorSuggestions[selectedCoAuthorSuggestionIndex]
      addCoAuthor(suggestion || coAuthorInput)
      return
    }

    if (event.key === 'Backspace' && coAuthorInput.length === 0 && coAuthors.length > 0) {
      removeCoAuthor(coAuthors[coAuthors.length - 1].username)
      return
    }

    if (event.key === 'Escape') {
      if (coAuthorInput) {
        setCoAuthorInput('')
      } else if (coAuthors.length === 0) {
        setCoAuthorPanelOpen(false)
      }
    }
  }

  async function handleGenerate(): Promise<void> {
    setMessage(null)
    try {
      await generateCommitMessage(activeProjectId || '', root.path, {
        wholeFiles: selectedFileList,
        patch: selectedPatchInput()
      })
      // The draft is consumed by the useEffect below — works even if the
      // user navigated away from this tab while the agent was running, since
      // the draft sits in the store until DiffPane mounts and drains it.
    } catch {
      // Error is surfaced via the store; the effect below shows it.
    }
  }

  async function handleCommit(): Promise<void> {
    setMessage(null)
    try {
      const commitCoAuthors = coAuthorInput.trim()
        ? mergeCoAuthors(coAuthors, coAuthorInput)
        : coAuthors
      const result = await commitSelection(root.path, {
        title,
        body: appendCoAuthorTrailers(body, commitCoAuthors),
        wholeFiles: selectedFileList,
        patch: selectedPatchInput()
      })
      setTitle('')
      setBody('')
      setCoAuthorPanelOpen(false)
      setCoAuthorInput('')
      setCoAuthors([])
      setSelectedFiles(new Set())
      setSelectedLineIds(new Set())
      setMessage(`Committed ${result.hash.slice(0, 7)}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Commit failed')
    }
  }

  async function copySelectedCommitHash(): Promise<void> {
    if (!selectedCommit) return
    try {
      await writeClipboardText(selectedCommit.hash)
      setMessage(`Copied ${selectedCommit.shortHash}.`)
    } catch {
      setMessage('Unable to copy commit hash')
    }
  }

  function includeContextFiles(paths: string[]): void {
    setSelectedFiles((current) => new Set([...current, ...paths]))
    setSelectedLineIds((current) => {
      const next = new Set(Array.from(current).filter((id) => !paths.includes(getFilePathFromLineSelectionId(id))))
      return sameStringSet(current, next) ? current : next
    })
    setMessage(`Included ${pluralize(paths.length, 'file')}.`)
  }

  function excludeContextFiles(paths: string[]): void {
    setSelectedFiles((current) => {
      const next = new Set(current)
      paths.forEach((path) => next.delete(path))
      return next
    })
    setSelectedLineIds((current) => {
      const next = new Set(Array.from(current).filter((id) => !paths.includes(getFilePathFromLineSelectionId(id))))
      return sameStringSet(current, next) ? current : next
    })
    setMessage(`Excluded ${pluralize(paths.length, 'file')}.`)
  }

  async function discardContextFiles(paths: string[]): Promise<void> {
    const confirmed = window.confirm(
      paths.length === 1
        ? `Discard changes in ${paths[0]}? This cannot be undone.`
        : `Discard changes in ${paths.length} selected files? This cannot be undone.`
    )
    if (!confirmed) return

    setMessage(null)
    try {
      await pear.git.discardFiles(root.path, paths)
      setFileRowSelection(new Set())
      setFileRowSelectionAnchor(null)
      await refreshRepository()
      setMessage(`Discarded ${pluralize(paths.length, 'change')}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to discard changes')
    }
  }

  async function ignoreContextPatterns(patterns: string[]): Promise<void> {
    setMessage(null)
    try {
      await pear.git.addGitignorePatterns(root.path, patterns)
      await refreshRepository()
      setMessage(`Updated .gitignore with ${pluralize(patterns.length, 'pattern')}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update .gitignore')
    }
  }

  async function copyContextPaths(paths: string[], relative: boolean): Promise<void> {
    try {
      const text = paths
        .map((path) => relative ? path : absoluteFilePath(root.path, path))
        .join('\n')
      await writeClipboardText(text)
      setMessage(`Copied ${relative ? 'relative ' : ''}${pluralize(paths.length, 'path')}.`)
    } catch {
      setMessage('Unable to copy paths')
    }
  }

  async function revealContextPath(paths: string[]): Promise<void> {
    const firstPath = paths[0]
    if (!firstPath) return
    try {
      await pear.fs.revealPath(absoluteFilePath(root.path, firstPath))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to reveal file')
    }
  }

  async function explainContextFiles(paths: string[]): Promise<void> {
    setMessage(null)
    try {
      if (!activeProjectId) throw new Error('No project selected')

      const projectStore = useProjectStore.getState()
      const project = projectStore.getActiveProject()
      if (!project) throw new Error('No project selected')

      await projectStore.ensureBroker()
      const liveAgents = await pear.broker.listAgents(activeProjectId)
      const existingChannels = [
        ...project.channels,
        ...liveAgents.map((agent) => agent.name),
        ...agents.flatMap((agent) => agent.channels || []),
        ...liveAgents.flatMap((agent) => agent.channels || [])
      ]
      const channelName = nextReviewChannelName(existingChannels)
      const requestedName = channelName
      const diffs = await Promise.all(paths.map((path) => pear.git.diff(root.path, path).catch(() => '')))
      const selectedDiff = compactReviewDiff(diffs.filter(Boolean).join('\n'))
      if (!selectedDiff.trim()) throw new Error('No diff available for selected files')

      const reviewRequest = [
        'Please explain these selected git changes.',
        '',
        'Focus on what changed, why it matters, and any risks or follow-up checks.',
        '',
        'Files:',
        ...paths.map((path) => `- ${path}`),
        '',
        'Diff:',
        '```diff',
        selectedDiff,
        '```'
      ].join('\n')
      const spawned = await pear.broker.spawnAgent(activeProjectId, {
        name: requestedName,
        cli: 'codex',
        cwd: root.path,
        channels: [channelName],
        task: `You are subscribed to #${channelName}. Respond in that channel to the human review request with a concise explanation of the selected git changes.`
      })
      const agentName = spawned.name || requestedName

      await pear.broker.attachTerminal({
        projectId: activeProjectId,
        name: agentName,
        mode: 'passthrough'
      }).catch(() => undefined)

      useAgentStore.getState().trackSpawnedAgent(agentName, activeProjectId, root.id, 'codex', root.path, {
        channels: [channelName],
        terminalMode: 'passthrough'
      })
      useAgentStore.getState().setActiveAgentKey(getAgentKey(activeProjectId, agentName))
      useUIStore.getState().openTab({ kind: 'channel', projectId: activeProjectId, channelName })

      const { eventId } = await pear.broker.sendMessage(activeProjectId, {
        to: `#${channelName}`,
        text: reviewRequest,
        from: 'human'
      })
      useAgentStore.getState().addHumanMessage(`#${channelName}`, reviewRequest, activeProjectId, eventId)
      setMessage(`Spawned ${agentName} in #${channelName}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to spawn review agent')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pear-bg)]">
      <div
        className="relative z-30 flex shrink-0 border-b border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]"
        style={{ height: SOURCE_HEADER_HEIGHT }}
      >
        <CurrentRootSelector
          project={activeProject}
          activeRoot={root}
          gitStates={rootGitStates}
          width={leftSidebarWidth}
          onSelect={setActiveRoot}
        />
        <CurrentBranchSelector
          rootPath={root.path}
          currentBranch={branchSyncStatus?.branch || summary?.branch || 'detached'}
          loading={branchStatusLoading}
          onBranchChanged={handleBranchChanged}
        />
        <FetchOriginButton
          status={branchSyncStatus}
          loading={branchSyncLoading}
          lastFetchedAt={lastFetchedAt}
          error={branchSyncError}
          onClick={() => void handleRemoteSync()}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <PaneSidebar width={leftSidebarWidth}>
          <PaneTabs activeTab={activeTab} onSelectTab={setActiveTab} fileCount={files.length} />

          {activeTab === 'changes' ? (
            <>
              <FileListPanel
                filter={filter}
                onFilterChange={setFilter}
                fileCount={files.length}
                filteredFiles={filteredFiles}
                selectedFiles={selectedFiles}
                fullySelectedLineFilePaths={fullySelectedLineFilePaths}
                partiallySelectedFilePaths={partiallySelectedFilePaths}
                selectedFile={selectedFile}
                fileRowSelection={fileRowSelection}
                windowFocused={windowFocused}
                allVisibleSelected={allVisibleSelected}
                someVisibleSelected={someVisibleSelected}
                listRef={changedFilesListRef}
                onListKeyDown={handleChangedFilesKeyDown}
                onToggleAllVisible={toggleAllVisible}
                onToggleFile={toggleFile}
                onSelectRow={selectChangedFileRow}
                onContextMenu={handleChangedFileContextMenu}
              />
              <CommitForm
                authUser={authUser}
                title={title}
                onTitleChange={setTitle}
                body={body}
                onBodyChange={setBody}
                coAuthorTriggerRef={coAuthorTriggerRef}
                coAuthorPanelVisible={coAuthorPanelVisible}
                onAddCoAuthor={handleAddCoAuthor}
                onGenerate={handleGenerate}
                generateDisabled={selectedCommitFileCount === 0 || commitDraftStatus === 'generating'}
                generating={commitDraftStatus === 'generating'}
                coAuthors={coAuthors}
                coAuthorInputRef={coAuthorInputRef}
                coAuthorPanelRef={coAuthorPanelRef}
                coAuthorInput={coAuthorInput}
                coAuthorSuggestions={coAuthorSuggestions}
                selectedCoAuthorSuggestionIndex={selectedCoAuthorSuggestionIndex}
                showCoAuthorSuggestions={showCoAuthorSuggestions}
                onCoAuthorInputChange={setCoAuthorInput}
                onCoAuthorInputKeyDown={handleCoAuthorInputKeyDown}
                onSelectCoAuthorSuggestion={addCoAuthor}
                onRemoveCoAuthor={removeCoAuthor}
                onCommit={handleCommit}
                canCommit={canCommit}
                actionLoading={actionLoading}
                selectedCommitFileCount={selectedCommitFileCount}
                commitTarget={commitTarget}
                message={message}
              />
            </>
          ) : (
            <CommitHistoryList
              history={history}
              historyLoading={historyLoading}
              selectedCommit={selectedCommit}
              authUser={authUser}
              listRef={historyCommitListRef}
              onKeyDown={handleHistoryCommitsKeyDown}
              onSelectCommit={(commit) => selectCommit(root.path, commit)}
            />
          )}
        </PaneSidebar>

        <button
          type="button"
          tabIndex={-1}
          aria-label="Resize source control panel"
          className="group flex h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-[var(--pear-bg)] hover:bg-[var(--pear-bg-surface-hover)]"
          onPointerDown={(event) =>
            startPanelResize(event, {
              axis: 'x',
              startValue: leftSidebarWidth,
              min: LEFT_SIDEBAR_MIN_WIDTH,
              max: LEFT_SIDEBAR_MAX_WIDTH,
              onResize: setLeftSidebarWidth
            })
          }
        >
          <GripVertical size={12} className="opacity-0 text-[var(--pear-text-faint)] group-hover:opacity-100" />
        </button>

        {activeTab === 'changes' ? (
          <ChangesDiffView
            selectedFileEntry={selectedFileEntry}
            selectedFile={selectedFile}
            rootPath={root.path}
            diff={diff}
            loading={loading}
            selectedFiles={selectedFiles}
            selectedLineIds={selectedLineIds}
            onToggleLine={toggleLine}
            onSetLines={setLinesSelected}
            selectedFileIsEmpty={selectedFileIsEmpty}
            selectedFileProbePending={selectedFileProbePending}
            fileCount={files.length}
          />
        ) : (
          <CommitHistoryDetail
            selectedCommit={selectedCommit}
            authUser={authUser}
            commitDetailsExpanded={commitDetailsExpanded}
            onCopyHash={() => void copySelectedCommitHash()}
            onToggleExpanded={() => setCommitDetailsExpanded((expanded) => !expanded)}
            historyFilesWidth={historyFilesWidth}
            onResizeHistoryFiles={setHistoryFilesWidth}
            historyFilesListRef={historyFilesListRef}
            onHistoryFilesKeyDown={handleHistoryFilesKeyDown}
            selectedCommitFile={selectedCommitFile}
            onSelectCommitFile={(path) => selectCommitFile(root.path, path)}
            windowFocused={windowFocused}
            loading={loading}
            commitDiff={commitDiff}
          />
        )}
      </div>
      {fileContextMenu && (
        <FileContextMenu
          menu={fileContextMenu}
          onClose={() => setFileContextMenu(null)}
          onDiscard={discardContextFiles}
          onIgnorePatterns={ignoreContextPatterns}
          onInclude={includeContextFiles}
          onExclude={excludeContextFiles}
          onCopyPaths={copyContextPaths}
          onReveal={revealContextPath}
          onExplain={explainContextFiles}
        />
      )}
    </div>
  )
}
