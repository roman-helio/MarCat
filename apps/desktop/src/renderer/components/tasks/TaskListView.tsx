import { useMemo } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight, Repeat2 } from 'lucide-react'
import { daysUntil, isOverdue } from '@/lib/date'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import { SortableHeader } from '@/components/ui/DataList'
import { CARD_STATE_STYLES, CardStateBadge } from '@/components/ui/CardState'
import { TagBadge } from './TagBadge'
import { PRIORITY_META, STATUS_META, type TaskWithTags } from './meta'
import type { SortDirection, TaskSortKey } from './taskSort'

interface Dependency {
  id: string
  blockerTaskId: string
  blockedTaskId: string
}

interface TreeNode {
  task: TaskWithTags
  children: TreeNode[]
}

function buildTree(tasks: TaskWithTags[], dependencies: Dependency[]): TreeNode[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const order = new Map(tasks.map((task, index) => [task.id, index]))
  const parents = new Map<string, string[]>()
  for (const dependency of dependencies) {
    if (!taskById.has(dependency.blockerTaskId) || !taskById.has(dependency.blockedTaskId)) continue
    parents.set(dependency.blockedTaskId, [...(parents.get(dependency.blockedTaskId) ?? []), dependency.blockerTaskId])
  }
  const primaryParent = new Map<string, string>()
  for (const [childId, parentIds] of parents) {
    const parentId = [...parentIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0]
    if (parentId) primaryParent.set(childId, parentId)
  }
  const children = new Map<string, TaskWithTags[]>()
  for (const task of tasks) {
    const parentId = primaryParent.get(task.id)
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), task])
  }
  const node = (task: TaskWithTags): TreeNode => ({ task, children: (children.get(task.id) ?? []).map(node) })
  return tasks.filter((task) => !primaryParent.has(task.id)).map(node)
}

export function TaskListView({
  tasks,
  dependencies,
  onSelect,
  selectedIds,
  onToggleSelect,
  sortKey,
  sortDirection,
  onSort,
  collapsedIds,
  onCollapsedIdsChange,
}: {
  tasks: TaskWithTags[]
  dependencies: Dependency[]
  onSelect: (id: string) => void
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
  sortKey: TaskSortKey
  sortDirection: SortDirection
  onSort: (key: TaskSortKey) => void
  collapsedIds: Set<string>
  onCollapsedIdsChange: (ids: Set<string>) => void
}) {
  const t = useT()
  const tree = useMemo(() => buildTree(tasks, dependencies), [tasks, dependencies])
  const selectable = !!onToggleSelect

  const renderNode = (node: TreeNode, depth: number) => {
    const { task, children } = node
    const checked = selectedIds?.has(task.id) ?? false
    const isCollapsed = collapsedIds.has(task.id)
    const finished = task.status === 'done' || task.status === 'cancelled'
    const overdue = isOverdue(task.dueDate) && !finished
    const dueDays = task.dueDate ? daysUntil(task.dueDate) : null
    const severelyOverdue = overdue && dueDays != null && dueDays < -5
    const dueLabel =
      dueDays == null
        ? '—'
        : dueDays < 0
          ? t('task.cardOverdue', { n: Math.abs(dueDays) })
          : dueDays === 0
            ? t('task.cardToday')
            : t('task.cardDueIn', { n: dueDays })

    return (
      <div key={task.id}>
        <div
          className={cn(
            'group/task-row flex min-h-10 items-center gap-x-2 border-b border-l-[4px] border-b-border bg-surface px-3 text-sm transition-colors last:border-b-0 hover:bg-surface-2/60',
            CARD_STATE_STYLES[STATUS_META[task.status].tone].spine,
            checked && 'bg-accent/5',
          )}
        >
          <div className="flex h-10 w-24 shrink-0 items-center gap-1.5">
            {selectable && (
              <label className="inline-flex h-10 w-4 shrink-0 cursor-pointer items-center justify-center opacity-0 transition-opacity duration-150 ease-out group-hover/task-row:opacity-100 focus-within:opacity-100 has-[:checked]:opacity-100">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelect!(task.id)}
                  className="h-3.5 w-3.5 accent-accent"
                  aria-label={t('common.select')}
                />
              </label>
            )}
            <span className="nums min-w-0 flex-1 truncate text-xs text-muted">{task.taskKey ?? '—'}</span>
          </div>
          <span className="w-28 shrink-0">
            <CardStateBadge tone={STATUS_META[task.status].tone}>{t(`status.${task.status}`)}</CardStateBadge>
          </span>
          <span className="w-24 shrink-0">
            <span
              className={cn('inline-flex rounded-[5px] px-1.5 py-0.5 t-caption', PRIORITY_META[task.priority].cls)}
            >
              {t(`prio.${task.priority}`)}
            </span>
          </span>
          <div className="flex min-w-72 flex-1 items-center" style={{ paddingLeft: `${Math.min(depth, 8) * 18}px` }}>
            {children.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  const next = new Set(collapsedIds)
                  if (next.has(task.id)) next.delete(task.id)
                  else next.add(task.id)
                  onCollapsedIdsChange(next)
                }}
                className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-text"
                aria-label={isCollapsed ? t('tasks.expandChildren') : t('tasks.collapseChildren')}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            ) : (
              <span
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-border-strong"
                aria-hidden
              >
                {depth > 0 && <CornerDownRight className="h-3.5 w-3.5" />}
              </span>
            )}
            <button
              type="button"
              onClick={() => onSelect(task.id)}
              className={cn(
                'tap h-10 min-w-0 flex-1 truncate rounded-[var(--radius)] text-left font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                finished && 'text-muted line-through',
              )}
              title={task.title}
            >
              {task.title}
            </button>
            {task.recurrenceInterval && task.recurrenceUnit && (
              <span
                className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] bg-accent/8 text-accent"
                title={t('task.recurring')}
                aria-label={t('task.recurring')}
              >
                <Repeat2 className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
          <div className="flex w-32 shrink-0 items-center justify-end gap-1 overflow-hidden xl:w-64">
            {task.tags.slice(0, 2).map((tag) => (
              <TagBadge key={tag.id} tag={tag} className="max-w-28" />
            ))}
            {task.tags.length > 2 && (
              <span className="nums shrink-0 t-caption text-muted">+{task.tags.length - 2}</span>
            )}
          </div>
          <span
            className={cn(
              'nums w-36 shrink-0 whitespace-nowrap text-right text-xs',
              overdue ? 'text-alarm' : 'text-muted',
              severelyOverdue && 'deadline-dance font-medium',
            )}
          >
            {dueLabel}
          </span>
          <button
            type="button"
            onClick={() => onSelect(task.id)}
            className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] text-muted opacity-40 hover:bg-surface-2 hover:text-text group-hover/task-row:opacity-100"
            aria-label={t('task.open', { title: task.title })}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        {!isCollapsed && children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-[10px] bg-surface shadow-hard">
      <div className="min-w-[976px] xl:min-w-[1152px]">
        <div className="flex h-9 items-center gap-x-2 border-b border-border bg-surface-2 px-3">
          <SortableHeader
            label={t('tasks.col.key')}
            active={sortKey === 'key'}
            direction={sortDirection}
            onClick={() => onSort('key')}
            className="w-24"
          />
          <SortableHeader
            label={t('task.status')}
            active={sortKey === 'status'}
            direction={sortDirection}
            onClick={() => onSort('status')}
            className="w-28"
          />
          <SortableHeader
            label={t('task.priority')}
            active={sortKey === 'priority'}
            direction={sortDirection}
            onClick={() => onSort('priority')}
            className="w-24"
          />
          <SortableHeader
            label={t('tasks.col.task')}
            active={sortKey === 'title'}
            direction={sortDirection}
            onClick={() => onSort('title')}
            className="min-w-72 flex-1"
          />
          <SortableHeader
            label={t('task.tags')}
            active={sortKey === 'tags'}
            direction={sortDirection}
            onClick={() => onSort('tags')}
            align="right"
            className="w-32 xl:w-64"
          />
          <SortableHeader
            label={t('task.due')}
            active={sortKey === 'dueDate'}
            direction={sortDirection}
            onClick={() => onSort('dueDate')}
            align="right"
            className="w-36"
          />
          <span className="w-10 shrink-0" />
        </div>
        <div>{tree.map((node) => renderNode(node, 0))}</div>
      </div>
    </div>
  )
}
