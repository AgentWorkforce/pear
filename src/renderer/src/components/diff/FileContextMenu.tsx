import type React from 'react'
import {
  commonFileExtension,
  containingFolder,
  gitignoreExtensionPattern,
  gitignoreFilePattern,
  gitignoreFolderPattern,
  FILE_CONTEXT_MENU_WIDTH,
  type FileContextMenuState
} from './diffPaneUtils'

function ContextMenuDivider(): React.ReactNode {
  return <div className="my-1 h-px bg-white/12" />
}

function ContextMenuItem({
  label,
  onClick,
  disabled = false
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] font-medium text-[var(--pear-text)] outline-none hover:bg-[var(--pear-selection-blue)] hover:text-white disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[var(--pear-text)]"
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

export function FileContextMenu({
  menu,
  onClose,
  onDiscard,
  onIgnorePatterns,
  onInclude,
  onExclude,
  onCopyPaths,
  onReveal,
  onExplain
}: {
  menu: FileContextMenuState
  onClose: () => void
  onDiscard: (paths: string[]) => Promise<void>
  onIgnorePatterns: (patterns: string[]) => Promise<void>
  onInclude: (paths: string[]) => void
  onExclude: (paths: string[]) => void
  onCopyPaths: (paths: string[], relative: boolean) => Promise<void>
  onReveal: (paths: string[]) => Promise<void>
  onExplain: (paths: string[]) => Promise<void>
}): React.ReactNode {
  const { paths } = menu
  const multi = paths.length > 1
  const extension = commonFileExtension(paths)
  const folder = !multi ? containingFolder(paths[0]) : null
  const selectedChangeLabel = `${paths.length} Selected Change${paths.length === 1 ? '' : 's'}`

  function run(action: () => void): void {
    onClose()
    action()
  }

  return (
    <div
      className="fixed inset-0 z-[95]"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        role="menu"
        className="fixed max-h-[430px] overflow-y-auto rounded-xl border border-white/15 bg-[rgba(24,31,40,0.98)] p-1.5 shadow-2xl backdrop-blur"
        style={{ left: menu.x, top: menu.y, width: FILE_CONTEXT_MENU_WIDTH }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <ContextMenuItem
          label={multi ? `Discard ${selectedChangeLabel}` : 'Discard Changes'}
          onClick={() => run(() => void onDiscard(paths))}
        />
        <ContextMenuDivider />
        <ContextMenuItem
          label={multi
            ? `Ignore ${paths.length} Selected Files (Add to .gitignore)`
            : 'Ignore File (Add to .gitignore)'}
          onClick={() => run(() => void onIgnorePatterns(paths.map(gitignoreFilePattern)))}
        />
        {folder && (
          <ContextMenuItem
            label="Ignore Folder (Add to .gitignore)"
            onClick={() => run(() => void onIgnorePatterns([gitignoreFolderPattern(folder)]))}
          />
        )}
        {extension && (
          <ContextMenuItem
            label={`Ignore All ${extension} Files (Add to .gitignore)`}
            onClick={() => run(() => void onIgnorePatterns([gitignoreExtensionPattern(extension)]))}
          />
        )}
        {multi && (
          <>
            <ContextMenuDivider />
            <ContextMenuItem label="Include Selected Files" onClick={() => run(() => onInclude(paths))} />
            <ContextMenuItem label="Exclude Selected Files" onClick={() => run(() => onExclude(paths))} />
          </>
        )}
        <ContextMenuDivider />
        <ContextMenuItem
          label={multi ? 'Copy Paths' : 'Copy File Path'}
          onClick={() => run(() => void onCopyPaths(paths, false))}
        />
        <ContextMenuItem
          label={multi ? 'Copy Relative Paths' : 'Copy Relative File Path'}
          onClick={() => run(() => void onCopyPaths(paths, true))}
        />
        <ContextMenuDivider />
        <ContextMenuItem label="Reveal in Finder" onClick={() => run(() => void onReveal(paths))} />
        <ContextMenuItem
          label="Have agent explain these changes"
          onClick={() => run(() => void onExplain(paths))}
        />
      </div>
    </div>
  )
}
