import { PRIORITY_ORDER, STATUS_ORDER, type TaskWithTags } from './meta'

export type TaskSortKey =
  | 'manual'
  | 'key'
  | 'title'
  | 'status'
  | 'priority'
  | 'tags'
  | 'startDate'
  | 'dueDate'
  | 'createdAt'
  | 'updatedAt'

export type SortDirection = 'asc' | 'desc'

const emptyLast = (value: string | null | undefined, direction: SortDirection) =>
  value ? value : direction === 'asc' ? '\uffff' : ''

export function sortTasks(tasks: TaskWithTags[], key: TaskSortKey, direction: SortDirection): TaskWithTags[] {
  const sign = direction === 'asc' ? 1 : -1
  const statusRank = new Map(STATUS_ORDER.map((value, index) => [value, index]))
  const priorityRank = new Map(PRIORITY_ORDER.map((value, index) => [value, index]))

  return [...tasks].sort((a, b) => {
    let result = 0
    switch (key) {
      case 'manual':
        result = a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
        break
      case 'key':
        result = (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
        break
      case 'title':
        result = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        break
      case 'status':
        result = (statusRank.get(a.status) ?? 99) - (statusRank.get(b.status) ?? 99)
        break
      case 'priority':
        result = (priorityRank.get(a.priority) ?? 99) - (priorityRank.get(b.priority) ?? 99)
        break
      case 'tags':
        result = a.tags
          .map((tag) => tag.name)
          .join(', ')
          .localeCompare(b.tags.map((tag) => tag.name).join(', '), undefined, { sensitivity: 'base' })
        break
      case 'startDate':
      case 'dueDate':
        result = emptyLast(a[key], direction).localeCompare(emptyLast(b[key], direction))
        break
      case 'createdAt':
      case 'updatedAt':
        result = a[key].localeCompare(b[key])
        break
    }
    return result * sign || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  })
}
