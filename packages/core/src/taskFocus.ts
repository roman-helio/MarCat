import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  games,
  taskChecklistItems,
  taskDependencies,
  tasks,
  type ChecklistItem,
  type DB,
  type Task,
  type TaskDependency,
} from '@marcat/db'

const DAY_MS = 86_400_000
const OPEN_STATUSES = new Set(['todo', 'doing', 'blocked'])

export interface ChecklistSummary {
  total: number
  done: number
  remaining: number
  progressPct: number
  nextOpenItem: { id: string; text: string } | null
}

export interface TaskFocusItem {
  rank: number
  score: number
  id: string
  taskKey: string | null
  title: string
  status: Task['status']
  priority: Task['priority']
  dueDate: string | null
  daysLeft: number | null
  overdueDays: number
  checklist: ChecklistSummary
  unlocks: number
  reasons: string[]
  recommendedAction: 'close_task' | 'finish_checklist_item' | 'continue_task' | 'start_task'
}

export interface TaskFocusQueue {
  generatedAt: string
  focus: TaskFocusItem[]
  needsClarification: Array<{
    id: string
    taskKey: string | null
    title: string
    reason: 'blocked_without_dependency'
  }>
}

export function summarizeChecklist(items: ChecklistItem[]): ChecklistSummary {
  const done = items.filter((item) => item.done).length
  const total = items.length
  const next = items.find((item) => !item.done)
  return {
    total,
    done,
    remaining: total - done,
    progressPct: total ? Math.round((done / total) * 100) : 0,
    nextOpenItem: next ? { id: next.id, text: next.text } : null,
  }
}

const daysFrom = (iso: string, today: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)

function rankTasks(
  rows: Task[],
  checklistRows: ChecklistItem[],
  dependencies: TaskDependency[],
  gameKey: string | null,
  limit: number,
  today: string,
): TaskFocusQueue {
  const byId = new Map(rows.map((task) => [task.id, task]))
  const checklists = new Map<string, ChecklistItem[]>()
  for (const item of checklistRows) {
    checklists.set(item.taskId, [...(checklists.get(item.taskId) ?? []), item])
  }

  const openBlockers = new Map<string, string[]>()
  const unlocks = new Map<string, number>()
  for (const dependency of dependencies) {
    const blocker = byId.get(dependency.blockerTaskId)
    const blocked = byId.get(dependency.blockedTaskId)
    if (!blocker || !blocked || !OPEN_STATUSES.has(blocked.status)) continue
    if (OPEN_STATUSES.has(blocker.status)) {
      openBlockers.set(blocked.id, [...(openBlockers.get(blocked.id) ?? []), blocker.id])
      unlocks.set(blocker.id, (unlocks.get(blocker.id) ?? 0) + 1)
    }
  }

  const taskKey = (task: Task) => (gameKey && task.seq != null ? `${gameKey}-${task.seq}` : null)
  const needsClarification = rows
    .filter((task) => task.status === 'blocked' && !(openBlockers.get(task.id)?.length ?? 0))
    .slice(0, 5)
    .map((task) => ({
      id: task.id,
      taskKey: taskKey(task),
      title: task.title,
      reason: 'blocked_without_dependency' as const,
    }))

  const focus = rows
    .filter(
      (task) =>
        OPEN_STATUSES.has(task.status) && task.status !== 'blocked' && !(openBlockers.get(task.id)?.length ?? 0),
    )
    .map((task) => {
      const checklist = summarizeChecklist(checklists.get(task.id) ?? [])
      const downstream = unlocks.get(task.id) ?? 0
      const dueIn = task.dueDate ? daysFrom(task.dueDate, today) : null
      const overdueDays = dueIn != null && dueIn < 0 ? Math.abs(dueIn) : 0
      const reasons: string[] = []
      let score = { urgent: 30, high: 20, med: 10, low: 0 }[task.priority]

      if (task.status === 'doing') {
        score += 30
        reasons.push('already in progress')
      }
      if (overdueDays) {
        score += Math.min(36, 18 + overdueDays)
        reasons.push(`overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'}`)
      } else if (dueIn === 0) {
        score += 18
        reasons.push('due today')
      } else if (dueIn != null && dueIn <= 7) {
        score += Math.max(8, 16 - dueIn)
        reasons.push(`due in ${dueIn} day${dueIn === 1 ? '' : 's'}`)
      }
      if (checklist.total && checklist.remaining === 0) {
        score += 34
        reasons.push('checklist complete; ready to close')
      } else if (checklist.done) {
        score += checklist.progressPct >= 50 ? Math.round(checklist.progressPct * 0.28) : 8
        reasons.push(`checklist ${checklist.done}/${checklist.total}`)
      }
      if (downstream) {
        score += Math.min(24, downstream * 8)
        reasons.push(`unlocks ${downstream} task${downstream === 1 ? '' : 's'}`)
      }
      if (!reasons.length) reasons.push(task.priority === 'urgent' ? 'urgent priority' : `${task.priority} priority`)

      const recommendedAction: TaskFocusItem['recommendedAction'] =
        checklist.total && checklist.remaining === 0
          ? 'close_task'
          : checklist.nextOpenItem
            ? 'finish_checklist_item'
            : task.status === 'doing'
              ? 'continue_task'
              : 'start_task'
      return {
        rank: 0,
        score,
        id: task.id,
        taskKey: taskKey(task),
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate,
        daysLeft: dueIn,
        overdueDays,
        checklist,
        unlocks: downstream,
        reasons,
        recommendedAction,
        sortOrder: task.sortOrder,
      }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
        a.sortOrder - b.sortOrder,
    )
    .slice(0, limit)
    .map(({ sortOrder: _sortOrder, ...item }, index) => ({ ...item, rank: index + 1 }))

  return { generatedAt: new Date().toISOString(), focus, needsClarification }
}

export async function buildTaskFocusQueue(
  db: DB,
  gameId: string,
  limit = 5,
  today = new Date().toISOString().slice(0, 10),
): Promise<TaskFocusQueue> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.gameId, gameId))
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt))
  const ids = rows.map((task) => task.id)
  const [gameRows, checklistRows, dependencies] = await Promise.all([
    db.select({ key: games.key }).from(games).where(eq(games.id, gameId)).limit(1),
    ids.length
      ? db
          .select()
          .from(taskChecklistItems)
          .where(inArray(taskChecklistItems.taskId, ids))
          .orderBy(asc(taskChecklistItems.sortOrder))
      : Promise.resolve([]),
    ids.length
      ? db
          .select()
          .from(taskDependencies)
          .where(and(inArray(taskDependencies.blockerTaskId, ids), inArray(taskDependencies.blockedTaskId, ids)))
      : Promise.resolve([]),
  ])
  return rankTasks(rows, checklistRows, dependencies, gameRows[0]?.key ?? null, limit, today)
}
