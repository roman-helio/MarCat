import { ArrowDown, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SortDirection = 'asc' | 'desc'

export function compareListValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  direction: SortDirection,
): number {
  const aMissing = a == null || a === ''
  const bMissing = b == null || b === ''
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0
    return aMissing ? 1 : -1
  }
  const result =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true })
  return direction === 'asc' ? result : -result
}

export function SortableHeader({
  label,
  active,
  direction,
  onClick,
  align = 'left',
  className,
}: {
  label: string
  active: boolean
  direction: SortDirection
  onClick: () => void
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'tap group flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius)] text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        align === 'right' ? 'justify-end text-right' : 'justify-start text-left',
        active ? 'font-medium text-text' : 'text-muted hover:text-text',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      <ArrowDown
        className={cn(
          'h-3 w-3 shrink-0 transition-[opacity,transform] duration-150 ease-out',
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40 group-focus-visible:opacity-40',
          active && direction === 'asc' && 'rotate-180',
        )}
        aria-hidden
      />
    </button>
  )
}

export function StatusSelect<T extends string>({
  value,
  options,
  onChange,
  toneClassName,
  ariaLabel,
  className,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  toneClassName: string
  ariaLabel: string
  className?: string
}) {
  const label = options.find((option) => option.value === value)?.label ?? value
  return (
    <div
      className={cn(
        'relative flex h-10 shrink-0 items-center rounded-[var(--radius)] focus-within:ring-2 focus-within:ring-accent/60',
        className,
      )}
    >
      <span
        className={cn(
          'inline-flex h-6 w-full items-center justify-between gap-1 rounded-[6px] border px-2 text-xs font-medium',
          toneClassName,
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
      </span>
      <select
        value={value}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value as T)}
        aria-label={ariaLabel}
        className="absolute inset-0 h-10 w-full cursor-pointer opacity-0 outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
