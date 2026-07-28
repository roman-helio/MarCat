import type { Task } from '@marcat/db'

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'med' | 'high' | 'urgent'
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year'

export type TaskTag = { id: string; name: string; color: string; colorEnabled: boolean }
/** taskKey is the Jira-style display id (`${game.key}-${seq}`), computed in the router. */
export type TaskWithTags = Task & { tags: TaskTag[]; taskKey?: string | null }

export const STATUS_META: Record<
  TaskStatus,
  { label: string; badge: string; dot: string; column: string; border: string }
> = {
  todo: {
    label: 'To do',
    badge: 'bg-surface-2 text-muted',
    dot: 'bg-muted',
    column: 'bg-surface-2/45',
    border: 'border-border-strong',
  },
  doing: {
    label: 'In progress',
    badge: 'bg-info/12 text-info',
    dot: 'bg-info',
    column: 'bg-info/[0.045]',
    border: 'border-info/35',
  },
  blocked: {
    label: 'Blocked',
    badge: 'bg-alarm/12 text-alarm',
    dot: 'bg-alarm',
    column: 'bg-alarm/[0.045]',
    border: 'border-alarm/35',
  },
  done: {
    label: 'Done',
    badge: 'bg-success/12 text-success',
    dot: 'bg-success',
    column: 'bg-success/[0.045]',
    border: 'border-success/35',
  },
  cancelled: {
    label: 'Cancelled',
    badge: 'bg-muted/10 text-muted',
    dot: 'bg-muted/60',
    column: 'bg-surface-2/30',
    border: 'border-border',
  },
}

export const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'blocked', 'done', 'cancelled']
export const BOARD_COLUMNS: TaskStatus[] = ['todo', 'doing', 'blocked', 'done']

export const PRIORITY_META: Record<TaskPriority, { label: string; cls: string }> = {
  urgent: { label: 'Urgent', cls: 'bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300' },
  high: { label: 'High', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-400/15 dark:text-orange-300' },
  med: { label: 'Med', cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-400/15 dark:text-yellow-300' },
  low: { label: 'Low', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300' },
}

export const PRIORITY_ORDER: TaskPriority[] = ['urgent', 'high', 'med', 'low']

export interface TaskPatch {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  startDate?: string | null
  dueDate?: string | null
  reminderAt?: string | null
  recurrence?: { every: number; unit: RecurrenceUnit } | null
  sortOrder?: number
}
