import type React from 'react'
import { type ReactNode, type ComponentType, type CSSProperties } from 'react'
import { Filter, X } from 'lucide-react'

type PaneSidebarProps = {
  width?: number | string
  className?: string
  children: ReactNode
}

export function PaneSidebar({ width, className, children }: PaneSidebarProps): React.ReactNode {
  const style: CSSProperties | undefined = width !== undefined ? { width } : undefined
  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] ${className ?? ''}`}
      style={style}
    >
      {children}
    </aside>
  )
}

type FilterInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon?: ComponentType<{ size?: number; className?: string }>
  ariaLabel?: string
  showClear?: boolean
  trailing?: ReactNode
}

export function FilterInput({
  value,
  onChange,
  placeholder = 'Filter',
  icon: Icon = Filter,
  ariaLabel,
  showClear = false,
  trailing
}: FilterInputProps): React.ReactNode {
  return (
    <label className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-[var(--pear-border-subtle)] bg-[var(--pear-bg)] px-2.5 text-[13px] text-[var(--pear-text-secondary)] focus-within:border-[var(--pear-accent-dim)] focus-within:ring-1 focus-within:ring-[var(--pear-accent-dim)]">
      <Icon size={14} className="shrink-0 text-[var(--pear-text-faint)]" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-[var(--pear-text)] outline-none placeholder:text-[var(--pear-text-faint)]"
      />
      {showClear && value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--pear-text-secondary)] hover:bg-[var(--pear-bg-surface-hover)] hover:text-[var(--pear-text)]"
          aria-label="Clear"
        >
          <X size={12} />
        </button>
      )}
      {trailing}
    </label>
  )
}
