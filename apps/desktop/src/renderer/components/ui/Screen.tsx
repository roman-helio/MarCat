import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  actions?: ReactNode
}

/** Stable page chrome: identity on the left, persistent page actions on the right. */
export function PageHeader({ title, subtitle, leading, actions, className, ...props }: PageHeaderProps) {
  return (
    <header
      data-ui="page-header"
      className={cn('flex min-h-11 flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-3">
        {leading && <div className="flex h-7 shrink-0 items-center justify-center text-accent">{leading}</div>}
        <div className="min-w-0">
          <h1 tabIndex={-1} className="t-title text-balance outline-none">
            {title}
          </h1>
          {subtitle && <p className="mt-1 max-w-2xl t-body text-pretty text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </header>
  )
}

interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  navigation?: ReactNode
  primary?: ReactNode
  utilities?: ReactNode
}

/**
 * A toolbar with invariant slots. View navigation never changes position when
 * contextual controls appear, disappear, or change width.
 */
export function Toolbar({ navigation, primary, utilities, className, ...props }: ToolbarProps) {
  return (
    <div
      data-ui="toolbar"
      className={cn(
        'grouped-surface grid min-h-[60px] min-w-0 grid-cols-[auto_minmax(12rem,1fr)_auto] items-center gap-2 p-2',
        className,
      )}
      {...props}
    >
      {navigation && <div className="shrink-0">{navigation}</div>}
      {primary && <div className="min-w-0">{primary}</div>}
      {utilities && <div className="flex min-h-11 min-w-0 items-center justify-end gap-2">{utilities}</div>}
    </div>
  )
}

export function GroupedSurface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-ui="grouped-surface" className={cn('grouped-surface p-4', className)} {...props} />
}
