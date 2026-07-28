export const RECURRENCE_UNITS = ['day', 'week', 'month', 'year'] as const

export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number]

export interface TaskRecurrence {
  every: number
  unit: RecurrenceUnit
}

function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, date!))
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** Add calendar periods without drifting 31st/month-end recurrences toward the 28th. */
export function addRecurrence(day: string, every: number, unit: RecurrenceUnit, occurrences = 1): string {
  const source = parseDay(day)
  const amount = every * occurrences
  if (unit === 'day' || unit === 'week') {
    source.setUTCDate(source.getUTCDate() + amount * (unit === 'week' ? 7 : 1))
    return formatDay(source)
  }

  const sourceYear = source.getUTCFullYear()
  const sourceMonth = source.getUTCMonth()
  const sourceDate = source.getUTCDate()
  const sourceIsMonthEnd = sourceDate === daysInUtcMonth(sourceYear, sourceMonth)
  const targetMonthIndex = unit === 'month' ? sourceMonth + amount : sourceMonth
  const targetYear = unit === 'year' ? sourceYear + amount : sourceYear + Math.floor(targetMonthIndex / 12)
  const targetMonth = unit === 'year' ? sourceMonth : ((targetMonthIndex % 12) + 12) % 12
  const targetMonthEnd = daysInUtcMonth(targetYear, targetMonth)
  return formatDay(
    new Date(
      Date.UTC(targetYear, targetMonth, sourceIsMonthEnd ? targetMonthEnd : Math.min(sourceDate, targetMonthEnd)),
    ),
  )
}

export function shiftDay(day: string, days: number): string {
  const date = parseDay(day)
  date.setUTCDate(date.getUTCDate() + days)
  return formatDay(date)
}

function dayDistance(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000)
}

/**
 * Advance at least one occurrence and, for an overdue task, skip missed occurrences
 * so completing it never immediately creates another overdue deadline.
 */
export function nextRecurringSchedule(input: {
  dueDate: string | null
  startDate: string | null
  completedOn: string
  recurrence: TaskRecurrence
}): { dueDate: string; startDate: string | null } {
  const anchor = input.dueDate ?? input.completedOn
  let occurrence = 1
  let dueDate = addRecurrence(anchor, input.recurrence.every, input.recurrence.unit, occurrence)
  while (dueDate <= input.completedOn) {
    occurrence++
    dueDate = addRecurrence(anchor, input.recurrence.every, input.recurrence.unit, occurrence)
  }
  return {
    dueDate,
    startDate:
      input.startDate && input.dueDate
        ? shiftDay(input.startDate, dayDistance(input.dueDate, dueDate))
        : input.startDate,
  }
}
