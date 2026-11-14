import type React from 'react'
import { User } from 'lucide-react'
import { AgentHarnessIcon, agentIconKey } from '@/components/common/AgentIcons'
import { GrokAvatar } from '@/components/common/GrokAvatar'
import { HumanAvatar } from '@/components/chat/HumanAvatar'
import { isSignedInPerson, useAuthUser } from '@/lib/auth-user'

/**
 * An agent's tile: its tool's mark (Grok's animated avatar), or its initial
 * when the tool is unknown. People show their photo when they're the
 * signed-in user, a person icon otherwise.
 */
export function AgentAvatar({
  name,
  cli,
  human = false,
  size = 40
}: {
  name: string
  cli?: string | null
  human?: boolean
  size?: number
}): React.ReactNode {
  const user = useAuthUser()
  const art = Math.round(size * 0.6)
  if (human && isSignedInPerson(name, user)) {
    return (
      <HumanAvatar
        user={user}
        iconSize={art}
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--pear-bg)]/60"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg bg-[var(--pear-bg)]/60 text-[var(--pear-text-secondary)]"
      style={{ width: size, height: size }}
    >
      {human ? (
        <User aria-label={`${name} (person)`} size={art} />
      ) : cli ? (
        <span aria-label={`${cli} agent`} className="flex text-[var(--pear-text)]" style={{ width: art, height: art }}>
          {agentIconKey(cli) === 'grok' ? (
            <GrokAvatar seed={name} size={art} />
          ) : (
            <AgentHarnessIcon cli={cli} className="h-full w-full" />
          )}
        </span>
      ) : (
        <span className="font-bold" style={{ fontSize: Math.round(size * 0.35) }}>
          {(name || '?').slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  )
}
