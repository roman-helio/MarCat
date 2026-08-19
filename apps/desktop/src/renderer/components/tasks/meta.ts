import type { Task } from '@marcat/db'
import { CARD_STATE_STYLES, type CardStateTone } from '@/components/ui/CardState'

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'med' | 'high' | 'urgent'
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year'

export type TaskTag = { id: string; name: string; color: string; colorEnabled: boolean }
/** taskKey is the Jira-style display id (`${game.key}-${seq}`), computed in the router. */
export type TaskWithTags = Task & { tags: TaskTag[]; taskKey?: string | null }

export const STATUS_META: Record<
  TaskStatus,
  { label: string; tone: CardStateTone; badge: string; dot: string; column: string; border: string }
> = {
  todo: {
    label: 'To do',
    tone: 'neutral',
    badge: CARD_STATE_STYLES.neutral.badge,
    dot: CARD_STATE_STYLES.neutral.dot,
    column: CARD_STATE_STYLES.neutral.column,
    border: CARD_STATE_STYLES.neutral.columnBorder,
  },
  doing: {
    label: 'In progress',
    tone: 'info',
    badge: CARD_STATE_STYLES.info.badge,
    dot: CARD_STATE_STYLES.info.dot,
    column: CARD_STATE_STYLES.info.column,
    border: CARD_STATE_STYLES.info.columnBorder,
  },
  blocked: {
    label: 'Blocked',
    tone: 'danger',
    badge: CARD_STATE_STYLES.danger.badge,
    dot: CARD_STATE_STYLES.danger.dot,
    column: CARD_STATE_STYLES.danger.column,
    border: CARD_STATE_STYLES.danger.columnBorder,
  },
  done: {
    label: 'Done',
    tone: 'success',
    badge: CARD_STATE_STYLES.success.badge,
    dot: CARD_STATE_STYLES.success.dot,
    column: CARD_STATE_STYLES.success.column,
    border: CARD_STATE_STYLES.success.columnBorder,
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'danger',
    badge: CARD_STATE_STYLES.danger.badge,
    dot: CARD_STATE_STYLES.danger.dot,
    column: CARD_STATE_STYLES.danger.column,
    border: CARD_STATE_STYLES.danger.columnBorder,
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
