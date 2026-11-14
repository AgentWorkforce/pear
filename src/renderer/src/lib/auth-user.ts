import { useEffect, useState } from 'react'
import { pear, type AuthUser } from '@/lib/ipc'

let authUserLoad: Promise<AuthUser | null> | null = null

function loadAuthUser(): Promise<AuthUser | null> {
  if (!authUserLoad) {
    authUserLoad = Promise.resolve()
      .then(() => pear.auth.status())
      .then((status) => (status.loggedIn ? status.user ?? null : null))
      .catch(() => {
        authUserLoad = null
        return null
      })
  }
  return authUserLoad
}

/** The signed-in Cloud user, read once and shared by every avatar. */
export function useAuthUser(): AuthUser | null {
  const [user, setUser] = useState<AuthUser | null>(null)
  useEffect(() => {
    let live = true
    void loadAuthUser().then((loaded) => {
      if (live) setUser(loaded)
    })
    return () => {
      live = false
    }
  }, [])
  return user
}

function slug(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Whether a Relaycast human (`khaliq-gant@host`) is the signed-in user. */
export function isSignedInPerson(name: string, user: AuthUser | null | undefined): boolean {
  if (!user) return false
  const identity = slug(name.split('@')[0])
  if (!identity) return false
  return [user.name, user.githubUsername, user.username, user.email?.split('@')[0]]
    .map(slug)
    .some((candidate) => candidate === identity)
}
