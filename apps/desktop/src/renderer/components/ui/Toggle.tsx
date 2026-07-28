import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SegItem<T extends string> {
  value: T
  label?: string
  icon?: ReactNode
  title?: string
}

/** Compact segmented control (pixel font), one quiet accent-tinted active segment. */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  items: SegItem<T>[]
  ariaLabel?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex h-10 items-center overflow-hidden rounded-[var(--radius)] border border-border text-sm"
    >
      {items.map((it, i) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          title={it.title}
          aria-label={it.title}
          onClick={() => onChange(it.value)}
          className={cn(
            'inline-flex h-full items-center gap-1.5 px-2.5 transition-colors',
            i > 0 && 'border-l border-border',
            value === it.value ? 'bg-accent/10 text-accent' : 'text-muted hover:text-text',
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  )
}

/** Quiet square icon toggle: subtle accent tint when active. */
export function IconToggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border transition-colors active:scale-[0.96]',
        active ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  )
}
