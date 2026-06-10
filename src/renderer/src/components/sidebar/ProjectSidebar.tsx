import type React from 'react'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  FolderKanban,
  Hash,
  Inbox,
  LayoutGrid,
  LogIn,
  LogOut,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Plus,
  Search,
  Settings,
  X
} from 'lucide-react'
import { AgentHarnessIcon } from '@/components/common/AgentIcons'
import {
  deriveDirectMessageRooms,
  getDirectMessageRoomId,
  type DirectMessageRoom
} from '@/lib/direct-messages'
import { getAgentKeyForAgent, useAgentStore, type Agent } from '@/stores/agent-store'
import { useIsAgentTyping } from '@/stores/typing-store'
import { useProjectStore, type Project } from '@/stores/project-store'
import { useIssuesStore } from '@/stores/issues-store'
import { useUIStore, type AppTab, type AppTabInput } from '@/stores/ui-store'
import { pear, type AuthUser, type IntegrationAuthRecoveryState } from '@/lib/ipc'

function AgentRelayLogo(): React.ReactNode {
  return (
    <svg
      className="h-7 w-auto text-[var(--pear-accent)]"
      viewBox="0 0 112 91"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M71.3682 21.7098L54.042 39.036C50.6567 42.4213 50.6568 47.9099 54.042 51.2952L71.3727 68.6259L52.8321 87.1665C48.6005 91.3981 41.7397 91.3981 37.5081 87.1665L3.17369 52.8321C-1.05789 48.6005 -1.0579 41.7397 3.17369 37.5081L37.5081 3.17369C41.7397 -1.0579 48.6005 -1.05789 52.8321 3.17369L71.3682 21.7098Z"
        fill="currentColor"
      />
      <path
        d="M75.5711 72.8243C78.9563 76.2096 84.445 76.2096 87.8302 72.8243L109.359 51.2952C112.745 47.9099 112.745 42.4213 109.359 39.036L87.8302 17.507C84.445 14.1218 78.9563 14.1218 75.5711 17.507L71.3682 21.7098L88.6989 39.0405C92.0842 42.4258 92.0842 47.9144 88.6989 51.2997L71.3727 68.6259L75.5711 72.8243Z"
        fill="currentColor"
        opacity="0.5"
      />
    </svg>
  )
}

function AgentRelayWordmark(): React.ReactNode {
  return (
    <svg
      className="h-4.5 w-auto text-[var(--pear-text)]"
      viewBox="64 0 264 54"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M74.7504 42.84C72.6304 42.84 70.7304 42.48 69.0504 41.76C67.4104 41.04 66.0904 39.98 65.0904 38.58C64.1304 37.18 63.6504 35.48 63.6504 33.48C63.6504 31.44 64.1304 29.76 65.0904 28.44C66.0904 27.08 67.4304 26.06 69.1104 25.38C70.8304 24.7 72.7704 24.36 74.9304 24.36H83.9304V22.44C83.9304 20.72 83.4104 19.34 82.3704 18.3C81.3304 17.26 79.7304 16.74 77.5704 16.74C75.4504 16.74 73.8304 17.24 72.7104 18.24C71.5904 19.24 70.8504 20.54 70.4904 22.14L64.7304 20.28C65.2104 18.68 65.9704 17.24 67.0104 15.96C68.0904 14.64 69.5104 13.58 71.2704 12.78C73.0304 11.98 75.1504 11.58 77.6304 11.58C81.4704 11.58 84.4904 12.56 86.6904 14.52C88.8902 16.48 89.9902 19.26 89.9902 22.86V35.04C89.9902 36.24 90.5502 36.84 91.6702 36.84H94.1902V42H89.5702C88.1702 42 87.0304 41.64 86.1504 40.92C85.2704 40.2 84.8304 39.22 84.8304 37.98V37.8H83.9304C83.6104 38.4 83.1304 39.1 82.4904 39.9C81.8504 40.7 80.9104 41.4 79.6704 42C78.4304 42.56 76.7904 42.84 74.7504 42.84ZM75.6504 37.74C78.1304 37.74 80.1304 37.04 81.6504 35.64C83.1704 34.2 83.9304 32.24 83.9304 29.76V29.16H75.2904C73.6504 29.16 72.3304 29.52 71.3304 30.24C70.3304 30.92 69.8304 31.94 69.8304 33.3C69.8304 34.66 70.3504 35.74 71.3904 36.54C72.4304 37.34 73.8504 37.74 75.6504 37.74ZM93.2562 27.36V26.46C93.2562 23.34 93.8762 20.68 95.1162 18.48C96.3962 16.28 98.0762 14.58 100.156 13.38C102.236 12.18 104.516 11.58 106.996 11.58C109.876 11.58 112.076 12.12 113.596 13.2C115.156 14.28 116.296 15.44 117.016 16.68H117.976V12.42H123.976V48.06C123.976 49.86 123.436 51.3 122.356 52.38C121.316 53.46 119.876 54 118.036 54H98.1162V48.6H116.116C117.276 48.6 117.856 48 117.856 46.8V37.38H116.896C116.456 38.1 115.836 38.84 115.036 39.6C114.236 40.36 113.176 40.98 111.856 41.46C110.576 41.94 108.956 42.18 106.996 42.18C104.516 42.18 102.216 41.6 100.096 40.44C98.0162 39.24 96.3562 37.54 95.1162 35.34C93.8762 33.1 93.2562 30.44 93.2562 27.36ZM108.676 36.78C111.356 36.78 113.556 35.94 115.276 34.26C117.036 32.54 117.916 30.18 117.916 27.18V26.64C117.916 23.56 117.056 21.2 115.336 19.56C113.616 17.88 111.396 17.04 108.676 17.04C106.036 17.04 103.836 17.88 102.076 19.56C100.356 21.2 99.4962 23.56 99.4962 26.64V27.18C99.4962 30.18 100.356 32.54 102.076 34.26C103.836 35.94 106.036 36.78 108.676 36.78ZM141.835 42.84C138.835 42.84 136.215 42.22 133.975 40.98C131.735 39.7 129.975 37.92 128.695 35.64C127.455 33.32 126.835 30.64 126.835 27.6V26.88C126.835 23.8 127.455 21.12 128.695 18.84C129.935 16.52 131.655 14.74 133.855 13.5C136.095 12.22 138.675 11.58 141.595 11.58C144.435 11.58 146.915 12.22 149.035 13.5C151.195 14.74 152.875 16.48 154.075 18.72C155.275 20.96 155.875 23.58 155.875 26.58V28.92H133.135C133.215 31.52 134.075 33.6 135.715 35.16C137.395 36.68 139.475 37.44 141.955 37.44C144.275 37.44 146.015 36.92 147.175 35.88C148.375 34.84 149.295 33.64 149.935 32.28L155.035 34.92C154.475 36.04 153.655 37.22 152.575 38.46C151.535 39.7 150.155 40.74 148.435 41.58C146.715 42.42 144.515 42.84 141.835 42.84ZM133.195 24.18H149.575C149.415 21.94 148.615 20.2 147.175 18.96C145.735 17.68 143.855 17.04 141.535 17.04C139.215 17.04 137.315 17.68 135.835 18.96C134.395 20.2 133.515 21.94 133.195 24.18ZM158.514 42V12.42H164.574V16.86H165.534C166.094 15.66 167.094 14.54 168.534 13.5C169.974 12.46 172.114 11.94 174.954 11.94C177.194 11.94 179.174 12.44 180.894 13.44C182.654 14.44 184.034 15.86 185.034 17.7C186.034 19.5 186.534 21.68 186.534 24.24V42H180.354V24.72C180.354 22.16 179.714 20.28 178.434 19.08C177.154 17.84 175.394 17.22 173.154 17.22C170.594 17.22 168.534 18.06 166.974 19.74C165.454 21.42 164.694 23.86 164.694 27.06V42H158.514ZM200.908 42C199.108 42 197.668 41.46 196.588 40.38C195.548 39.3 195.028 37.86 195.028 36.06V17.64H186.868V12.42H195.028V2.64H201.208V12.42H210.028V17.64H201.208V34.98C201.208 36.18 201.768 36.78 202.888 36.78H209.068V42H200.908ZM212.488 42V12.42H218.548V15.9H219.508C219.988 14.66 220.748 13.76 221.788 13.2C222.868 12.6 224.188 12.3 225.748 12.3H229.288V17.88H225.508C223.508 17.88 221.868 18.44 220.588 19.56C219.308 20.64 218.668 22.32 218.668 24.6V42H212.488ZM243.397 42.84C240.397 42.84 237.777 42.22 235.537 40.98C233.297 39.7 231.537 37.92 230.257 35.64C229.017 33.32 228.397 30.64 228.397 27.6V26.88C228.397 23.8 229.017 21.12 230.257 18.84C231.497 16.52 233.217 14.74 235.417 13.5C237.657 12.22 240.237 11.58 243.157 11.58C245.997 11.58 248.477 12.22 250.597 13.5C252.757 14.74 254.437 16.48 255.637 18.72C256.837 20.96 257.437 23.58 257.437 26.58V28.92H234.697C234.777 31.52 235.637 33.6 237.277 35.16C238.957 36.68 241.037 37.44 243.517 37.44C245.837 37.44 247.577 36.92 248.737 35.88C249.937 34.84 250.857 33.64 251.497 32.28L256.597 34.92C256.037 36.04 255.217 37.22 254.137 38.46C253.097 39.7 251.717 40.74 249.997 41.58C248.277 42.42 246.077 42.84 243.397 42.84ZM234.757 24.18H251.137C250.977 21.94 250.177 20.2 248.737 18.96C247.297 17.68 245.417 17.04 243.097 17.04C240.777 17.04 238.877 17.68 237.397 18.96C235.957 20.2 235.077 21.94 234.757 24.18ZM260.076 42V0H266.256V42H260.076ZM279.807 42.84C277.687 42.84 275.787 42.48 274.107 41.76C272.467 41.04 271.147 39.98 270.147 38.58C269.187 37.18 268.707 35.48 268.707 33.48C268.707 31.44 269.187 29.76 270.147 28.44C271.147 27.08 272.487 26.06 274.167 25.38C275.887 24.7 277.827 24.36 279.987 24.36H288.987V22.44C288.987 20.72 288.467 19.34 287.427 18.3C286.387 17.26 284.787 16.74 282.627 16.74C280.507 16.74 278.887 17.24 277.767 18.24C276.647 19.24 275.907 20.54 275.547 22.14L269.787 20.28C270.267 18.68 271.027 17.24 272.067 15.96C273.147 14.64 274.567 13.58 276.327 12.78C278.087 11.98 280.207 11.58 282.687 11.58C286.527 11.58 289.547 12.56 291.747 14.52C293.947 16.48 295.047 19.26 295.047 22.86V35.04C295.047 36.24 295.607 36.84 296.727 36.84H299.247V42H294.627C293.227 42 292.087 41.64 291.207 40.92C290.327 40.2 289.887 39.22 289.887 37.98V37.8H288.987C288.667 38.4 288.187 39.1 287.547 39.9C286.907 40.7 285.967 41.4 284.727 42C283.487 42.56 281.847 42.84 279.807 42.84ZM280.707 37.74C283.187 37.74 285.187 37.04 286.707 35.64C288.227 34.2 288.987 32.24 288.987 29.76V29.16H280.347C278.707 29.16 277.387 29.52 276.387 30.24C275.387 30.92 274.887 31.94 274.887 33.3C274.887 34.66 275.407 35.74 276.447 36.54C277.487 37.34 278.907 37.74 280.707 37.74ZM303.114 54V48.6H319.614C320.734 48.6 321.294 48 321.294 46.8V37.68H320.334C319.974 38.48 319.414 39.26 318.654 40.02C317.934 40.74 316.954 41.34 315.714 41.82C314.474 42.3 312.914 42.54 311.034 42.54C308.794 42.54 306.794 42.04 305.034 41.04C303.274 40.04 301.894 38.62 300.894 36.78C299.894 34.94 299.394 32.76 299.394 30.24V12.42H305.574V29.76C305.574 32.32 306.214 34.22 307.494 35.46C308.774 36.66 310.554 37.26 312.834 37.26C315.354 37.26 317.374 36.42 318.894 34.74C320.454 33.06 321.234 30.62 321.234 27.42V12.42H327.414V48.06C327.414 49.86 326.874 51.3 325.794 52.38C324.754 53.46 323.314 54 321.474 54H303.114Z" fill="currentColor" />
    </svg>
  )
}

function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function userInitials(user?: AuthUser): string {
  if (user?.name?.trim()) {
    return user.name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase()
  }

  return (
    user?.email?.trim().charAt(0) ||
    '?'
  ).toUpperCase()
}

function userDisplayName(user?: AuthUser): string {
  return user?.name?.trim() || user?.email?.trim() || 'Signed in'
}

function isRemoteAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

function providedAvatarUrl(user?: AuthUser): string | null {
  const avatarUrl = user?.avatarUrl?.trim()
  return avatarUrl && isRemoteAvatarUrl(avatarUrl) ? avatarUrl : null
}

function avatarUrls(user?: AuthUser): string[] {
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

function SignedOutAvatar({ loading }: { loading: boolean }): React.ReactNode {
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--pear-border)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text-faint)]"
      title={loading ? 'Signing in...' : 'Not signed in'}
      aria-label={loading ? 'Signing in...' : 'Not signed in'}
    >
      <LogIn size={13} />
    </div>
  )
}

function hasSignedInUser(auth: { loggedIn: boolean; user?: AuthUser }): boolean {
  return auth.loggedIn
}

function recoverySummary(state: IntegrationAuthRecoveryState | null): string | null {
  if (!state) return null
  if (state.reason === 'cloud-auth-required') return 'Cloud sign-in required'
  if (state.failureClass) return `Workspace unavailable: ${state.failureClass}`
  return 'Workspace unavailable'
}

function UserAvatar({ user }: { user?: AuthUser }): React.ReactNode {
  const label = userDisplayName(user)
  const avatar = useAvatarUrl(avatarUrls(user))

  if (avatar.src) {
    return (
      <img
        src={avatar.src}
        alt={label}
        title={label}
        className="h-7 w-7 shrink-0 rounded-full bg-[var(--pear-bg-overlay)] object-cover"
        referrerPolicy="no-referrer"
        onError={avatar.onError}
      />
    )
  }

  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--pear-accent)] text-[10px] font-semibold text-[var(--pear-bg)]"
      title={label}
      aria-label={label}
    >
      {userInitials(user)}
    </div>
  )
}

function AccountMenu({ compact = false }: { compact?: boolean }): React.ReactNode {
  const openTab = useUIStore((s) => s.openTab)
  const [auth, setAuth] = useState<{ loggedIn: boolean; user?: AuthUser }>({ loggedIn: false })
  const [authRecovery, setAuthRecovery] = useState<IntegrationAuthRecoveryState | null>(null)
  const [loading, setLoading] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    void pear.auth.status().then(setAuth)
    // Initial recovery-state probe is best-effort: on failure we leave the
    // banner hidden, and the integration-auth event listener below will set it
    // if recovery is actually needed.
    pear.integrations.authRecoveryState().then(setAuthRecovery).catch(() => undefined)
  }, [])

  useEffect(() => {
    return pear.integrations.onEvent((event) => {
      if (event.type === 'integration-auth-recovered') {
        setAuthRecovery(null)
        return
      }
      if (event.type !== 'integration-auth-required') return
      pear.integrations.authRecoveryState().then(setAuthRecovery).catch(() => {
        setAuthRecovery({
          reason: event.reason,
          since: Date.now(),
          message: event.message
        })
      })
    })
  }, [])

  const handleLogin = useCallback(async () => {
    setLoading(true)
    try {
      const result = await pear.auth.login()
      setAuth(result.loggedIn ? await pear.auth.status() : result)
      // Post-login recovery probe is best-effort: null just clears the banner,
      // which is the correct post-login default if the probe itself fails.
      setAuthRecovery(await pear.integrations.authRecoveryState().catch(() => null))
    } finally {
      setLoading(false)
    }
  }, [])

  const openAccountSettings = useCallback(() => {
    openTab({
      kind: 'account-settings',
      title: 'Account settings'
    })
    setMenuOpen(false)
  }, [openTab])

  const handleLogout = useCallback(async () => {
    await pear.auth.logout()
    setAuth({ loggedIn: false })
    setMenuOpen(false)
  }, [])

  const signedIn = hasSignedInUser(auth)
  const recovery = recoverySummary(authRecovery)

  if (!signedIn) {
    return (
      <button
        onClick={handleLogin}
        disabled={loading}
        className={`flex items-center gap-2.5 rounded-lg text-sm text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)] disabled:opacity-50 ${
          compact ? 'h-10 w-10 justify-center p-0' : 'w-full px-3 py-2.5'
        }`}
        title={loading ? 'Signing in...' : 'Sign in'}
        aria-label={loading ? 'Signing in...' : 'Sign in'}
      >
        <SignedOutAvatar loading={loading} />
        {!compact && (
          <div className="min-w-0 flex-1 text-left">
            <div className="truncate text-sm leading-tight">{loading ? 'Signing in...' : 'Sign in'}</div>
            <div className="truncate text-[11px] leading-tight text-[var(--pear-text-faint)]">Not signed in</div>
          </div>
        )}
      </button>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className={`flex items-center gap-2.5 rounded-lg text-sm text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface)] ${
          compact ? 'h-10 w-10 justify-center p-0' : 'w-full px-3 py-2.5'
        }`}
        title={userDisplayName(auth.user)}
        aria-label={userDisplayName(auth.user)}
      >
        <UserAvatar user={auth.user} />
        {!compact && (
          <div className="min-w-0 flex-1 text-left">
            <div className="truncate text-sm leading-tight">{userDisplayName(auth.user)}</div>
            {recovery ? (
              <div className="flex min-w-0 items-center gap-1 truncate text-[11px] leading-tight text-[var(--pear-yellow)]">
                <AlertTriangle size={10} className="shrink-0" />
                <span className="truncate">{recovery}</span>
              </div>
            ) : auth.user?.organizationName && (
              <div className="truncate text-[11px] leading-tight text-[var(--pear-text-faint)]">{auth.user.organizationName}</div>
            )}
          </div>
        )}
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className={`absolute z-50 mb-1 rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] py-1 shadow-lg ${
            compact ? 'bottom-0 left-full ml-2 w-44' : 'bottom-full left-2 right-2'
          }`}>
            <button
              type="button"
              onClick={openAccountSettings}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]"
            >
              <Settings size={13} />
              <span>Account settings</span>
            </button>
            {authRecovery && (
              <div className="border-t border-[var(--pear-border-subtle)] px-3 py-2 text-xs leading-4 text-[var(--pear-text-dim)]">
                <div className="font-medium text-[var(--pear-text)]">
                  {authRecovery.reason === 'cloud-auth-required' ? 'Sign-in needed' : 'Workspace unavailable'}
                </div>
                <div className="mt-1 break-words">
                  {authRecovery.reason === 'cloud-auth-required'
                    ? 'Reconnect Agent Relay Cloud to resume integration mounts.'
                    : 'Pear cannot resolve the Agent Relay Cloud workspace for integration writebacks.'}
                </div>
                {authRecovery.reason === 'cloud-auth-required' && (
                  <button
                    type="button"
                    onClick={() => void handleLogin()}
                    disabled={loading}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--pear-border)] px-2 text-[11px] text-[var(--pear-text)] hover:border-[var(--pear-accent-dim)] disabled:opacity-40"
                  >
                    <LogIn size={11} />
                    <span>Sign in again</span>
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
            >
              <LogOut size={13} />
              <span>Sign out</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function tabAfterProjectSwitch(project: Project, activeTab: AppTab | undefined): AppTabInput {
  switch (activeTab?.kind) {
    case 'source-control':
      return { kind: 'source-control', projectId: project.id }
    case 'project-settings':
      return { kind: 'project-settings', projectId: project.id }
    case 'broker-details':
      return {
        kind: 'broker-details',
        projectId: project.id,
        title: `${project.name} Relay`
      }
    default:
      return { kind: 'agents', projectId: project.id }
  }
}

function channelAgentCount(agents: Agent[], channel: string): number {
  return agents.filter((agent) => !agent.channels || agent.channels.includes(channel)).length
}

function compactLabel(value: string): string {
  const letters = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
  return letters || '?'
}

function rowClass(active: boolean): string {
  return `flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors ${
    active
      ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)] ring-1 ring-[var(--pear-border-subtle)]'
      : 'text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
  }`
}

function collapsedButtonClass(active: boolean): string {
  return `relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors ${
    active
      ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)] ring-1 ring-[var(--pear-border)]'
      : 'text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
  }`
}

interface SectionMenuItem {
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  onSelect: () => void
}

function HeaderActionButton({
  label,
  onClick,
  children,
  expanded
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  expanded?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
    >
      {children}
    </button>
  )
}

function SectionHeader({
  title,
  addLabel,
  onAdd,
  menuItems = []
}: {
  title: string
  addLabel?: string
  onAdd?: () => void
  menuItems?: SectionMenuItem[]
}): React.ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const hasMenu = menuItems.length > 0

  function selectMenuItem(item: SectionMenuItem): void {
    setMenuOpen(false)
    item.onSelect()
  }

  return (
    <div className="group/section-header relative flex items-center justify-between gap-2 px-2 pb-1.5 pt-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">
        {title}
      </span>
      {(onAdd || hasMenu) && (
        <div
          className={`z-50 flex items-center gap-0.5 transition-opacity ${
            menuOpen
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 group-hover/section-header:pointer-events-auto group-hover/section-header:opacity-100 group-focus-within/section-header:pointer-events-auto group-focus-within/section-header:opacity-100'
          }`}
        >
          {onAdd && addLabel && (
            <HeaderActionButton label={addLabel} onClick={onAdd}>
              <Plus size={12} />
            </HeaderActionButton>
          )}
          {hasMenu && (
            <HeaderActionButton
              label={`${title} menu`}
              onClick={() => setMenuOpen((open) => !open)}
              expanded={menuOpen}
            >
              <MoreHorizontal size={13} />
            </HeaderActionButton>
          )}
        </div>
      )}

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-2 top-[calc(100%+2px)] z-50 w-44 overflow-hidden rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] py-1 shadow-xl">
            {menuItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => selectMenuItem(item)}
                  className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12px] text-[var(--pear-text-dim)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                >
                  <Icon size={13} className="shrink-0 text-[var(--pear-text-faint)]" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function EmptySection({ label }: { label: string }): React.ReactNode {
  return (
    <div className="rounded-md border border-dashed border-[var(--pear-border-subtle)] px-2 py-2 text-[11px] text-[var(--pear-text-faint)]">
      {label}
    </div>
  )
}

function AgentActivityIndicator({ agent }: { agent: Agent }): React.ReactNode {
  const typing = useIsAgentTyping(agent)
  if (agent.terminalMode === 'drive' || agent.currentState === 'blocked_on_send') {
    const label = agent.currentState === 'blocked_on_send' ? 'Blocked on send' : 'Holding messages'
    return (
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 text-[var(--pear-text-faint)] opacity-75"
        title={label}
        aria-label={label}
      >
        <Pause size={9} strokeWidth={2.4} />
      </span>
    )
  }

  if (typing) {
    return (
      <span
        className="flex h-4 w-6 shrink-0 items-center justify-center gap-0.5 rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 opacity-75"
        title="Thinking"
        aria-label="Thinking"
      >
        <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse" />
        <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse [animation-delay:120ms]" />
        <span className="h-1 w-1 rounded-full bg-[var(--pear-text-faint)] animate-pulse [animation-delay:240ms]" />
      </span>
    )
  }

  const active = agent.activity !== 'idle' && agent.status === 'running'

  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)]/35 opacity-75"
      title={active ? 'Active' : 'Idle'}
      aria-label={active ? 'Active' : 'Idle'}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[var(--pear-teal)]' : 'bg-[var(--pear-yellow)]'}`} />
    </span>
  )
}

function ProjectSwitcher({ collapsed = false }: { collapsed?: boolean }): React.ReactNode {
  const [compactOpen, setCompactOpen] = useState(false)
  const [query, setQuery] = useState('')
  const switcherRef = useRef<HTMLDivElement | null>(null)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const projectSwitcherExpanded = useUIStore((s) => s.projectSwitcherExpanded)
  const setProjectSwitcherExpanded = useUIStore((s) => s.setProjectSwitcherExpanded)
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const openTab = useUIStore((s) => s.openTab)
  const openDialog = useUIStore((s) => s.openDialog)
  const open = collapsed ? compactOpen : projectSwitcherExpanded
  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
    ),
    [projects]
  )
  const activeProject = projects.find((project) => project.id === activeProjectId) || sortedProjects[0]
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return sortedProjects
    return sortedProjects.filter((project) => project.name.toLowerCase().includes(normalizedQuery))
  }, [query, sortedProjects])

  useEffect(() => {
    if (projects.length > 0) return

    setCompactOpen(false)
    setQuery('')
  }, [projects.length])

  useEffect(() => {
    if (!collapsed || !open) return

    function closeOnOutsideClick(event: PointerEvent): void {
      const target = event.target
      if (target instanceof Node && switcherRef.current?.contains(target)) return
      setCompactOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsideClick, true)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick, true)
  }, [collapsed, open])

  function toggleOpen(): void {
    const nextOpen = !open
    if (!nextOpen) setQuery('')

    if (collapsed) {
      setCompactOpen(nextOpen)
    } else {
      setProjectSwitcherExpanded(nextOpen)
    }
  }

  function selectProject(project: Project): void {
    if (collapsed) setCompactOpen(false)
    setQuery('')
    openTab(tabAfterProjectSwitch(project, activeTab))
    setActiveProject(project.id).catch((error) => {
      console.error('[sidebar] Failed to set active project:', error)
    })
  }

  function openProjectSettingsForProject(project: Project): void {
    if (collapsed) setCompactOpen(false)
    setQuery('')
    openTab({ kind: 'project-settings', projectId: project.id })
    setActiveProject(project.id).catch((error) => {
      console.error('[sidebar] Failed to set active project:', error)
    })
  }

  function openAddProject(): void {
    if (collapsed) setCompactOpen(false)
    setQuery('')
    openDialog('add-project')
  }

  if (!activeProject) {
    return collapsed ? (
      <button
        type="button"
        onClick={openAddProject}
        className={collapsedButtonClass(false)}
        title="Add project"
        aria-label="Add project"
      >
        <Plus size={16} />
      </button>
    ) : (
      <button
        type="button"
        onClick={openAddProject}
        className="project-switcher-trigger flex h-[52px] w-full items-center gap-2.5 px-5 text-left text-[var(--pear-text-dim)] transition-colors hover:text-[var(--pear-text)]"
      >
        <Plus size={15} className="shrink-0 text-[var(--pear-text-faint)]" />
        <span className="min-w-0">
          <span className="block text-[11px] font-medium leading-[14px] text-[var(--pear-text-faint)]">
            Current Project
          </span>
          <span className="block truncate text-[13px] font-semibold leading-4">Add project</span>
        </span>
      </button>
    )
  }

  const switcherButton = collapsed ? (
    <button
      type="button"
      onClick={toggleOpen}
      className={collapsedButtonClass(open)}
      title={`Switch project: ${activeProject.name}`}
      aria-label={`Switch project: ${activeProject.name}`}
      aria-expanded={open}
    >
      <span className="text-sm font-semibold">{projectInitial(activeProject.name)}</span>
    </button>
  ) : (
    <button
      type="button"
      onClick={toggleOpen}
      className={`project-switcher-trigger flex h-[52px] w-full items-center gap-2.5 px-5 text-left transition-colors ${
        open ? 'is-open' : ''
      }`}
      aria-expanded={open}
    >
      <FolderKanban size={14} className="shrink-0 text-[var(--pear-text-secondary)]" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[11px] font-medium leading-[14px] text-[var(--pear-text-faint)]">
          Current Project
        </span>
        <span className="block truncate text-[13px] font-semibold leading-4 text-[var(--pear-text)]">
          {activeProject.name}
        </span>
      </span>
      {open
        ? <ChevronUp size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />
        : <ChevronDown size={12} className="shrink-0 text-[var(--pear-text-secondary)]" />}
    </button>
  )

  return (
    <div ref={switcherRef} className={collapsed ? 'relative z-50' : 'relative'}>
      {switcherButton}

      {open && (
        <div
          className={collapsed
            ? 'project-switcher-dropdown absolute left-[calc(100%+8px)] top-0 z-50 w-[300px] overflow-hidden rounded-lg border border-[var(--pear-border)] p-3'
            : 'project-switcher-panel overflow-hidden border-b border-[var(--pear-border-subtle)] pb-3 pt-2'
          }
        >
          <div className="mb-2 flex items-center gap-2 px-3">
            <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-transparent bg-[var(--pear-bg)] px-2.5 text-[12px] text-[var(--pear-text-secondary)] transition-colors focus-within:border-[#0166D6]">
              <Search size={12} className="shrink-0 text-[var(--pear-text-faint)]" />
              <input
                autoFocus={collapsed}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter projects"
                className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--pear-text)] caret-[#0166D6] outline-none placeholder:text-[var(--pear-text-faint)]"
                data-focus-ring="none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
                  aria-label="Clear project filter"
                >
                  <X size={12} />
                </button>
              )}
            </label>
            <button
              type="button"
              onClick={openAddProject}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--pear-border)] px-2.5 text-[12px] font-semibold text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]"
            >
              <Plus size={12} />
              Add
            </button>
          </div>

          <div className="max-h-[300px] overflow-y-auto px-3">
            {filteredProjects.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--pear-text-faint)]">No projects match</div>
            ) : (
              <div className="space-y-1">
                {filteredProjects.map((project) => {
                  const active = project.id === activeProjectId
                  return (
                    <div
                      key={project.id}
                      className={`flex h-8 w-full items-center rounded-md text-[13px] font-semibold ${
                        active
                          ? 'bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
                          : 'text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectProject(project)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-3.5 text-left"
                      >
                        <FolderKanban size={13} className="shrink-0 text-[var(--pear-text-secondary)]" />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pear-accent)]" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => openProjectSettingsForProject(project)}
                        className="flex h-full w-8 shrink-0 items-center justify-center rounded-r-md text-[var(--pear-text-faint)] hover:bg-[var(--pear-bg-surface)] hover:text-[var(--pear-text)]"
                        title={`Open ${project.name} settings`}
                        aria-label={`Open ${project.name} settings`}
                      >
                        <Settings size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// The Attention Inbox is a global, cross-project surface, so its entry lives
// above the project-scoped navigation and stays reachable even with no active
// project selected (e.g. the browser demo build).
function IssuesNavEntry({ collapsed = false }: { collapsed?: boolean }): React.ReactNode {
  const openTab = useUIStore((s) => s.openTab)
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const active = activeTab?.kind === 'issues'
  const needsYouCount = useIssuesStore((s) => s.issues.reduce((count, issue) => issue.band === 'needs-you' ? count + 1 : count, 0))

  function openIssues(): void {
    openTab({ kind: 'issues' })
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={openIssues}
        className={collapsedButtonClass(active)}
        title={needsYouCount > 0 ? `Issues — ${needsYouCount} need you` : 'Issues'}
        aria-label="Issues"
      >
        <Inbox size={18} className={active ? '' : 'text-[var(--pear-text-dim)]'} />
        {needsYouCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--pear-red)] px-1 text-[9px] font-bold leading-none text-white">
            {needsYouCount}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="px-3 pb-2 pt-1">
      <button
        type="button"
        onClick={openIssues}
        className={`flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md border px-2.5 text-left text-[13px] font-semibold transition-colors ${
          active
            ? 'border-[var(--pear-accent-dim)] bg-[var(--pear-bg-overlay)] text-[var(--pear-text)]'
            : 'border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)]/70 text-[var(--pear-text)] hover:border-[var(--pear-border)] hover:bg-[var(--pear-bg-surface-hover)]'
        }`}
      >
        <Inbox size={15} className="shrink-0 text-[var(--pear-text-dim)]" />
        <span className="min-w-0 flex-1 truncate">Issues</span>
        {needsYouCount > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--pear-red)] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {needsYouCount}
          </span>
        )}
      </button>
    </div>
  )
}

function ProjectNavigation({ collapsed = false }: { collapsed?: boolean }): React.ReactNode {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeChannelName = useProjectStore((s) => s.activeChannelName)
  const setActiveChannel = useProjectStore((s) => s.setActiveChannel)
  const projects = useProjectStore((s) => s.projects)
  const allAgents = useAgentStore((s) => s.agents)
  const allMessages = useAgentStore((s) => s.messages)
  const activeAgentKey = useAgentStore((s) => s.activeAgentKey)
  const setActiveAgentKey = useAgentStore((s) => s.setActiveAgentKey)
  const activeTab = useUIStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const openTab = useUIStore((s) => s.openTab)
  const openDialog = useUIStore((s) => s.openDialog)
  const activeProject = projects.find((project) => project.id === activeProjectId)
  const agents = useMemo(
    () => activeProject ? allAgents.filter((agent) => agent.projectId === activeProject.id) : [],
    [activeProject, allAgents]
  )
  const directMessageRooms = useMemo(
    () => activeProject
      ? deriveDirectMessageRooms(allMessages, activeProject.id, activeProject.channels)
      : [],
    [activeProject, allMessages]
  )
  const activeDirectMessageRoomId = activeTab?.kind === 'dm' && activeProject
    ? getDirectMessageRoomId(activeTab.dmParticipants || [])
    : null

  function openAgents(): void {
    if (!activeProject) return
    setActiveChannel(null)
    openTab({ kind: 'agents', projectId: activeProject.id })
  }

  function openProjectSettings(): void {
    if (!activeProject) return
    openTab({ kind: 'project-settings', projectId: activeProject.id })
  }

  function addAgent(): void {
    openDialog('spawn-agent')
  }

  function addChannel(): void {
    openDialog('add-channel')
  }

  function selectAgent(agent: Agent): void {
    setActiveChannel(null)
    openTab({ kind: 'agents', projectId: agent.projectId })
    setActiveAgentKey(getAgentKeyForAgent(agent))
  }

  function selectChannel(channel: string): void {
    if (!activeProject) return
    setActiveAgentKey(null)
    setActiveChannel(channel)
    openTab({ kind: 'channel', projectId: activeProject.id, channelName: channel })
  }

  function selectDirectMessage(room: DirectMessageRoom): void {
    if (!activeProject) return
    setActiveAgentKey(null)
    setActiveChannel(null)
    openTab({
      kind: 'dm',
      projectId: activeProject.id,
      dmParticipants: room.participants,
      title: room.title
    })
  }

  if (!activeProject) {
    return collapsed ? (
      <div className="flex min-h-0 flex-1 flex-col items-center" />
    ) : (
      <div className="flex min-h-0 flex-1 px-3 py-4">
        <button
          type="button"
          onClick={() => openDialog('add-project')}
          className="h-fit w-full rounded-lg border border-dashed border-[var(--pear-border)] px-4 py-6 text-center text-xs text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text-dim)]"
        >
          Add a project to start
        </button>
      </div>
    )
  }

  if (collapsed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 pb-2">
        <button
          type="button"
          onClick={openAgents}
          className={collapsedButtonClass(activeTab?.kind === 'agents')}
          title={`${activeProject.name} agents`}
          aria-label={`${activeProject.name} agents`}
        >
          <LayoutGrid size={16} />
          {agents.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--pear-accent)] px-1 text-[9px] font-semibold leading-none text-[var(--pear-bg)]">
              {agents.length}
            </span>
          )}
        </button>
        <div className="my-1 h-px w-7 shrink-0 bg-[var(--pear-border-subtle)]" />

        {agents.map((agent) => {
          const key = getAgentKeyForAgent(agent)
          const active = activeTab?.kind === 'agents' && activeAgentKey === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => selectAgent(agent)}
              className={collapsedButtonClass(active)}
              title={agent.name}
              aria-label={agent.name}
            >
              <AgentHarnessIcon cli={agent.cli} className="h-4 w-4" />
              <span
                className={`absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ${
                  agent.status === 'running' && agent.activity !== 'idle'
                    ? 'bg-[var(--pear-teal)]'
                    : 'bg-[var(--pear-yellow)]'
                }`}
              />
            </button>
          )
        })}

        <div className="my-1 h-px w-7 shrink-0 bg-[var(--pear-border-subtle)]" />

        {activeProject.channels.map((channel) => {
          const active = activeTab?.kind === 'channel' &&
            activeTab.projectId === activeProject.id &&
            activeChannelName === channel
          return (
            <button
              key={channel}
              type="button"
              onClick={() => selectChannel(channel)}
              className={collapsedButtonClass(active)}
              title={`#${channel}`}
              aria-label={`#${channel}`}
            >
              <Hash size={15} />
              <span className="absolute bottom-1 right-1 text-[8px] font-semibold leading-none">
                {compactLabel(channel).slice(0, 1)}
              </span>
            </button>
          )
        })}

        {directMessageRooms.length > 0 && (
          <>
            <div className="my-1 h-px w-7 shrink-0 bg-[var(--pear-border-subtle)]" />
            {directMessageRooms.map((room) => (
              <button
                key={room.id}
                type="button"
                onClick={() => selectDirectMessage(room)}
                className={collapsedButtonClass(activeDirectMessageRoomId === room.id)}
                title={room.title}
                aria-label={room.title}
              >
                <MessageCircle size={15} />
                <span className="absolute bottom-1 right-1 text-[8px] font-semibold leading-none">
                  {compactLabel(room.title).slice(0, 1)}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <section>
          <SectionHeader
            title="Agents"
            addLabel="Add agent"
            onAdd={addAgent}
            menuItems={[
              { label: 'Add agent', icon: Plus, onSelect: addAgent },
              { label: 'Agent settings', icon: Settings, onSelect: openProjectSettings }
            ]}
          />
          <div className="space-y-1">
            {agents.length === 0 ? (
              <button
                type="button"
                onClick={addAgent}
                className="w-full rounded-md border border-dashed border-[var(--pear-border-subtle)] px-2 py-2 text-left text-[11px] text-[var(--pear-text-faint)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text-dim)]"
              >
                Spawn an agent
              </button>
            ) : (
              agents.map((agent) => {
                const key = getAgentKeyForAgent(agent)
                const active = activeTab?.kind === 'agents' && activeAgentKey === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => selectAgent(agent)}
                    className={rowClass(active)}
                  >
                    <AgentHarnessIcon cli={agent.cli} className="h-3.5 w-3.5 shrink-0 text-[var(--pear-text-faint)]" />
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    <AgentActivityIndicator agent={agent} />
                  </button>
                )
              })
            )}
          </div>
        </section>

        <section>
          <SectionHeader
            title="Channels"
            addLabel="Add channel"
            onAdd={addChannel}
            menuItems={[
              { label: 'Add channel', icon: Plus, onSelect: addChannel },
              { label: 'Channel settings', icon: Settings, onSelect: openProjectSettings }
            ]}
          />
          <div className="space-y-1">
            {activeProject.channels.length === 0 ? (
              <EmptySection label="No channels" />
            ) : (
              activeProject.channels.map((channel) => {
                const active = activeTab?.kind === 'channel' &&
                  activeTab.projectId === activeProject.id &&
                  activeChannelName === channel
                const count = channelAgentCount(agents, channel)
                return (
                  <button
                    key={channel}
                    type="button"
                    onClick={() => selectChannel(channel)}
                    className={rowClass(active)}
                  >
                    <Hash size={12} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{channel}</span>
                    {count > 0 && (
                      <span className="shrink-0 rounded-full bg-[var(--pear-bg)]/40 px-1.5 py-0.5 text-[10px] leading-none text-[var(--pear-text-faint)]">
                        {count}
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </section>

        <section>
          <SectionHeader title="DMs" />
          <div className="space-y-1">
            {directMessageRooms.length === 0 ? (
              <div className="px-2 py-1 text-[11px] text-[var(--pear-text-faint)]">No DMs</div>
            ) : (
              directMessageRooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => selectDirectMessage(room)}
                  className={rowClass(activeDirectMessageRoomId === room.id)}
                >
                  <MessageCircle size={12} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{room.title}</span>
                  <span className="shrink-0 rounded-full bg-[var(--pear-bg)]/40 px-1.5 py-0.5 text-[10px] leading-none text-[var(--pear-text-faint)]">
                    {room.messageCount}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <section>
          <SectionHeader title="Conversations" />
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => openTab({ kind: 'ai-hist', projectId: activeProject.id })}
              className={rowClass(
                activeTab?.kind === 'ai-hist' && activeTab.projectId === activeProject.id
              )}
              title="Browse Claude / Codex / Cursor history scoped to this project"
            >
              <MessageSquare size={12} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">Conversation history</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

export function ProjectSidebar(): React.ReactNode {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)

  if (sidebarCollapsed) {
    return (
      <div className="flex h-full flex-col items-center border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]/95 py-2 backdrop-blur-xl">
        <div className="mb-2 flex h-9 w-9 items-center justify-center">
          <AgentRelayLogo />
        </div>

        <div className="mb-2">
          <ProjectSwitcher collapsed />
        </div>

        <div className="mb-2">
          <IssuesNavEntry collapsed />
        </div>

        <ProjectNavigation collapsed />

        <div className="shrink-0 border-t border-[var(--pear-border-subtle)] px-2 pt-2">
          <AccountMenu compact />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]/95 backdrop-blur-xl">
      <div className="titlebar-nodrag flex h-16 shrink-0 items-center border-b border-[var(--pear-border-subtle)] px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <AgentRelayLogo />
          <AgentRelayWordmark />
        </div>
      </div>

      <div className="titlebar-nodrag shrink-0 pb-2">
        <ProjectSwitcher />
      </div>

      <div className="shrink-0">
        <IssuesNavEntry />
      </div>

      <ProjectNavigation />

      <div className="shrink-0 border-t border-[var(--pear-border-subtle)] px-3 py-2">
        <AccountMenu />
      </div>
    </div>
  )
}
