import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared lifecycle language for every entity card in MarCat.
 *
 * The state tone owns only the left spine, status badge and board-column tint.
 * Domain signals such as priority, deadline, platform, fit or price stay in metadata
 * and must never recolor the whole card surface.
 */
export type CardStateTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger'

export const CARD_STATE_STYLES: Record<
  CardStateTone,
  {
    badge: string
    control: string
    dot: string
    spine: string
    column: string
    columnBorder: string
    text: string
  }
> = {
  neutral: {
    badge: 'bg-surface-2 text-muted',
    control: 'border-border bg-surface-2 text-muted',
    dot: 'bg-muted',
    spine: 'border-l-border-strong',
    column: 'bg-surface-2/45',
    columnBorder: 'border-border-strong',
    text: 'text-muted',
  },
  info: {
    badge: 'bg-info/12 text-info',
    control: 'border-info/25 bg-info/10 text-info',
    dot: 'bg-info',
    spine: 'border-l-info',
    column: 'bg-info/[0.045]',
    columnBorder: 'border-info/35',
    text: 'text-info',
  },
  warning: {
    badge: 'bg-warning/12 text-warning',
    control: 'border-warning/25 bg-warning/10 text-warning',
    dot: 'bg-warning',
    spine: 'border-l-warning',
    column: 'bg-warning/[0.045]',
    columnBorder: 'border-warning/35',
    text: 'text-warning',
  },
  success: {
    badge: 'bg-success/12 text-success',
    control: 'border-success/25 bg-success/10 text-success',
    dot: 'bg-success',
    spine: 'border-l-success',
    column: 'bg-success/[0.045]',
    columnBorder: 'border-success/35',
    text: 'text-success',
  },
  danger: {
    badge: 'bg-alarm/12 text-alarm',
    control: 'border-alarm/25 bg-alarm/10 text-alarm',
    dot: 'bg-alarm',
    spine: 'border-l-alarm',
    column: 'bg-alarm/[0.045]',
    columnBorder: 'border-alarm/35',
    text: 'text-alarm',
  },
}

export function CardStateBadge({
  tone,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone: CardStateTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-1.5 py-0.5 t-caption font-medium leading-4',
        CARD_STATE_STYLES[tone].badge,
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}

interface CardSurfaceProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  tone: CardStateTone
  children: ReactNode
  compact?: boolean
  selected?: boolean
  dragging?: boolean
  static?: boolean
}

/** Standard interactive entity-card surface. Non-interactive rows can reuse CARD_STATE_STYLES[tone].spine. */
export const CardSurface = forwardRef<HTMLButtonElement, CardSurfaceProps>(
  (
    {
      tone,
      compact = false,
      selected = false,
      dragging = false,
      static: isStatic = false,
      className,
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative w-full rounded-[10px] border-l-[4px] bg-surface p-2.5 text-left shadow-hard hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        !isStatic && 'tactile',
        CARD_STATE_STYLES[tone].spine,
        compact && 'rounded-[8px] px-2.5 py-2',
        selected && 'ring-2 ring-accent/50',
        dragging && 'opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
)
CardSurface.displayName = 'CardSurface'
