import type React from 'react'
import { Moon, Settings, Sun, X } from 'lucide-react'
import { useUIStore } from '@/stores/ui-store'

export function AccountSettings(): React.ReactNode {
  const closeActiveTab = useUIStore((s) => s.closeActiveTab)
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)

  return (
    <div className="h-full overflow-y-auto bg-[var(--pear-bg)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-7 px-8 py-8">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">
              <Settings size={13} />
              Account settings
            </div>
            <h1 className="text-2xl font-semibold text-[var(--pear-text)]">Settings</h1>
          </div>
          <button
            type="button"
            onClick={closeActiveTab}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--pear-border)] text-[var(--pear-text-dim)] hover:border-[var(--pear-accent-dim)] hover:text-[var(--pear-text)]"
            title="Close account settings"
            aria-label="Close account settings"
          >
            <X size={16} />
          </button>
        </header>

        <section className="border-t border-[var(--pear-border-subtle)] pt-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--pear-text-faint)]">Appearance</h2>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--pear-border-subtle)] bg-[var(--pear-bg-raised)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm text-[var(--pear-text)]">Theme</div>
              <div className="text-xs text-[var(--pear-text-faint)]">Switch between dark and light mode</div>
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--pear-border-subtle)] p-0.5">
              {(['dark', 'light'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={theme === mode}
                  onClick={() => setTheme(mode)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm capitalize transition-colors ${
                    theme === mode
                      ? 'bg-[var(--pear-bg-surface)] text-[var(--pear-text)]'
                      : 'text-[var(--pear-text-faint)] hover:text-[var(--pear-text-dim)]'
                  }`}
                >
                  {mode === 'dark' ? <Moon size={13} /> : <Sun size={13} />}
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
