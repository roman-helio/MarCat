import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SegItem<T extends string> {
  value: T
  label?: ReactNode
  icon?: ReactNode
  title?: string
}

/** Compact segmented control (pixel font), one quiet accent-tinted active segment. */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  ariaLabel,
  className,
}: {
  value: T
  onChange: (v: T) => void
  items: SegItem<T>[]
  ariaLabel?: string
  className?: string
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    onChange(items[nextIndex].value)
    buttons.current[nextIndex]?.focus()
  }

  return (
    <div
      data-ui="segmented"
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-grid h-11 w-fit auto-cols-fr grid-flow-col items-stretch rounded-[12px] bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_var(--border)]',
        className,
      )}
    >
      {items.map((it, index) => (
        <button
          key={it.value}
          ref={(node) => {
            buttons.current[index] = node
          }}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          tabIndex={value === it.value ? 0 : -1}
          title={it.title}
          aria-label={it.title}
          onClick={() => onChange(it.value)}
          onKeyDown={(event) => moveFocus(event, index)}
          className={cn(
            'tap inline-flex min-w-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 t-control transition-[transform,background-color,color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            value === it.value
              ? 'bg-surface text-accent shadow-hard'
              : 'text-muted hover:bg-surface/55 hover:text-text',
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
        'tap inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius)] border transition-[transform,background-color,border-color,color] duration-150 ease-out',
        active ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  )
}
