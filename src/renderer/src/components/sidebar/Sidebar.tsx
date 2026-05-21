import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { LogIn, LogOut, Settings } from 'lucide-react'
import { pear } from '@/lib/ipc'
import { useUIStore } from '@/stores/ui-store'
import { ProjectSidebar } from './ProjectSidebar'

type AuthStatus = Awaited<ReturnType<typeof pear.auth.status>>

function getInitials(user: AuthStatus['user']): string {
  const fromName = user?.name
    ?.trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')

  return (fromName || user?.email?.[0] || '?').slice(0, 2).toUpperCase()
}

interface UserMenuProps {
  collapsed: boolean
}

function UserMenu({ collapsed }: UserMenuProps): React.ReactNode {
  const openTab = useUIStore((s) => s.openTab)
  const [auth, setAuth] = useState<AuthStatus>({ loggedIn: false })
  const [menuOpen, setMenuOpen] = useState(false)
  const [signingIn, setSigningIn] = useState(false)

  useEffect(() => {
    let cancelled = false

    pear.auth.status()
      .then((status) => {
        if (!cancelled) setAuth(status)
      })
      .catch(() => {
        if (!cancelled) setAuth({ loggedIn: false })
      })

    return () => {
      cancelled = true
    }
  }, [])

  const initials = useMemo(() => getInitials(auth.user), [auth.user])

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

  const handleLogin = useCallback(async () => {
    setSigningIn(true)
    try {
      const result = await pear.auth.login()
      // login() resolves with { loggedIn, apiUrl } but not the user record;
      // re-fetch status so the avatar/initials populate immediately.
      setAuth(result.loggedIn ? await pear.auth.status() : result)
    } catch {
      setAuth({ loggedIn: false })
    } finally {
      setSigningIn(false)
    }
  }, [])

  if (!auth.loggedIn) {
    return (
      <div
        className={`titlebar-nodrag shrink-0 border-r border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]/95 backdrop-blur-xl ${
          collapsed ? 'flex h-14 items-center justify-center px-2' : 'flex px-5 py-3'
        }`}
      >
        <button
          type="button"
          onClick={handleLogin}
          disabled={signingIn}
          aria-label="Sign in"
          title="Sign in"
          className={`flex items-center justify-center gap-2 rounded-lg text-sm font-medium text-[var(--pear-bg)] bg-[var(--pear-accent)] shadow-sm hover:brightness-110 disabled:opacity-60 ${
            collapsed ? 'h-8 w-8' : 'w-full px-3 py-2'
          }`}
        >
          <LogIn size={collapsed ? 15 : 13} />
          {!collapsed && <span>{signingIn ? 'Signing in…' : 'Sign in'}</span>}
        </button>
      </div>
    )
  }

  return (
    <div
      className={`titlebar-nodrag shrink-0 border-r border-t border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]/95 backdrop-blur-xl ${
        collapsed ? 'flex h-14 items-center justify-center px-2' : 'flex justify-end px-5 py-3'
      }`}
    >
      <div className="relative">
        <button
          type="button"
          aria-label="Open user menu"
          title={auth.user?.email || auth.user?.name || 'User menu'}
          onClick={() => setMenuOpen((open) => !open)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--pear-accent)] text-[10px] font-semibold text-[var(--pear-bg)] shadow-sm hover:brightness-110"
        >
          {initials}
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className={`absolute bottom-full z-50 mb-1 w-48 rounded-lg border border-[var(--pear-border)] bg-[var(--pear-bg-surface)] py-1 shadow-lg ${
                collapsed ? 'left-0' : 'right-0'
              }`}
            >
              <button
                type="button"
                onClick={openAccountSettings}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--pear-text)] hover:bg-[var(--pear-bg-surface-hover)]"
              >
                <Settings size={13} />
                <span>Account settings</span>
              </button>
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
    </div>
  )
}

export function Sidebar(): React.ReactNode {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)

  return (
    <div className="flex h-full flex-col bg-[var(--pear-bg-raised)]/95">
      <div className="min-h-0 flex-1">
        <ProjectSidebar />
      </div>
      <UserMenu collapsed={sidebarCollapsed} />
    </div>
  )
}

export default Sidebar
