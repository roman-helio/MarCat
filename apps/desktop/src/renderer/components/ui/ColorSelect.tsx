import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ColorSelectOption<T extends string> {
  value: T
  label: string
  tone: string
}

/** Compact custom select whose selected value and every menu row retain their semantic colour. */
export function ColorSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T
  options: ColorSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  if (!selected) return null

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'tap flex h-10 w-full min-w-0 items-center gap-2 rounded-[var(--radius)] px-2.5 text-left text-sm shadow-hard outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          selected.tone,
        )}
      >
        <span className="min-w-0 flex-1 whitespace-nowrap">{selected.label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 top-[calc(100%+4px)] z-[80] w-max min-w-full rounded-[10px] bg-surface p-1 shadow-hard"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className="tap flex h-10 w-full min-w-max items-center gap-2 rounded-[7px] px-1.5 text-left text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <span className={cn('inline-flex min-w-max whitespace-nowrap rounded-[6px] px-2 py-1', option.tone)}>
                {option.label}
              </span>
              <Check
                className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-accent', option.value !== value && 'opacity-0')}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
