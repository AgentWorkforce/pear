import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import type { AuthUser, GitHistoryCoAuthor, GitHistoryCommit } from '@/lib/ipc'
import {
  authorInitial,
  clamp,
  coAuthorCli,
  commitCoAuthors,
  uniqueAvatarUrls,
  userAvatarUrls,
  userInitials
} from './diffPaneUtils'

export function useAvatarUrl(urls: string[]): { src: string | undefined; onError: () => void } {
  const key = urls.join('\0')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
  }, [key])

  return {
    src: urls[index],
    onError: () => setIndex((current) => current + 1)
  }
}

function CommitAuthorTooltip({
  anchorRef,
  visible,
  name,
  email
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  visible: boolean
  name: string
  email?: string
}): React.ReactNode {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!visible) {
      setPosition(null)
      return
    }

    function updatePosition(): void {
      const anchor = anchorRef.current
      if (!anchor) {
        setPosition(null)
        return
      }

      const rect = anchor.getBoundingClientRect()
      const tooltipWidth = 260
      const tooltipHeight = email ? 64 : 44
      const gutter = 8
      const left = clamp(
        rect.left + rect.width / 2 - tooltipWidth / 2,
        gutter,
        window.innerWidth - tooltipWidth - gutter
      )
      let top = rect.top - tooltipHeight - gutter
      if (top < gutter) {
        top = rect.bottom + gutter
      }

      setPosition({
        left,
        top: clamp(top, gutter, window.innerHeight - tooltipHeight - gutter)
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef, email, visible])

  if (!visible || !position || typeof document === 'undefined') return null

  return createPortal(
    <span
      className="commit-author-tooltip-panel"
      role="tooltip"
      style={{ left: position.left, top: position.top }}
    >
      <span className="truncate font-semibold text-[var(--pear-text)]">{name}</span>
      {email && <span className="truncate text-[var(--pear-text-secondary)]">{email}</span>}
    </span>,
    document.body
  )
}

function CommitAuthorTooltipTrigger({
  name,
  email,
  className,
  children
}: {
  name: string
  email?: string
  className: string
  children: React.ReactNode
}): React.ReactNode {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const label = email ? `${name} <${email}>` : name

  return (
    <span
      ref={anchorRef}
      className={className}
      aria-label={label}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      <CommitAuthorTooltip anchorRef={anchorRef} visible={visible} name={name} email={email} />
    </span>
  )
}

export function CommitAvatar({
  author,
  email,
  avatarUrls,
  active = false
}: {
  author: string
  email?: string
  avatarUrls: string[]
  active?: boolean
}): React.ReactNode {
  const avatar = useAvatarUrl(avatarUrls)

  if (avatar.src) {
    return (
      <CommitAuthorTooltipTrigger name={author} email={email} className="commit-primary-author-wrap">
        <img
          src={avatar.src}
          alt={author}
          className="h-[18px] w-[18px] shrink-0 rounded-full bg-[var(--pear-bg-overlay)] object-cover"
          referrerPolicy="no-referrer"
          onError={avatar.onError}
        />
      </CommitAuthorTooltipTrigger>
    )
  }

  return (
    <CommitAuthorTooltipTrigger name={author} email={email} className="commit-primary-author-wrap">
      <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--pear-bg-overlay)] text-[9px] font-semibold ${
        active ? 'text-white' : 'text-[var(--pear-text)]'
      }`}>
        {authorInitial(author)}
      </span>
    </CommitAuthorTooltipTrigger>
  )
}

function CommitCoAuthorBadge({
  coAuthor,
  active
}: {
  coAuthor: GitHistoryCoAuthor
  active: boolean
}): React.ReactNode {
  const cli = coAuthorCli(coAuthor)
  const avatar = useAvatarUrl(uniqueAvatarUrls([coAuthor.avatarUrl, coAuthor.cachedAvatarUrl]))

  return (
    <CommitAuthorTooltipTrigger
      name={coAuthor.name}
      email={coAuthor.email}
      className="commit-author-avatar-wrap"
    >
      {avatar.src && !cli ? (
        <img
          src={avatar.src}
          alt={coAuthor.name}
          className="commit-co-author-avatar object-cover"
          referrerPolicy="no-referrer"
          onError={avatar.onError}
        />
      ) : cli ? (
        <span className="commit-co-author-avatar bg-[#b45f43] text-white">
          <AgentHarnessIcon cli={cli} className="h-[13px] w-[13px]" />
        </span>
      ) : (
        <span className={`commit-co-author-avatar bg-[var(--pear-bg-overlay)] text-[9px] font-semibold ${
          active ? 'text-white' : 'text-[var(--pear-text)]'
        }`}>
          {authorInitial(coAuthor.name)}
        </span>
      )}
    </CommitAuthorTooltipTrigger>
  )
}

export function CommitAuthorStack({
  commit,
  authorAvatarUrls,
  active
}: {
  commit: GitHistoryCommit
  authorAvatarUrls: string[]
  active: boolean
}): React.ReactNode {
  const coAuthors = commitCoAuthors(commit)

  return (
    <span className={`commit-author-stack ${coAuthors.length > 0 ? 'has-co-authors' : ''}`}>
      <CommitAvatar
        author={commit.author}
        email={commit.authorEmail}
        avatarUrls={authorAvatarUrls}
        active={active}
      />
      {coAuthors.map((coAuthor) => (
        <CommitCoAuthorBadge key={`${coAuthor.email}:${coAuthor.name}`} coAuthor={coAuthor} active={active} />
      ))}
    </span>
  )
}

export function CommitAuthorAvatar({ user }: { user: AuthUser | null }): React.ReactNode {
  const label = user?.name || user?.email || 'Commit author'
  const avatar = useAvatarUrl(userAvatarUrls(user))

  if (avatar.src) {
    return (
      <img
        src={avatar.src}
        alt={label}
        title={label}
        className="h-9 w-9 shrink-0 rounded-full border border-[var(--pear-border)] bg-[var(--pear-bg-overlay)] object-cover"
        referrerPolicy="no-referrer"
        onError={avatar.onError}
      />
    )
  }

  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--pear-border)] bg-[var(--pear-accent)] text-[13px] font-semibold text-[var(--pear-bg)]"
      title={label}
      aria-label={label}
    >
      {userInitials(user)}
    </span>
  )
}
