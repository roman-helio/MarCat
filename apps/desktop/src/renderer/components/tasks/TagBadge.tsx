import { cn } from '@/lib/utils'
import type { TaskTag } from './meta'

export function TagBadge({ tag, className }: { tag: TaskTag; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center truncate rounded-[5px] px-1.5 py-0.5 t-caption leading-4',
        !tag.colorEnabled && 'bg-surface-2 text-muted',
        className,
      )}
      style={tag.colorEnabled ? { background: `${tag.color}1f`, color: tag.color } : undefined}
    >
      {tag.name}
    </span>
  )
}
