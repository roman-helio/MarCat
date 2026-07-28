import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { ChevronRight, Repeat2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { daysUntil, isOverdue } from '@/lib/date'
import { useT } from '@/i18n/useT'
import { PRIORITY_META, STATUS_META, type TaskPriority, type TaskStatus, type TaskTag } from './meta'
import { TagBadge } from './TagBadge'

export interface TaskCardData {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  dueDate?: string | null
  recurrenceInterval?: number | null
  recurrenceUnit?: string | null
  taskKey?: string | null
  tags?: TaskTag[]
}

export function TaskCardBody({
  task,
  gameName,
  showOpen = true,
  compact = false,
}: {
  task: TaskCardData
  gameName?: string
  showOpen?: boolean
  compact?: boolean
}) {
  const t = useT()
  const finished = task.status === 'done' || task.status === 'cancelled'
  const dueDays = task.dueDate ? daysUntil(task.dueDate) : null
  const overdue = isOverdue(task.dueDate) && !finished
  const severelyOverdue = overdue && dueDays != null && dueDays < -5
  const dueLabel =
    dueDays == null
      ? null
      : dueDays < 0
        ? t('task.cardOverdue', { n: Math.abs(dueDays) })
        : dueDays === 0
          ? t('task.cardToday')
          : t('task.cardDueIn', { n: dueDays })

  if (compact) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        {task.taskKey && <span className="nums w-[5.25rem] shrink-0 text-xs text-muted">{task.taskKey}</span>}
        <span
          className={cn(
            'hidden shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] leading-4 sm:inline-flex',
            STATUS_META[task.status].badge,
          )}
        >
          {t(`status.${task.status}`)}
        </span>
        <span
          className={cn(
            'hidden shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] leading-4 md:inline-flex',
            PRIORITY_META[task.priority].cls,
          )}
        >
          {t(`prio.${task.priority}`)}
        </span>
        <span
          className={cn('min-w-0 flex-1 truncate text-sm font-medium text-text', finished && 'text-muted line-through')}
        >
          {task.title}
        </span>
        {(task.tags?.length ?? 0) > 0 && (
          <span className="hidden max-w-[28%] shrink-0 items-center gap-1 xl:flex">
            {task.tags!.slice(0, 2).map((tag) => (
              <TagBadge key={tag.id} tag={tag} className="max-w-32" />
            ))}
            {task.tags!.length > 2 && <span className="nums text-[11px] text-muted">+{task.tags!.length - 2}</span>}
          </span>
        )}
        {task.recurrenceInterval && task.recurrenceUnit && (
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] bg-accent/8 text-accent"
            title={t('task.recurring')}
            aria-label={t('task.recurring')}
          >
            <Repeat2 className="h-3.5 w-3.5" />
          </span>
        )}
        {task.dueDate && (
          <span
            className={cn(
              'nums hidden shrink-0 whitespace-nowrap text-xs md:inline',
              overdue ? 'text-alarm' : 'text-muted',
              severelyOverdue && 'deadline-dance font-medium',
            )}
          >
            {dueLabel ?? task.dueDate}
          </span>
        )}
        {showOpen && (
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted opacity-40 transition-[opacity,background-color,color] duration-150 ease-out group-hover:bg-surface-2 group-hover:text-text group-hover:opacity-100"
            aria-hidden
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 t-hint">
          {task.taskKey && <span className="nums text-text">{task.taskKey}</span>}
          <span className={cn('rounded-[5px] px-1.5 py-0.5 text-[11px]', STATUS_META[task.status].badge)}>
            {t(`status.${task.status}`)}
          </span>
          <span className={cn('rounded-[5px] px-1.5 py-0.5 text-[11px]', PRIORITY_META[task.priority].cls)}>
            {t(`prio.${task.priority}`)}
          </span>
          {task.recurrenceInterval && task.recurrenceUnit && (
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-accent/8 text-accent"
              title={t('task.recurring')}
              aria-label={t('task.recurring')}
            >
              <Repeat2 className="h-3 w-3" />
            </span>
          )}
        </div>

        <div
          className={cn(
            'mt-1 line-clamp-2 break-words t-body font-medium text-pretty [overflow-wrap:anywhere]',
            finished && 'text-muted line-through',
          )}
        >
          {task.title}
        </div>

        {(gameName || task.dueDate) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 t-hint">
            {gameName && <span>{gameName}</span>}
            {gameName && task.dueDate && <span aria-hidden>·</span>}
            {task.dueDate && (
              <span className={cn('nums', overdue && 'text-alarm', severelyOverdue && 'deadline-dance font-medium')}>
                {!finished && dueLabel ? `${dueLabel} · ` : ''}
                {task.dueDate}
              </span>
            )}
          </div>
        )}

        {(task.tags?.length ?? 0) > 0 && (
          <div className="mt-1.5 flex min-w-0 gap-1 overflow-hidden">
            {task.tags!.slice(0, 2).map((tag) => (
              <TagBadge key={tag.id} tag={tag} />
            ))}
            {task.tags!.length > 2 && (
              <span className="nums shrink-0 text-[11px] text-muted">+{task.tags!.length - 2}</span>
            )}
          </div>
        )}
      </div>

      {showOpen && (
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted opacity-40 transition-[opacity,background-color,color] duration-150 ease-out group-hover:bg-surface-2 group-hover:text-text group-hover:opacity-100"
          aria-hidden
        >
          <ChevronRight className="h-4 w-4" />
        </span>
      )}
    </div>
  )
}

interface TaskCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'> {
  task: TaskCardData
  gameName?: string
  onOpen: (taskId: string) => void
  selected?: boolean
  compact?: boolean
}

export const TaskCard = forwardRef<HTMLButtonElement, TaskCardProps>(
  ({ task, gameName, onOpen, selected = false, compact = false, className, ...props }, ref) => {
    const t = useT()
    const overdue = isOverdue(task.dueDate) && task.status !== 'done' && task.status !== 'cancelled'
    return (
      <button
        ref={ref}
        type="button"
        onClick={() => onOpen(task.id)}
        aria-label={t('task.open', { title: task.title })}
        className={cn(
          'tactile group w-full rounded-[10px] bg-surface p-2.5 text-left shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          compact && 'rounded-[8px] px-2.5 py-2',
          overdue && 'bg-red-50/80 dark:bg-red-950/20',
          selected && 'ring-2 ring-accent/50',
          className,
        )}
        {...props}
      >
        <TaskCardBody task={task} gameName={gameName} compact={compact} />
      </button>
    )
  },
)
TaskCard.displayName = 'TaskCard'
