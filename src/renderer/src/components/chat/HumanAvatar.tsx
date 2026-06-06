import type React from 'react'
import { useEffect, useState } from 'react'
import { User } from 'lucide-react'
import type { AuthUser } from '@/lib/ipc'

function isRemoteAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

function providedAvatarUrl(user?: AuthUser | null): string | null {
  const avatarUrl = user?.avatarUrl?.trim()
  return avatarUrl && isRemoteAvatarUrl(avatarUrl) ? avatarUrl : null
}

function avatarUrls(user?: AuthUser | null): string[] {
  return Array.from(new Set([user?.cachedAvatarUrl, providedAvatarUrl(user)]
    .map((url) => url?.trim())
    .filter((url): url is string => !!url)))
}

function useAvatarUrl(urls: string[]): { src: string | undefined; onError: () => void } {
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

function userLabel(user?: AuthUser | null): string {
  return user?.name || user?.email || 'You'
}

export function HumanAvatar({
  user,
  color = 'var(--pear-accent-bright)',
  iconSize = 15,
  className,
  style
}: {
  user?: AuthUser | null
  color?: string
  iconSize?: number
  className: string
  style?: React.CSSProperties
}): React.ReactNode {
  const avatar = useAvatarUrl(avatarUrls(user))
  const label = userLabel(user)

  return (
    <div
      className={className}
      style={style}
      title={label}
      aria-label={label}
    >
      {avatar.src ? (
        <img
          src={avatar.src}
          alt={label}
          className="h-full w-full rounded-md object-cover"
          referrerPolicy="no-referrer"
          onError={avatar.onError}
        />
      ) : (
        <User size={iconSize} style={{ color }} />
      )}
    </div>
  )
}
