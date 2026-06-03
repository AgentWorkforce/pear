import type React from 'react'

export function SkeletonBlock({ className }: { className: string }): React.ReactNode {
  return <div className={`animate-pulse rounded bg-[var(--pear-bg-overlay)] ${className}`} />
}

export function Metric({ label, value, loading = false }: { label: string; value: string; loading?: boolean }): React.ReactNode {
  return (
    <div className="min-w-[120px] rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-surface)] px-4 py-3">
      <div className="text-[11px] uppercase text-[var(--pear-text-faint)]">{label}</div>
      <div className="mt-1 h-7 text-xl font-semibold text-[var(--pear-text)]">
        {loading ? <SkeletonBlock className="h-6 w-24" /> : value}
      </div>
    </div>
  )
}

export function SectionLoadingRows({ rows = 3 }: { rows?: number }): React.ReactNode {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex animate-pulse items-center gap-3">
          <div className="h-3 flex-1 rounded bg-[var(--pear-bg-overlay)]" />
          <div className="h-3 w-16 rounded bg-[var(--pear-bg-overlay)]" />
          <div className="h-3 w-12 rounded bg-[var(--pear-bg-overlay)]" />
        </div>
      ))}
    </div>
  )
}

export function Section({
  title,
  children,
  empty,
  loading,
  loadingRows = 3
}: {
  title: string
  children: React.ReactNode
  empty?: boolean
  loading?: boolean
  loadingRows?: number
}): React.ReactNode {
  return (
    <section className="rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)]">
      <div className="flex h-11 items-center border-b border-[var(--pear-border-subtle)] px-4">
        <h2 className="text-sm font-semibold text-[var(--pear-text)]">{title}</h2>
      </div>
      <div className="p-4">
        {loading ? (
          <SectionLoadingRows rows={loadingRows} />
        ) : empty ? (
          <div className="py-5 text-sm text-[var(--pear-text-faint)]">No data yet</div>
        ) : children}
      </div>
    </section>
  )
}

export function sessionShortId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}` : sessionId
}
